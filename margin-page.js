/* ==========================================================================
   margin-page.js — страница «Маржа Binance».

   Режимы данных:
     • Публичный (без ключа): все маржинальные активы Binance с текущей
       ставкой и лимитом займа (bapi vip/spec/list-all), история ставки
       (bapi history-interest-rate), цена (klines).
     • С ключом (server.py + config.local.json): займы и погашения,
       выведенные из изменений пула кросс-маржи, Z-оценки, пул и события
       «пул пуст / всплеск займов» — /api/margin/*.
   ========================================================================== */
(function () {
  'use strict';

  const D = window.CTData;
  const F = window.CTFormat;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const STORE = 'cryptoterminal.margin.v1';
  const BAPI = 'https://www.binance.com/bapi/margin/v1/public/margin/vip/spec';

  const COLS = [
    { key: 'borrow', label: 'Займы', unit: true, cls: 'mg-c-borrow', needKey: true },
    { key: 'repay', label: 'Погашения', unit: true, cls: 'mg-c-repay', needKey: true },
    { key: 'volume', label: 'Объём', unit: true, needKey: true },
    { key: 'net', label: 'Чистый займ', unit: true, signed: true, needKey: true },
    { key: 'bz', label: 'B.Z', z: true, needKey: true, hint: 'Z-оценка займов за окно против базы' },
    { key: 'rz', label: 'R.Z', z: true, needKey: true, hint: 'Z-оценка погашений за окно против базы' },
    { key: 'bd', label: 'BΔ%, за 1 ч', pct: true, needKey: true, hint: 'Изменение суммы займов за окно за последний час' },
    { key: 'rd', label: 'RΔ%, за 1 ч', pct: true, needKey: true, hint: 'Изменение суммы погашений за окно за последний час' },
    { key: 'bdz', label: 'BΔZ', z: true, needKey: true, hint: 'Z-оценка часового прироста займов' },
    { key: 'rdz', label: 'RΔZ', z: true, needKey: true, hint: 'Z-оценка часового прироста погашений' },
    { key: 'pool', label: 'Пул', unit: true, needKey: true, hint: 'Доступно для займа в кросс-марже' },
    { key: 'rate', label: 'Ставка, % год.', rate: true, hint: 'VIP 0, годовых' },
    { key: 'limit', label: 'Лимит займа', unit: true, hint: 'VIP 0' }
  ];
  const METRICS = [
    { key: 'price', label: 'Цена' },
    { key: 'borrow', label: 'Займы', needKey: true },
    { key: 'repay', label: 'Погашения', needKey: true },
    { key: 'net', label: 'Чистый займ', needKey: true },
    { key: 'pool', label: 'Пул', needKey: true },
    { key: 'rate', label: 'Ставка' }
  ];
  const RANGES = [1, 3, 7, 14];
  const SERIES_COLORS = ['--color-series-1', '--color-series-2', '--color-series-3', '--color-series-4', '--color-series-5', '--color-series-6'];

  const defaults = {
    units: 'USDT',
    sort: { key: 'volume', dir: -1 },
    cols: COLS.map((c) => c.key),
    assets: ['USDT', 'USDC'],
    metrics: ['price', 'borrow', 'pool'],
    days: 7,
    offset: 0,
    win: 24,
    base: 7,
    ev: { min24: 10000, win: 15, growth: 100, days: 7 },
    collapsed: {}
  };

  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (!s) return JSON.parse(JSON.stringify(defaults));
      const o = Object.assign(JSON.parse(JSON.stringify(defaults)), s);
      o.ev = Object.assign({}, defaults.ev, s.ev || {});
      o.sort = Object.assign({}, defaults.sort, s.sort || {});
      return o;
    } catch (e) {
      return JSON.parse(JSON.stringify(defaults));
    }
  }
  const st = loadState();
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (e) { /* квота */ } };

  // ---------------------------------------------------------- data state
  const data = {
    mode: 'loading',          // 'key' | 'public' | 'loading'
    server: null,             // /api/margin/status
    rates: new Map(),         // asset -> {daily, limit}
    rows: [],
    table: null,
    events: [],
    updated: 0,
    error: null
  };

  let inited = false;
  let visible = false;
  let refreshTimer = null;
  let clockTimer = null;

  // ---------------------------------------------------------- format
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const fmtShort = (v) => (v === null || v === undefined || !isFinite(v) ? '—' : F.fmtShort(v));
  function fmtUtc(t, date) {
    const d = new Date(t * 1000);
    const p = (n) => String(n).padStart(2, '0');
    const hm = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
    return date ? p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + ' ' + hm : hm;
  }

  function priceOf(asset, row) {
    if (asset === 'USDT') return 1;
    if (row && row.price > 0) return row.price;
    const tk = window.CTApp && window.CTApp.tickers;
    if (tk) {
      for (const sym of [asset + 'USDT', asset + 'USDC', asset + 'FDUSD']) {
        const t = tk.data.spot.get(sym);
        if (t && t.price > 0) return t.price;
      }
    }
    return null;
  }

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  // ---------------------------------------------------------- fetch
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function loadStatus() {
    try {
      data.server = await getJSON('/api/margin/status');
    } catch (e) {
      data.server = null;
    }
    data.mode = data.server && data.server.configured ? 'key' : 'public';
  }

  async function loadRates() {
    const j = await getJSON(BAPI + '/list-all');
    const m = new Map();
    for (const a of j.data || []) {
      const s0 = (a.specs || []).find((s) => s.vipLevel === '0') || (a.specs || [])[0];
      if (!s0) continue;
      m.set(a.assetName, { daily: +s0.dailyInterestRate, limit: +s0.borrowLimit });
    }
    data.rates = m;
  }

  async function loadTable() {
    if (data.mode !== 'key') { data.table = null; return; }
    data.table = await getJSON('/api/margin/table?win=' + st.win + '&base=' + st.base);
  }

  async function loadEvents() {
    if (data.mode !== 'key') { data.events = []; return; }
    const e = st.ev;
    const j = await getJSON('/api/margin/events?days=' + e.days + '&min24=' + e.min24 + '&win=' + e.win + '&growth=' + e.growth);
    data.events = j.events || [];
  }

  function buildRows() {
    const byAsset = new Map();
    for (const [a, r] of data.rates) byAsset.set(a, { asset: a, rate: r.daily * 365 * 100, limitQty: r.limit });
    if (data.table) {
      for (const r of data.table.rows) {
        const o = byAsset.get(r.asset) || { asset: r.asset };
        Object.assign(o, r);
        byAsset.set(r.asset, o);
      }
    }
    const rows = [];
    for (const o of byAsset.values()) {
      const px = priceOf(o.asset, o);
      const k = st.units === 'USDT' ? px : 1;
      const conv = (q) => (q === null || q === undefined || !isFinite(q) ? null : (k ? q * k : null));
      rows.push({
        asset: o.asset,
        price: px,
        borrow: conv(o.borrow),
        repay: conv(o.repay),
        volume: o.borrow !== undefined && o.borrow !== null ? conv(o.borrow + o.repay) : null,
        net: o.borrow !== undefined && o.borrow !== null ? conv(o.borrow - o.repay) : null,
        bz: o.bz, rz: o.rz, bd: o.bd, rd: o.rd, bdz: o.bdz, rdz: o.rdz,
        pool: conv(o.pool),
        rate: o.rate !== undefined ? o.rate : null,
        limit: conv(o.limitQty)
      });
    }
    data.rows = rows;
  }

  async function refresh(full) {
    try {
      if (full || data.mode === 'loading') await loadStatus();
      const jobs = [];
      if (full || !data.rates.size || Date.now() - (data.ratesAt || 0) > 300e3) jobs.push(loadRates().then(() => { data.ratesAt = Date.now(); }));
      jobs.push(loadTable());
      jobs.push(loadEvents());
      if (data.mode === 'key') jobs.push(loadStatus());
      await Promise.all(jobs);
      data.error = null;
      data.updated = data.mode === 'key' && data.server && data.server.lastPoll ? data.server.lastPoll : Math.floor(Date.now() / 1000);
    } catch (e) {
      data.error = e.message;
    }
    buildRows();
    renderAll();
  }

  // ---------------------------------------------------------- render: header
  function renderHeader() {
    const s = data.server;
    const dot = $('#mg-status-dot');
    let txt;
    if (data.mode === 'key') {
      txt = 'данные на ' + (data.updated ? fmtUtc(data.updated, true) : '—') + ' UTC';
      dot.setAttribute('data-state', s && s.lastError ? 'error' : 'live');
    } else {
      txt = 'ставки на ' + (data.updated ? fmtUtc(data.updated, true) : '—') + ' UTC';
      dot.setAttribute('data-state', data.error ? 'error' : 'public');
    }
    $('#mg-status-text').textContent = txt;
    let note;
    if (data.mode === 'key') {
      note = s && s.lastError ? 'Ошибка опроса пула: ' + s.lastError : 'Без задержки · пул кросс-маржи опрашивается раз в минуту';
    } else if (!s) {
      note = 'Займы и пул — через server.py с API-ключом Binance (только чтение)';
    } else {
      note = 'Займы и пул — добавьте API-ключ Binance (только чтение) в config.local.json';
    }
    $('#mg-status-note').textContent = note;
  }

  // ---------------------------------------------------------- render: toolbar
  function ddLabel(id, html) { const el = $('#' + id + ' .mg-dd-val'); if (el) el.innerHTML = html; }

  function renderToolbar() {
    const as = st.assets;
    ddLabel('mg-dd-assets', as.length ? esc(as.slice(0, 2).join(', ')) + (as.length > 2 ? ' +' + (as.length - 2) : '') : '—');
    ddLabel('mg-dd-units', st.units === 'USDT' ? 'USDT' : 'Монеты');
    const sc = COLS.find((c) => c.key === st.sort.key);
    ddLabel('mg-dd-sort', esc(sc ? sc.label : 'Объём'));
    ddLabel('mg-dd-dir', st.sort.dir < 0 ? '↓ по убыванию' : '↑ по возрастанию');
    ddLabel('mg-dd-cols', st.cols.length === COLS.length ? 'Все' : st.cols.length + ' из ' + COLS.length);
    const ml = METRICS.filter((m) => st.metrics.includes(m.key)).map((m) => m.label);
    ddLabel('mg-dd-metrics', ml.length ? esc(ml.slice(0, 2).join(', ')) + (ml.length > 2 ? ' +' + (ml.length - 2) : '') : '—');
    ddLabel('mg-dd-range', st.days + ' д');
  }

  // ---------------------------------------------------------- render: table
  function zClass(z) {
    if (z === null || z === undefined || !isFinite(z)) return '';
    const a = Math.abs(z);
    const lvl = a >= 3 ? 3 : a >= 2 ? 2 : a >= 1 ? 1 : 0;
    if (!lvl) return '';
    return (z > 0 ? 'mg-pos-' : 'mg-neg-') + lvl;
  }

  function cellHTML(c, r) {
    const v = r[c.key];
    if (c.z) {
      return '<td class="num ' + zClass(v) + '">' + (v === null || v === undefined || !isFinite(v) ? '<span class="mg-dash">–</span>' : F.fmtSigned(v, (x) => F.fmtNum(x, 2))) + '</td>';
    }
    if (c.pct) {
      if (v === null || v === undefined || !isFinite(v)) return '<td class="num"><span class="mg-dash">–</span></td>';
      const cls = v > 0 ? 'ct-up' : v < 0 ? 'ct-down' : '';
      return '<td class="num ' + cls + '">' + F.fmtSigned(v, (x) => F.fmtNum(x, Math.abs(x) < 10 ? 1 : 0)) + '%</td>';
    }
    if (c.rate) {
      return '<td class="num">' + (v === null || !isFinite(v) ? '<span class="mg-dash">–</span>' : F.fmtNum(v, v < 10 ? 2 : 1)) + '</td>';
    }
    if (v === null || v === undefined || !isFinite(v)) return '<td class="num ' + (c.cls || '') + '"><span class="mg-dash">–</span></td>';
    if (v === 0) return '<td class="num ' + (c.cls || '') + '">0</td>';
    if (c.signed) {
      const cls = v < 0 ? 'ct-up' : '';
      return '<td class="num ' + cls + '">' + (v > 0 ? '+' : '') + fmtShort(v) + '</td>';
    }
    return '<td class="num ' + (c.cls || '') + '">' + fmtShort(v) + '</td>';
  }

  function sortedRows() {
    const q = ($('#mg-search').value || '').trim().toUpperCase();
    let rows = data.rows;
    if (q) rows = rows.filter((r) => r.asset.indexOf(q) >= 0);
    const k = st.sort.key;
    const dir = st.sort.dir;
    rows = rows.slice().sort((a, b) => {
      const va = a[k];
      const vb = b[k];
      const na = va === null || va === undefined || !isFinite(va);
      const nb = vb === null || vb === undefined || !isFinite(vb);
      if (na && nb) {
        // без данных сортируем по лимиту займа — грубая оценка размера рынка
        return ((b.limit || 0) - (a.limit || 0));
      }
      if (na) return 1;
      if (nb) return -1;
      if (va !== vb) return (va - vb) * dir;
      // равные значения (например, нули в начале истории) — крупные рынки выше
      return ((b.pool || 0) - (a.pool || 0)) || ((b.limit || 0) - (a.limit || 0));
    });
    return rows;
  }

  function renderTable() {
    const cols = COLS.filter((c) => st.cols.includes(c.key));
    const unit = st.units === 'USDT' ? 'USDT' : '';
    let head = '<tr><th class="mg-th-sel"></th><th class="mg-th-asset" data-sort="asset">Актив</th>';
    for (const c of cols) {
      const on = st.sort.key === c.key;
      head += '<th class="num' + (on ? ' on' : '') + '" data-sort="' + c.key + '"' + (c.hint ? ' title="' + esc(c.hint) + '"' : '') + '>' +
        (on ? (st.sort.dir < 0 ? '↓ ' : '↑ ') : '') + '<b>' + c.label + '</b>' + (c.unit && unit ? '<span>, ' + unit + '</span>' : '') + '</th>';
    }
    head += '</tr>';
    const rows = sortedRows();
    let body = '';
    const sel = new Set(st.assets);
    for (const r of rows) {
      const on = sel.has(r.asset);
      body += '<tr data-asset="' + esc(r.asset) + '" class="' + (on ? 'sel' : '') + '"><td class="mg-td-sel"><span class="mg-radio" data-on="' + on + '"></span></td><td class="mg-td-asset">' + esc(r.asset) + '</td>';
      for (const c of cols) body += cellHTML(c, r);
      body += '</tr>';
    }
    if (!rows.length) body = '<tr><td colspan="' + (cols.length + 2) + '" class="mg-empty-cell">' + (data.rows.length ? 'Ничего не найдено' : 'Загрузка…') + '</td></tr>';
    $('#mg-thead').innerHTML = head;
    $('#mg-tbody').innerHTML = body;
    $('#mg-count').textContent = String(data.rows.length);
    const banner = $('#mg-banner');
    if (data.mode === 'key') {
      const cov = data.table ? data.table.coverageHours : 0;
      banner.hidden = cov >= st.win + st.base * 24;
      banner.innerHTML = 'История пула копится с момента запуска сервера: <b>' + F.fmtNum(cov, 1) + ' ч</b>. Суммы за ' + st.win + ' ч полные через ' + st.win + ' ч, Z-оценки — когда наберётся база ' + st.base + ' д.';
    } else {
      banner.hidden = false;
      banner.innerHTML = 'Сейчас показаны публичные данные Binance: ставка и лимит займа по ' + data.rows.length + ' активам. ' +
        'Займы, погашения, пул, Z-оценки и события требуют API-ключ Binance с правом «только чтение» и запуска <code>python server.py</code>. ' +
        '<span class="mg-link" data-help="key">Как подключить</span>';
    }
  }

  // ---------------------------------------------------------- render: events
  function renderEvents() {
    const e = st.ev;
    $('#mg-ev-min').value = e.min24;
    $('#mg-ev-growth').value = e.growth;
    ddLabel('mg-dd-evwin', e.win + ' мин');
    ddLabel('mg-dd-evdays', 'Последние ' + e.days + ' ' + (e.days === 1 ? 'день' : e.days < 5 ? 'дня' : 'дней'));
    $('#mg-ev-winlabel').textContent = e.win + ' мин';
    const body = $('#mg-ev-body');
    if (data.mode !== 'key') {
      body.innerHTML = '<div class="mg-hatch">События считаются по истории пула — нужен API-ключ Binance и запущенный server.py</div>';
      return;
    }
    if (!data.events.length) {
      body.innerHTML = '<div class="mg-hatch">За выбранный период событий нет</div>';
      return;
    }
    let h = '<table class="mg-table mg-ev-table"><thead><tr><th>Время, UTC</th><th>Актив</th><th>Событие</th><th class="num">Займы за 24 ч, USDT</th><th class="num">Рост займов за ' + e.win + ' мин</th><th class="num">Пул</th></tr></thead><tbody>';
    for (const ev of data.events) {
      h += '<tr data-asset="' + esc(ev.asset) + '"><td>' + fmtUtc(ev.t, true) + '</td><td class="mg-td-asset">' + esc(ev.asset) + '</td>' +
        '<td>' + (ev.type === 'empty' ? '<span class="mg-tag mg-tag-empty">пул пуст</span>' : '<span class="mg-tag mg-tag-spike">всплеск займов</span>') + '</td>' +
        '<td class="num">' + fmtShort(ev.borrow24) + '</td>' +
        '<td class="num ct-up">' + (ev.growth !== null && ev.growth !== undefined ? '+' + F.fmtNum(ev.growth, 0) + '%' : '<span class="mg-dash">–</span>') + '</td>' +
        '<td class="num">' + (ev.pool === null || ev.pool === undefined ? '–' : fmtShort(ev.pool)) + '</td></tr>';
    }
    h += '</tbody></table>';
    body.innerHTML = h;
  }

  // ---------------------------------------------------------- render: footer
  function renderFooter() {
    const s = data.server;
    let left = 'CRYPTOTERMINAL';
    if (data.mode === 'key' && s && s.firstData) {
      const h = Math.max(0, (s.now - s.firstData) / 3600);
      left += '  ·  ИСТОРИЯ ПУЛА ' + (h >= 48 ? F.fmtNum(h / 24, 1) + ' ДН' : F.fmtNum(h, 1) + ' Ч');
    } else {
      left += '  ·  ПУБЛИЧНЫЕ СТАВКИ';
    }
    $('#mg-foot-left').textContent = left;
  }

  function tickClock() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    $('#mg-foot-clock').textContent = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' UTC';
  }

  function renderSections() {
    $$('[data-mg-section]').forEach((sec) => {
      const id = sec.dataset.mgSection;
      sec.setAttribute('data-collapsed', st.collapsed[id] ? 'true' : 'false');
    });
  }

  function renderAll() {
    if (!visible) return;
    renderHeader();
    renderToolbar();
    renderTable();
    renderEvents();
    renderFooter();
    renderSections();
    chart.load();
  }

  // ---------------------------------------------------------- dropdowns
  let openDD = null;
  function closeDD() {
    if (openDD) { openDD.setAttribute('data-open', 'false'); openDD = null; }
  }

  function ddBody(id) {
    const opt = (attr, val, label, on, multi) =>
      '<button type="button" class="mg-opt" ' + attr + '="' + esc(String(val)) + '" aria-checked="' + on + '">' +
      (multi ? '<span class="ct-toggle-mark" data-on="' + on + '"></span>' : '<span class="mg-check">' + (on ? '✓' : '') + '</span>') + label + '</button>';
    switch (id) {
      case 'mg-dd-assets': {
        const q = (openDD && openDD.querySelector('.mg-dd-search') ? openDD.querySelector('.mg-dd-search').value : '').toUpperCase();
        const sel = new Set(st.assets);
        const list = sortedRows().map((r) => r.asset).filter((a) => !q || a.indexOf(q) >= 0);
        const ordered = st.assets.concat(list.filter((a) => !sel.has(a))).slice(0, 80);
        return ordered.map((a) => opt('data-asset-opt', a, esc(a), sel.has(a), true)).join('') +
          '<div class="mg-dd-note">До 6 активов на графике</div>';
      }
      case 'mg-dd-units':
        return opt('data-units', 'USDT', 'USDT', st.units === 'USDT') + opt('data-units', 'coin', 'Монеты', st.units === 'coin');
      case 'mg-dd-sort':
        return COLS.map((c) => opt('data-sortkey', c.key, c.label + (c.needKey && data.mode !== 'key' ? ' <span class="mg-dim">· ключ</span>' : ''), st.sort.key === c.key)).join('');
      case 'mg-dd-dir':
        return opt('data-dir', -1, '↓ по убыванию', st.sort.dir < 0) + opt('data-dir', 1, '↑ по возрастанию', st.sort.dir > 0);
      case 'mg-dd-cols':
        return '<button type="button" class="mg-opt" data-cols-all="1"><span class="mg-check"></span>Все колонки</button>' +
          COLS.map((c) => opt('data-col', c.key, c.label, st.cols.includes(c.key), true)).join('');
      case 'mg-dd-metrics':
        return METRICS.map((m) => opt('data-metric', m.key, m.label + (m.needKey && data.mode !== 'key' ? ' <span class="mg-dim">· ключ</span>' : ''), st.metrics.includes(m.key), true)).join('');
      case 'mg-dd-params':
        return '<div class="mg-dd-cap">Окно сумм</div>' + [1, 4, 12, 24].map((h) => opt('data-win', h, h + ' ч', st.win === h)).join('') +
          '<div class="mg-dd-cap">База для Z-оценок</div>' + [3, 7, 14].map((d) => opt('data-base', d, d + ' д', st.base === d)).join('');
      case 'mg-dd-range':
        return RANGES.map((d) => opt('data-range', d, d + ' д', st.days === d)).join('');
      case 'mg-dd-evwin':
        return [5, 15, 30, 60].map((m) => opt('data-evwin', m, m + ' мин', st.ev.win === m)).join('');
      case 'mg-dd-evdays':
        return [1, 3, 7, 14].map((d) => opt('data-evdays', d, 'Последние ' + d + ' ' + (d === 1 ? 'день' : d < 5 ? 'дня' : 'дней'), st.ev.days === d)).join('');
      default:
        return '';
    }
  }

  function openDropdown(dd) {
    if (openDD === dd) { closeDD(); return; }
    closeDD();
    openDD = dd;
    const menu = dd.querySelector('.mg-dd-menu');
    const id = dd.id;
    menu.innerHTML = (id === 'mg-dd-assets' ? '<input class="ct-input mg-dd-search" placeholder="Найти актив">' : '') + '<div class="mg-dd-list">' + ddBody(id) + '</div>';
    dd.setAttribute('data-open', 'true');
    const s = menu.querySelector('.mg-dd-search');
    if (s) {
      s.focus();
      s.addEventListener('input', () => { menu.querySelector('.mg-dd-list').innerHTML = ddBody(id); });
    }
  }

  function refreshOpenDD() {
    if (!openDD) return;
    const list = openDD.querySelector('.mg-dd-list');
    if (list) list.innerHTML = ddBody(openDD.id);
  }

  function onOption(e) {
    const b = e.target.closest('.mg-opt');
    if (!b) return false;
    const ds = b.dataset;
    let reloadData = false;
    let keepOpen = false;
    if (ds.assetOpt) {
      const a = ds.assetOpt;
      const i = st.assets.indexOf(a);
      if (i >= 0) st.assets.splice(i, 1); else if (st.assets.length < 6) st.assets.push(a);
      keepOpen = true;
    } else if (ds.units) st.units = ds.units;
    else if (ds.sortkey) { st.sort.key = ds.sortkey; }
    else if (ds.dir) st.sort.dir = Number(ds.dir);
    else if (ds.colsAll) { st.cols = COLS.map((c) => c.key); keepOpen = true; }
    else if (ds.col) {
      const i = st.cols.indexOf(ds.col);
      if (i >= 0) { if (st.cols.length > 1) st.cols.splice(i, 1); } else st.cols = COLS.map((c) => c.key).filter((k) => k === ds.col || st.cols.includes(k));
      keepOpen = true;
    } else if (ds.metric) {
      const i = st.metrics.indexOf(ds.metric);
      if (i >= 0) { if (st.metrics.length > 1) st.metrics.splice(i, 1); } else st.metrics = METRICS.map((m) => m.key).filter((k) => k === ds.metric || st.metrics.includes(k));
      keepOpen = true;
    } else if (ds.win) { st.win = Number(ds.win); reloadData = true; }
    else if (ds.base) { st.base = Number(ds.base); reloadData = true; }
    else if (ds.range) { st.days = Number(ds.range); st.offset = 0; }
    else if (ds.evwin) { st.ev.win = Number(ds.evwin); reloadData = true; }
    else if (ds.evdays) { st.ev.days = Number(ds.evdays); reloadData = true; }
    save();
    if (keepOpen) refreshOpenDD(); else closeDD();
    if (ds.units) buildRows();
    if (reloadData) refresh(false); else renderAll();
    return true;
  }

  // ---------------------------------------------------------- chart
  const chart = {
    cache: new Map(),       // key -> data
    reqId: 0,
    hover: null,
    model: null,

    range() {
      const span = st.days * 86400e3;
      const end = Date.now() - st.offset * span / 2;
      return { start: end - span, end, span };
    },

    async load() {
      const sec = $('[data-mg-section="chart"]');
      if (!visible || sec.getAttribute('data-collapsed') === 'true') return;
      const id = ++this.reqId;
      const { start, end, span } = this.range();
      const interval = span <= 86400e3 ? '15m' : span <= 3 * 86400e3 ? '1h' : span <= 7 * 86400e3 ? '1h' : '4h';
      const metrics = METRICS.filter((m) => st.metrics.includes(m.key));
      const model = { start, end, interval, panes: [] };
      $('#mg-chart-note').textContent = 'Загрузка…';
      const assets = st.assets.slice(0, 6);
      try {
        const perAsset = await Promise.all(assets.map((a) => this.assetData(a, metrics, start, end, interval)));
        if (id !== this.reqId) return;
        for (const m of metrics) {
          const series = [];
          perAsset.forEach((pa, i) => {
            const s = pa[m.key];
            if (s && s.length) series.push({ asset: assets[i], color: cssVar(SERIES_COLORS[i % SERIES_COLORS.length]), pts: s });
          });
          let label = m.label;
          if (m.key === 'price' && series.length > 1) label += ', % от начала';
          if (m.key === 'rate') label += ', % год.';
          if (['borrow', 'repay', 'net', 'pool'].includes(m.key)) label += st.units === 'USDT' ? ', USDT' : ', монеты';
          if (['borrow', 'repay', 'net'].includes(m.key)) label += ' · за ' + (interval === '15m' ? '15 мин' : interval === '1h' ? '1 ч' : '4 ч');
          model.panes.push({ key: m.key, label, series, needKey: m.needKey && data.mode !== 'key' });
        }
        this.model = model;
        const notes = [];
        if (metrics.some((m) => m.needKey) && data.mode !== 'key') notes.push('займы и пул — с API-ключом');
        if (st.offset) notes.push('сдвиг ' + F.fmtNum(st.offset * st.days / 2, 1) + ' д назад');
        $('#mg-chart-note').textContent = notes.join(' · ');
      } catch (e) {
        if (id !== this.reqId) return;
        $('#mg-chart-note').textContent = 'Ошибка загрузки: ' + e.message;
      }
      this.draw();
    },

    async assetData(asset, metrics, start, end, interval) {
      const out = {};
      const keys = metrics.map((m) => m.key);
      const tasks = [];
      if (keys.includes('price')) tasks.push(this.price(asset, start, end, interval).then((p) => { out.price = p; }).catch(() => { out.price = []; }));
      if (keys.includes('rate')) tasks.push(this.rate(asset, start, end).then((p) => { out.rate = p; }).catch(() => { out.rate = []; }));
      if (data.mode === 'key' && keys.some((k) => ['borrow', 'repay', 'net', 'pool'].includes(k))) {
        tasks.push(this.flows(asset, start, end, interval).then((f) => Object.assign(out, f)).catch(() => {}));
      }
      await Promise.all(tasks);
      return out;
    },

    async price(asset, start, end, interval) {
      if (asset === 'USDT') return [[start, 1], [end, 1]];
      const sym = asset === 'USDC' ? 'USDCUSDT' : asset + 'USDT';
      const key = 'p|' + sym + '|' + interval + '|' + Math.round(start / 60e3) + '|' + Math.round(end / 60e3);
      if (this.cache.has(key)) return this.cache.get(key);
      const url = D.MARKETS.spot.rest + '/klines?symbol=' + sym + '&interval=' + interval + '&startTime=' + Math.floor(start) + '&endTime=' + Math.floor(end) + '&limit=1000';
      const rows = await getJSON(url);
      const pts = rows.map((k) => [k[0], +k[4]]);
      this.cache.set(key, pts);
      return pts;
    },

    async rate(asset, start, end) {
      const key = 'r|' + asset + '|' + Math.round(start / 3600e3) + '|' + Math.round(end / 3600e3);
      if (this.cache.has(key)) return this.cache.get(key);
      // Binance принимает окно не длиннее 30 дней; берём запас 3 дня до начала, чтобы знать стартовое значение
      const from = Math.max(start - 3 * 86400e3, end - 29 * 86400e3);
      const j = await getJSON(BAPI + '/history-interest-rate?asset=' + encodeURIComponent(asset) + '&vipLevel=0&size=90&startTime=' + Math.floor(from) + '&endTime=' + Math.floor(end));
      if (j.code && j.code !== '000000') throw new Error(j.message || j.code);
      const raw = (j.data || []).map((x) => [+x.timestamp, +x.dailyInterestRate * 365 * 100]).sort((a, b) => a[0] - b[0]);
      // ступенчатая линия: значение действует до следующего изменения
      const pts = [];
      let cur = null;
      for (const [t, v] of raw) {
        if (t <= start) { cur = v; continue; }
        if (t > end) break;
        if (cur !== null) pts.push([Math.max(start, t - 1), cur]);
        else pts.push([start, v]);
        pts.push([t, v]);
        cur = v;
      }
      if (cur !== null) {
        if (!pts.length) pts.push([start, cur]);
        pts.push([end, cur]);
      }
      this.cache.set(key, pts);
      return pts;
    },

    async flows(asset, start, end, interval) {
      const days = Math.min(15, Math.ceil((Date.now() - start) / 86400e3) + 1);
      const s = await getJSON('/api/margin/series?asset=' + encodeURIComponent(asset) + '&days=' + days);
      const step = { '15m': 900e3, '1h': 3600e3, '4h': 14400e3 }[interval];
      const px = priceOf(asset, { price: s.price });
      const k = st.units === 'USDT' ? (px || null) : 1;
      const agg = new Map();
      for (let i = 0; i < s.t.length; i++) {
        const t = s.t[i] * 1000;
        if (t < start || t > end) continue;
        const b = Math.floor(t / step) * step;
        let a = agg.get(b);
        if (!a) { a = { b: 0, r: 0, p: null }; agg.set(b, a); }
        a.b += s.borrow[i];
        a.r += s.repay[i];
        if (s.pool[i] !== null) a.p = s.pool[i];
      }
      const keys = Array.from(agg.keys()).sort((x, y) => x - y);
      const mul = (v) => (k ? v * k : null);
      return {
        borrow: keys.map((t) => [t, mul(agg.get(t).b)]),
        repay: keys.map((t) => [t, mul(agg.get(t).r)]),
        net: keys.map((t) => [t, mul(agg.get(t).b - agg.get(t).r)]),
        pool: keys.filter((t) => agg.get(t).p !== null).map((t) => [t, mul(agg.get(t).p)])
      };
    },

    draw() {
      const cv = $('#mg-chart');
      const wrap = cv.parentElement;
      const m = this.model;
      const W = wrap.clientWidth;
      const paneH = 120;
      const axisH = 22;
      const panes = m ? m.panes : [];
      const H = Math.max(80, panes.length * paneH + axisH);
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.width = W + 'px';
      cv.style.height = H + 'px';
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!m) return;
      const axisW = 76;
      const plotW = W - axisW;
      const xOf = (t) => (t - m.start) / (m.end - m.start) * plotW;
      const mono = '11px "Geist Mono", ui-monospace, monospace';
      const border = cssVar('--color-border');
      const faint = cssVar('--color-faint');
      const text = cssVar('--color-text');
      ctx.font = mono;
      this.layout = { panes: [], plotW, xOf, m };
      panes.forEach((p, pi) => {
        const y0 = pi * paneH;
        const top = y0 + 22;
        const bot = y0 + paneH - 6;
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y0 + 0.5);
        ctx.lineTo(W, y0 + 0.5);
        ctx.moveTo(plotW + 0.5, y0);
        ctx.lineTo(plotW + 0.5, y0 + paneH);
        ctx.stroke();
        ctx.fillStyle = faint;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.label, 8, y0 + 11);
        // нормировка цены при нескольких активах
        let series = p.series;
        if (p.key === 'price' && series.length > 1) {
          series = series.map((s) => {
            const base = s.pts.find((x) => x[1] > 0);
            return Object.assign({}, s, { pts: base ? s.pts.map((x) => [x[0], (x[1] / base[1] - 1) * 100]) : [] });
          });
        }
        let mn = Infinity;
        let mx = -Infinity;
        for (const s of series) for (const [t, v] of s.pts) { if (v === null || !isFinite(v) || t < m.start || t > m.end) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
        const lp = { y0, top, bot, series, mn, mx, key: p.key };
        this.layout.panes.push(lp);
        if (p.needKey || !isFinite(mn)) {
          ctx.fillStyle = faint;
          ctx.textAlign = 'center';
          ctx.fillText(p.needKey ? 'Нужен API-ключ Binance и server.py' : 'Нет данных за период', plotW / 2, (top + bot) / 2);
          return;
        }
        if (mn === mx) { mn -= Math.abs(mn) * 0.01 || 1; mx += Math.abs(mx) * 0.01 || 1; }
        const pad = (mx - mn) * 0.08;
        mn -= pad; mx += pad;
        lp.mn = mn; lp.mx = mx;
        const yOf = (v) => bot - (v - mn) / (mx - mn) * (bot - top);
        lp.yOf = yOf;
        // сетка и ось
        ctx.strokeStyle = border;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        for (let k = 0; k <= 2; k++) {
          const v = mn + (mx - mn) * k / 2;
          const y = Math.round(yOf(v)) + 0.5;
          ctx.moveTo(0, y);
          ctx.lineTo(plotW, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = faint;
        ctx.textAlign = 'left';
        for (let k = 0; k <= 2; k++) {
          const v = mn + (mx - mn) * k / 2;
          ctx.fillText(this.fmtV(p.key, v, series.length > 1), plotW + 6, Math.max(top, Math.min(bot, yOf(v))));
        }
        const isBars = (p.key === 'borrow' || p.key === 'repay' || p.key === 'net') && series.length === 1;
        for (const s of series) {
          if (isBars) {
            const pts = s.pts.filter((x) => x[1] !== null);
            const bw = Math.max(1, plotW / Math.max(1, (m.end - m.start) / ({ '15m': 900e3, '1h': 3600e3, '4h': 14400e3 }[m.interval])) * 0.7);
            const y0v = yOf(Math.max(mn, Math.min(mx, 0)));
            for (const [t, v] of pts) {
              const x = xOf(t);
              const y = yOf(v);
              ctx.fillStyle = p.key === 'net' ? (v >= 0 ? cssVar('--color-series-1') : cssVar('--color-up')) : s.color;
              ctx.fillRect(x - bw / 2, Math.min(y, y0v), bw, Math.max(1, Math.abs(y - y0v)));
            }
          } else {
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            let started = false;
            for (const [t, v] of s.pts) {
              if (v === null || !isFinite(v)) { started = false; continue; }
              const x = xOf(t);
              const y = yOf(v);
              if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }
        // легенда активов
        let lx = ctx.measureText(p.label).width + 24;
        for (const s of series) {
          ctx.fillStyle = s.color;
          ctx.fillRect(lx, y0 + 7, 10, 3);
          ctx.fillStyle = text;
          ctx.fillText(s.asset, lx + 14, y0 + 11);
          lx += ctx.measureText(s.asset).width + 30;
        }
      });
      // ось времени
      const yA = panes.length * paneH;
      ctx.strokeStyle = border;
      ctx.beginPath();
      ctx.moveTo(0, yA + 0.5);
      ctx.lineTo(W, yA + 0.5);
      ctx.stroke();
      const span = m.end - m.start;
      const step = span <= 86400e3 ? 3 * 3600e3 : span <= 3 * 86400e3 ? 12 * 3600e3 : 86400e3 * (span <= 7 * 86400e3 ? 1 : 2);
      ctx.fillStyle = faint;
      ctx.textAlign = 'center';
      for (let t = Math.ceil(m.start / step) * step; t <= m.end; t += step) {
        const x = xOf(t);
        if (x < 24 || x > plotW - 24) continue;
        const d = new Date(t);
        const p2 = (n) => String(n).padStart(2, '0');
        const lab = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1) : p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
        ctx.fillText(lab, x, yA + 11);
      }
      // перекрестие
      if (this.hover !== null && this.layout) {
        const x = this.hover;
        if (x >= 0 && x <= plotW) {
          const t = m.start + x / plotW * (m.end - m.start);
          ctx.strokeStyle = faint;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, yA);
          ctx.stroke();
          ctx.setLineDash([]);
          const d = new Date(t);
          const p2 = (n) => String(n).padStart(2, '0');
          const lab = p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
          const tw = ctx.measureText(lab).width + 12;
          ctx.fillStyle = cssVar('--color-series-bone');
          ctx.fillRect(Math.max(0, Math.min(plotW - tw, x - tw / 2)), yA + 2, tw, 18);
          ctx.fillStyle = cssVar('--color-bg');
          ctx.fillText(lab, Math.max(tw / 2, Math.min(plotW - tw / 2, x)), yA + 11);
          for (const lp of this.layout.panes) {
            if (!lp.yOf) continue;
            let ly = lp.y0 + 11;
            let lx2 = plotW - 8;
            ctx.textAlign = 'right';
            for (let si = lp.series.length - 1; si >= 0; si--) {
              const s = lp.series[si];
              let best = null;
              for (const pt of s.pts) { if (pt[0] <= t) best = pt; else break; }
              if (!best || best[1] === null) continue;
              const txt = s.asset + ' ' + this.fmtV(lp.key, best[1], lp.series.length > 1);
              ctx.fillStyle = s.color;
              ctx.fillText(txt, lx2, ly);
              lx2 -= ctx.measureText(txt).width + 14;
            }
          }
        }
      }
    },

    fmtV(key, v, normalized) {
      if (!isFinite(v)) return '—';
      if (key === 'price') return normalized ? F.fmtSigned(v, (x) => F.fmtNum(x, 2)) + '%' : F.fmtNum(v, v >= 100 ? 1 : v >= 1 ? 3 : 6);
      if (key === 'rate') return F.fmtNum(v, 2) + '%';
      return F.fmtShort(v);
    }
  };

  // ---------------------------------------------------------- bind
  function bind() {
    const page = $('#page-margin');
    page.addEventListener('click', (e) => {
      if (onOption(e)) return;
      const ddBtn = e.target.closest('.mg-dd > button');
      if (ddBtn) { e.stopPropagation(); openDropdown(ddBtn.parentElement); return; }
      if (e.target.closest('.mg-dd-menu')) return;
      closeDD();
      const th = e.target.closest('th[data-sort]');
      if (th && th.closest('#mg-thead')) {
        const k = th.dataset.sort;
        if (k === 'asset') return;
        if (st.sort.key === k) st.sort.dir *= -1; else { st.sort.key = k; st.sort.dir = -1; }
        save();
        renderToolbar();
        renderTable();
        return;
      }
      const tr = e.target.closest('tr[data-asset]');
      if (tr) {
        const a = tr.dataset.asset;
        const i = st.assets.indexOf(a);
        if (i >= 0) st.assets.splice(i, 1);
        else {
          if (st.assets.length >= 6) st.assets.shift();
          st.assets.push(a);
        }
        save();
        renderToolbar();
        renderTable();
        st.collapsed.chart = false;
        renderSections();
        chart.load();
        return;
      }
      const sec = e.target.closest('[data-mg-toggle]');
      if (sec) {
        const id = sec.dataset.mgToggle;
        st.collapsed[id] = !st.collapsed[id];
        save();
        renderSections();
        if (id === 'chart' && !st.collapsed.chart) chart.load();
        return;
      }
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        const a = nav.dataset.nav;
        const i = RANGES.indexOf(st.days);
        if (a === 'back') st.offset += 1;
        else if (a === 'fwd') st.offset = Math.max(0, st.offset - 1);
        else if (a === 'zoomin') st.days = RANGES[Math.max(0, i - 1)];
        else if (a === 'zoomout') st.days = RANGES[Math.min(RANGES.length - 1, i + 1)];
        else if (a === 'reload') { chart.cache.clear(); refresh(true); return; }
        save();
        renderToolbar();
        chart.load();
        return;
      }
      if (e.target.closest('[data-help]')) {
        const h = $('#mg-help');
        h.hidden = !h.hidden;
      }
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.mg-dd')) closeDD(); });
    $('#mg-search').addEventListener('input', () => renderTable());
    window.addEventListener('keydown', (e) => {
      if (!visible) return;
      if (e.key === '/' && document.activeElement && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        $('#mg-search').focus();
      }
      if (e.key === 'Escape') closeDD();
    });
    const evInput = (id, key) => $(id).addEventListener('change', (e) => {
      const v = Number(e.target.value);
      if (isFinite(v) && v >= 0) { st.ev[key] = v; save(); refresh(false); }
    });
    evInput('#mg-ev-min', 'min24');
    evInput('#mg-ev-growth', 'growth');
    const cv = $('#mg-chart');
    cv.addEventListener('mousemove', (e) => { const r = cv.getBoundingClientRect(); chart.hover = e.clientX - r.left; chart.draw(); });
    cv.addEventListener('mouseleave', () => { chart.hover = null; chart.draw(); });
    window.addEventListener('resize', () => { if (visible) chart.draw(); });
  }

  // ---------------------------------------------------------- public API
  function show() {
    visible = true;
    if (!inited) { inited = true; bind(); }
    refresh(true);
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refresh(false), 60e3);
    clearInterval(clockTimer);
    tickClock();
    clockTimer = setInterval(tickClock, 1000);
  }

  function hide() {
    visible = false;
    clearInterval(refreshTimer);
    clearInterval(clockTimer);
    closeDD();
  }

  window.CTMargin = { show, hide, get state() { return st; }, get data() { return data; } };
})();
