/* ==========================================================================
   data-engine.js — данные Binance (Futures fapi + Spot api), кластеры,
   стакан, Z-Score полос стакана, дельта стакана и Bid Dominance.

   Источники (публичные, без ключей):
     REST  klines (300 свечей + прогрев базы Z-Score), aggTrades (дозагрузка
           последних сделок), depth?limit=1000 (опрос каждые 3 с),
           exchangeInfo (tickSize), ticker/24hr.
     WS    <symbol>@aggTrade (живые сделки), !miniTicker@arr (тикеры),
           Coinbase ticker и Deribit ticker (котировки в панели).

   Стакан хранится как «сетка» ликвидности относительно mid:
   200 корзин по 0,05 % на каждую сторону (0–10 %), значения в USDT.

   История стакана на Binance публично не отдаётся, поэтому прошлые свечи
   получают РЕКОНСТРУКЦИЮ стакана (модель из OHLCV, taker-buy объёма и
   объёмных узлов прошлых свечей). Модель калибруется по реальным снимкам
   depth, а реальные минутные снимки (в т.ч. сохранённые в IndexedDB)
   замещают модель везде, где они есть.
   ========================================================================== */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------ const
  const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3 };
  const TF_LIST = ['1m', '5m', '15m', '1h', '4h'];
  const TF_LABEL = { '1m': '1м', '5m': '5м', '15m': '15м', '1h': '1ч', '4h': '4ч' };

  const MARKETS = {
    futures: {
      id: 'futures',
      label: 'Binance фьючерсы',
      rest: 'https://fapi.binance.com/fapi/v1',
      ws: 'wss://fstream.binance.com/ws',
      klineMax: 1500,
      depthLimit: 1000
    },
    spot: {
      id: 'spot',
      label: 'Binance спот',
      rest: 'https://api.binance.com/api/v3',
      ws: 'wss://stream.binance.com:9443/ws',
      klineMax: 1000,
      depthLimit: 1000
    }
  };

  const BUCKET_PCT = 0.05;          // ширина корзины сетки стакана, %
  const BUCKETS = 200;              // 200 × 0,05 % = 10 %
  const Z_BANDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
  const NB = Z_BANDS.length - 1;
  const BAND_K = [];                // [k0, k1) — диапазоны корзин каждой полосы
  for (let b = 0; b < NB; b++) {
    BAND_K.push([Math.round(Z_BANDS[b] / BUCKET_PCT), Math.round(Z_BANDS[b + 1] / BUCKET_PCT)]);
  }
  const BUCKET_BAND = new Int16Array(BUCKETS);
  for (let b = 0; b < NB; b++) for (let k = BAND_K[b][0]; k < BAND_K[b][1]; k++) BUCKET_BAND[k] = b;

  const DELTA_RANGES = [0.5, 1, 2.5, 5, 10];
  const IMB_BANDS = 12;             // Imbalance Heatmap: первые 12 полос Z_BANDS (0–2,5 %)
  const DOM_RANGES = [0.25, 0.5, 1];

  const BASES = { '4h': 4 * 3600e3, '12h': 12 * 3600e3, '24h': 24 * 3600e3, '3d': 3 * 86400e3, '7d': 7 * 86400e3, '14d': 14 * 86400e3 };
  const BASE_LIST = ['4h', '12h', '24h', '3d', '7d', '14d'];
  const BASE_LABEL = { '4h': '4 ч', '12h': '12 ч', '24h': '24 ч', '3d': '3 д', '7d': '7 д', '14d': '14 д' };

  const MAIN_CANDLES = 300;
  const MAX_CANDLES = 3000;
  const DEPTH_POLL_MS = 3000;
  const BACKFILL_PAGES = 16;
  const LOGSTEP = Math.log(1 + BUCKET_PCT / 100);
  const MINUTE = 60e3;
  const FETCH_TIMEOUT_MS = 15000;   // зависший запрос обрывается и повторяется
  const WS_SILENCE_MS = 45000;      // поток сделок молчит дольше — переподключаем
  const Z_SMOOTH_MIN = 60;          // сглаживание полос стакана во времени для Z (минуты)

  /**
   * EMA по времени для рядов log-объёма полос: шум отдельных снимков не
   * должен перекрашивать зону каждую свечу. Одинаково применяется к
   * свечам и к базе, поэтому Z остаётся согласованным.
   */
  function smoothBands(list, tfMs) {
    const a = 1 - Math.exp(-(tfMs / MINUTE) / Z_SMOOTH_MIN);
    const out = new Array(list.length);
    let prev = null;
    for (let i = 0; i < list.length; i++) {
      const src = list[i];
      const cur = new Float64Array(src.length);
      for (let j = 0; j < src.length; j++) {
        const v = src[j];
        const pv = prev ? prev[j] : NaN;
        if (!isFinite(v)) cur[j] = pv;
        else cur[j] = isFinite(pv) ? pv + a * (v - pv) : v;
      }
      out[i] = cur;
      prev = cur;
    }
    return out;
  }

  // --------------------------------------------------------------- helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchJSON(url, tries) {
    tries = tries || 4;
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
        let res;
        try {
          res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
          if (res.ok) return await res.json();      // тело читается под тем же таймаутом
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 429 || res.status === 418) {
          const ra = Number(res.headers.get('Retry-After')) || (2 + i * 3);
          await sleep(ra * 1000);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error('HTTP ' + res.status + ' ' + url.split('?')[0] + ' ' + text.slice(0, 160));
        }
      } catch (e) {
        lastErr = e && e.name === 'AbortError' ? new Error('Таймаут запроса ' + url.split('?')[0]) : e;
        await sleep(400 * Math.pow(2, i));
      }
    }
    throw lastErr || new Error('fetch failed: ' + url);
  }

  function lowerBound(arr, x, key) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((key ? arr[mid][key] : arr[mid]) < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function median(values) {
    if (!values.length) return 0;
    const s = values.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function decimalsOf(step) {
    if (!isFinite(step) || step <= 0) return 2;
    const s = String(step);
    if (s.indexOf('e-') >= 0) return Number(s.split('e-')[1]);
    const i = s.indexOf('.');
    if (i < 0) return 0;
    return s.slice(i + 1).replace(/0+$/, '').length;
  }

  function parseKline(k) {
    return {
      t: k[0],
      o: +k[1], h: +k[2], l: +k[3], c: +k[4],
      v: +k[5],
      q: +k[7],
      n: +k[8],
      buy: +k[9],      // taker buy base volume
      buyQ: +k[10]     // taker buy quote volume
    };
  }

  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return () => this.off(ev, fn); }
    off(ev, fn) { const a = this._h[ev]; if (a) this._h[ev] = a.filter((f) => f !== fn); }
    emit(ev, data) { const a = this._h[ev]; if (a) for (const f of a.slice()) { try { f(data); } catch (e) { console.error(e); } } }
  }

  // ---------------------------------------------------------- exchangeInfo
  const exInfoCache = { futures: null, spot: new Map() };

  async function getSymbolInfo(market, symbol) {
    const m = MARKETS[market];
    if (market === 'futures') {
      if (!exInfoCache.futures) {
        const j = await fetchJSON(m.rest + '/exchangeInfo');
        const map = new Map();
        for (const s of j.symbols) {
          const pf = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
          map.set(s.symbol, { tick: pf ? +pf.tickSize : 0.01, base: s.baseAsset, quote: s.quoteAsset, status: s.status });
        }
        exInfoCache.futures = map;
      }
      const info = exInfoCache.futures.get(symbol);
      if (!info) throw new Error('Символ ' + symbol + ' не найден на Binance Futures');
      return info;
    }
    if (exInfoCache.spot.has(symbol)) return exInfoCache.spot.get(symbol);
    const j = await fetchJSON(m.rest + '/exchangeInfo?symbol=' + encodeURIComponent(symbol));
    const s = j.symbols && j.symbols[0];
    if (!s) throw new Error('Символ ' + symbol + ' не найден на Binance Spot');
    const pf = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
    const info = { tick: pf ? +pf.tickSize : 0.01, base: s.baseAsset, quote: s.quoteAsset, status: s.status };
    exInfoCache.spot.set(symbol, info);
    return info;
  }

  /** Свечи с пагинацией назад, если limit больше максимума биржи. */
  async function fetchKlines(market, symbol, interval, total) {
    const m = MARKETS[market];
    let out = [];
    let endTime = null;
    while (out.length < total) {
      const need = Math.min(m.klineMax, total - out.length);
      let url = m.rest + '/klines?symbol=' + symbol + '&interval=' + interval + '&limit=' + need;
      if (endTime !== null) url += '&endTime=' + endTime;
      const rows = await fetchJSON(url);
      if (!rows.length) break;
      const parsed = rows.map(parseKline);
      out = parsed.concat(out);
      endTime = parsed[0].t - 1;
      if (rows.length < need) break;
    }
    // дедупликация на стыках страниц
    const seen = new Set();
    out = out.filter((k) => (seen.has(k.t) ? false : (seen.add(k.t), true)));
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // ------------------------------------------------------- book utilities
  /** Перевести стакан Binance в сетку корзин относительно mid. */
  function depthToGrid(depth) {
    const bids = depth.bids || [];
    const asks = depth.asks || [];
    if (!bids.length || !asks.length) return null;
    const bestBid = +bids[0][0];
    const bestAsk = +asks[0][0];
    const mid = (bestBid + bestAsk) / 2;
    const bid = new Float32Array(BUCKETS);
    const ask = new Float32Array(BUCKETS);
    let bidReach = 0;
    let askReach = 0;
    for (let i = 0; i < bids.length; i++) {
      const p = +bids[i][0];
      const q = +bids[i][1];
      const d = (mid - p) / mid * 100;
      const k = Math.floor(d / BUCKET_PCT);
      if (k >= 0 && k < BUCKETS) bid[k] += p * q;
      if (d > bidReach) bidReach = d;
    }
    for (let i = 0; i < asks.length; i++) {
      const p = +asks[i][0];
      const q = +asks[i][1];
      const d = (p - mid) / mid * 100;
      const k = Math.floor(d / BUCKET_PCT);
      if (k >= 0 && k < BUCKETS) ask[k] += p * q;
      if (d > askReach) askReach = d;
    }
    // Глубина limit=1000 может не доставать до 10 %: корзины за пределами
    // охвата помечаем отрицательным значением (нет данных).
    const kb = Math.min(BUCKETS, Math.floor(bidReach / BUCKET_PCT));
    const ka = Math.min(BUCKETS, Math.floor(askReach / BUCKET_PCT));
    for (let k = kb; k < BUCKETS; k++) bid[k] = -1;
    for (let k = ka; k < BUCKETS; k++) ask[k] = -1;
    return { mid, bid, ask, bestBid, bestAsk };
  }

  function bandSums(grid, out, offset) {
    for (let b = 0; b < NB; b++) {
      let s = 0;
      let missing = false;
      for (let k = BAND_K[b][0]; k < BAND_K[b][1]; k++) {
        const v = grid[k];
        if (v < 0) { missing = true; break; }
        s += v;
      }
      out[offset + b] = missing ? NaN : s;
    }
  }

  function rangeSum(grid, pct) {
    const kmax = Math.min(BUCKETS, Math.round(pct / BUCKET_PCT));
    let s = 0;
    for (let k = 0; k < kmax; k++) {
      const v = grid[k];
      if (v < 0) return NaN;
      s += v;
    }
    return s;
  }

  function dominance(b, a) {
    if (!(b > 0) || !(a > 0)) return NaN;
    const v = b >= a ? (b / a - 1) * 100 : -(a / b - 1) * 100;
    return Math.max(-999, Math.min(999, v));
  }

  // ------------------------------------------------- reconstruction model
  /**
   * Реконструкция стакана для серии свечей (модель, а не реальные данные).
   * Ликвидность корзины = база(средний объём) × форма(расстояние)
   *   × (1 + объёмные узлы прошлых свечей на этой цене)
   *   × сдвиг от агрессии тейкеров (покупки «съедают» аски, продажи — биды)
   *   × снятие ликвидности у цены при всплеске волатильности.
   * Все постоянные заданы в минутах, поэтому модель согласована между ТФ.
   */
  function reconstructSeries(series, tfMs) {
    const tfMin = tfMs / MINUTE;
    const aV = 1 - Math.exp(-tfMin / 240);
    const aF = 1 - Math.exp(-tfMin / 30);
    const aS = 1 - Math.exp(-tfMin / 30);
    const aL = 1 - Math.exp(-tfMin / 600);
    const aSmooth = 1 - Math.exp(-tfMin / 20);
    const lambda = Math.min(tfMin / 360, 0.2);
    const memTau = 1 / (1 - Math.exp(-lambda));

    const shape = new Float32Array(BUCKETS);
    const near = new Float32Array(BUCKETS);
    for (let k = 0; k < BUCKETS; k++) {
      const d = (k + 0.5) * BUCKET_PCT;
      shape[k] = 0.25 + 0.75 * (1 - Math.exp(-d / 0.6)) + 0.15 * d;
      near[k] = Math.exp(-d / 0.8);
    }

    const mem = new Map();
    // старт EMA объёма — медиана первых свечей, чтобы одна аномальная свеча не задирала прогрев
    const head = [];
    for (let i = 0; i < Math.min(60, series.length); i++) {
      const c = series[i];
      head.push((c.q > 0 ? c.q : c.v * c.c) / tfMin);
    }
    let V = head.length ? Math.max(1, median(head)) : null;
    let F = 0;
    let rs = null;
    let rl = null;
    let prevBid = null;
    let prevAsk = null;

    for (let i = 0; i < series.length; i++) {
      const c = series[i];
      const G = Math.exp(lambda * i);
      const qpm = (c.q > 0 ? c.q : c.v * c.c) / tfMin;
      V = V === null ? Math.max(qpm, 1) : V + aV * (Math.min(qpm, V * 8) - V);
      const dn = c.v > 0 ? (2 * c.buy - c.v) / c.v : 0;
      F = F + aF * (dn - F);
      const r = c.c > 0 ? (c.h - c.l) / c.c : 0;
      rs = rs === null ? r : rs + aS * (r - rs);
      rl = rl === null ? Math.max(r, 1e-6) : rl + aL * (r - rl);
      const volR = rl > 0 ? rs / rl : 1;

      // объёмный отпечаток свечи по цене (треугольник к POC)
      const q = c.q > 0 ? c.q : c.v * c.c;
      if (q > 0 && c.h > 0 && c.l > 0) {
        const i0 = Math.round(Math.log(c.l) / LOGSTEP);
        const i1 = Math.round(Math.log(c.h) / LOGSTEP);
        const poc = (c.h + c.l + 2 * c.c) / 4;
        const ip = Math.round(Math.log(poc) / LOGSTEP);
        const span = Math.max(1, i1 - i0);
        let wsum = 0;
        const ws = [];
        for (let j = i0; j <= i1; j++) {
          const w = Math.max(0.08, 1 - Math.abs(j - ip) / (span * 0.75 + 1));
          ws.push(w * w);
          wsum += w * w;
        }
        for (let j = i0; j <= i1; j++) {
          const add = q * ws[j - i0] / wsum * G;
          mem.set(j, (mem.get(j) || 0) + add);
        }
      }

      const B = V * 30;
      const memNorm = V * memTau * tfMin;
      const flowK = 1.6 * Math.max(-1, Math.min(1, F * 2.5));
      const volK = 0.5 * Math.max(-1, Math.min(3, volR - 1));
      const bid = new Float32Array(BUCKETS);
      const ask = new Float32Array(BUCKETS);
      const lc = Math.log(c.c);
      for (let k = 0; k < BUCKETS; k++) {
        const d = (k + 0.5) * BUCKET_PCT / 100;
        const ia = Math.round((lc + Math.log(1 + d)) / LOGSTEP);
        const ib = Math.round((lc + Math.log(1 - d)) / LOGSTEP);
        const ma = (mem.get(ia) || 0) / G / memNorm * 25;
        const mb = (mem.get(ib) || 0) / G / memNorm * 25;
        const satA = ma / (1 + ma);
        const satB = mb / (1 + mb);
        const nk = near[k];
        let va = B * shape[k] * (1 + 2.2 * satA) * Math.exp(-flowK * nk) * Math.exp(-volK * nk);
        let vb = B * shape[k] * (1 + 2.2 * satB) * Math.exp(flowK * nk) * Math.exp(-volK * nk);
        if (prevAsk) {
          va = prevAsk[k] + aSmooth * (va - prevAsk[k]);
          vb = prevBid[k] + aSmooth * (vb - prevBid[k]);
        }
        ask[k] = va;
        bid[k] = vb;
      }
      c.model = { bid, ask };
      prevBid = bid;
      prevAsk = ask;

      // чистка памяти от совсем старых и малых значений
      if (i % 200 === 199) {
        const thr = 1e-6 * memNorm * G;
        for (const [key, val] of mem) if (val < thr) mem.delete(key);
      }
    }
  }

  // ------------------------------------------------- synthetic clusters
  /** Распределить объём свечи по строкам цены (для свечей без ленты сделок). */
  function syntheticRows(c, rowSize) {
    const r0 = Math.floor(c.l / rowSize + 1e-9);
    const r1 = Math.floor(c.h / rowSize + 1e-9);
    const count = r1 - r0 + 1;
    const rows = [];
    if (count <= 0 || !(c.v > 0)) return rows;
    const poc = (c.h + c.l + 2 * c.c) / 4;
    const range = Math.max(c.h - c.l, rowSize);
    const bf = c.v > 0 ? c.buy / c.v : 0.5;
    const dir = c.c > c.o ? 1 : c.c < c.o ? -1 : 0;
    let wsum = 0;
    const ws = new Float64Array(count);
    for (let j = 0; j < count; j++) {
      const p = (r0 + j + 0.5) * rowSize;
      const w = Math.max(0.06, 1 - Math.abs(p - poc) / (range * 0.75));
      ws[j] = Math.pow(w, 1.5);
      wsum += ws[j];
    }
    let bsum = 0;
    const bfs = new Float64Array(count);
    for (let j = 0; j < count; j++) {
      const rel = count > 1 ? j / (count - 1) : 0.5;
      bfs[j] = Math.max(0.02, Math.min(0.98, bf + dir * 0.18 * (rel - 0.5)));
      bsum += ws[j] / wsum * c.v * bfs[j];
    }
    const bScale = bsum > 0 ? (c.buy || 0) / bsum : 1;
    for (let j = 0; j < count; j++) {
      const vol = ws[j] / wsum * c.v;
      let b = vol * bfs[j] * bScale;
      if (b > vol) b = vol;
      const s = vol - b;
      const n = ws[j] / wsum * (c.n || 0);
      const nb = n * (vol > 0 ? b / vol : 0.5);
      rows.push({ p: (r0 + j) * rowSize, b, s, n, nb, ns: n - nb });
    }
    return rows;
  }

  // ===================================================================
  //                             DataEngine
  // ===================================================================
  class DataEngine extends Emitter {
    constructor(storage) {
      super();
      this.db = storage || null;
      this.gen = 0;
      this.candles = [];
      this.baseline = [];
      this.realMinutes = [];      // [{t, mid, n, bid, ask}] по возрастанию t
      this.acc = null;            // накопитель текущей минуты стакана
      this.lastBook = null;       // последний снимок depth (сетка)
      this.ws = null;
      this.depthTimer = null;
      this.cal = new Float64Array(2 * NB);
      this.calF = new Float64Array(2 * NB).fill(1);
      this.status = { trades: 'connecting', depth: 'connecting' };
      this.coverageStart = Infinity;
      this.storedZ = new Map();
      this.lastPrice = NaN;
      this.info = null;
      this.ready = false;
      this.version = 0;
    }

    // ---------------------------------------------------------- public
    async load(opts) {
      const gen = ++this.gen;
      this._teardown();
      this.ready = false;
      this.market = opts.market;
      this.symbol = opts.symbol;
      this.tf = opts.tf;
      this.base = opts.base || '4h';
      this.tfMs = TF_MS[this.tf];
      this.candles = [];
      this.baseline = [];
      this.realMinutes = [];
      this.acc = null;
      this.lastBook = null;
      this.cal = new Float64Array(2 * NB);
      this.calF = new Float64Array(2 * NB).fill(1);
      this.coverageStart = Infinity;
      this.lastAggId = 0;
      this.wsBuffer = [];
      this.backfillDone = false;
      this.storedZ = new Map();

      this._status('trades', 'connecting');
      this._status('depth', 'connecting');
      this.emit('loading', { stage: 'Параметры инструмента…' });

      this.info = await getSymbolInfo(this.market, this.symbol);
      if (gen !== this.gen) return;
      this.tick = this.info.tick;
      this.priceDecimals = decimalsOf(this.tick);

      // живой поток открываем сразу, сообщения буферизуются до конца дозагрузки
      this._openTradeStream(gen);

      this.emit('loading', { stage: 'Свечи ' + this.symbol + ' ' + TF_LABEL[this.tf] + '…' });
      await this._loadKlines(gen);
      if (gen !== this.gen) return;

      this.emit('loading', { stage: 'История стакана (IndexedDB)…' });
      await this._loadStoredBook(gen);
      if (gen !== this.gen) return;

      this.emit('loading', { stage: 'Лента сделок aggTrades…' });
      await this._backfillTrades(gen);
      if (gen !== this.gen) return;

      this.emit('loading', { stage: 'Стакан depth 1000…' });
      await this._pollDepth(gen);
      if (gen !== this.gen) return;
      this.depthTimer = setInterval(() => this._pollDepth(gen), DEPTH_POLL_MS);

      this._recomputeAll();
      this.ready = true;
      this.emit('reload', this);
    }

    async setBase(base) {
      if (base === this.base) return;
      this.base = base;
      const gen = this.gen;
      this.emit('loading', { stage: 'База Z-Score ' + BASE_LABEL[base] + '…' });
      await this._loadBaselineIfNeeded(gen);
      if (gen !== this.gen) return;
      this.storedZ = await this._loadStoredZ();
      this._recomputeAll();
      this.emit('reload', this);
    }

    destroy() {
      this.gen++;
      this._teardown();
    }

    /** Строки кластера свечи для заданного шага цены. */
    rowsFor(c, rowSize) {
      if (c._rowsSize === rowSize && c._rowsVer === c.ver) return c._rows;
      let rows;
      if (c.covered && c.clusters) {
        const agg = new Map();
        const tick = this.tick;
        for (const [key, cl] of c.clusters) {
          const r = Math.floor((key * tick) / rowSize + 1e-9);
          let a = agg.get(r);
          if (!a) { a = { p: r * rowSize, b: 0, s: 0, n: 0, nb: 0, ns: 0 }; agg.set(r, a); }
          a.b += cl.b; a.s += cl.s; a.n += cl.nb + cl.ns; a.nb += cl.nb; a.ns += cl.ns;
        }
        rows = Array.from(agg.values()).sort((x, y) => x.p - y.p);
      } else {
        rows = syntheticRows(c, rowSize);
      }
      c._rows = rows;
      c._rowsSize = rowSize;
      c._rowsVer = c.ver;
      return rows;
    }

    /** Итоговая сетка стакана свечи (реальная или калиброванная модель). */
    gridFor(c) {
      return c.book;
    }

    get bandEdges() { return Z_BANDS; }

    // --------------------------------------------------------- private
    _status(kind, state) {
      this.status[kind] = state;
      this.emit('status', { kind, state });
    }

    _teardown() {
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        try { this.ws.close(); } catch (e) { /* закрыто */ }
        this.ws = null;
      }
      if (this.wsRetryTimer) { clearTimeout(this.wsRetryTimer); this.wsRetryTimer = null; }
      if (this.depthTimer) { clearInterval(this.depthTimer); this.depthTimer = null; }
      if (this.wdTimer) { clearInterval(this.wdTimer); this.wdTimer = null; }
      this.wsOpenedOnce = false;
      this.depthBusy = 0;
    }

    /**
     * Ряд для статистики Z. Берём самый крупный ТФ не старше основного, в окне
     * базы которого хотя бы 12 точек (иначе на 1ч с базой 4ч статистика пуста
     * и Z вообще не считается); если такого нет — прежний выбор.
     */
    _pickBaselineTf() {
      const base = BASES[this.base];
      const span = MAIN_CANDLES * this.tfMs + base;
      const max = MARKETS[this.market].klineMax * 2;
      const finer = TF_LIST.filter((tf) => TF_MS[tf] <= this.tfMs);
      for (let i = finer.length - 1; i >= 0; i--) {
        const m = TF_MS[finer[i]];
        if (base / m >= 12 && span / m <= max) return finer[i];
      }
      for (const tf of TF_LIST) {
        if (TF_MS[tf] < this.tfMs) continue;
        if (span / TF_MS[tf] <= max) return tf;
      }
      return '4h';
    }

    /** Окно базы: не короче 12 точек базового ряда. */
    _baseMs() {
      return Math.max(BASES[this.base], 12 * TF_MS[this.tfB || this.tf]);
    }

    async _loadKlines(gen) {
      this.tfB = this._pickBaselineTf();
      const baseMs = this._baseMs();
      if (this.tfB === this.tf) {
        const total = Math.min(MARKETS[this.market].klineMax * 2, MAIN_CANDLES + Math.ceil(baseMs / this.tfMs) + 2);
        const ks = await fetchKlines(this.market, this.symbol, this.tf, total);
        if (gen !== this.gen) return;
        this.candles = ks.map((k) => this._mkCandle(k));
        this.baselineShared = true;
        this.baseline = [];
      } else {
        const ks = await fetchKlines(this.market, this.symbol, this.tf, MAIN_CANDLES);
        if (gen !== this.gen) return;
        this.candles = ks.map((k) => this._mkCandle(k));
        await this._fetchBaseline(gen);
      }
      reconstructSeries(this.candles, this.tfMs);
      const last = this.candles[this.candles.length - 1];
      if (last) this.lastPrice = last.c;
    }

    async _fetchBaseline(gen) {
      const tfBMs = TF_MS[this.tfB];
      const span = this.candles.length * this.tfMs + this._baseMs();
      const count = Math.min(MARKETS[this.market].klineMax * 2, Math.ceil(span / tfBMs) + 2);
      const ks = await fetchKlines(this.market, this.symbol, this.tfB, count);
      if (gen !== this.gen) return;
      this.baseline = ks.map((k) => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, q: k.q, n: k.n, buy: k.buy }));
      this.baselineShared = false;
      reconstructSeries(this.baseline, tfBMs);
    }

    async _loadBaselineIfNeeded(gen) {
      const newTfB = this._pickBaselineTf();
      this.tfB = newTfB;
      const needSpan = this._baseMs() + this.candles.length * this.tfMs;
      if (newTfB === this.tf) {
        // общий ряд: при нехватке прогрева догружаем свечи текущего ТФ
        const have = this.candles.length ? (this.candles[this.candles.length - 1].t - this.candles[0].t) : 0;
        if (have < needSpan - this.tfMs && this.candles.length < MARKETS[this.market].klineMax * 2) {
          const total = Math.min(MARKETS[this.market].klineMax * 2, Math.ceil(needSpan / this.tfMs) + 2);
          const ks = await fetchKlines(this.market, this.symbol, this.tf, total);
          if (gen !== this.gen) return;
          const known = new Map(this.candles.map((c) => [c.t, c]));
          const merged = ks.map((k) => known.get(k.t) || this._mkCandle(k));
          for (const c of this.candles) if (!merged.length || c.t > merged[merged.length - 1].t) merged.push(c);
          this.candles = merged;
          reconstructSeries(this.candles, this.tfMs);
          this._recomputeRealBooks();
        }
        this.tfB = newTfB;
        this.baselineShared = true;
        this.baseline = [];
      } else {
        this.tfB = newTfB;
        await this._fetchBaseline(gen);
      }
    }

    _mkCandle(k) {
      return {
        t: k.t, o: k.o, h: k.h, l: k.l, c: k.c,
        v: k.v, q: k.q, n: k.n, buy: k.buy,
        covered: false, clusters: null, ver: 0,
        model: null, book: null, realFrac: 0,
        bands: new Float64Array(2 * NB), z: new Float64Array(2 * NB), zStored: false,
        dBid: new Float64Array(DELTA_RANGES.length), dAsk: new Float64Array(DELTA_RANGES.length),
        dom: new Float64Array(DOM_RANGES.length)
      };
    }

    async _loadStoredBook(gen) {
      if (!this.db) return;
      const from = (this.baselineShared ? this.candles[0].t : (this.baseline[0] ? this.baseline[0].t : this.candles[0].t));
      try {
        const rows = await this.db.getBookMinutes(this.market, this.symbol, from, Date.now() + MINUTE);
        if (gen !== this.gen) return;
        rows.sort((a, b) => a.t - b.t);
        this.realMinutes = rows.map((r) => ({ t: r.t, mid: r.mid, n: r.n, bid: r.bid, ask: r.ask }));
        this.storedZ = await this._loadStoredZ();
      } catch (e) {
        console.warn('[engine] не удалось прочитать IndexedDB:', e);
      }
    }

    async _loadStoredZ() {
      if (!this.db || !this.candles.length) return new Map();
      try {
        return await this.db.getZScores(this.market, this.symbol, this.tf, this.base, this.candles[0].t, Date.now());
      } catch (e) {
        return new Map();
      }
    }

    // ------------------------------------------------------- trades
    _openTradeStream(gen) {
      const url = MARKETS[this.market].ws + '/' + this.symbol.toLowerCase() + '@aggTrade';
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this._status('trades', 'error');
        return;
      }
      this.ws = ws;
      this._status('trades', 'connecting');
      this.lastWsMsg = Date.now();
      this._startWatchdog(gen);
      ws.onopen = () => {
        if (gen !== this.gen) return;
        const reopened = this.wsOpenedOnce;
        this.wsOpenedOnce = true;
        this.wsAttempts = 0;
        this.lastWsMsg = Date.now();
        this._status('trades', 'live');
        if (reopened && this.backfillDone) this._fillGap(gen);
      };
      ws.onmessage = (ev) => {
        if (gen !== this.gen) return;
        this.lastWsMsg = Date.now();
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (!m || m.e !== 'aggTrade') return;
        const tr = { a: m.a, p: +m.p, q: +m.q, T: m.T, buy: !m.m };
        if (!this.backfillDone) { this.wsBuffer.push(tr); return; }
        if (tr.a <= this.lastAggId) return;
        this.lastAggId = tr.a;
        this._applyTrade(tr, true);
      };
      ws.onerror = () => { if (gen === this.gen) this._status('trades', 'error'); };
      ws.onclose = () => {
        if (gen !== this.gen) return;
        this._status('trades', 'connecting');
        this.wsAttempts = (this.wsAttempts || 0) + 1;
        const delay = Math.min(15000, 500 * Math.pow(2, this.wsAttempts));
        this.wsRetryTimer = setTimeout(() => { if (gen === this.gen) this._openTradeStream(gen); }, delay);
      };
    }

    /** Тишина в потоке сделок (спящая вкладка, тихий обрыв) — закрываем сокет, onclose переподключит. */
    _startWatchdog(gen) {
      if (this.wdTimer) clearInterval(this.wdTimer);
      this.wdTimer = setInterval(() => {
        if (gen !== this.gen) { clearInterval(this.wdTimer); return; }
        if (Date.now() - this.lastWsMsg > WS_SILENCE_MS && this.ws) {
          this.lastWsMsg = Date.now();
          try { this.ws.close(); } catch (e) { /* уже закрыт */ }
          // если close не сработал (сокет «завис» в CONNECTING), открываем заново принудительно
          setTimeout(() => {
            if (gen === this.gen && this.ws && this.ws.readyState !== 1) {
              this.ws.onclose = null;
              this._openTradeStream(gen);
            }
          }, 3000);
        }
      }, 5000);
    }

    /** Вернулись на вкладку или проснулся ПК: проверяем соединения и опрос стакана. */
    wake() {
      if (!this.ready) return;
      const stale = Date.now() - this.lastWsMsg > 15000;
      if (stale && this.ws && this.ws.readyState === 1) { try { this.ws.close(); } catch (e) { /* ок */ } }
      this._pollDepth(this.gen);
    }

    /** После переподключения докачиваем сделки, пропущенные за время обрыва. */
    async _fillGap(gen) {
      const m = MARKETS[this.market];
      this.backfillDone = false;           // живые сделки временно копятся в буфере
      this.wsBuffer = [];
      try {
        for (let page = 0; page < 8; page++) {
          const rows = await fetchJSON(m.rest + '/aggTrades?symbol=' + this.symbol + '&fromId=' + (this.lastAggId + 1) + '&limit=1000', 2);
          if (gen !== this.gen) return;
          if (!rows.length) break;
          for (const t of rows) {
            if (t.a <= this.lastAggId) continue;
            this.lastAggId = t.a;
            this._applyTrade({ a: t.a, p: +t.p, q: +t.q, T: t.T, buy: !t.m }, false);
          }
          if (rows.length < 1000) break;
        }
      } catch (e) {
        console.warn('[engine] не удалось докачать пропущенные сделки:', e);
      }
      if (gen !== this.gen) return;
      const buf = this.wsBuffer;
      this.wsBuffer = [];
      this.backfillDone = true;
      buf.sort((x, y) => x.a - y.a);
      for (const tr of buf) {
        if (tr.a <= this.lastAggId) continue;
        this.lastAggId = tr.a;
        this._applyTrade(tr, false);
      }
      this._recomputeAll();
      this.emit('newCandle', this);
    }

    async _backfillTrades(gen) {
      const m = MARKETS[this.market];
      const base = m.rest + '/aggTrades?symbol=' + this.symbol + '&limit=1000';
      let trades = [];
      try {
        const latest = await fetchJSON(base);
        if (gen !== this.gen) return;
        if (latest.length) {
          trades = latest;
          const firstId = latest[0].a;
          const ids = [];
          for (let k = 1; k < BACKFILL_PAGES; k++) {
            const from = firstId - 1000 * k;
            if (from < 0) break;
            ids.push(from);
          }
          for (let i = 0; i < ids.length; i += 4) {
            const batch = ids.slice(i, i + 4);
            const res = await Promise.all(batch.map((from) => fetchJSON(base + '&fromId=' + from).catch(() => [])));
            if (gen !== this.gen) return;
            for (const r of res) trades = trades.concat(r);
          }
        }
      } catch (e) {
        console.warn('[engine] aggTrades недоступны:', e);
      }
      if (gen !== this.gen) return;

      const seen = new Set();
      const list = [];
      for (const t of trades) {
        if (seen.has(t.a)) continue;
        seen.add(t.a);
        list.push({ a: t.a, p: +t.p, q: +t.q, T: t.T, buy: !t.m });
      }
      list.sort((x, y) => x.a - y.a);

      // проверяем непрерывность id — покрытие считаем только от непрерывного хвоста
      let startIdx = 0;
      for (let i = list.length - 1; i > 0; i--) {
        if (list[i].a - list[i - 1].a !== 1) { startIdx = i; break; }
      }
      const cont = list.slice(startIdx);
      if (cont.length) {
        this.coverageStart = cont[0].T;
        for (const c of this.candles) {
          if (c.t >= this.coverageStart) {
            c.covered = true;
            c.clusters = new Map();
            c.v = 0; c.q = 0; c.buy = 0; c.n = 0;
            c.ver++;
          }
        }
        for (const tr of cont) this._applyTrade(tr, false);
        this.lastAggId = cont[cont.length - 1].a;
      }

      // добавляем буфер живого потока
      this.backfillDone = true;
      const buf = this.wsBuffer;
      this.wsBuffer = [];
      buf.sort((x, y) => x.a - y.a);
      for (const tr of buf) {
        if (tr.a <= this.lastAggId) continue;
        if (!cont.length && this.coverageStart === Infinity) {
          // ленты не было: покрытие начинается со следующей свечи после первого живого трейда
          this.coverageStart = Math.floor(tr.T / this.tfMs) * this.tfMs + this.tfMs;
        }
        this.lastAggId = tr.a;
        this._applyTrade(tr, false);
      }
      if (this.coverageStart === Infinity) {
        const last = this.candles[this.candles.length - 1];
        this.coverageStart = last ? last.t + this.tfMs : Date.now();
      }
    }

    _applyTrade(tr, live) {
      const tfMs = this.tfMs;
      const t = Math.floor(tr.T / tfMs) * tfMs;
      let last = this.candles[this.candles.length - 1];
      if (!last) return;
      if (t < last.t) {
        // поздний трейд в уже закрытую свечу
        const idx = lowerBound(this.candles, t, 't');
        const c = this.candles[idx];
        if (c && c.t === t) this._addTradeToCandle(c, tr);
        return;
      }
      let newCandle = false;
      while (t > last.t) {
        const nt = last.t + tfMs;
        const c = this._mkCandle({ t: nt, o: last.c, h: last.c, l: last.c, c: last.c, v: 0, q: 0, n: 0, buy: 0 });
        c.covered = nt >= this.coverageStart || this.backfillDone;
        if (c.covered) c.clusters = new Map();
        c.model = last.model;
        c.book = last.book;
        if (nt === t) { c.o = tr.p; c.h = tr.p; c.l = tr.p; c.c = tr.p; }
        this._onCandleClosed(last);
        this.candles.push(c);
        last = c;
        newCandle = true;
      }
      if (this.candles.length > MAX_CANDLES) this.candles.splice(0, this.candles.length - MAX_CANDLES);
      this._addTradeToCandle(last, tr);
      this.lastPrice = tr.p;
      if (live) {
        if (newCandle) {
          this._extendModelForNewCandle();
          this._recomputeAll();
          this.emit('newCandle', this);
        }
        this.emit('tick', tr);
      }
    }

    _addTradeToCandle(c, tr) {
      if (tr.p > c.h) c.h = tr.p;
      if (tr.p < c.l) c.l = tr.p;
      c.c = tr.p;
      c.v += tr.q;
      c.q += tr.q * tr.p;
      c.n += 1;
      if (tr.buy) c.buy += tr.q;
      this.version = (this.version || 0) + 1;
      if (c.covered) {
        if (!c.clusters) c.clusters = new Map();
        const key = Math.round(tr.p / this.tick);
        let cl = c.clusters.get(key);
        if (!cl) { cl = { b: 0, s: 0, nb: 0, ns: 0 }; c.clusters.set(key, cl); }
        if (tr.buy) { cl.b += tr.q; cl.nb += 1; } else { cl.s += tr.q; cl.ns += 1; }
      }
      c.ver++;
    }

    _extendModelForNewCandle() {
      // модель пересчитывается по всей серии (дёшево: ≤ 3000 × 400 корзин)
      reconstructSeries(this.candles, this.tfMs);
      if (!this.baselineShared && this.baseline.length && TF_MS[this.tfB] < this.tfMs) {
        const g = this.gen;
        this._fetchBaseline(g).then(() => {
          if (g !== this.gen) return;
          this._recomputeAll();
          this.emit('book', this);
        }).catch(() => {});
      } else if (!this.baselineShared && this.baseline.length) {
        const tfBMs = TF_MS[this.tfB];
        const lastB = this.baseline[this.baseline.length - 1];
        const lastC = this.candles[this.candles.length - 1];
        const tB = Math.floor(lastC.t / tfBMs) * tfBMs;
        // агрегируем основные свечи в незакрытые свечи базового ТФ
        let bc = lastB;
        if (tB > lastB.t) {
          bc = { t: tB, o: lastC.o, h: lastC.h, l: lastC.l, c: lastC.c, v: 0, q: 0, n: 0, buy: 0 };
          this.baseline.push(bc);
        }
        const members = this.candles.filter((c) => c.t >= bc.t && c.t < bc.t + tfBMs);
        if (members.length) {
          bc.o = members[0].o;
          bc.c = members[members.length - 1].c;
          bc.h = Math.max(...members.map((c) => c.h));
          bc.l = Math.min(...members.map((c) => c.l));
          bc.v = members.reduce((s, c) => s + c.v, 0);
          bc.q = members.reduce((s, c) => s + c.q, 0);
          bc.n = members.reduce((s, c) => s + c.n, 0);
          bc.buy = members.reduce((s, c) => s + c.buy, 0);
        }
        reconstructSeries(this.baseline, tfBMs);
      }
    }

    _onCandleClosed(c) {
      if (!this.db || !(c.realFrac > 0)) return;
      const rec = { t: c.t, bid: Float32Array.from(c.z.subarray(0, NB)), ask: Float32Array.from(c.z.subarray(NB)), real: c.realFrac };
      this.db.putZScores(this.market, this.symbol, this.tf, this.base, [rec]).catch(() => {});
    }

    // --------------------------------------------------------- depth
    async _pollDepth(gen) {
      if (this.depthBusy && Date.now() - this.depthBusy < 20000) return;   // предыдущий опрос ещё идёт
      this.depthBusy = Date.now();
      try {
        await this._pollDepthInner(gen);
      } finally {
        this.depthBusy = 0;
      }
    }

    async _pollDepthInner(gen) {
      const m = MARKETS[this.market];
      let depth;
      try {
        depth = await fetchJSON(m.rest + '/depth?symbol=' + this.symbol + '&limit=' + m.depthLimit, 2);
      } catch (e) {
        if (gen === this.gen) this._status('depth', 'error');
        return;
      }
      if (gen !== this.gen) return;
      const g = depthToGrid(depth);
      if (!g) return;
      this._status('depth', 'live');
      this.lastBook = g;
      const now = Date.now();
      const minute = Math.floor(now / MINUTE) * MINUTE;
      if (this.acc && this.acc.t !== minute) this._flushMinute();
      if (!this.acc) {
        this.acc = { t: minute, n: 0, mid: 0, bid: new Float64Array(BUCKETS), ask: new Float64Array(BUCKETS), bidMiss: new Uint8Array(BUCKETS), askMiss: new Uint8Array(BUCKETS) };
      }
      const a = this.acc;
      a.n++;
      a.mid += g.mid;
      for (let k = 0; k < BUCKETS; k++) {
        if (g.bid[k] < 0) a.bidMiss[k] = 1; else a.bid[k] += g.bid[k];
        if (g.ask[k] < 0) a.askMiss[k] = 1; else a.ask[k] += g.ask[k];
      }
      if (this.ready) {
        this._recomputeAll();
        this.emit('book', this);
      }
    }

    _accRecord() {
      const a = this.acc;
      if (!a || !a.n) return null;
      const bid = new Float32Array(BUCKETS);
      const ask = new Float32Array(BUCKETS);
      for (let k = 0; k < BUCKETS; k++) {
        bid[k] = a.bidMiss[k] ? -1 : a.bid[k] / a.n;
        ask[k] = a.askMiss[k] ? -1 : a.ask[k] / a.n;
      }
      return { t: a.t, mid: a.mid / a.n, n: a.n, bid, ask };
    }

    _flushMinute() {
      const rec = this._accRecord();
      this.acc = null;
      if (!rec) return;
      const i = lowerBound(this.realMinutes, rec.t, 't');
      if (this.realMinutes[i] && this.realMinutes[i].t === rec.t) this.realMinutes[i] = rec;
      else this.realMinutes.splice(i, 0, rec);
      if (this.db) {
        this.db.putBookMinute({ market: this.market, symbol: this.symbol, t: rec.t, mid: rec.mid, n: rec.n, bid: rec.bid, ask: rec.ask })
          .then(() => this.emit('stored', rec))
          .catch((e) => console.warn('[engine] запись в IndexedDB не удалась:', e));
      }
    }

    /** Реальные минуты в интервале [t0, t1) (включая текущий накопитель). */
    _realIn(t0, t1) {
      const out = [];
      let i = lowerBound(this.realMinutes, t0, 't');
      while (i < this.realMinutes.length && this.realMinutes[i].t < t1) { out.push(this.realMinutes[i]); i++; }
      if (this.acc && this.acc.t >= t0 && this.acc.t < t1) {
        const r = this._accRecord();
        if (r) out.push(r);
      }
      return out;
    }

    static _avgGrids(list) {
      const bid = new Float32Array(BUCKETS);
      const ask = new Float32Array(BUCKETS);
      const nb = new Uint16Array(BUCKETS);
      const na = new Uint16Array(BUCKETS);
      for (const r of list) {
        for (let k = 0; k < BUCKETS; k++) {
          if (r.bid[k] >= 0) { bid[k] += r.bid[k]; nb[k]++; }
          if (r.ask[k] >= 0) { ask[k] += r.ask[k]; na[k]++; }
        }
      }
      for (let k = 0; k < BUCKETS; k++) {
        bid[k] = nb[k] ? bid[k] / nb[k] : -1;
        ask[k] = na[k] ? ask[k] / na[k] : -1;
      }
      return { bid, ask };
    }

    _recomputeRealBooks() {
      const tfMs = this.tfMs;
      const minutesPerCandle = tfMs / MINUTE;
      for (const c of this.candles) {
        const list = this._realIn(c.t, c.t + tfMs);
        if (list.length) {
          c.real = DataEngine._avgGrids(list);
          c.realFrac = Math.min(1, list.length / minutesPerCandle);
        } else {
          c.real = null;
          c.realFrac = 0;
        }
      }
      if (!this.baselineShared) {
        const tfBMs = TF_MS[this.tfB];
        for (const b of this.baseline) {
          const list = this._realIn(b.t, b.t + tfBMs);
          b.real = list.length ? DataEngine._avgGrids(list) : null;
        }
      }
    }

    // ------------------------------------------------------- compute
    _computeCalibration() {
      const diffs = [];
      for (let j = 0; j < 2 * NB; j++) diffs.push([]);
      const tmpR = new Float64Array(2 * NB);
      const tmpM = new Float64Array(2 * NB);
      for (const c of this.candles) {
        if (!c.real || !c.model) continue;
        bandSums(c.real.bid, tmpR, 0); bandSums(c.real.ask, tmpR, NB);
        bandSums(c.model.bid, tmpM, 0); bandSums(c.model.ask, tmpM, NB);
        for (let j = 0; j < 2 * NB; j++) {
          if (tmpR[j] > 0 && tmpM[j] > 0) diffs[j].push(Math.log(tmpR[j]) - Math.log(tmpM[j]));
        }
      }
      let anyReal = false;
      for (let j = 0; j < 2 * NB; j++) {
        if (diffs[j].length) { this.cal[j] = median(diffs[j]); anyReal = true; }
      }
      // полосы вне охвата depth: переносим калибровку ближайшей известной полосы
      for (let side = 0; side < 2; side++) {
        let lastKnown = null;
        for (let b = 0; b < NB; b++) {
          const j = side * NB + b;
          if (diffs[j].length) lastKnown = this.cal[j];
          else if (lastKnown !== null) this.cal[j] = lastKnown;
        }
      }
      this.calibrated = anyReal;
      this.calF = new Float64Array(2 * NB);
      for (let j = 0; j < 2 * NB; j++) this.calF[j] = Math.exp(this.cal[j]);
    }

    /** Итоговая сетка свечи: реальные корзины + калиброванная модель там, где реальных нет. */
    _finalGrid(c) {
      const bid = new Float32Array(BUCKETS);
      const ask = new Float32Array(BUCKETS);
      const m = c.model;
      const r = c.real;
      const fB = this.calF;
      for (let k = 0; k < BUCKETS; k++) {
        const fb = fB[BUCKET_BAND[k]];
        const fa = fB[NB + BUCKET_BAND[k]];
        bid[k] = r && r.bid[k] >= 0 ? r.bid[k] : (m ? m.bid[k] * fb : 0);
        ask[k] = r && r.ask[k] >= 0 ? r.ask[k] : (m ? m.ask[k] * fa : 0);
      }
      return { bid, ask };
    }

    _recomputeAll() {
      if (!this.candles.length) return;
      this._recomputeRealBooks();
      this._computeCalibration();

      // 1) итоговые сетки, полосы (log), дельты и доминирование для основных свечей
      for (const c of this.candles) {
        c.book = this._finalGrid(c);
        bandSums(c.book.bid, c.bands, 0);
        bandSums(c.book.ask, c.bands, NB);
        for (let j = 0; j < 2 * NB; j++) c.bands[j] = c.bands[j] > 0 ? Math.log(c.bands[j]) : NaN;
        for (let i = 0; i < DELTA_RANGES.length; i++) {
          c.dBid[i] = rangeSum(c.book.bid, DELTA_RANGES[i]);
          c.dAsk[i] = rangeSum(c.book.ask, DELTA_RANGES[i]);
        }
        for (let i = 0; i < DOM_RANGES.length; i++) {
          c.dom[i] = dominance(rangeSum(c.book.bid, DOM_RANGES[i]), rangeSum(c.book.ask, DOM_RANGES[i]));
        }
        // префиксные суммы сетки: сумма любой полосы 0..X % за O(1)
        if (!c.cb) { c.cb = new Float64Array(BUCKETS + 1); c.ca = new Float64Array(BUCKETS + 1); }
        c.reachB = BUCKETS;
        c.reachA = BUCKETS;
        for (let k = 0; k < BUCKETS; k++) {
          const vb = c.book.bid[k];
          const va = c.book.ask[k];
          if (vb < 0 && c.reachB === BUCKETS) c.reachB = k;
          if (va < 0 && c.reachA === BUCKETS) c.reachA = k;
          c.cb[k + 1] = c.cb[k] + (vb > 0 ? vb : 0);
          c.ca[k + 1] = c.ca[k] + (va > 0 ? va : 0);
        }
        // Imbalance по 12 полосам: (бид − аск) / (бид + аск), %
        if (!c.imb) c.imb = new Float64Array(IMB_BANDS);
        for (let b = 0; b < IMB_BANDS; b++) {
          const k0 = BAND_K[b][0];
          const k1 = BAND_K[b][1];
          if (k1 > c.reachB || k1 > c.reachA) { c.imb[b] = NaN; continue; }
          const sb = c.cb[k1] - c.cb[k0];
          const sa = c.ca[k1] - c.ca[k0];
          c.imb[b] = sb + sa > 0 ? (sb - sa) / (sb + sa) * 100 : NaN;
        }
      }
      this.version = (this.version || 0) + 1;

      // 2) базовый ряд для статистики
      let baseT;
      let baseVals;
      if (this.baselineShared) {
        baseT = this.candles.map((c) => c.t);
        baseVals = smoothBands(this.candles.map((c) => c.bands), this.tfMs);
        for (let i = 0; i < this.candles.length; i++) this.candles[i].bandsS = baseVals[i];
      } else {
        baseT = this.baseline.map((b) => b.t);
        baseVals = this.baseline.map((b) => {
          const g = this._finalGrid(b);
          const arr = new Float64Array(2 * NB);
          bandSums(g.bid, arr, 0);
          bandSums(g.ask, arr, NB);
          for (let j = 0; j < 2 * NB; j++) arr[j] = arr[j] > 0 ? Math.log(arr[j]) : NaN;
          return arr;
        });
        baseVals = smoothBands(baseVals, TF_MS[this.tfB]);
        const own = smoothBands(this.candles.map((c) => c.bands), this.tfMs);
        for (let i = 0; i < this.candles.length; i++) this.candles[i].bandsS = own[i];
      }
      const n = baseT.length;
      const S1 = [];
      const S2 = [];
      const CN = [];
      for (let j = 0; j < 2 * NB; j++) {
        const s1 = new Float64Array(n + 1);
        const s2 = new Float64Array(n + 1);
        const cn = new Int32Array(n + 1);
        for (let i = 0; i < n; i++) {
          const v = baseVals[i][j];
          const ok = isFinite(v);
          s1[i + 1] = s1[i] + (ok ? v : 0);
          s2[i + 1] = s2[i] + (ok ? v * v : 0);
          cn[i + 1] = cn[i] + (ok ? 1 : 0);
        }
        S1.push(s1); S2.push(s2); CN.push(cn);
      }

      // 3) Z-Score по каждой свече
      const baseMs = this._baseMs();
      let realCount = 0;
      let storedUsed = 0;
      for (const c of this.candles) {
        const endT = c.t + this.tfMs;
        // база — окно ДО свечи (сама свеча в статистику не входит, иначе Z зажимается)
        const j0 = lowerBound(baseT, c.t - baseMs);
        const j1 = lowerBound(baseT, c.t);
        const stored = !c.real && this.storedZ.get(c.t);
        if (stored) {
          for (let b = 0; b < NB; b++) { c.z[b] = stored.bid[b]; c.z[NB + b] = stored.ask[b]; }
          c.zStored = true;
          storedUsed++;
          continue;
        }
        c.zStored = false;
        if (c.real) realCount++;
        // значение свечи — среднее по точкам того же базового ряда внутри свечи:
        // иначе модель крупного ТФ и модель базы дают сдвиг масштаба и Z «уезжает»
        let xs = c.bandsS || c.bands;
        if (!this.baselineShared && TF_MS[this.tfB] < this.tfMs) {
          const a0 = lowerBound(baseT, c.t);
          const a1 = lowerBound(baseT, c.t + this.tfMs);
          if (a1 > a0) {
            xs = new Float64Array(2 * NB);
            for (let j = 0; j < 2 * NB; j++) {
              let sum = 0;
              let m = 0;
              for (let q = a0; q < a1; q++) { const v = baseVals[q][j]; if (isFinite(v)) { sum += v; m++; } }
              xs[j] = m ? sum / m : NaN;
            }
          }
        }
        for (let j = 0; j < 2 * NB; j++) {
          const cnt = CN[j][j1] - CN[j][j0];
          const x = xs[j];
          if (cnt < 8 || !isFinite(x)) { c.z[j] = NaN; continue; }
          const mean = (S1[j][j1] - S1[j][j0]) / cnt;
          const variance = Math.max(0, (S2[j][j1] - S2[j][j0]) / cnt - mean * mean);
          const sd = Math.max(Math.sqrt(variance), 0.03);
          let z = (x - mean) / sd;
          if (z > 6) z = 6; else if (z < -6) z = -6;
          c.z[j] = z;
        }
      }
      const baseFirst = baseT[0] || 0;
      const lastT = this.candles[this.candles.length - 1].t + this.tfMs;
      this.zInfo = {
        base: this.base,
        baseLabel: BASE_LABEL[this.base],
        tfB: this.tfB,
        baseCoverage: Math.min(1, (lastT - baseFirst) / (baseMs + this.tfMs)),
        realCandles: realCount,
        storedCandles: storedUsed,
        realMinutes: this.realMinutes.length + (this.acc ? 1 : 0),
        calibrated: !!this.calibrated
      };
    }
  }

  /** Сумма стакана свечи от mid до pct % (side: 'bid' | 'ask'), NaN — вне охвата depth. */
  function candleRange(c, side, pct) {
    if (!c || !c.cb) return NaN;
    const k = Math.min(BUCKETS, Math.round(pct / BUCKET_PCT));
    if (side === 'bid') return k > c.reachB ? NaN : c.cb[k];
    return k > c.reachA ? NaN : c.ca[k];
  }

  /** Перекос стакана в полосе 0..pct %: (бид − аск) / (бид + аск), %. */
  function candleImb(c, pct) {
    const b = candleRange(c, 'bid', pct);
    const a = candleRange(c, 'ask', pct);
    if (!(b + a > 0)) return NaN;
    return (b - a) / (b + a) * 100;
  }

  // ===================================================================
  //                          Тикеры (правая панель)
  // ===================================================================
  const VENUES = {
    futures: { id: 'futures', label: 'Binance фьючерсы', quote: 'USDT', chart: true },
    spot: { id: 'spot', label: 'Binance спот', quote: 'USDT', chart: true },
    coinbase: { id: 'coinbase', label: 'Coinbase спот', quote: 'USDT', chart: false },
    deribit: { id: 'deribit', label: 'Deribit спот', quote: 'USDT', chart: false }
  };
  const VENUE_LIST = ['futures', 'spot', 'coinbase', 'deribit'];
  const COINBASE_PRODUCTS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT', 'DOGE-USDT', 'ADA-USDT', 'LTC-USDT', 'LINK-USDT'];
  const DERIBIT_INSTRUMENTS = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'XRP_USDT'];

  /** Базовый актив символа любой площадки (BTCUSDT, BTC-USDT, BTC_USDT → BTC). */
  function assetOf(symbol) {
    return symbol.replace(/[-_]/g, '').replace(/USDT$/, '');
  }

  class TickerFeed extends Emitter {
    constructor() {
      super();
      this.data = { futures: new Map(), spot: new Map(), coinbase: new Map(), deribit: new Map() };
      this.state = { futures: 'connecting', spot: 'connecting', coinbase: 'connecting', deribit: 'connecting' };
      this.updatedAt = { futures: 0, spot: 0, coinbase: 0, deribit: 0 };
      this._emitPending = false;
    }

    async start() {
      this._openCoinbase();
      this._openDeribit();
      await Promise.all(['futures', 'spot'].map((m) => this._loadBinance(m)));
      this._emit();
    }

    _put(venue, rec) {
      const map = this.data[venue];
      const prev = map.get(rec.symbol);
      rec.venue = venue;
      rec.market = venue;
      rec.asset = assetOf(rec.symbol);
      rec.dir = prev ? (rec.price > prev.price ? 1 : rec.price < prev.price ? -1 : 0) : 0;
      map.set(rec.symbol, rec);
      this.updatedAt[venue] = Date.now();
    }

    async _loadBinance(market) {
      try {
        const rows = await fetchJSON(MARKETS[market].rest + '/ticker/24hr');
        for (const r of rows) {
          if (!/^[A-Z0-9]+USDT$/.test(r.symbol)) continue;
          const price = +r.lastPrice;
          if (!(price > 0)) continue;
          this._put(market, { symbol: r.symbol, price, open: +r.openPrice, change: +r.priceChangePercent, volume: +r.quoteVolume });
        }
      } catch (e) {
        console.warn('[tickers] REST', market, e);
      }
      this._openBinanceWs(market);
    }

    _openBinanceWs(market) {
      let ws;
      try { ws = new WebSocket(MARKETS[market].ws + '/!miniTicker@arr'); } catch (e) { this._setState(market, 'error'); return; }
      ws.onopen = () => this._setState(market, 'live');
      ws.onmessage = (ev) => {
        let arr;
        try { arr = JSON.parse(ev.data); } catch (e) { return; }
        if (!Array.isArray(arr)) return;
        for (const t of arr) {
          if (!/^[A-Z0-9]+USDT$/.test(t.s)) continue;
          const price = +t.c;
          const open = +t.o;
          this._put(market, { symbol: t.s, price, open, change: open > 0 ? (price / open - 1) * 100 : 0, volume: +t.q });
        }
        this._emit();
      };
      ws.onerror = () => this._setState(market, 'error');
      ws.onclose = () => { this._setState(market, 'connecting'); setTimeout(() => this._openBinanceWs(market), 3000); };
    }

    _openCoinbase() {
      let ws;
      try { ws = new WebSocket('wss://ws-feed.exchange.coinbase.com'); } catch (e) { this._setState('coinbase', 'error'); return; }
      ws.onopen = () => {
        this._setState('coinbase', 'live');
        ws.send(JSON.stringify({ type: 'subscribe', product_ids: COINBASE_PRODUCTS, channels: ['ticker'] }));
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (!m || m.type !== 'ticker' || !m.product_id) return;
        const price = +m.price;
        const open = +m.open_24h;
        this._put('coinbase', { symbol: m.product_id, price, open, change: open > 0 ? (price / open - 1) * 100 : 0, volume: (+m.volume_24h || 0) * price });
        this._emit();
      };
      ws.onerror = () => this._setState('coinbase', 'error');
      ws.onclose = () => { this._setState('coinbase', 'connecting'); setTimeout(() => this._openCoinbase(), 5000); };
    }

    _openDeribit() {
      let ws;
      try { ws = new WebSocket('wss://www.deribit.com/ws/api/v2'); } catch (e) { this._setState('deribit', 'error'); return; }
      let hb = null;
      ws.onopen = () => {
        this._setState('deribit', 'live');
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: DERIBIT_INSTRUMENTS.map((i) => 'ticker.' + i + '.agg2') } }));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'public/set_heartbeat', params: { interval: 30 } }));
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.method === 'heartbeat') {
          if (m.params && m.params.type === 'test_request') ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'public/test', params: {} }));
          return;
        }
        if (m.method !== 'subscription' || !m.params || !m.params.data) return;
        const d = m.params.data;
        const price = +d.last_price;
        if (!(price > 0)) return;
        const st = d.stats || {};
        const change = isFinite(+st.price_change) ? +st.price_change : 0;
        this._put('deribit', { symbol: d.instrument_name, price, open: price / (1 + change / 100), change, volume: +st.volume_usd || (+st.volume || 0) * price, ts: d.timestamp });
        this._emit();
      };
      ws.onerror = () => this._setState('deribit', 'error');
      ws.onclose = () => {
        if (hb) clearInterval(hb);
        this._setState('deribit', 'connecting');
        setTimeout(() => this._openDeribit(), 5000);
      };
    }

    _setState(venue, s) {
      this.state[venue] = s;
      this.emit('status', { venue, state: s });
    }

    _emit() {
      if (this._emitPending) return;
      this._emitPending = true;
      setTimeout(() => { this._emitPending = false; this.emit('update', this.data); }, 300);
    }

    get(venue, symbol) {
      const m = this.data[venue];
      return m ? m.get(symbol) : undefined;
    }
  }

  global.CTData = {
    DataEngine,
    TickerFeed,
    TF_MS, TF_LIST, TF_LABEL,
    MARKETS,
    VENUES, VENUE_LIST, assetOf,
    BUCKET_PCT, BUCKETS,
    Z_BANDS, NB, IMB_BANDS,
    DELTA_RANGES, DOM_RANGES,
    BASES, BASE_LIST, BASE_LABEL,
    candleRange, candleImb,
    decimalsOf,
    getSymbolInfo
  };
})(window);
