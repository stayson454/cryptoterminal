/* ==========================================================================
   indicators.js — реестр индикаторов терминала.

   На графике:   Профиль по свечам (подпанель), Z-score стакана (фон графика)
   Стакан:       Дельта стакана, Imbalance Heatmap, Imbalance Dynamics,
                 Bid Dominance, Z-score полос
   Поток:        DMI, SMF, CVD
   Классика:     RSI, MACD

   Каждое определение:
     kind        'pane' — подпанель под графиком, 'overlay' — слой графика
     height      высота подпанели, px
     defaults    параметры по умолчанию
     settings    схема настроек для окна «Индикаторы»
     title()     заголовок (легенда и список)
     series()    расчёт по всем свечам (кэшируется по версии данных)
     range()     диапазон шкалы для видимых свечей
     draw()      отрисовка подпанели
     legend()    HTML значений в легенде для свечи под курсором
   ========================================================================== */
(function (global) {
  'use strict';

  const D = global.CTData;
  const fmt = () => global.CTFormat;

  const CATEGORIES = [
    { id: 'chart', label: 'График', note: 'на графике' },
    { id: 'book', label: 'Стакан', note: 'среднее за свечу · depth Binance' },
    { id: 'flow', label: 'Поток', note: 'по выбранной паре · сделки Binance' },
    { id: 'classic', label: 'Классика', note: 'в браузере' }
  ];

  const MAX_PANES = 6;

  // ------------------------------------------------------------- helpers
  function ema(src, n) {
    const out = new Float64Array(src.length);
    const a = 2 / (n + 1);
    let prev = NaN;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (!isFinite(v)) { out[i] = prev; continue; }
      prev = isFinite(prev) ? prev + a * (v - prev) : v;
      out[i] = prev;
    }
    return out;
  }

  function sma(src, n) {
    const out = new Float64Array(src.length);
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < src.length; i++) {
      sum += src[i]; cnt++;
      if (cnt > n) { sum -= src[i - n]; cnt--; }
      out[i] = sum / cnt;
    }
    return out;
  }

  function minmax(arrs, i0, i1, init) {
    let mn = init ? init[0] : Infinity;
    let mx = init ? init[1] : -Infinity;
    for (const a of arrs) {
      for (let i = i0; i <= i1; i++) {
        const v = a[i];
        if (!isFinite(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    if (!isFinite(mn)) return [0, 1];
    if (mn === mx) { mn -= 1; mx += 1; }
    const pad = (mx - mn) * 0.08;
    return [mn - pad, mx + pad];
  }

  function signedFmt(v, f) { return fmt().fmtSigned(v, f); }
  function short(v) { return fmt().fmtShort(v); }
  function num(v, d) { return fmt().fmtNum(v, d); }
  function pctLabel(p) { return num(p, p % 1 ? (p * 100 % 10 ? 2 : 1) : 0) + ' %'; }
  function cls(v) { return v >= 0 ? 'ct-up' : 'ct-down'; }
  function val(v, f, colored) {
    const txt = isFinite(v) ? f(v) : '—';
    return '<b class="ct-pl-v' + (colored && isFinite(v) ? ' ' + cls(v) : '') + '">' + txt + '</b>';
  }
  function dot(color) { return '<i class="ct-pl-dot" style="background:' + color + '"></i>'; }
  function dash(color, dotted) { return '<i class="ct-pl-dash' + (dotted ? ' dotted' : '') + '" style="color:' + color + '"></i>'; }

  function unitLabel(r, units) { return units === 'coins' ? r.opt.baseAsset : '$'; }
  function toUnits(v, c, units) { return units === 'coins' && c ? v / c.c : v; }

  function windowMs(w) {
    return { '1d': 864e5, '3d': 3 * 864e5, '7d': 7 * 864e5, '14d': 14 * 864e5 }[w] || 864e5;
  }

  // --------------------------------------------------------- definitions
  const DEFS = {
    // ============================================================ chart
    profile: {
      cat: 'chart', kind: 'pane', height: 96,
      name: 'Профиль по свечам',
      desc: 'объём, дельта и сделки по свечам',
      defaults: { metric: 'delta', cumulative: false },
      settings: [
        { key: 'metric', label: 'Метрика', type: 'seg', options: [['volume', 'Объём'], ['delta', 'Дельта объёма'], ['trades', 'Сделки'], ['tradesDelta', 'Дельта сделок']] },
        { key: 'cumulative', label: 'Накопительно', type: 'seg', options: [[false, 'Нет'], [true, 'Да']] }
      ],
      labels: { volume: 'Объём', delta: 'Дельта объёма', trades: 'Сделки', tradesDelta: 'Дельта сделок' },
      title(inst, r) {
        const m = inst.params.metric;
        const unit = m === 'trades' || m === 'tradesDelta' ? '' : ', ' + r.opt.baseAsset;
        return this.labels[m] + unit;
      },
      listTitle() { return 'Профиль по свечам'; },
      controls(inst) {
        const m = inst.params.metric;
        let h = '';
        for (const [k, l] of [['volume', 'Объём'], ['delta', 'Дельта объёма'], ['trades', 'Сделки'], ['tradesDelta', 'Дельта сделок']]) {
          h += '<button type="button" class="ct-seg-sm" data-act="set" data-key="metric" data-val="' + k + '" aria-pressed="' + (m === k) + '">' + l + '</button>';
        }
        h += '<button type="button" class="ct-seg-sm" data-act="set" data-key="cumulative" data-val="' + (!inst.params.cumulative) + '" aria-pressed="' + !!inst.params.cumulative + '" title="Нарастающий итог по свечам слева направо в видимом диапазоне"><span class="ct-toggle-mark" data-on="' + !!inst.params.cumulative + '"></span>Накопительно</button>';
        return h;
      },
      signed(inst) { return inst.params.metric === 'delta' || inst.params.metric === 'tradesDelta'; },
      series(r, inst) {
        const cs = r.candles();
        const out = new Float64Array(cs.length);
        const m = inst.params.metric;
        for (let i = 0; i < cs.length; i++) {
          const c = cs[i];
          if (m === 'volume') out[i] = c.v;
          else if (m === 'delta') out[i] = 2 * c.buy - c.v;
          else if (m === 'trades') out[i] = c.n;
          else out[i] = r.tradesDelta(c);
        }
        return { v: out };
      },
      visible(s, inst, i0, i1) {
        if (!inst.params.cumulative) return s.v;
        const out = new Float64Array(s.v.length).fill(NaN);
        let acc = 0;
        for (let i = Math.max(0, i0); i <= i1 && i < s.v.length; i++) { acc += s.v[i]; out[i] = acc; }
        return out;
      },
      range(r, inst, s, i0, i1) {
        const v = this.visible(s, inst, i0, i1);
        const signed = this.signed(inst) || inst.params.cumulative;
        const [mn, mx] = minmax([v], i0, i1);
        return signed ? [Math.min(mn, 0), Math.max(mx, 0)] : [0, mx];
      },
      draw(r, ctx, pane, inst, s, i0, i1, yOf) {
        const v = this.visible(s, inst, i0, i1);
        if (inst.params.cumulative) {
          r.zero(ctx, yOf(0));
          r.line(ctx, i0, i1, v, yOf, r.rgba(r.C.accent, 0.95), 1.5);
          return;
        }
        const signed = this.signed(inst);
        if (signed) r.zero(ctx, yOf(0));
        const cs = r.candles();
        r.hist(ctx, i0, i1, v, yOf, yOf(0), (i, x) => {
          if (signed) return r.rgba(x >= 0 ? r.C.deltaPos : r.C.deltaNeg, 0.95);
          const c = cs[i];
          return r.rgba(c && c.c >= c.o ? r.C.up : r.C.down, 0.7);
        });
      },
      legend(r, inst, s, i) {
        const v = this.visible(s, inst, r.vis ? r.vis[0] : 0, i)[i];
        const signed = this.signed(inst) || inst.params.cumulative;
        return { right: val(v, signed ? (x) => signedFmt(x, short) : short, signed) };
      }
    },

    zscore: {
      cat: 'chart', kind: 'overlay', single: true,
      name: 'Z-score стакана',
      desc: 'аномалии полос стакана фоном графика',
      defaults: { units: 'usd', thresholdOn: false, threshold: 2, visible: true },
      settings: [
        { key: '__base', label: 'База', type: 'seg', options: D.BASE_LIST.map((b) => [b, D.BASE_LABEL[b]]) },
        { key: 'units', label: 'Единицы', type: 'seg', options: [['usd', '$'], ['coins', 'монеты']] },
        { key: 'thresholdOn', label: 'Порог', type: 'threshold' }
      ],
      title(inst, r) {
        return 'Z-score стакана · база ' + D.BASE_LABEL[r.engineBase()] + ', ' + unitLabel(r, inst.params.units) + ' · на графике';
      }
    },

    // ============================================================= book
    depth: {
      cat: 'book', kind: 'pane', height: 84,
      name: 'Дельта стакана',
      desc: 'бид, аск и их разница в полосе',
      defaults: { range: 1, units: 'usd' },
      settings: [
        { key: 'range', label: 'Полоса', type: 'seg', options: D.DELTA_RANGES.map((p) => [p, pctLabel(p)]) },
        { key: 'units', label: 'Единицы', type: 'seg', options: [['usd', '$'], ['coins', 'монеты']] }
      ],
      title(inst, r) { return 'Дельта стакана ' + pctLabel(inst.params.range) + ', ' + unitLabel(r, inst.params.units); },
      series(r, inst) {
        const cs = r.candles();
        const n = cs.length;
        const bid = new Float64Array(n);
        const ask = new Float64Array(n);
        const del = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const c = cs[i];
          bid[i] = toUnits(D.candleRange(c, 'bid', inst.params.range), c, inst.params.units);
          ask[i] = toUnits(D.candleRange(c, 'ask', inst.params.range), c, inst.params.units);
          del[i] = bid[i] - ask[i];
        }
        return { bid, ask, del };
      },
      range(r, inst, s, i0, i1) { return minmax([s.bid, s.ask, s.del], i0, i1); },
      draw(r, ctx, pane, inst, s, i0, i1, yOf) {
        if (pane.min < 0 && pane.max > 0) r.zero(ctx, yOf(0));
        r.line(ctx, i0, i1, s.ask, yOf, r.rgba(r.C.depthAsk, 0.85), 1.4);
        r.line(ctx, i0, i1, s.bid, yOf, r.rgba(r.C.depthBid, 0.75), 1.4);
        r.line(ctx, i0, i1, s.del, yOf, r.rgba(r.C.depthDelta, 0.95), 1.6);
      },
      legend(r, inst, s, i) {
        return {
          vals: dot('var(--color-depth-bid)') + 'бид ' + val(s.bid[i], short) +
            dot('var(--color-depth-ask)') + 'аск ' + val(s.ask[i], short) +
            dot('var(--color-depth-delta)') + 'дельта ' + val(s.del[i], (x) => signedFmt(x, short))
        };
      }
    },

    imbHeat: {
      cat: 'book', kind: 'pane', height: 110,
      name: 'Imbalance Heatmap',
      desc: 'бид и аск по 12 полосам: перекос в %',
      defaults: { scale: 50 },
      settings: [
        { key: 'scale', label: 'Насыщение', type: 'seg', options: [[25, '±25 %'], [50, '±50 %'], [75, '±75 %']] }
      ],
      title() { return 'Imbalance Heatmap, %'; },
      series() { return {}; },
      range() { return [0, D.IMB_BANDS]; },
      axisLabels() {
        return [[D.IMB_BANDS - 0.5, num(D.Z_BANDS[D.IMB_BANDS], 1) + ' %'], [D.IMB_BANDS / 2, num(D.Z_BANDS[D.IMB_BANDS / 2], 2).replace(/,?0+$/, '') + ' %'], [0.5, '0 %']];
      },
      draw(r, ctx, pane, inst, s, i0, i1, yOf) {
        const cs = r.candles();
        const sc = inst.params.scale;
        const rowH = (pane.bot - pane.top) / D.IMB_BANDS;
        for (let i = i0; i <= i1; i++) {
          const c = cs[i];
          if (!c || !c.imb) continue;
          const [x0, w] = r.colRect(i);
          for (let b = 0; b < D.IMB_BANDS; b++) {
            const v = c.imb[b];
            if (!isFinite(v)) continue;
            const k = Math.min(1, Math.abs(v) / sc);
            const col = v >= 0 ? r.C.zBidSurge : r.C.zAskSurge;
            ctx.fillStyle = r.rgba(col, 0.06 + 0.84 * Math.pow(k, 0.9));
            const y = pane.bot - (b + 1) * rowH;
            ctx.fillRect(x0, Math.floor(y), w, Math.ceil(rowH));
          }
        }
      },
      legend(r, inst, s, i) {
        const c = r.candles()[i];
        if (!c || !c.imb) return { vals: '' };
        const z = D.Z_BANDS;
        const pick = [0, 4, 7, 11];
        return {
          vals: pick.map((b) => '<span class="ct-pl-dim">' + num(z[b], 2).replace(/,?0+$/, '') + '–' + num(z[b + 1], 2).replace(/,?0+$/, '') + ' %</span> ' + val(c.imb[b], (x) => signedFmt(x, (y) => num(y, 0)), true)).join(' ')
        };
      }
    },

    imbDyn: {
      cat: 'book', kind: 'pane', height: 84,
      name: 'Imbalance Dynamics',
      desc: 'перекос бидов и асков по выбранным полосам, %',
      defaults: { set: 'near', smooth: 1 },
      sets: { near: [0.25, 0.5, 1], mid: [0.5, 1, 2.5], far: [1, 2.5, 5] },
      settings: [
        { key: 'set', label: 'Полосы', type: 'seg', options: [['near', '0,25 · 0,5 · 1 %'], ['mid', '0,5 · 1 · 2,5 %'], ['far', '1 · 2,5 · 5 %']] },
        { key: 'smooth', label: 'Сглаживание', type: 'seg', options: [[1, 'Нет'], [3, '3'], [5, '5'], [10, '10']] }
      ],
      colors: ['--color-series-9', '--color-series-1', '--color-series-bone'],
      title() { return 'Imbalance Dynamics, %'; },
      series(r, inst) {
        const cs = r.candles();
        const bands = this.sets[inst.params.set];
        const lines = bands.map((p) => {
          const a = new Float64Array(cs.length);
          for (let i = 0; i < cs.length; i++) a[i] = D.candleImb(cs[i], p);
          return inst.params.smooth > 1 ? ema(a, inst.params.smooth) : a;
        });
        return { lines, bands };
      },
      range(r, inst, s, i0, i1) {
        const [mn, mx] = minmax(s.lines, i0, i1);
        return [Math.min(mn, -5), Math.max(mx, 5)];
      },
      draw(r, ctx, pane, inst, s, i0, i1, yOf) {
        r.zero(ctx, yOf(0));
        const cols = [r.C.s9, r.C.s1, r.C.bone];
        for (let k = s.lines.length - 1; k >= 0; k--) r.line(ctx, i0, i1, s.lines[k], yOf, r.rgba(cols[k], 0.95), k === 0 ? 1.5 : 1.2, k === 0 ? null : [3, 3]);
      },
      legend(r, inst, s, i) {
        return {
          vals: s.bands.map((p, k) => dash('var(' + this.colors[k] + ')', k > 0) + pctLabel(p) + ' ' + val(s.lines[k][i], (x) => signedFmt(x, (y) => num(y, 1)))).join(' ')
        };
      }
    },

    dom: {
      cat: 'book', kind: 'pane', height: 84,
      name: 'Bid Dominance',
      desc: 'перевес бидов к меньшей стороне, %',
      defaults: { smooth: 1 },
      settings: [
        { key: 'smooth', label: 'Сглаживание', type: 'seg', options: [[1, 'Нет'], [3, '3'], [5, '5'], [10, '10']] }
      ],
      title() { return 'Bid Dominance, %'; },
      series(r, inst) {
        const cs = r.candles();
        const lines = D.DOM_RANGES.map((_, k) => {
          const a = new Float64Array(cs.length);
          for (let i = 0; i < cs.length; i++) a[i] = cs[i].dom ? cs[i].dom[k] : NaN;
          return inst.params.smooth > 1 ? ema(a, inst.params.smooth) : a;
        });
        return { lines };
      },
      range(r, inst, s, i0, i1) { return minmax(s.lines, i0, i1); },
      fmtAxis(v) { return num(v, 0); },
      draw(r, ctx, pane, inst, s, i0, i1, yOf) {
        if (pane.min < 0 && pane.max > 0) r.zero(ctx, yOf(0));
        r.line(ctx, i0, i1, s.lines[2], yOf, r.rgba(r.C.bone, 0.8), 1.2, [2, 3]);
        r.line(ctx, i0, i1, s.lines[1], yOf, r.rgba(r.C.s1, 0.95), 1.3, [3, 3]);
        r.line(ctx, i0, i1, s.lines[0], yOf, r.rgba(r.C.s9, 0.95), 1.5);
      },
      legend(r, inst, s, i) {
        const f = (x) => signedFmt(x, (y) => num(y, 1));
        return {
          vals: dash('var(--color-series-9)') + '0,25 % ' + val(s.lines[0][i], f) +
            dash('var(--color-series-1)', true) + '0,5 % ' + val(s.lines[1][i], f) +
            dash('var(--color-series-bone)', true) + '1 % ' + val(s.lines[2][i], f)
        };
      }
    },

    zbands: {
      cat: 'book', kind: 'pane', height: 120,
      name: 'Z-score полос',
      desc: 'необычные полосы стакана × время',
      defaults: { depth: 10 },
      settings: [
        { key: 'depth', label: 'Глубина', type: 'seg', options: [[2.5, '2,5 %'], [5, '5 %'], [10, '10 %']] }
      ],
      title(inst, r) { return 'Z-score полос · база ' + D.BASE_LABEL[r.engineBase()] + ' · до ' + pctLabel(inst.params.depth); },
      series() { return {}; },
      nb(inst) {
        let nb = 0;
        while (nb < D.NB && D.Z_BANDS[nb + 1] <= inst.params.depth + 1e-9) nb++;
        return nb;
      },
      range() { return [-1, 1]; },
      axisLabels(inst) { return [[0.9, 'аск'], [0, '0 %'], [-0.9, 'бид']]; },
      draw(r, ctx, pane, inst, s, i0, i1) {
        const cs = r.candles();
        const nb = this.nb(inst);
        const half = (pane.bot - pane.top) / 2;
        const rowH = half / nb;
        const mid = pane.top + half;
        for (let i = i0; i <= i1; i++) {
          const c = cs[i];
          if (!c || !c.z) continue;
          const [x0, w] = r.colRect(i);
          for (let b = 0; b < nb; b++) {
            const za = c.z[D.NB + b];
            const zb = c.z[b];
            const fa = isFinite(za) ? r.zFill(1, za) : null;
            const fb = isFinite(zb) ? r.zFill(0, zb) : null;
            if (fa) { ctx.fillStyle = fa; ctx.fillRect(x0, Math.floor(mid - (b + 1) * rowH), w, Math.ceil(rowH)); }
            if (fb) { ctx.fillStyle = fb; ctx.fillRect(x0, Math.floor(mid + b * rowH), w, Math.ceil(rowH)); }
          }
        }
        ctx.fillStyle = r.rgba(r.C.border, 1);
        ctx.fillRect(0, Math.round(mid), r.plotW, 1);
      },
      legend(r, inst, s, i) {
        const c = r.candles()[i];
        if (!c || !c.z) return { vals: '' };
        const nb = this.nb(inst);
        const best = (side) => {
          let bz = 0;
          let bb = -1;
          for (let b = 0; b < nb; b++) {
            const z = c.z[side * D.NB + b];
            if (isFinite(z) && Math.abs(z) > Math.abs(bz)) { bz = z; bb = b; }
          }
          if (bb < 0) return '—';
          const lo = num(D.Z_BANDS[bb], 2).replace(/,?0+$/, '');
          const hi = num(D.Z_BANDS[bb + 1], 2).replace(/,?0+$/, '');
          return '<span class="ct-pl-dim">' + lo + '–' + hi + ' %</span> <b class="ct-pl-v" style="color:' + r.rgba(r.zColor(side, bz), 1) + '">' + signedFmt(bz, (y) => num(y, 2)) + '</b>';
        };
        return { vals: 'аск ' + best(1) + ' · бид ' + best(0) };
      }
    },

    // ============================================================= flow
    dmi: {
      cat: 'flow', kind: 'pane', height: 84,
      name: 'DMI',
      desc: 'перегрев потока: плюс — покупки разогнаны, минус — продажи',
      defaults: { period: 14, thr: 25 },
      settings: [
        { key: 'period', label: 'Период', type: 'seg', options: [[7, '7'], [14, '14'], [21, '21'], [50, '50']] },
        { key: 'thr', label: 'Перегрев', type: 'seg', options: [[15, '±15'], [25, '±25'], [40, '±40']] }
      ],
      title(inst) { return 'DMI ' + inst.params.period + ', %'; },
      series(r, inst) {
        const cs = r.candles();
        const d = new Float64Array(cs.length);
        const v = new Float64Array(cs.length);
        for (let i = 0; i < cs.length; i++) { d[i] = 2 * cs[i].buy - cs[i].v; v[i] = cs[i].v; }
        const ed = ema(d, inst.params.period);
        const ev = ema(v, inst.params.period);
        const out = new Float64Array(cs.length);
        for (let i = 0; i < cs.length; i++) out[i] = ev[i] > 0 ? ed[i] / ev[i] * 100 : 0;
        return { v: out };
      },
      range(r, inst, s, i0, i1) {
        const [mn, mx] = minmax([s.v], i0, i1);
        const t = inst.params.thr * 1.3;
        return [Math.min(mn, -t), Math.max(mx, t)];
      },
      fmtAxis(v) { return num(v, 0); },
      draw(r, ctx, pane, inst, s, i0, i1, yOf) {
        const t = inst.params.thr;
        r.zero(ctx, yOf(0));
        r.hline(ctx, yOf(t), r.rgba(r.C.up, 0.45), [3, 3]);
        r.hline(ctx, yOf(-t), r.rgba(r.C.down, 0.45), [3, 3]);
        r.area(ctx, i0, i1, s.v, yOf, yOf(t), (x) => x > t, r.rgba(r.C.up, 0.28));
        r.area(ctx, i0, i1, s.v, yOf, yOf(-t), (x) => x < -t, r.rgba(r.C.down, 0.28));
        r.line(ctx, i0, i1, s.v, yOf, r.rgba(r.C.s9, 0.95), 1.5);
      },
      legend(r, inst, s, i) {
        const v = s.v[i];
        const t = inst.params.thr;
        const tag = v > t ? ' <span class="ct-up">перегрев покупок</span>' : v < -t ? ' <span class="ct-down">перегрев продаж</span>' : '';
        return { vals: val(v, (x) => signedFmt(x, (y) => num(y, 1)), true) + tag };
      }
    },

    smf: {
      cat: 'flow', kind: 'pane', height: 84,
      name: 'SMF',
      desc: 'поток «умных денег»: перевес покупок и продаж',
      defaults: { period: 20, mult: 2 },
      settings: [
        { key: 'period', label: 'Средний объём', type: 'seg', options: [[10, '10'], [20, '20'], [50, '50']] },
        { key: 'mult', label: 'Крупные свечи', type: 'seg', options: [[1.5, '× 1,5'], [2, '× 2'], [3, '× 3']] }
      ],
      title(inst, r) { return 'SMF · свечи объёмом × ' + num(inst.params.mult, inst.params.mult % 1 ? 1 : 0) + ', ' + r.opt.baseAsset; },
      series(r, inst) {
        const cs = r.candles();
        const vol = new Float64Array(cs.length);
        for (let i = 0; i < cs.length; i++) vol[i] = cs[i].v;
        const avg = sma(vol, inst.params.period);
        const flow = new Float64Array(cs.length);
        const cum = new Float64Array(cs.length);
        let acc = 0;
        for (let i = 0; i < cs.length; i++) {
          const prevAvg = i > 0 ? avg[i - 1] : avg[i];
          const big = cs[i].v > inst.params.mult * prevAvg;
          flow[i] = big ? 2 * cs[i].buy - cs[i].v : 0;
          acc += flow[i];
          cum[i] = acc;
        }
        return { flow, cum };
      },
      visibleCum(s, i0, i1) {
        const out = new Float64Array(s.cum.length).fill(NaN);
        const base = i0 > 0 ? s.cum[i0 - 1] : 0;
        for (let i = Math.max(0, i0); i <= i1 && i < s.cum.length; i++) out[i] = s.cum[i] - base;
        return out;
      },
      range(r, inst, s, i0, i1) {
        const vc = this.visibleCum(s, i0, i1);
        const [mn, mx] = minmax([s.flow, vc], i0, i1);
        return [Math.min(mn, 0), Math.max(mx, 0)];
      },
      draw(r, ctx, pane, inst, s, i0, i1, yOf) {
        r.zero(ctx, yOf(0));
        r.hist(ctx, i0, i1, s.flow, yOf, yOf(0), (i, x) => r.rgba(x >= 0 ? r.C.deltaPos : r.C.deltaNeg, 0.85));
        r.line(ctx, i0, i1, this.visibleCum(s, i0, i1), yOf, r.rgba(r.C.accent, 0.95), 1.5);
      },
      legend(r, inst, s, i) {
        const vc = this.visibleCum(s, r.vis ? r.vis[0] : 0, i);
        return {
          vals: 'поток ' + val(s.flow[i], (x) => signedFmt(x, short), true) + dash('var(--color-accent)') + 'Σ видимого ' + val(vc[i], (x) => signedFmt(x, short), true)
        };
      }
    },

    cvd: {
      cat: 'flow', kind: 'pane', height: 84,
      name: 'CVD',
      desc: 'дельта сделок за скользящее окно (1–14 д)',
      defaults: { window: '1d' },
      settings: [
        { key: 'window', label: 'Окно', type: 'seg', options: [['1d', '1 д'], ['3d', '3 д'], ['7d', '7 д'], ['14d', '14 д']] }
      ],
      title(inst, r) { return 'CVD · окно ' + inst.params.window.replace('d', ' д') + ', ' + r.opt.baseAsset; },
      series(r, inst) {
        const cs = r.candles();
        const w = windowMs(inst.params.window);
        const out = new Float64Array(cs.length);
        const limited = new Uint8Array(cs.length);
        let j = 0;
        let acc = 0;
        for (let i = 0; i < cs.length; i++) {
          acc += 2 * cs[i].buy - cs[i].v;
          while (j <= i && cs[j].t <= cs[i].t - w) { acc -= 2 * cs[j].buy - cs[j].v; j++; }
          out[i] = acc;
          limited[i] = cs[0].t > cs[i].t - w + (r.engine ? r.engine.tfMs : 0) ? 1 : 0;
        }
        return { v: out, limited };
      },
      range(r, inst, s, i0, i1) {
        const [mn, mx] = minmax([s.v], i0, i1);
        return [Math.min(mn, 0), Math.max(mx, 0)];
      },
      draw(r, ctx, pane, inst, s, i0, i1, yOf) {
        r.zero(ctx, yOf(0));
        r.area(ctx, i0, i1, s.v, yOf, yOf(0), (x) => x >= 0, r.rgba(r.C.up, 0.16));
        r.area(ctx, i0, i1, s.v, yOf, yOf(0), (x) => x < 0, r.rgba(r.C.down, 0.16));
        r.line(ctx, i0, i1, s.v, yOf, r.rgba(r.C.s1, 0.95), 1.5);
      },
      legend(r, inst, s, i) {
        const note = s.limited[i] ? ' <span class="ct-pl-dim">· окно ограничено загруженной историей</span>' : '';
        return { vals: val(s.v[i], (x) => signedFmt(x, short), true) + note };
      }
    },

    // ========================================================== classic
    rsi: {
      cat: 'classic', kind: 'pane', height: 84,
      name: 'RSI',
      desc: 'по умолчанию 14 свечей · уровни 30 и 70',
      defaults: { period: 14, levels: '30/70' },
      settings: [
        { key: 'period', label: 'Период', type: 'seg', options: [[7, '7'], [14, '14'], [21, '21'], [28, '28']] },
        { key: 'levels', label: 'Уровни', type: 'seg', options: [['30/70', '30 / 70'], ['20/80', '20 / 80'], ['40/60', '40 / 60']] }
      ],
      title(inst) { return 'RSI ' + inst.params.period; },
      series(r, inst) {
        const cs = r.candles();
        const n = inst.params.period;
        const out = new Float64Array(cs.length).fill(NaN);
        let ag = 0;
        let al = 0;
        for (let i = 1; i < cs.length; i++) {
          const ch = cs[i].c - cs[i - 1].c;
          const g = ch > 0 ? ch : 0;
          const l = ch < 0 ? -ch : 0;
          if (i <= n) {
            ag += g / n; al += l / n;
            if (i === n) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
          } else {
            ag = (ag * (n - 1) + g) / n;
            al = (al * (n - 1) + l) / n;
            out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
          }
        }
        return { v: out };
      },
      range() { return [0, 100]; },
      fmtAxis(v) { return num(v, 0); },
      axisLabels(inst) {
        const [lo, hi] = inst.params.levels.split('/').map(Number);
        return [[hi, String(hi)], [50, '50'], [lo, String(lo)]];
      },
      draw(r, ctx, pane, inst, s, i0, i1, yOf) {
        const [lo, hi] = inst.params.levels.split('/').map(Number);
        ctx.fillStyle = r.rgba(r.C.s8 || r.C.s1, 0.07);
        ctx.fillRect(0, yOf(hi), r.plotW, yOf(lo) - yOf(hi));
        r.hline(ctx, yOf(hi), r.rgba(r.C.down, 0.5), [3, 3]);
        r.hline(ctx, yOf(lo), r.rgba(r.C.up, 0.5), [3, 3]);
        r.hline(ctx, yOf(50), r.rgba(r.C.faint, 0.25), [2, 4]);
        r.line(ctx, i0, i1, s.v, yOf, r.rgba(r.C.s8 || r.C.s1, 0.95), 1.5);
      },
      legend(r, inst, s, i) {
        const [lo, hi] = inst.params.levels.split('/').map(Number);
        const v = s.v[i];
        const tag = v >= hi ? ' <span class="ct-down">перекупленность</span>' : v <= lo ? ' <span class="ct-up">перепроданность</span>' : '';
        return { vals: val(v, (x) => num(x, 1)) + tag };
      }
    },

    macd: {
      cat: 'classic', kind: 'pane', height: 96,
      name: 'MACD',
      desc: 'по умолчанию 12 и 26 · сигнал 9',
      defaults: { preset: '12/26/9' },
      settings: [
        { key: 'preset', label: 'Периоды', type: 'seg', options: [['12/26/9', '12 · 26 · 9'], ['8/21/5', '8 · 21 · 5'], ['5/35/5', '5 · 35 · 5']] }
      ],
      title(inst) { return 'MACD ' + inst.params.preset.split('/').join(' · '); },
      series(r, inst) {
        const cs = r.candles();
        const [f, sl, sg] = inst.params.preset.split('/').map(Number);
        const close = new Float64Array(cs.length);
        for (let i = 0; i < cs.length; i++) close[i] = cs[i].c;
        const ef = ema(close, f);
        const es = ema(close, sl);
        const macd = new Float64Array(cs.length);
        for (let i = 0; i < cs.length; i++) macd[i] = ef[i] - es[i];
        const signal = ema(macd, sg);
        const hist = new Float64Array(cs.length);
        for (let i = 0; i < cs.length; i++) hist[i] = macd[i] - signal[i];
        return { macd, signal, hist };
      },
      range(r, inst, s, i0, i1) { return minmax([s.macd, s.signal, s.hist], i0, i1); },
      fmtAxis(v, r) { return num(v, r.opt.priceDecimals); },
      draw(r, ctx, pane, inst, s, i0, i1, yOf) {
        r.zero(ctx, yOf(0));
        r.hist(ctx, i0, i1, s.hist, yOf, yOf(0), (i, x) => {
          const prev = i > 0 ? s.hist[i - 1] : x;
          const growing = Math.abs(x) >= Math.abs(prev);
          return r.rgba(x >= 0 ? r.C.deltaPos : r.C.deltaNeg, growing ? 0.9 : 0.45);
        });
        r.line(ctx, i0, i1, s.macd, yOf, r.rgba(r.C.s1, 0.95), 1.4);
        r.line(ctx, i0, i1, s.signal, yOf, r.rgba(r.C.accent, 0.95), 1.2);
      },
      legend(r, inst, s, i) {
        const f = (x) => signedFmt(x, (y) => num(y, r.opt.priceDecimals));
        return {
          vals: dash('var(--color-series-1)') + 'MACD ' + val(s.macd[i], f) + dash('var(--color-accent)') + 'сигнал ' + val(s.signal[i], f) + ' гист. ' + val(s.hist[i], f, true)
        };
      }
    }
  };

  const ORDER = ['profile', 'zscore', 'depth', 'imbHeat', 'imbDyn', 'dom', 'zbands', 'dmi', 'smf', 'cvd', 'rsi', 'macd'];

  let uidSeq = 0;
  function create(type, params) {
    const def = DEFS[type];
    return { uid: type + '-' + Date.now().toString(36) + '-' + (uidSeq++), type, params: Object.assign({}, def.defaults, params || {}) };
  }

  function defaultSet() {
    return [create('profile'), create('zscore'), create('depth', { range: 1 }), create('dom')];
  }

  global.CTIndicators = { DEFS, ORDER, CATEGORIES, MAX_PANES, create, defaultSet, ema, sma };
})(window);
