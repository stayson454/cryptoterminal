/* ==========================================================================
   app.js — логика терминала.
     • Вкладки графиков и раскладки «Один / Два рядом / Два стопкой».
     • Ячейка графика (CellView): свой DataEngine + ChartRenderer.
     • Шапка: таймфрейм, вид, метрика окраски, детализация (tickSize).
     • Окно «Индикаторы»: на графике / добавить (каталог indicators.js).
     • Правая панель: «Инструменты» (Площадки / Активы, ★, Фильтры),
       «Маржа» (фандинг, OI, лонг/шорт), «Мой доступ» (данные и настройки).
     • Ценовые уведомления (колокольчик).
   ========================================================================== */
(function () {
  'use strict';

  const D = window.CTData;
  const F = window.CTFormat;
  const IND = window.CTIndicators;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const STORE_KEY = 'cryptoterminal.state.v2';
  const DETAIL_MULTS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const METRIC_LABEL = {
    volume: 'Объём',
    delta: 'Дельта объёма',
    buysell: 'Покупки/продажи',
    trades: 'Сделки',
    tradesDelta: 'Дельта сделок'
  };
  const ICON_X = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
  const ICON_CHEV = '<svg class="ct-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>';
  const ICON_STAR = '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>';

  // ================================================================ state
  function uid(p) { return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function newCell(from) {
    if (from) {
      const c = JSON.parse(JSON.stringify(from, skipPrivate));
      c.indicators = c.indicators.map((i) => IND.create(i.type, i.params));
      return c;
    }
    return {
      market: 'futures', symbol: 'BTCUSDT', tf: '5m',
      view: 'profile', metric: 'delta',
      detail: {}, zBase: '4h',
      indicators: IND.defaultSet()
    };
  }

  function newTab(fromTab) {
    if (fromTab) {
      return { id: uid('t'), name: null, layout: fromTab.layout, active: fromTab.active, cells: fromTab.cells.map((c) => newCell(c)) };
    }
    return { id: uid('t'), name: null, layout: 'one', active: 0, cells: [newCell()] };
  }

  function skipPrivate(k, v) { return k && k[0] === '_' ? undefined : v; }

  const defaults = () => ({
    tabs: [newTab()],
    activeTab: 0,
    dock: { open: true, view: 'instruments', width: 384 },
    watch: {
      mode: 'venues',
      favOnly: true,
      favorites: ['futures:BTCUSDT', 'futures:ETHUSDT', 'spot:BTCUSDT', 'spot:ETHUSDT', 'coinbase:BTC-USDT', 'deribit:BTC_USDT'],
      sort: { key: 'volume', dir: -1 },
      collapsed: {},
      venues: { futures: true, spot: true, coinbase: true, deribit: true },
      minVol: 0
    },
    alerts: [],
    tz: 'utc'
  });

  function loadState() {
    const d = defaults();
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return d;
      const s = JSON.parse(raw);
      const out = Object.assign(d, s);
      out.dock = Object.assign(defaults().dock, s.dock || {});
      if (out.dock.view !== 'instruments' && out.dock.view !== 'access') out.dock.view = 'instruments';
      out.watch = Object.assign(defaults().watch, s.watch || {});
      out.watch.venues = Object.assign(defaults().watch.venues, (s.watch && s.watch.venues) || {});
      if (!Array.isArray(out.tabs) || !out.tabs.length) out.tabs = [newTab()];
      for (const t of out.tabs) {
        if (!Array.isArray(t.cells) || !t.cells.length) t.cells = [newCell()];
        for (const c of t.cells) {
          if (!Array.isArray(c.indicators)) c.indicators = IND.defaultSet();
          c.indicators = c.indicators.filter((i) => IND.DEFS[i.type]).map((i) => Object.assign(i, { params: Object.assign({}, IND.DEFS[i.type].defaults, i.params) }));
          if (!c.detail) c.detail = {};
          if (!c.zBase || !D.BASES[c.zBase]) c.zBase = '4h';
        }
        if (t.active >= t.cells.length) t.active = 0;
        if (!['one', 'cols', 'rows'].includes(t.layout)) t.layout = 'one';
      }
      if (out.activeTab >= out.tabs.length) out.activeTab = 0;
      if (!Array.isArray(out.alerts)) out.alerts = [];
      return out;
    } catch (e) {
      return d;
    }
  }

  let state = loadState();
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state, skipPrivate)); } catch (e) { /* квота */ }
    }, 250);
  }

  const tab = () => state.tabs[state.activeTab];
  const visibleCount = () => (tab().layout === 'one' ? 1 : 2);
  const activeIdx = () => Math.min(tab().active, visibleCount() - 1);
  const cellState = (i) => tab().cells[i === undefined ? activeIdx() : i];

  // ================================================================ utils
  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.setAttribute('data-show', 'true');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.setAttribute('data-show', 'false'), ms || 2800);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function fmtUtc(t, withDate) {
    const d = new Date(t);
    const hm = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    if (!withDate) return hm;
    return String(d.getUTCDate()).padStart(2, '0') + '.' + String(d.getUTCMonth() + 1).padStart(2, '0') + ' ' + hm;
  }

  function pctLabel(p) { return F.fmtNum(p, p % 1 ? (Math.round(p * 100) % 10 ? 2 : 1) : 0) + ' %'; }

  function priceFmt(p) {
    if (!(p > 0)) return '—';
    const dec = p >= 1000 ? 1 : p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 7;
    return F.fmtNum(p, dec);
  }

  // ============================================================ CellView
  const tickers = new D.TickerFeed();
  const views = [];

  class CellView {
    constructor(idx) {
      this.idx = idx;
      const frag = $('#cell-tpl').content.cloneNode(true);
      this.el = frag.querySelector('[data-cell]');
      $('#cells').appendChild(this.el);
      const q = (n) => this.el.querySelector('[data-el="' + n + '"]');
      this.q = q;
      this.engine = new D.DataEngine(window.StorageDB);
      this.renderer = new window.ChartRenderer({
        host: q('host'),
        base: q('base'),
        overlay: q('overlay'),
        profile: q('profile'),
        tooltip: q('tooltip'),
        autoBtn: q('auto'),
        zoneChip: q('zone'),
        legendLayer: q('legends')
      });
      this.renderer.onLegendAction = (u, act, key, val) => onLegendAction(this, u, act, key, val);
      this.loadKey = '';
      this.viewKey = '';
      this.rowSize = 10;
      this._bindDom();
      this._bindEngine();
    }

    get cell() { return tab().cells[this.idx]; }
    get active() { return activeIdx() === this.idx; }

    destroy() {
      this.engine.destroy();
      this.renderer.destroy();
      this.el.remove();
    }

    _bindDom() {
      const q = this.q;
      this.el.addEventListener('pointerdown', () => {
        if (activeIdx() !== this.idx) {
          tab().active = this.idx;
          save();
          syncActive();
        }
      }, true);
      const ruler = q('ruler');
      ruler.addEventListener('click', () => this.toggleRuler());
      q('auto').addEventListener('click', () => this.renderer.setAuto(!this.renderer.auto));
      q('zone').addEventListener('click', () => {
        state.tz = state.tz === 'utc' ? 'local' : 'utc';
        save();
        views.forEach((v) => v.pushOptions());
      });
      q('zswitch').addEventListener('click', (e) => {
        e.stopPropagation();
        let z = this.cell.indicators.find((i) => i.type === 'zscore');
        if (!z) { z = IND.create('zscore'); this.cell.indicators.splice(1, 0, z); }
        else z.params.visible = z.params.visible === false;
        save();
        this.pushIndicators();
        renderIndPop();
      });
      q('zmore').addEventListener('click', (e) => {
        e.stopPropagation();
        const pop = q('zpop');
        pop.setAttribute('data-open', pop.getAttribute('data-open') === 'true' ? 'false' : 'true');
        this.updateZStat();
      });
    }

    toggleRuler() {
      const b = this.q('ruler');
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      this.renderer.setRuler(on);
      if (on) toast('Линейка: щелчок — начало, щелчок — конец, Esc — сброс');
    }

    _bindEngine() {
      const e = this.engine;
      e.on('loading', (ev) => this.showLoading(ev.stage));
      e.on('reload', () => {
        this.hideLoading();
        this.applyDetail();
        this.pushOptions();
        this.pushIndicators();
        const key = e.market + ':' + e.symbol + ':' + e.tf;
        if (this.viewKey !== key) {
          this.viewKey = key;
          this.renderer.setEngine(e);
        } else {
          this.renderer.onDataReplaced();
        }
        this.updateZStat();
        this.syncLive();
        if (this.active) { syncHeader(); updateDockDynamic(); }
        renderTabs();
      });
      e.on('tick', (tr) => {
        this.renderer.requestDraw(false);
        checkAlerts(e.market, e.symbol, tr.p);
      });
      e.on('newCandle', () => this.renderer.onNewCandle());
      e.on('book', () => {
        this.renderer.requestDraw(false);
        if (this.q('zpop').getAttribute('data-open') === 'true') this.updateZStat();
        this.updateZSource();
      });
      e.on('stored', () => { if (state.dock.view === 'access') renderAccess(); });
      e.on('status', () => { this.syncLive(); if (state.dock.view === 'access') renderAccess(); });
    }

    showLoading(text, isError) {
      const box = this.q('loading');
      if (box.getAttribute('data-show') !== 'true') this.loadingSince = Date.now();
      box.setAttribute('data-show', 'true');
      this.isLoadError = !!isError;
      const t = this.q('loading-text');
      this.q('spinner').style.display = isError ? 'none' : '';
      if (isError) {
        t.innerHTML = esc(text) + ' <span class="ct-link-btn" style="color:var(--color-accent-2);cursor:pointer;text-decoration:underline">Повторить</span>';
        t.querySelector('span').addEventListener('click', () => this.load(true));
      } else {
        t.textContent = text;
      }
    }

    hideLoading() { this.q('loading').setAttribute('data-show', 'false'); this.loadingSince = 0; this.isLoadError = false; }

    async load(force) {
      const c = this.cell;
      const key = c.market + ':' + c.symbol + ':' + c.tf;
      if (!force && key === this.loadKey) {
        if (this.engine.base !== c.zBase && this.engine.ready) this.engine.setBase(c.zBase).catch(() => {});
        this.pushOptions();
        this.pushIndicators();
        return;
      }
      this.loadKey = key;
      this.showLoading('Загрузка ' + c.symbol + '…');
      this.pushOptions();
      this.pushIndicators();
      try {
        await this.engine.load({ market: c.market, symbol: c.symbol, tf: c.tf, base: c.zBase });
      } catch (err) {
        console.error(err);
        if (this.loadKey === key) this.showLoading('Ошибка загрузки: ' + (err && err.message ? err.message : err), true);
      }
    }

    detailKey() { return this.cell.market + ':' + this.cell.symbol + ':' + this.cell.tf; }

    applyDetail() {
      const tick = this.engine.tick || 0.01;
      let idx = this.cell.detail[this.detailKey()];
      if (idx === undefined) {
        idx = defaultDetailIdx(this.engine.lastPrice, tick, this.engine.tfMs);
        this.cell.detail[this.detailKey()] = idx;
        save();
      }
      const dec = Math.max(D.decimalsOf(tick), 0);
      this.rowSize = Number((DETAIL_MULTS[idx] * tick).toFixed(dec));
      this.detailLabel = F.fmtNum(this.rowSize, D.decimalsOf(this.rowSize)) + ' ' + ((this.engine.info && this.engine.info.quote) || 'USDT');
      this.q('lg-detail').textContent = this.detailLabel;
      this.renderer.setOptions({ rowSize: this.rowSize });
      if (this.active) syncHeader();
    }

    pushOptions() {
      const c = this.cell;
      const e = this.engine;
      const base = (e.info && e.info.base) || D.assetOf(c.symbol);
      this.renderer.setOptions({
        view: c.view,
        metric: c.metric,
        rowSize: this.rowSize,
        tz: state.tz,
        baseAsset: base,
        quoteAsset: (e.info && e.info.quote) || 'USDT',
        priceDecimals: e.priceDecimals !== undefined ? e.priceDecimals : 2,
        tfLabel: D.TF_LABEL[c.tf]
      });
      const unit = c.metric === 'trades' || c.metric === 'tradesDelta' ? '' : ', ' + base;
      this.q('lg-metric').textContent = METRIC_LABEL[c.metric] + unit;
      const scale = this.q('lg-scale');
      scale.innerHTML = c.metric === 'volume' || c.metric === 'trades'
        ? '<i style="background:var(--color-surface-2)"></i><i style="background:var(--color-up)"></i>'
        : '<i style="background:var(--color-down)"></i><i style="background:var(--color-up)"></i>';
      this.q('zone').textContent = state.tz === 'utc' ? 'UTC' : 'Местное';
      this.q('celltitle').textContent = c.symbol + ' · ' + (c.market === 'spot' ? 'спот' : 'фьючерсы') + ' · ' + D.TF_LABEL[c.tf];
    }

    pushIndicators() {
      this.renderer.setIndicators(this.cell.indicators);
      const z = this.cell.indicators.find((i) => i.type === 'zscore');
      const on = !!(z && z.params.visible !== false);
      this.q('zswitch').setAttribute('aria-checked', on ? 'true' : 'false');
      this.q('zpop-base').textContent = 'база ' + D.BASE_LABEL[this.cell.zBase];
      if (this.active) syncHeader();
    }

    syncLive() {
      const st = this.engine.status.trades;
      this.q('lg-live').setAttribute('data-state', st);
      this.q('lg-live-text').textContent = st === 'live' ? 'в реальном времени' : st === 'error' ? 'нет соединения, переподключение…' : 'подключение…';
    }

    updateZSource() {
      const zi = this.engine.zInfo;
      if (!zi) return;
      const total = this.engine.candles.length;
      this.q('zsrc').setAttribute('data-source', zi.realCandles >= total ? 'real' : zi.realCandles > 0 || zi.storedCandles > 0 ? 'mixed' : 'model');
    }

    updateZStat() {
      const zi = this.engine.zInfo;
      const el = this.q('zpop-stat');
      if (!zi) { el.textContent = '—'; return; }
      this.updateZSource();
      const total = this.engine.candles.length;
      el.innerHTML = 'Реальный стакан: <span class="ct-zstat">' + zi.realCandles + '</span> из ' + total + ' свечей' +
        (zi.storedCandles ? ', Z из IndexedDB: <span class="ct-zstat">' + zi.storedCandles + '</span>' : '') +
        '. Остальные — реконструкция по OHLCV, taker-buy и объёмным узлам' + (zi.calibrated ? ', откалиброванная по снимкам depth' : ' (ждёт первого снимка depth для калибровки)') + '. ' +
        'База ' + zi.baseLabel + ' по свечам ' + D.TF_LABEL[zi.tfB] + ', покрытие ' + F.fmtNum(zi.baseCoverage * 100, 0) + ' %.';
    }
  }

  function defaultDetailIdx(price, tick, tfMs) {
    if (!(price > 0) || !(tick > 0)) return 3;
    // крупнее таймфрейм — крупнее шаг строки (5м ≈ 10 USDT, 1ч ≈ 50 USDT на BTC)
    const target = price * 0.00013 * Math.sqrt(Math.max(1, (tfMs || 300e3) / 300e3));
    let best = 0;
    let bestErr = Infinity;
    DETAIL_MULTS.forEach((m, i) => {
      const err = Math.abs(Math.log(m * tick / target));
      if (err < bestErr) { bestErr = err; best = i; }
    });
    return best;
  }

  const activeView = () => views[activeIdx()];

  // ------------------------------------------------------------ cells
  function syncCells() {
    const t = tab();
    if (t.layout !== 'one' && t.cells.length < 2) t.cells.push(newCell(t.cells[0]));
    const need = visibleCount();
    while (views.length > need) views.pop().destroy();
    while (views.length < need) views.push(new CellView(views.length));
    $('#cells').setAttribute('data-layout', t.layout);
    views.forEach((v) => v.load(false));
    syncActive();
  }

  function syncActive() {
    views.forEach((v) => v.el.setAttribute('data-active', v.active ? 'true' : 'false'));
    syncHeader();
    renderTabs();
    renderIndPop();
    updateDockDynamic();
    renderAlerts();
  }

  function reloadActive() {
    const v = activeView();
    if (v) v.load(false);
    syncHeader();
    renderTabs();
  }

  // ================================================================ header
  function syncHeader() {
    const v = activeView();
    const c = cellState();
    $$('#tf-group [data-tf]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tf === c.tf ? 'true' : 'false'));
    $$('#view-group [data-view]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === c.view ? 'true' : 'false'));
    $('#metric-label').textContent = METRIC_LABEL[c.metric];
    $$('#metric-menu [data-metric]').forEach((b) => {
      const on = b.dataset.metric === c.metric;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.querySelector('.ct-check').textContent = on ? '✓' : '';
    });
    const m = D.MARKETS[c.market];
    $('#title-symbol').textContent = c.symbol;
    $('#title-market').textContent = m.label;
    if (document.body.getAttribute('data-route') !== 'margin') document.title = c.symbol + ' · ' + m.label + ' — график — CryptoTerminal';
    if (v) {
      const idx = c.detail[c.market + ':' + c.symbol + ':' + c.tf];
      if (idx !== undefined) $('#detail-range').value = String(idx);
      $('#detail-value').textContent = v.detailLabel || '—';
    }
    $('#ind-count').textContent = String(c.indicators.length);
    $('#dock-btn').setAttribute('aria-pressed', state.dock.open && state.dock.view === 'instruments' ? 'true' : 'false');
    $$('#layout-group [data-layout]').forEach((b) => b.setAttribute('aria-checked', b.dataset.layout === tab().layout ? 'true' : 'false'));
  }

  function bindHeader() {
    $('#tf-group').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tf]');
      if (!b || b.dataset.tf === cellState().tf) return;
      cellState().tf = b.dataset.tf;
      save();
      reloadActive();
    });
    $('#view-group').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (!b) return;
      cellState().view = b.dataset.view;
      save();
      activeView().pushOptions();
      syncHeader();
    });
    const menu = $('#metric-menu');
    $('#metric-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.getAttribute('data-open') === 'true';
      menu.setAttribute('data-open', open ? 'false' : 'true');
      $('#metric-btn').setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-metric]');
      if (!b) return;
      cellState().metric = b.dataset.metric;
      menu.setAttribute('data-open', 'false');
      save();
      activeView().pushOptions();
      syncHeader();
    });
    $('#detail-range').addEventListener('input', (e) => {
      const c = cellState();
      c.detail[c.market + ':' + c.symbol + ':' + c.tf] = Number(e.target.value);
      save();
      activeView().applyDetail();
    });
    $('#ind-btn').addEventListener('click', (e) => { e.stopPropagation(); togglePop('ind-pop', $('#ind-btn')); });
    $('#dock-btn').addEventListener('click', () => {
      if (state.dock.open && state.dock.view === 'instruments') state.dock.open = false;
      else { state.dock.open = true; state.dock.view = 'instruments'; }
      save();
      syncDock();
    });
    $('#title-btn').addEventListener('click', () => {
      state.dock.open = true;
      state.dock.view = 'instruments';
      save();
      syncDock();
      setTimeout(() => { const i = $('#tk-search'); i.focus(); i.select(); }, 30);
    });
    $('#bell-btn').addEventListener('click', (e) => { e.stopPropagation(); togglePop('alert-pop', $('#bell-btn'), true); });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#metric-dd')) menu.setAttribute('data-open', 'false');
      if (!e.target.closest('[data-el="zpop"]') && !e.target.closest('[data-el="zmore"]')) $$('[data-el="zpop"]').forEach((p) => p.setAttribute('data-open', 'false'));
      for (const id of ['ind-pop', 'alert-pop', 'filter-pop']) {
        const p = $('#' + id);
        if (p.getAttribute('data-open') === 'true' && !e.target.closest('#' + id) && !e.target.closest('[data-pop-anchor="' + id + '"]')) closePop(id);
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { ['ind-pop', 'alert-pop', 'filter-pop'].forEach(closePop); menu.setAttribute('data-open', 'false'); }
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') activeView().toggleRuler();
    });
    window.addEventListener('resize', () => { for (const id of ['ind-pop', 'alert-pop', 'filter-pop']) if ($('#' + id).getAttribute('data-open') === 'true') positionPop(id); });

    // rail
    $('#rail-toggle').addEventListener('click', () => {
      const rail = $('#app-shell-rail');
      const exp = !rail.classList.contains('ct-rail-expanded');
      rail.classList.toggle('ct-rail-expanded', exp);
      rail.classList.toggle('w-16', !exp);
      rail.setAttribute('data-collapsed', exp ? 'false' : 'true');
      $('#rail-toggle').setAttribute('aria-expanded', exp ? 'true' : 'false');
      $('#rail-toggle').setAttribute('aria-label', exp ? 'Свернуть меню' : 'Развернуть меню');
    });
    $$('.ct-rail-link').forEach((a) => a.addEventListener('click', () => {
      const r = a.dataset.rail;
      if (r === 'margin') { location.hash = '#/margin'; return; }
      state.dock.open = true;
      state.dock.view = r === 'access' ? 'access' : 'instruments';
      save();
      if (location.hash !== '#/chart' && location.hash !== '') location.hash = '#/chart';
      else applyRoute();
      syncDock();
    }));
    $('#mg-bell').addEventListener('click', (e) => { e.stopPropagation(); togglePop('alert-pop', $('#mg-bell')); });
    window.addEventListener('hashchange', applyRoute);
  }

  // ================================================================ routes
  function applyRoute() {
    const route = location.hash === '#/margin' ? 'margin' : 'chart';
    document.body.setAttribute('data-route', route);
    $('#page-margin').hidden = route !== 'margin';
    if (route === 'margin') {
      ['ind-pop', 'filter-pop'].forEach(closePop);
      window.CTMargin.show();
      document.title = 'Маржа Binance — CryptoTerminal';
    } else {
      window.CTMargin.hide();
      syncHeader();
    }
    syncRail();
  }

  function syncRail() {
    const route = document.body.getAttribute('data-route') || 'chart';
    $$('.ct-rail-link').forEach((a) => {
      const r = a.dataset.rail;
      let cur;
      if (r === 'margin') cur = route === 'margin';
      else if (r === 'access') cur = route === 'chart' && state.dock.open && state.dock.view === 'access';
      else cur = route === 'chart' && !(state.dock.open && state.dock.view === 'access');
      if (cur) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  // ================================================================ popovers
  const popAnchors = {};
  function positionPop(id) {
    const pop = $('#' + id);
    const a = popAnchors[id];
    if (!a) return;
    const r = a.getBoundingClientRect();
    const w = pop.offsetWidth || 400;
    let left = r.right - w;
    if (left < 8) left = 8;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    pop.style.left = left + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
  }

  function togglePop(id, anchor) {
    const pop = $('#' + id);
    if (pop.getAttribute('data-open') === 'true') { closePop(id); return; }
    ['ind-pop', 'alert-pop', 'filter-pop'].forEach((x) => { if (x !== id) closePop(x); });
    popAnchors[id] = anchor;
    anchor.setAttribute('data-pop-anchor', id);
    pop.setAttribute('data-open', 'true');
    if (id === 'ind-pop') renderIndPop();
    if (id === 'alert-pop') renderAlerts();
    if (id === 'filter-pop') renderFilters();
    anchor.setAttribute('aria-expanded', 'true');
    positionPop(id);
  }

  function closePop(id) {
    const pop = $('#' + id);
    pop.setAttribute('data-open', 'false');
    const a = popAnchors[id];
    if (a) a.setAttribute('aria-expanded', 'false');
  }

  // ============================================================ indicators
  const openInd = {};

  function paneCount(c) {
    return c.indicators.filter((i) => IND.DEFS[i.type].kind === 'pane').length;
  }

  function settingHTML(cell, inst, s) {
    let cur;
    if (s.key === '__base') cur = cell.zBase;
    else cur = inst.params[s.key];
    if (s.type === 'seg') {
      return '<div class="ct-field"><span>' + s.label + '</span><span class="ct-opts">' + s.options.map((o) =>
        '<button type="button" class="ct-opt" data-uid="' + inst.uid + '" data-key="' + s.key + '" data-val="' + esc(String(o[0])) + '" aria-pressed="' + (String(o[0]) === String(cur)) + '">' + o[1] + '</button>'
      ).join('') + '</span></div>';
    }
    if (s.type === 'threshold') {
      const on = !!inst.params.thresholdOn;
      return '<div class="ct-field"><span>' + s.label + '</span><span class="ct-opts">' +
        '<button type="button" class="ct-opt" data-uid="' + inst.uid + '" data-key="thresholdOn" data-val="false" aria-pressed="' + !on + '">Нет</button>' +
        '<button type="button" class="ct-opt" data-uid="' + inst.uid + '" data-key="thresholdOn" data-val="true" aria-pressed="' + on + '">Число</button>' +
        '<input type="number" class="ct-num-input" data-uid="' + inst.uid + '" data-num="threshold" min="0.1" max="6" step="0.1" value="' + inst.params.threshold + '"' + (on ? '' : ' disabled') + ' title="|Z| ≥ порога — подсветка аномалии">' +
        '</span></div>';
    }
    return '';
  }

  function renderIndPop() {
    const body = $('#ind-pop-body');
    if (!body) return;
    const v = activeView();
    const c = cellState();
    const r = v ? v.renderer : null;
    const pc = paneCount(c);
    $('#ind-pop-count').textContent = pc + ' из ' + IND.MAX_PANES + ' подпанелей';
    let h = '<div class="ct-pop-sub">На графике</div>';
    if (!c.indicators.length) h += '<div class="ct-empty">Нет индикаторов</div>';
    for (const inst of c.indicators) {
      const def = IND.DEFS[inst.type];
      const title = def.listTitle ? def.listTitle(inst, r) : def.title(inst, r || { opt: { baseAsset: D.assetOf(c.symbol) }, engineBase: () => c.zBase });
      const open = !!openInd[inst.uid];
      h += '<div class="ct-ind" data-ind="' + inst.uid + '" data-open="' + open + '"' + (flashUid === inst.uid ? ' data-flash="true"' : '') + '>' +
        '<div class="ct-ind-row" data-toggle="' + inst.uid + '">' + ICON_CHEV +
        '<span class="ct-ind-name">' + title + '</span>' +
        '<span class="ct-x" data-remove="' + inst.uid + '" title="Убрать">' + ICON_X + '</span></div>' +
        '<div class="ct-ind-body">' + (def.settings || []).map((s) => settingHTML(c, inst, s)).join('') + '</div></div>';
    }
    h += '<div class="ct-pop-sep"></div><div class="ct-pop-sub">Добавить</div>';
    for (const cat of IND.CATEGORIES) {
      const types = IND.ORDER.filter((t) => IND.DEFS[t].cat === cat.id);
      const avail = types.filter((t) => !(IND.DEFS[t].cat === 'chart' && c.indicators.some((i) => i.type === t)));
      if (!avail.length) continue;
      h += '<div class="ct-add-cat"><span>' + cat.label + '</span><span>' + cat.note + '</span></div>';
      for (const t of avail) {
        const def = IND.DEFS[t];
        const full = def.kind === 'pane' && pc >= IND.MAX_PANES;
        h += '<div class="ct-add-row" data-add="' + t + '" aria-disabled="' + full + '" title="' + (full ? 'Не больше ' + IND.MAX_PANES + ' подпанелей' : 'Добавить') + '"><b>' + def.name + '</b><span class="ct-add-desc">' + def.desc + '</span><span class="ct-plus">+</span></div>';
      }
    }
    body.innerHTML = h;
    syncHeader();
  }

  let flashUid = null;
  function openIndicatorConfig(view, u) {
    openInd[u] = true;
    flashUid = u;
    if ($('#ind-pop').getAttribute('data-open') !== 'true') togglePop('ind-pop', $('#ind-btn'));
    else renderIndPop();
    const el = $('#ind-pop-body [data-ind="' + u + '"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
    setTimeout(() => { flashUid = null; const x = $('#ind-pop-body [data-ind="' + u + '"]'); if (x) x.removeAttribute('data-flash'); }, 1200);
  }

  function applyIndChange(view, opts) {
    save();
    if (opts && opts.base) {
      view.engine.setBase(view.cell.zBase).catch((err) => toast('Не удалось загрузить базу: ' + err.message));
    }
    view.pushIndicators();
    renderIndPop();
  }

  function setParam(view, u, key, val) {
    const c = view.cell;
    const inst = c.indicators.find((i) => i.uid === u);
    if (!inst) return;
    if (key === '__base') {
      if (c.zBase === val) return;
      c.zBase = val;
      applyIndChange(view, { base: true });
      return;
    }
    const def = IND.DEFS[inst.type];
    const sch = (def.settings || []).find((s) => s.key === key);
    if (sch && sch.type === 'seg') {
      const opt = sch.options.find((o) => String(o[0]) === String(val));
      if (opt) val = opt[0];
    }
    if (key === 'thresholdOn') val = val === true || val === 'true';
    inst.params[key] = val;
    applyIndChange(view);
  }

  function onLegendAction(view, u, act, key, val) {
    if (act === 'set') setParam(view, u, key, val);
    else if (act === 'config') { tab().active = view.idx; syncActive(); openIndicatorConfig(view, u); }
    else if (act === 'remove') {
      view.cell.indicators = view.cell.indicators.filter((i) => i.uid !== u);
      applyIndChange(view);
    }
  }

  function bindIndPop() {
    const body = $('#ind-pop-body');
    body.addEventListener('click', (e) => {
      const view = activeView();
      const c = cellState();
      const rm = e.target.closest('[data-remove]');
      if (rm) {
        c.indicators = c.indicators.filter((i) => i.uid !== rm.dataset.remove);
        applyIndChange(view);
        return;
      }
      const opt = e.target.closest('.ct-opt');
      if (opt) { setParam(view, opt.dataset.uid, opt.dataset.key, opt.dataset.val); return; }
      const tg = e.target.closest('[data-toggle]');
      if (tg) { openInd[tg.dataset.toggle] = !openInd[tg.dataset.toggle]; renderIndPop(); return; }
      const add = e.target.closest('[data-add]');
      if (add) {
        if (add.getAttribute('aria-disabled') === 'true') { toast('Не больше ' + IND.MAX_PANES + ' подпанелей: уберите одну, чтобы добавить новую'); return; }
        const inst = IND.create(add.dataset.add);
        if (inst.type === 'zscore') c.indicators.splice(Math.min(1, c.indicators.length), 0, inst);
        else c.indicators.push(inst);
        openInd[inst.uid] = true;
        applyIndChange(view);
      }
    });
    body.addEventListener('change', (e) => {
      const inp = e.target.closest('[data-num]');
      if (!inp) return;
      const v = Math.max(0.1, Math.min(6, Number(inp.value) || 2));
      setParam(activeView(), inp.dataset.uid, inp.dataset.num, v);
    });
  }

  // ================================================================ tabs
  function tabTitle(t) {
    const c = t.cells[Math.min(t.active, (t.layout === 'one' ? 1 : 2) - 1)];
    return t.name || (c.symbol + ' ' + D.TF_LABEL[c.tf]);
  }

  function renderTabs() {
    const wrap = $('#desk-tabs');
    wrap.innerHTML = state.tabs.map((t, i) => {
      const c = t.cells[Math.min(t.active, (t.layout === 'one' ? 1 : 2) - 1)];
      return '<button type="button" role="tab" class="ct-desk-tab tnum font-mono" data-i="' + i + '" aria-selected="' + (i === state.activeTab) + '" title="' + esc(c.symbol + ' · ' + D.MARKETS[c.market].label + ' · ' + D.TF_LABEL[c.tf]) + '. Двойной щелчок или F2 — переименовать">' +
        '<span class="flex min-w-0 whitespace-pre"><span class="min-w-0 truncate">' + esc(t.name || c.symbol) + '</span>' + (t.name ? '' : '<span class="shrink-0"> ' + D.TF_LABEL[c.tf] + '</span>') + '</span>' +
        (state.tabs.length > 1 ? '<span class="ct-tab-close" data-close="' + i + '" title="Закрыть вкладку">' + ICON_X.replace('aria-hidden', 'width="12" height="12" aria-hidden') + '</span>' : '') +
        '</button>';
    }).join('');
  }

  function renameTab(i) {
    const btn = $('#desk-tabs [data-i="' + i + '"]');
    if (!btn) return;
    const t = state.tabs[i];
    const input = document.createElement('input');
    input.value = t.name || tabTitle(t);
    btn.innerHTML = '';
    btn.appendChild(input);
    input.focus();
    input.select();
    const done = (ok) => {
      if (ok) { const v = input.value.trim(); t.name = v && v !== (cellState().symbol + ' ' + D.TF_LABEL[cellState().tf]) ? v : null; save(); }
      renderTabs();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); });
    input.addEventListener('blur', () => done(true));
  }

  function switchTab(i) {
    if (i === state.activeTab) return;
    state.activeTab = i;
    save();
    syncCells();
  }

  function bindTabs() {
    const wrap = $('#desk-tabs');
    wrap.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const close = e.target.closest('[data-close]');
      if (close) {
        e.stopPropagation();
        const i = Number(close.dataset.close);
        state.tabs.splice(i, 1);
        if (state.activeTab >= state.tabs.length) state.activeTab = state.tabs.length - 1;
        else if (i < state.activeTab) state.activeTab--;
        save();
        syncCells();
        return;
      }
      const b = e.target.closest('[data-i]');
      if (b) switchTab(Number(b.dataset.i));
    });
    wrap.addEventListener('dblclick', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) renameTab(Number(b.dataset.i));
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'F2') { const b = e.target.closest('[data-i]'); if (b) renameTab(Number(b.dataset.i)); }
    });
    $('#desk-add').addEventListener('click', () => {
      state.tabs.push(newTab(tab()));
      state.activeTab = state.tabs.length - 1;
      save();
      syncCells();
    });
    $('#layout-group').addEventListener('click', (e) => {
      const b = e.target.closest('[data-layout]');
      if (!b) return;
      const t = tab();
      if (t.layout === b.dataset.layout) return;
      t.layout = b.dataset.layout;
      if (t.layout === 'one') t.active = Math.min(t.active, 0) === 0 ? 0 : 0;
      save();
      syncCells();
    });
  }

  // ================================================================ dock
  function syncDock() {
    const dock = $('#dock');
    dock.hidden = !state.dock.open;
    dock.style.setProperty('--ct-dock-w', state.dock.width + 'px');
    const view = state.dock.view;
    $('#dock-instruments').hidden = view !== 'instruments';
    $('#dock-access').hidden = view !== 'access';
    $('#dock-head-right').style.display = view === 'instruments' ? '' : 'none';
    $('#dock-title').textContent = view === 'instruments' ? 'Инструменты' : 'Мой доступ';
    $$('[data-watch-mode]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.watchMode === state.watch.mode ? 'true' : 'false'));
    syncRail();
    if (document.body.getAttribute('data-route') !== 'margin') syncHeader();
    updateDockDynamic();
  }

  function updateDockDynamic() {
    if (!state.dock.open) return;
    if (state.dock.view === 'instruments') renderTickers();
    else renderAccess();
  }

  function bindDock() {
    $$('[data-watch-mode]').forEach((b) => b.addEventListener('click', () => {
      state.watch.mode = b.dataset.watchMode;
      save();
      syncDock();
    }));
    const handle = $('#dock-handle');
    let drag = null;
    handle.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, w: state.dock.width }; handle.setPointerCapture(e.pointerId); });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      state.dock.width = Math.max(336, Math.min(560, drag.w - (e.clientX - drag.x)));
      $('#dock').style.setProperty('--ct-dock-w', state.dock.width + 'px');
    });
    const end = () => { if (drag) { drag = null; save(); } };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------ instruments
  function sortRows(rows) {
    const { key, dir } = state.watch.sort;
    rows.sort((a, b) => {
      if (key === 'symbol') return a.symbol.localeCompare(b.symbol) * dir;
      const va = key === 'price' ? a.price : key === 'change' ? a.change : a.volume;
      const vb = key === 'price' ? b.price : key === 'change' ? b.change : b.volume;
      return ((va || 0) - (vb || 0)) * dir;
    });
    return rows;
  }

  function rowHTML(r, opts) {
    const key = r.venue + ':' + r.symbol;
    const favs = state.watch.favorites;
    const on = favs.includes(key);
    const c = cellState();
    const active = c.market === r.venue && c.symbol === r.symbol;
    const chgCls = r.change > 0 ? 'ct-up' : r.change < 0 ? 'ct-down' : '';
    const flash = r.dir > 0 ? ' ct-flash-up' : r.dir < 0 ? ' ct-flash-down' : '';
    const chartable = D.VENUES[r.venue].chart;
    return '<div class="ct-tk-row' + flash + '" data-venue="' + r.venue + '" data-symbol="' + r.symbol + '" data-active="' + active + '" data-nochart="' + !chartable + '" title="' + esc(D.VENUES[r.venue].label + ' · ' + r.symbol + (chartable ? '' : ' — только котировка')) + '">' +
      '<span class="ct-star" data-star="' + key + '" data-on="' + on + '" title="Избранное"><svg width="12" height="12" viewBox="0 0 24 24" fill="' + (on ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2">' + ICON_STAR + '</svg></span>' +
      '<span class="ct-sym">' + r.symbol + (active ? '<span class="ct-mark">✓</span>' : '') + (opts && opts.venueLabel ? '<span class="ct-venue">' + D.VENUES[r.venue].label + '</span>' : '') + '</span>' +
      '<span class="ct-num ct-px">' + priceFmt(r.price) + '</span>' +
      '<span class="ct-num ' + chgCls + '">' + F.fmtSigned(r.change, (v) => F.fmtNum(v, 2)) + ' %</span>' +
      '<span class="ct-vol">' + F.fmtCompact(r.volume) + '</span></div>';
  }

  function venueRows(venue, q) {
    const map = tickers.data[venue];
    let rows = Array.from(map.values());
    const favs = state.watch.favorites;
    if (q) rows = rows.filter((r) => r.symbol.indexOf(q) >= 0 || r.asset.indexOf(q) >= 0);
    else if (state.watch.favOnly) rows = rows.filter((r) => favs.includes(venue + ':' + r.symbol));
    if (state.watch.minVol > 0) rows = rows.filter((r) => r.volume >= state.watch.minVol || favs.includes(venue + ':' + r.symbol));
    sortRows(rows);
    const limit = q ? 60 : state.watch.favOnly ? 200 : 40;
    return { rows: rows.slice(0, limit), total: rows.length, size: map.size };
  }

  function renderTickers() {
    if (!state.dock.open || state.dock.view !== 'instruments') return;
    const q = $('#tk-search').value.trim().toUpperCase().replace(/[-_/ ]/g, '');
    const qRaw = $('#tk-search').value.trim().toUpperCase();
    let html = '';
    const venues = D.VENUE_LIST.filter((v) => state.watch.venues[v]);
    if (state.watch.mode === 'venues') {
      for (const v of venues) {
        const { rows, total, size } = venueRows(v, qRaw ? q : '');
        if (!rows.length && (q || state.watch.favOnly) && size) continue;
        const collapsed = !!state.watch.collapsed[v];
        let right = 'USDT';
        if (v === 'deribit' && tickers.updatedAt.deribit) right = 'на ' + fmtUtc(tickers.updatedAt.deribit) + ' UTC';
        html += '<div class="ct-tk-group" data-group="' + v + '" data-collapsed="' + collapsed + '">' +
          '<svg class="ct-g-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>' +
          '<span>' + D.VENUES[v].label + '</span><span class="ct-g-sub">USDT · ' + total + '</span><span class="ct-g-right">' + right + '</span></div>';
        if (collapsed) continue;
        if (!rows.length) { html += '<div class="ct-tk-empty">' + (size ? 'Нет инструментов' : 'Загрузка котировок…') + '</div>'; continue; }
        for (const r of rows) html += rowHTML(r);
      }
    } else {
      // Активы: одна группа на базовый актив, внутри — все площадки
      const byAsset = new Map();
      for (const v of venues) {
        const { rows } = venueRows(v, qRaw ? q : '');
        for (const r of rows) {
          if (!byAsset.has(r.asset)) byAsset.set(r.asset, []);
          byAsset.get(r.asset).push(r);
        }
      }
      const assets = Array.from(byAsset.entries()).map(([a, rows]) => ({ a, rows, vol: rows.reduce((s, r) => s + (r.volume || 0), 0) }));
      assets.sort((x, y) => y.vol - x.vol);
      for (const g of assets.slice(0, 40)) {
        const collapsed = !!state.watch.collapsed['asset:' + g.a];
        html += '<div class="ct-tk-group" data-group="asset:' + g.a + '" data-collapsed="' + collapsed + '">' +
          '<svg class="ct-g-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>' +
          '<span>' + g.a + '</span><span class="ct-g-sub">' + g.rows.length + ' площ.</span><span class="ct-g-right">' + F.fmtCompact(g.vol) + '</span></div>';
        if (collapsed) continue;
        for (const r of sortRows(g.rows)) html += rowHTML(r, { venueLabel: true });
      }
    }
    if (!html) html = '<div class="ct-tk-empty">' + (q ? 'Ничего не найдено' : 'Избранное пусто — снимите ★, чтобы видеть все инструменты') + '</div>';
    $('#tk-list').innerHTML = html;
    $$('.ct-tk-head .ct-sort').forEach((x) => {
      const on = x.dataset.sort === state.watch.sort.key;
      x.setAttribute('data-active', on ? 'true' : 'false');
      const base = { symbol: 'Символ', price: 'Цена', change: '24 ч', volume: 'Объём' }[x.dataset.sort];
      x.textContent = base + (on ? (state.watch.sort.dir < 0 ? ' ↓' : ' ↑') : '');
    });
    $('#tk-fav-only').setAttribute('aria-pressed', state.watch.favOnly ? 'true' : 'false');
    const filtered = D.VENUE_LIST.some((v) => !state.watch.venues[v]) || state.watch.minVol > 0;
    $('#tk-filters').setAttribute('data-active', filtered ? 'true' : 'false');
  }

  function bindTickers() {
    $('#tk-search').addEventListener('input', renderTickers);
    $('#tk-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = $('#tk-list .ct-tk-row[data-nochart="false"]');
        if (first) first.click();
      }
    });
    $('#tk-fav-only').addEventListener('click', () => { state.watch.favOnly = !state.watch.favOnly; save(); renderTickers(); });
    $('#tk-filters').addEventListener('click', (e) => { e.stopPropagation(); togglePop('filter-pop', $('#tk-filters')); });
    $$('.ct-tk-head .ct-sort').forEach((el) => el.addEventListener('click', () => {
      const k = el.dataset.sort;
      if (state.watch.sort.key === k) state.watch.sort.dir *= -1; else { state.watch.sort.key = k; state.watch.sort.dir = k === 'symbol' ? 1 : -1; }
      save();
      renderTickers();
    }));
    $('#tk-list').addEventListener('click', (e) => {
      const star = e.target.closest('[data-star]');
      if (star) {
        e.stopPropagation();
        const key = star.dataset.star;
        const i = state.watch.favorites.indexOf(key);
        if (i >= 0) state.watch.favorites.splice(i, 1); else state.watch.favorites.push(key);
        save();
        renderTickers();
        return;
      }
      const grp = e.target.closest('[data-group]');
      if (grp) {
        const g = grp.dataset.group;
        state.watch.collapsed[g] = !state.watch.collapsed[g];
        save();
        renderTickers();
        return;
      }
      const row = e.target.closest('[data-symbol]');
      if (!row) return;
      const venue = row.dataset.venue;
      if (!D.VENUES[venue].chart) {
        toast(D.VENUES[venue].label + ': только живая котировка. График с кластерами и стаканом строится по данным Binance.');
        return;
      }
      const c = cellState();
      if (c.market === venue && c.symbol === row.dataset.symbol) return;
      c.market = venue;
      c.symbol = row.dataset.symbol;
      save();
      reloadActive();
      renderTickers();
    });
  }

  function renderFilters() {
    const w = state.watch;
    let h = '<div class="ct-pop-sub">Площадки</div>';
    for (const v of D.VENUE_LIST) {
      h += '<div class="ct-filter-row" data-fvenue="' + v + '"><span class="ct-toggle-mark" data-on="' + !!w.venues[v] + '"></span>' + D.VENUES[v].label + '<span style="margin-left:auto;color:var(--color-faint)">' + tickers.data[v].size + '</span></div>';
    }
    h += '<div class="ct-pop-sub" style="margin-top:.375rem">Объём за 24 ч, не меньше</div><div class="ct-field" style="padding:0 .75rem"><span class="ct-opts" style="justify-content:flex-start">';
    for (const [val, lab] of [[0, 'Любой'], [1e6, '1 M'], [1e7, '10 M'], [1e8, '100 M'], [1e9, '1 B']]) {
      h += '<button type="button" class="ct-opt" data-fminvol="' + val + '" aria-pressed="' + (w.minVol === val) + '">' + lab + '</button>';
    }
    h += '</span></div>';
    $('#filter-body').innerHTML = h;
  }

  function bindFilters() {
    $('#filter-body').addEventListener('click', (e) => {
      const r = e.target.closest('[data-fvenue]');
      if (r) {
        const v = r.dataset.fvenue;
        state.watch.venues[v] = !state.watch.venues[v];
        if (!D.VENUE_LIST.some((x) => state.watch.venues[x])) state.watch.venues[v] = true;
      }
      const m = e.target.closest('[data-fminvol]');
      if (m) state.watch.minVol = Number(m.dataset.fminvol);
      save();
      renderFilters();
      renderTickers();
    });
    $('#filter-reset').addEventListener('click', () => {
      state.watch.venues = { futures: true, spot: true, coinbase: true, deribit: true };
      state.watch.minVol = 0;
      save();
      renderFilters();
      renderTickers();
    });
  }

  // ---------------------------------------------------------------- access
  let accessTimer = null;
  function renderAccess() {
    if (!state.dock.open || state.dock.view !== 'access') return;
    clearTimeout(accessTimer);
    accessTimer = setTimeout(async () => {
      const el = $('#dock-access');
      const c = cellState();
      const v = activeView();
      let st = null;
      try { st = await window.StorageDB.stats(c.market, c.symbol); } catch (e) { st = null; }
      const stLabel = (s) => (s === 'live' ? 'в сети' : s === 'error' ? 'ошибка' : 'подключение');
      let h = '<div class="ct-sec"><span class="ct-plan">Автономный режим · публичные API</span>' +
        '<p style="margin:.5rem 0 0;font-size:.75rem;color:var(--color-faint);line-height:1.5">Подписка не нужна: свечи, сделки, стакан и котировки идут напрямую из публичных REST и WebSocket Binance, Coinbase и Deribit. Ключи API не используются.</p></div>';
      h += '<div class="ct-sec"><h3>Источники данных</h3>';
      views.forEach((cv, i) => {
        const cc = cv.cell;
        h += '<div class="ct-src-row"><span class="ct-dot" data-state="' + cv.engine.status.trades + '"></span>График ' + (i + 1) + ': сделки ' + esc(cc.symbol) + ' @aggTrade<b>' + stLabel(cv.engine.status.trades) + '</b></div>';
        h += '<div class="ct-src-row"><span class="ct-dot" data-state="' + cv.engine.status.depth + '"></span>График ' + (i + 1) + ': стакан depth 1000 · 3 с<b>' + stLabel(cv.engine.status.depth) + '</b></div>';
      });
      for (const vn of D.VENUE_LIST) {
        h += '<div class="ct-src-row"><span class="ct-dot" data-state="' + tickers.state[vn] + '"></span>Котировки: ' + D.VENUES[vn].label + '<b>' + tickers.data[vn].size + ' · ' + stLabel(tickers.state[vn]) + '</b></div>';
      }
      h += '</div>';
      h += '<div class="ct-sec"><h3>Локальная история стакана (IndexedDB)</h3>';
      if (!st || !st.available) h += '<div class="ct-empty" style="padding:0">IndexedDB недоступна — история хранится только в памяти вкладки.</div>';
      else {
        h += '<div class="ct-kv"><span>Минут стакана, всего</span><b>' + F.fmtNum(st.book, 0) + '</b><span>Z-Score свечей, всего</span><b>' + F.fmtNum(st.zscore, 0) + '</b>' +
          '<span>' + esc(c.symbol) + ', с</span><b>' + (st.first ? fmtUtc(st.first, true) : '—') + '</b><span>по</span><b>' + (st.last ? fmtUtc(st.last, true) : '—') + '</b>' +
          (v && v.engine.zInfo ? '<span>Реальный стакан на графике</span><b>' + v.engine.zInfo.realCandles + ' из ' + v.engine.candles.length + ' свечей</b>' : '') +
          '</div><p style="margin:.5rem 0 0;font-size:.6875rem;color:var(--color-faint);line-height:1.5">Чем дольше открыт терминал, тем больше свечей получают реальный стакан вместо реконструкции. Записи старше 8 суток удаляются.</p>' +
          '<div class="ct-actions"><button type="button" class="ct-act" data-access="clear-db">Очистить историю</button></div>';
      }
      h += '</div>';
      h += '<div class="ct-sec"><h3>Настройки терминала</h3><div class="ct-kv"><span>Вкладок</span><b>' + state.tabs.length + '</b><span>Избранное</span><b>' + state.watch.favorites.length + '</b><span>Уведомления</span><b>' + state.alerts.filter((a) => !a.done).length + '</b><span>Часовой пояс</span><b>' + (state.tz === 'utc' ? 'UTC' : 'местный') + '</b></div>' +
        '<div class="ct-actions"><button type="button" class="ct-act" data-access="export">Экспорт настроек</button><button type="button" class="ct-act" data-access="import">Импорт</button><button type="button" class="ct-act" data-access="reset">Сбросить всё</button></div></div>';
      el.innerHTML = h;
    }, 150);
  }

  function bindAccess() {
    $('#dock-access').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-access]');
      if (!b) return;
      const a = b.dataset.access;
      if (a === 'clear-db') {
        if (!confirm('Удалить сохранённую историю стакана и Z-Score из IndexedDB?')) return;
        await window.StorageDB.clearAll();
        toast('История стакана очищена');
        renderAccess();
      } else if (a === 'export') {
        const blob = new Blob([JSON.stringify(state, skipPrivate, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'cryptoterminal-settings.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (a === 'import') {
        $('#import-file').click();
      } else if (a === 'reset') {
        if (!confirm('Сбросить вкладки, индикаторы, избранное и уведомления к настройкам по умолчанию?')) return;
        localStorage.removeItem(STORE_KEY);
        state = defaults();
        save();
        rebuildAll();
        toast('Настройки сброшены');
      }
    });
    $('#import-file').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const txt = await f.text();
        JSON.parse(txt);
        localStorage.setItem(STORE_KEY, txt);
        state = loadState();
        rebuildAll();
        toast('Настройки импортированы');
      } catch (err) {
        toast('Файл не похож на настройки терминала');
      }
      e.target.value = '';
    });
  }

  function rebuildAll() {
    while (views.length) views.pop().destroy();
    syncCells();
    syncDock();
    renderAlerts();
  }

  // ---------------------------------------------------------------- alerts
  function lastPriceOf(market, symbol) {
    const v = views.find((x) => x.engine.market === market && x.engine.symbol === symbol && isFinite(x.engine.lastPrice));
    if (v) return v.engine.lastPrice;
    const t = tickers.get(market, symbol);
    return t ? t.price : NaN;
  }

  function renderAlerts() {
    const body = $('#alert-body');
    const c = cellState();
    const last = lastPriceOf(c.market, c.symbol);
    const active = state.alerts.filter((a) => !a.done).length;
    $('#bell-badge').setAttribute('data-n', String(active));
    $('#bell-badge').textContent = active ? String(active) : '';
    if ($('#alert-pop').getAttribute('data-open') !== 'true') return;
    const perm = typeof Notification === 'undefined' ? 'нет поддержки' : Notification.permission === 'granted' ? 'системные: вкл' : Notification.permission === 'denied' ? 'системные: запрещены' : 'системные: спросим';
    $('#alert-perm').textContent = perm;
    let h = '<div class="ct-pop-sub">' + esc(c.symbol) + ' · ' + D.MARKETS[c.market].label + ' · сейчас ' + priceFmt(last) + '</div>' +
      '<div class="ct-alert-form"><input type="number" class="ct-input" id="alert-price" step="any" placeholder="Цена" value="' + (isFinite(last) ? last : '') + '"><button type="button" class="ct-act" id="alert-add">Добавить</button></div>';
    if (!state.alerts.length) h += '<div class="ct-empty">Уведомлений нет. Сработают, когда цена пересечёт уровень, — со звуком и системным уведомлением.</div>';
    for (const a of state.alerts.slice().reverse()) {
      h += '<div class="ct-alert-row" data-done="' + !!a.done + '"><span class="ct-al-sym">' + esc(a.symbol) + ' <span style="color:var(--color-faint)">' + (a.market === 'spot' ? 'спот' : 'фьюч.') + '</span></span>' +
        '<span class="' + (a.dir === 'above' ? 'ct-up' : 'ct-down') + '">' + (a.dir === 'above' ? '↑ ' : '↓ ') + priceFmt(a.price) + '</span>' +
        '<span class="ct-x" data-alert-rm="' + a.id + '" style="cursor:pointer;color:var(--color-faint)" title="Удалить">×</span></div>';
    }
    if (state.alerts.some((a) => a.done)) h += '<div class="ct-actions" style="padding:0 .75rem"><button type="button" class="ct-act" id="alert-clear">Убрать сработавшие</button></div>';
    body.innerHTML = h;
  }

  function bindAlerts() {
    $('#alert-body').addEventListener('click', (e) => {
      if (e.target.closest('#alert-add')) {
        const c = cellState();
        const price = Number($('#alert-price').value);
        const last = lastPriceOf(c.market, c.symbol);
        if (!(price > 0) || !isFinite(last)) { toast('Укажите цену'); return; }
        if (price === last) { toast('Уровень совпадает с текущей ценой'); return; }
        state.alerts.push({ id: uid('a'), market: c.market, symbol: c.symbol, price, dir: price > last ? 'above' : 'below', created: Date.now(), done: false });
        save();
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().then(renderAlerts);
        renderAlerts();
        toast('Уведомление: ' + c.symbol + (price > last ? ' выше ' : ' ниже ') + priceFmt(price));
        return;
      }
      const rm = e.target.closest('[data-alert-rm]');
      if (rm) { state.alerts = state.alerts.filter((a) => a.id !== rm.dataset.alertRm); save(); renderAlerts(); return; }
      if (e.target.closest('#alert-clear')) { state.alerts = state.alerts.filter((a) => !a.done); save(); renderAlerts(); }
    });
    $('#alert-body').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'alert-price') $('#alert-add').click(); });
  }

  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.5);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.55);
    } catch (e) { /* звук недоступен */ }
  }

  function checkAlerts(market, symbol, price) {
    if (!(price > 0) || !state.alerts.length) return;
    let fired = false;
    for (const a of state.alerts) {
      if (a.done || a.market !== market || a.symbol !== symbol) continue;
      if ((a.dir === 'above' && price >= a.price) || (a.dir === 'below' && price <= a.price)) {
        a.done = true;
        a.firedAt = Date.now();
        fired = true;
        const msg = symbol + ' ' + (a.dir === 'above' ? 'поднялся до ' : 'опустился до ') + priceFmt(a.price);
        toast('🔔 ' + msg, 6000);
        beep();
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try { new Notification('CryptoTerminal', { body: msg }); } catch (e) { /* нет поддержки */ }
        }
      }
    }
    if (fired) { save(); renderAlerts(); }
  }

  // ================================================================ init
  tickers.on('update', (data) => {
    if (state.dock.open && state.dock.view === 'instruments') renderTickers();
    for (const a of state.alerts) {
      if (a.done) continue;
      const v = views.find((x) => x.engine.market === a.market && x.engine.symbol === a.symbol);
      if (v) continue; // этот символ проверяется по живым сделкам
      const t = data[a.market] && data[a.market].get(a.symbol);
      if (t) checkAlerts(a.market, a.symbol, t.price);
    }
  });
  tickers.on('status', () => { if (state.dock.view === 'access') renderAccess(); });

  // ---------------------------------------------------------- самолечение
  // График «замер» или загрузка висит — лечим без ручной перезагрузки страницы
  function startHealthChecks() {
    views.forEach((v) => { v.lastActivity = Date.now(); });
    setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      for (const v of views) {
        if (v.loadingSince && !v.isLoadError && now - v.loadingSince > 45000) {
          v.loadingSince = now;
          v.load(true);                          // загрузка зависла — повторяем
          continue;
        }
        const e = v.engine;
        if (!e.ready) continue;
        const last = Math.max(e.lastWsMsg || 0, e.lastDepthOk || 0);
        if (now - last > 90000) e.wake();        // давно нет ни сделок, ни стакана
        if (now - last > 240000 && !v.healing) {
          v.healing = true;
          v.load(true).finally(() => { v.healing = false; });
        }
      }
    }, 10000);

    // новая версия сайта на хостинге: перезагружаемся, когда вкладка в фоне, иначе предлагаем
    const current = (document.querySelector('script[src*="app.js"]') || {}).src || '';
    const ver = (current.match(/v=(\d+)/) || [])[1];
    const check = async () => {
      try {
        const r = await fetch(location.pathname + '?_=' + Date.now(), { cache: 'no-store' });
        const m = (await r.text()).match(/app\.js\?v=(\d+)/);
        if (ver && m && m[1] !== ver) {
          if (document.hidden) { location.reload(); return; }
          const t = $('#toast');
          t.innerHTML = 'Вышла новая версия терминала. <span style="color:var(--color-accent-2);cursor:pointer;text-decoration:underline" id="reload-now">Обновить</span>';
          t.setAttribute('data-show', 'true');
          $('#reload-now').addEventListener('click', () => location.reload());
        }
      } catch (err) { /* нет сети — проверим позже */ }
    };
    setInterval(check, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }

  function init() {
    // вернулись на вкладку / проснулся ПК — не ждём таймеров, проверяем соединения
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) views.forEach((v) => v.engine.wake());
    });
    window.addEventListener('online', () => views.forEach((v) => v.engine.wake()));
    bindHeader();
    bindTabs();
    bindDock();
    bindTickers();
    bindFilters();
    bindIndPop();
    bindAccess();
    bindAlerts();
    syncCells();
    syncDock();
    applyRoute();
    renderAlerts();
    window.StorageDB.open().then(() => window.StorageDB.prune()).catch(() => {});
    tickers.start().catch((e) => console.warn(e));
    startHealthChecks();
    window.CTApp = { get state() { return state; }, views, tickers };
  }

  init();
})();
