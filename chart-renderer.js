/* ==========================================================================
   chart-renderer.js — High-DPI Canvas рендер терминала.

   Слои:
     base    — сетка, фон тепловой карты стакана (Z-Score полос или
               «Карта глубины Funds Analytics» RGW), свечи / профили /
               футпринт, подвалы (профиль по свечам, дельта стакана,
               Bid Dominance), оси.
     overlay — единое перекрестие по всем панелям, подсветка строки
               кластера, линейка, метки на осях.
     profile — левый видимый профиль объёма.
   Тултип кластера — HTML-элемент поверх графика.
   ========================================================================== */
(function (global) {
  'use strict';

  const D = global.CTData;
  const NB = D.NB;
  const Z_BANDS = D.Z_BANDS;
  const BUCKETS = D.BUCKETS;
  const BUCKET_PCT = D.BUCKET_PCT;
  const DELTA_RANGES = D.DELTA_RANGES;
  const DOM_RANGES = D.DOM_RANGES;

  const AXIS_W = 84;
  // полосы ближе 0,2 % к цене не подсвечиваются: там стакан постоянно
  // перетасовывают HFT, Z шумит — как в оригинале, у цены тёмный зазор
  const Z_DRAW_FROM = 2;
  // ступени яркости Z (замер по оригиналу): |Z|<0,5 — не закрашено, затем 0,03 / 0,12 / 0,27 / 0,5
  const Z_LEVELS = [0.03, 0.12, 0.27, 0.5].map((alpha) => ({ alpha, css: (c) => rgba(c, alpha) }));
  const TIME_H = 28;
  const LEGEND_H = 24;
  const ICON_GEAR = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings size-3" aria-hidden="true"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  const ICON_X = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
  const FONT_MONO = '"Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace';
  const FONT_SANS = '"Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif';

  // ------------------------------------------------------------ format
  function fmtNum(v, dec) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const s = Math.abs(v).toFixed(Math.max(0, dec | 0));
    const parts = s.split('.');
    const i = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const neg = v < 0 && Number(s) !== 0;
    return (neg ? '−' : '') + i + (parts[1] ? ',' + parts[1] : '');
  }

  function fmtCompact(v, dec) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const a = Math.abs(v);
    const d = dec === undefined ? 1 : dec;
    if (a >= 1e9) return fmtNum(v / 1e9, d) + ' B';
    if (a >= 1e6) return fmtNum(v / 1e6, d) + ' M';
    if (a >= 1e3) return fmtNum(v / 1e3, d) + ' k';
    if (a >= 100) return fmtNum(v, 0);
    if (a >= 10) return fmtNum(v, 1);
    if (a >= 1) return fmtNum(v, 2);
    if (a === 0) return '0';
    return fmtNum(v, 3);
  }

  /** Компактный формат легенд как в оригинале: 13M, 9,0M, 21k. */
  function fmtShort(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const a = Math.abs(v);
    let x = v;
    let suf = '';
    if (a >= 1e9) { x = v / 1e9; suf = 'B'; } else if (a >= 1e6) { x = v / 1e6; suf = 'M'; } else if (a >= 1e3) { x = v / 1e3; suf = 'k'; }
    const ax = Math.abs(x);
    let d;
    if (suf) d = ax >= 10 ? 0 : 1;
    else d = ax >= 100 ? 0 : ax >= 10 ? 1 : ax >= 1 ? 2 : 3;
    return fmtNum(x, d) + suf;
  }

  function fmtSigned(v, f) {
    if (!isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + f(v);
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function hexToRgb(hex, fb) {
    const h = (hex || '').trim().replace('#', '');
    if (h.length !== 6) return fb || [128, 128, 128];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function rgba(c, a) {
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a < 0 ? 0 : a > 1 ? 1 : a).toFixed(3) + ')';
  }

  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / e;
    const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return m * e;
  }

  function stepDecimals(step) {
    if (step >= 1) return 0;
    return Math.min(10, Math.ceil(-Math.log10(step) - 1e-9));
  }

  const TIME_STEPS = [60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 14400e3, 21600e3, 43200e3, 86400e3, 2 * 86400e3, 3 * 86400e3, 7 * 86400e3, 14 * 86400e3, 30 * 86400e3];

  // ====================================================================
  class ChartRenderer {
    constructor(els) {
      this.els = els;
      this.engine = null;
      this.opt = {
        view: 'profile',
        metric: 'delta',
        rowSize: 10,
        tz: 'utc',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        priceDecimals: 2,
        tfLabel: '5м',
        layers: { candles: true, clusters: false, heat: true },
        heatAlpha: 1
      };
      this.indicators = [];
      this.panes = [];
      this.onLegendAction = null;
      this.barW = 10;
      this.viewEnd = null;
      this.auto = true;
      this.pMin = 0;
      this.pMax = 1;
      this.hover = null;
      this.drag = null;
      this.ruler = { on: false, a: null, b: null, active: false };
      this.dirty = true;
      this.overlayDirty = true;
      this.lastBaseDraw = 0;
      this.alive = true;
      this._readColors();
      this._bind();
      this._bindLegends();
      this._resize();
      this.ro = new ResizeObserver(() => this._resize());
      this.ro.observe(els.host);
      this._raf = this._raf.bind(this);
      requestAnimationFrame(this._raf);
    }

    destroy() {
      this.alive = false;
      this.ro.disconnect();
    }

    _readColors() {
      const cs = getComputedStyle(document.documentElement);
      const g = (n, fb) => hexToRgb(cs.getPropertyValue(n), hexToRgb(fb));
      this.C = {
        bg: g('--color-bg', '#0b0906'),
        surface: g('--color-surface', '#161109'),
        surface2: g('--color-surface-2', '#1f170d'),
        border: g('--color-border', '#2a2116'),
        borderStrong: g('--color-border-strong', '#453421'),
        text: g('--color-text', '#f5efe4'),
        muted: g('--color-muted', '#a89a86'),
        faint: g('--color-faint', '#8d7f6c'),
        accent: g('--color-accent', '#f5760a'),
        up: g('--color-up', '#37d9a0'),
        down: g('--color-down', '#ff6b7a'),
        deltaPos: g('--color-delta-pos', '#5ccf9f'),
        deltaNeg: g('--color-delta-neg', '#f08a8a'),
        depthBid: g('--color-depth-bid', '#1eff00'),
        depthAsk: g('--color-depth-ask', '#ff001e'),
        depthDelta: g('--color-depth-delta', '#2a5dfa'),
        zAskSurge: g('--color-depth-z-ask-surge', '#e63232'),
        zAskDrain: g('--color-depth-z-ask-drain', '#00b4dc'),
        zBidSurge: g('--color-depth-z-bid-surge', '#00c853'),
        zBidDrain: g('--color-depth-z-bid-drain', '#ffa020'),
        s9: g('--color-series-9', '#e3cf56'),
        s1: g('--color-series-1', '#6fa8dc'),
        s8: g('--color-series-8', '#c3a6e8'),
        bone: g('--color-series-bone', '#e8dcc6'),
        warn: g('--color-warn', '#f4c05a')
      };
      const zMax = parseFloat(cs.getPropertyValue('--term-zband-alpha')) || 0.85;
      this.zAlphaMax = zMax;
    }

    setEngine(engine) {
      this.engine = engine;
      this.resetView();
    }

    setOptions(o) {
      const prevView = this.opt.view;
      Object.assign(this.opt, o);
      if (o.view && o.view !== prevView) {
        // сохраняем отступ последней свечи от правого края в пикселях
        const n = this._candles().length;
        const oldW = this.barW;
        this.barW = this._defaultBarW();
        if (this.viewEnd !== null && n) {
          const rightPx = Math.max(0, (this.viewEnd - (n - 1)) * oldW);
          this.viewEnd = (n - 1) + Math.min(rightPx, this.plotW * 0.5) / this.barW;
        }
      }
      this.requestDraw(true);
    }

    /** Список экземпляров индикаторов ячейки (см. indicators.js). */
    setIndicators(list) {
      this.indicators = list.slice();
      this._layout();
      this._buildLegends();
      this.requestDraw(true);
    }

    _zInst() {
      return this.indicators.find((x) => x.type === 'zscore') || null;
    }

    get zEnabled() {
      const z = this._zInst();
      return !!(z && z.params.visible !== false);
    }

    get zThreshold() {
      const z = this._zInst();
      return z && z.params.thresholdOn ? Math.max(0.1, Number(z.params.threshold) || 2) : null;
    }

    engineBase() {
      return this.engine && this.engine.base ? this.engine.base : '4h';
    }

    _defaultBarW() {
      switch (this.opt.view) {
        case 'footprint': return 72;
        case 'profile': return 6;
        case 'depthmap': return 6;
        default: return 7;
      }
    }

    resetView() {
      this.barW = this._defaultBarW();
      this.auto = true;
      const n = this._candles().length;
      this.viewEnd = n ? (n - 1) + 0.5 + (this.plotW * 0.28) / this.barW : 0;
      this._lastLen = n;
      this._syncAutoBtn();
      this.requestDraw(true);
    }

    /** Ряд свечей заменён (догрузка истории): сохраняем вид относительно последней свечи. */
    onDataReplaced() {
      const n = this._candles().length;
      if (this.viewEnd !== null && this._lastLen && n !== this._lastLen) this.viewEnd += n - this._lastLen;
      this._lastLen = n;
      this.requestDraw(true);
    }

    /** Новая свеча: если график «прилип» к правому краю — сдвигаем вид. */
    onNewCandle() {
      const n = this._candles().length;
      // предыдущая последняя свеча (n-2) была на экране → сохраняем отступ справа
      if (this.viewEnd !== null && this.viewEnd >= n - 2 - 1e-9 && this.viewEnd - this.plotW / this.barW <= n - 2) this.viewEnd += 1;
      this._lastLen = n;
      this.requestDraw(true);
    }

    requestDraw(urgent) {
      if (urgent) { this.dirty = true; this.urgent = true; } else this.dirty = true;
    }

    _candles() {
      return this.engine && this.engine.candles ? this.engine.candles : [];
    }

    _raf(now) {
      if (this.dirty && (this.urgent || now - this.lastBaseDraw > 120)) {
        this.dirty = false;
        this.urgent = false;
        this.lastBaseDraw = now;
        try {
          this._drawBase();
          this._drawProfileCol();
        } catch (e) { console.error(e); }
        this.overlayDirty = true;
      }
      if (this.overlayDirty) {
        this.overlayDirty = false;
        try { this._drawOverlay(); } catch (e) { console.error(e); }
      }
      if (this.alive) requestAnimationFrame(this._raf);
    }

    _resize() {
      const host = this.els.host;
      const W = Math.max(50, host.clientWidth);
      const H = Math.max(50, host.clientHeight);
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      this.W = W; this.H = H; this.dpr = dpr;
      for (const cv of [this.els.base, this.els.overlay]) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
        cv.style.width = W + 'px';
        cv.style.height = H + 'px';
      }
      const pc = this.els.profile;
      const pw = Math.max(10, pc.parentElement.clientWidth);
      const ph = Math.max(10, pc.parentElement.clientHeight);
      pc.width = Math.round(pw * dpr);
      pc.height = Math.round(ph * dpr);
      pc.style.width = pw + 'px';
      pc.style.height = ph + 'px';
      this.PW = pw; this.PH = ph;
      // сохраняем долю правого отступа: последняя свеча остаётся на том же месте по ширине
      const n = this._candles().length;
      const oldPlotW = this.plotW;
      this._layout();
      if (n && this.viewEnd !== null && oldPlotW && oldPlotW !== this.plotW) {
        const rightPx = (this.viewEnd - (n - 1)) * this.barW;
        this.viewEnd = (n - 1) + rightPx * (this.plotW / oldPlotW) / this.barW;
      }
      this.requestDraw(true);
    }

    _layout() {
      const W = this.W;
      const H = this.H;
      if (!W) return;
      this.plotW = Math.max(10, W - AXIS_W);
      const subs = [];
      for (const inst of this.indicators) {
        const def = global.CTIndicators.DEFS[inst.type];
        if (def && def.kind === 'pane') subs.push({ inst, def, h: def.height });
      }
      let subH = 0;
      for (const s of subs) subH += s.h;
      // при нехватке высоты подпанели сжимаются, но не меньше 48 px
      const minMain = 140;
      if (H - TIME_H - subH < minMain && subs.length) {
        const avail = Math.max(subs.length * 48, H - TIME_H - minMain);
        const k = avail / subH;
        subH = 0;
        for (const s of subs) { s.h = Math.max(48, Math.floor(s.h * k)); subH += s.h; }
      }
      const mainH = Math.max(80, H - TIME_H - subH);
      const old = new Map((this.panes || []).map((p) => [p.id, p]));
      const panes = [{ id: 'main', y: 0, h: mainH }];
      let y = mainH;
      for (const s of subs) {
        const prev = old.get(s.inst.uid);
        const p = { id: s.inst.uid, inst: s.inst, def: s.def, y, h: s.h, top: y + LEGEND_H, bot: y + s.h - 4, min: 0, max: 1 };
        if (prev && prev.inst === s.inst) { p.legendEl = prev.legendEl; p.valsEl = prev.valsEl; p.rvEl = prev.rvEl; }
        panes.push(p);
        y += s.h;
      }
      this.panes = panes;
      this.mainH = mainH;
      this.timeY = y;
      this._placeLegends();
      if (this.els.autoBtn) this.els.autoBtn.style.top = (mainH - 22) + 'px';
      if (this.els.zoneChip) { this.els.zoneChip.style.top = this.timeY + 'px'; this.els.zoneChip.style.bottom = 'auto'; }
    }

    // ------------------------------------------------ pane legends (DOM)
    _buildLegends() {
      const layer = this.els.legendLayer;
      if (!layer) return;
      layer.innerHTML = '';
      const DEFS = global.CTIndicators.DEFS;
      for (const p of this.panes) {
        if (p.id === 'main') continue;
        const def = DEFS[p.inst.type];
        const el = document.createElement('div');
        el.className = 'ct-pane-legend';
        el.dataset.uid = p.inst.uid;
        el.innerHTML =
          '<span class="ct-pl-left">' +
          (def.controls ? '<span class="ct-pl-controls">' + def.controls(p.inst, this) + '</span>' : '') +
          '<span class="ct-pl-name" title="' + def.title(p.inst, this).replace(/"/g, '&quot;') + '">' + def.title(p.inst, this) + '</span>' +
          '<span class="ct-pl-vals"></span>' +
          '</span>' +
          '<span class="ct-pl-right">' +
          '<span class="ct-pl-rv"></span>' +
          '<button type="button" class="ct-pl-btn" data-act="config" title="Настроить: ' + def.name + '">' + ICON_GEAR + '</button>' +
          '<button type="button" class="ct-pl-btn" data-act="remove" title="Убрать: ' + def.name + '">' + ICON_X + '</button>' +
          '</span>';
        layer.appendChild(el);
        p.legendEl = el;
        p.valsEl = el.querySelector('.ct-pl-vals');
        p.rvEl = el.querySelector('.ct-pl-rv');
        p._lastVals = null;
        p._lastRight = null;
      }
      this._placeLegends();
    }

    _placeLegends() {
      for (const p of this.panes || []) {
        if (!p.legendEl) continue;
        p.legendEl.style.top = (p.y + 1) + 'px';
        p.legendEl.style.width = this.plotW + 'px';
      }
    }

    _bindLegends() {
      const layer = this.els.legendLayer;
      if (!layer) return;
      layer.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const lg = b.closest('[data-uid]');
        if (!lg || !this.onLegendAction) return;
        let v = b.dataset.val;
        if (v === 'true') v = true; else if (v === 'false') v = false; else if (v !== undefined && v !== '' && !isNaN(Number(v))) v = Number(v);
        this.onLegendAction(lg.dataset.uid, b.dataset.act, b.dataset.key, v);
      });
    }

    // ------------------------------------------------------- scales
    xOf(i) { return this.plotW - (this.viewEnd - i) * this.barW; }
    idxAt(x) { return this.viewEnd - (this.plotW - x) / this.barW; }
    yOf(p) { return (this.pMax - p) / (this.pMax - this.pMin) * this.mainH; }
    pAt(y) { return this.pMax - y / this.mainH * (this.pMax - this.pMin); }

    _visibleRange() {
      const n = this._candles().length;
      if (!n) return [0, -1];
      const i0 = Math.max(0, Math.floor(this.idxAt(0)) - 1);
      const i1 = Math.min(n - 1, Math.ceil(this.idxAt(this.plotW)) + 1);
      return [i0, i1];
    }

    _autoscale(i0, i1) {
      const cs = this._candles();
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = i0; i <= i1; i++) {
        const c = cs[i];
        if (!c) continue;
        if (c.l < lo) lo = c.l;
        if (c.h > hi) hi = c.h;
      }
      if (!isFinite(lo)) return;
      // как в оригинале: над и под свечами ~17 % высоты остаётся под зоны стакана
      const pad = Math.max((hi - lo) * 0.17, hi * 0.0012);
      this.pMin = lo - pad;
      this.pMax = hi + pad;
    }

    _syncAutoBtn() {
      if (this.els.autoBtn) this.els.autoBtn.setAttribute('aria-pressed', this.auto ? 'true' : 'false');
    }

    setAuto(on) {
      this.auto = on;
      this._syncAutoBtn();
      this.requestDraw(true);
    }

    // ------------------------------------------------------- colors
    zColor(side, z) {
      // side 0 = bid, 1 = ask
      if (side === 1) return z >= 0 ? this.C.zAskSurge : this.C.zAskDrain;
      return z >= 0 ? this.C.zBidSurge : this.C.zBidDrain;
    }

    /**
     * Заливка полосы по Z:
     *   обычная плотность  → тусклый бордо (аски) / тёмно-зелёный (биды);
     *   рост (Z > 0)       → ярче красный / зелёный;
     *   снятие (Z < −1)    → ярко-синий (аски) / янтарный (биды).
     * С порогом «Число» всё, что |Z| < порога, рисуется фоновой плотностью.
     */
    zFill(side, z) {
      // Цвет — по знаку Z: аски рост → красный, снятие → бирюзовый;
      // биды рост → зелёный, снятие → янтарный. Яркость — четыре плоских
      // ступени (замер по оригиналу: 0,05 / 0,12 / 0,27 / 0,5).
      const surge = side === 1 ? this.C.zAskSurge : this.C.zBidSurge;
      const drain = side === 1 ? this.C.zAskDrain : this.C.zBidDrain;
      const col = z >= 0 ? surge : drain;
      const thr = this.zThreshold;
      let a = Math.abs(z);
      if (thr !== null && thr !== undefined) {
        if (a < thr) return Z_LEVELS[0].css(col);
        a = 1 + (a - thr);            // выше порога — сразу ступень «слабая аномалия»
      }
      if (a < 0.5) return null;
      const lvl = a >= 3 ? 3 : a >= 2 ? 2 : a >= 1 ? 1 : 0;
      return Z_LEVELS[lvl].css(col);
    }

    _rgw(t) {
      // Funds Analytics RGW: тёмный → красный → зелёный → белый
      if (t <= 0) return [20, 6, 6];
      if (t < 0.45) {
        const k = t / 0.45;
        return [Math.round(40 + 170 * k), Math.round(8 + 22 * k), Math.round(8 + 20 * k)];
      }
      if (t < 0.8) {
        const k = (t - 0.45) / 0.35;
        return [Math.round(210 - 180 * k), Math.round(30 + 170 * k), Math.round(28 + 52 * k)];
      }
      const k = Math.min(1, (t - 0.8) / 0.2);
      return [Math.round(30 + 225 * k), Math.round(200 + 55 * k), Math.round(80 + 175 * k)];
    }

    // ------------------------------------------------- metric values
    _rowMetric(r) {
      switch (this.opt.metric) {
        case 'volume': return r.b + r.s;
        case 'delta': return r.b - r.s;
        case 'buysell': return r.b + r.s;
        case 'trades': return r.n;
        case 'tradesDelta': return r.nb - r.ns;
        default: return r.b + r.s;
      }
    }

    _isSignedMetric() {
      return this.opt.metric === 'delta' || this.opt.metric === 'tradesDelta';
    }

    tradesDelta(c) {
      if (c._tdVer === c.ver) return c._td;
      let td;
      if (c.covered && c.clusters) {
        td = 0;
        for (const cl of c.clusters.values()) td += cl.nb - cl.ns;
      } else {
        td = c.v > 0 ? c.n * (2 * c.buy / c.v - 1) : 0;
      }
      c._td = td;
      c._tdVer = c.ver;
      return td;
    }

    // --------------------------------------------- API для indicators.js
    candles() { return this._candles(); }
    rgba(c, a) { return rgba(c, a); }

    colRect(i) {
      const bw = this.barW;
      const x0 = Math.floor(this.xOf(i) - bw / 2);
      return [x0, Math.max(1, Math.floor(this.xOf(i + 1) - bw / 2) - x0)];
    }

    zero(ctx, y) {
      ctx.strokeStyle = rgba(this.C.faint, 0.32);
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.plotW, Math.round(y) + 0.5);
      ctx.stroke();
    }

    hline(ctx, y, color, dash) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.plotW, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    line(ctx, i0, i1, vals, yOf, color, width, dash) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width || 1.4;
      ctx.lineJoin = 'round';
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      let started = false;
      for (let i = i0; i <= i1; i++) {
        const v = vals[i];
        if (!isFinite(v)) { started = false; continue; }
        const x = this.xOf(i);
        const y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    hist(ctx, i0, i1, vals, yOf, y0, colorFn) {
      const w = Math.max(1, Math.round(this.barW * 0.7));
      for (let i = i0; i <= i1; i++) {
        const v = vals[i];
        if (!isFinite(v)) continue;
        const x = Math.round(this.xOf(i) - w / 2);
        const y = yOf(v);
        ctx.fillStyle = colorFn(i, v);
        ctx.fillRect(x, Math.round(Math.min(y, y0)), w, Math.max(1, Math.round(Math.abs(y - y0))));
      }
    }

    /** Заливка между линией и уровнем yBase там, где pred(v) истинно. */
    area(ctx, i0, i1, vals, yOf, yBase, pred, color) {
      ctx.fillStyle = color;
      let open = false;
      let lastX = 0;
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const v = vals[i];
        const ok = isFinite(v) && pred(v);
        const x = this.xOf(i);
        if (ok) {
          if (!open) { ctx.moveTo(x, yBase); open = true; }
          ctx.lineTo(x, yOf(v));
          lastX = x;
        } else if (open) {
          ctx.lineTo(lastX, yBase);
          ctx.closePath();
          open = false;
        }
      }
      if (open) { ctx.lineTo(lastX, yBase); ctx.closePath(); }
      ctx.fill();
    }

    _series(inst) {
      const def = global.CTIndicators.DEFS[inst.type];
      const cs = this._candles();
      const key = (this.engine ? this.engine.version : 0) + '|' + cs.length + '|' + JSON.stringify(inst.params) + '|' + this.opt.baseAsset + '|' + (this.engine ? this.engine.base : '');
      if (!inst._cache || inst._cache.key !== key) inst._cache = { key, s: def.series(this, inst) };
      return inst._cache.s;
    }

    _drawBase() {
      const ctx = this.els.base.getContext('2d');
      const dpr = this.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);
      ctx.fillStyle = rgba(this.C.bg, 1);
      ctx.fillRect(0, 0, this.W, this.H);

      const cs = this._candles();
      if (!cs.length || this.viewEnd === null) {
        this._drawPaneFrames(ctx);
        return;
      }
      this._clampView();
      const [i0, i1] = this._visibleRange();
      this.vis = [i0, i1];
      if (this.auto) this._autoscale(i0, i1);
      if (!(this.pMax > this.pMin)) { this.pMax = this.pMin + 1; }

      // ---- главный пейн
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, this.plotW, this.mainH);
      ctx.clip();
      const L = this.opt.layers;
      // слой 1: тепловая карта стакана (ликвидность), независимая прозрачность
      if (L.heat && (this.opt.view === 'depthmap' || this.zEnabled)) {
        ctx.save();
        ctx.globalAlpha = Math.max(0.05, Math.min(1, this.opt.heatAlpha));
        if (this.opt.view === 'depthmap') this._drawDepthMap(ctx, i0, i1);
        else this._drawZBands(ctx, i0, i1);
        ctx.restore();
      }
      this._drawGrid(ctx, i0, i1);
      // слой 2: свечи; слой 3: кластеры по исполненным сделкам (футпринт bid/ask или профиль)
      if (L.candles) this._drawCandles(ctx, i0, i1);
      if (L.clusters) {
        if (this.opt.view === 'footprint') this._drawFootprint(ctx, i0, i1);
        else this._drawProfiles(ctx, i0, i1);
      }
      this._drawLastPriceLine(ctx);
      ctx.restore();

      // ---- подпанели индикаторов
      for (const p of this.panes) {
        if (p.id === 'main') continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, p.y, this.plotW, p.h);
        ctx.clip();
        this._drawTimeGrid(ctx, i0, i1, p.y, p.h);
        try {
          const s = this._series(p.inst);
          p.series = s;
          const mm = p.def.range(this, p.inst, s, i0, i1);
          p.min = mm[0];
          p.max = mm[1] > mm[0] ? mm[1] : mm[0] + 1;
          const yOf = (v) => p.bot - (v - p.min) / (p.max - p.min) * (p.bot - p.top);
          p.def.draw(this, ctx, p, p.inst, s, i0, i1, yOf);
        } catch (e) {
          console.error('[indicator]', p.inst.type, e);
        }
        ctx.restore();
      }

      this._drawPaneFrames(ctx);
      this._drawPriceAxis(ctx);
      this._drawSubAxes(ctx);
      this._drawTimeAxis(ctx, i0, i1);
      this._updatePaneLegends();
    }

    _clampView() {
      const n = this._candles().length;
      const visBars = this.plotW / this.barW;
      const maxEnd = n - 1 + visBars * 0.9;
      const minEnd = Math.min(n - 1, 5);
      if (this.viewEnd > maxEnd) this.viewEnd = maxEnd;
      if (this.viewEnd < minEnd) this.viewEnd = minEnd;
    }

    _drawPaneFrames(ctx) {
      ctx.strokeStyle = rgba(this.C.border, 1);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const p of this.panes) {
        if (p.id === 'main') continue;
        ctx.moveTo(0, Math.round(p.y) + 0.5);
        ctx.lineTo(this.W, Math.round(p.y) + 0.5);
      }
      ctx.moveTo(0, Math.round(this.timeY) + 0.5);
      ctx.lineTo(this.W, Math.round(this.timeY) + 0.5);
      ctx.moveTo(Math.round(this.plotW) + 0.5, 0);
      ctx.lineTo(Math.round(this.plotW) + 0.5, this.H);
      ctx.stroke();
    }

    // -------------------------------------------------- Z-score bands
    _drawZBands(ctx, i0, i1) {
      const cs = this._candles();
      const bw = this.barW;
      for (let i = i0; i <= i1; i++) {
        const c = cs[i];
        if (!c || !c.z) continue;
        const x0 = Math.floor(this.xOf(i) - bw / 2);
        const w = Math.max(1, Math.floor(this.xOf(i + 1) - bw / 2) - x0);
        for (let side = 0; side < 2; side++) {
          const ref = side === 1 ? c.h : c.l;
          for (let b = 0; b < NB; b++) {
            const z = c.z[side * NB + b];
            if (!isFinite(z)) continue;
            const near = b < Z_DRAW_FROM;
            const lo = Z_BANDS[b] / 100;
            const hi = Z_BANDS[b + 1] / 100;
            let pA;
            let pB;
            if (side === 1) { pA = ref * (1 + lo); pB = ref * (1 + hi); } else { pA = ref * (1 - lo); pB = ref * (1 - hi); }
            const ya = this.yOf(pA);
            const yb = this.yOf(pB);
            const top = Math.min(ya, yb);
            const bot = Math.max(ya, yb);
            if (bot < 0 || top > this.mainH) continue;
            const fill = near ? (Math.abs(z) < 0.5 ? null : Z_LEVELS[0].css(z >= 0 ? (side === 1 ? this.C.zAskSurge : this.C.zBidSurge) : (side === 1 ? this.C.zAskDrain : this.C.zBidDrain))) : this.zFill(side, z);
            if (!fill) continue;
            ctx.fillStyle = fill;
            ctx.fillRect(x0, Math.floor(top), w, Math.max(1, Math.ceil(bot) - Math.floor(top)));
          }
        }
      }
    }

    // ------------------------------------------------ depth map (RGW)
    _drawDepthMap(ctx, i0, i1) {
      const cs = this._candles();
      // нормировка: 97-й перцентиль корзин в видимом окне цены
      const sample = [];
      const pMin = this.pMin;
      const pMax = this.pMax;
      for (let i = i0; i <= i1; i += Math.max(1, Math.floor((i1 - i0) / 120))) {
        const c = cs[i];
        if (!c || !c.book) continue;
        for (let k = 0; k < BUCKETS; k++) {
          const d = (k + 0.5) * BUCKET_PCT / 100;
          const pa = c.c * (1 + d);
          const pb = c.c * (1 - d);
          if (pa <= pMax && c.book.ask[k] > 0) sample.push(c.book.ask[k]);
          if (pb >= pMin && c.book.bid[k] > 0) sample.push(c.book.bid[k]);
        }
      }
      if (!sample.length) return;
      sample.sort((a, b) => a - b);
      const ref = sample[Math.floor(sample.length * 0.97)] || sample[sample.length - 1];
      const bw = this.barW;
      for (let i = i0; i <= i1; i++) {
        const c = cs[i];
        if (!c || !c.book) continue;
        const x0 = Math.floor(this.xOf(i) - bw / 2);
        const w = Math.max(1, Math.floor(this.xOf(i + 1) - bw / 2) - x0);
        for (let side = 0; side < 2; side++) {
          const arr = side === 1 ? c.book.ask : c.book.bid;
          for (let k = 0; k < BUCKETS; k++) {
            const v = arr[k];
            if (!(v > 0)) continue;
            const d0 = k * BUCKET_PCT / 100;
            const d1 = (k + 1) * BUCKET_PCT / 100;
            const pA = side === 1 ? c.c * (1 + d0) : c.c * (1 - d0);
            const pB = side === 1 ? c.c * (1 + d1) : c.c * (1 - d1);
            const ya = this.yOf(pA);
            const yb = this.yOf(pB);
            const top = Math.min(ya, yb);
            const bot = Math.max(ya, yb);
            if (bot < 0 || top > this.mainH) continue;
            const t = Math.min(1, Math.pow(v / ref, 0.9));
            const col = this._rgw(t);
            ctx.fillStyle = rgba(col, 0.1 + 0.8 * t);
            ctx.fillRect(x0, Math.floor(top), w, Math.max(1, Math.ceil(bot) - Math.floor(top)));
          }
        }
      }
    }

    // ------------------------------------------------------- grid
    _priceTicks() {
      const range = this.pMax - this.pMin;
      const step = niceStep(range / Math.max(2, this.mainH / 26));
      const first = Math.ceil(this.pMin / step) * step;
      const ticks = [];
      for (let p = first; p <= this.pMax + 1e-9; p += step) ticks.push(p);
      return { ticks, step };
    }

    _timeStep() {
      const tfMs = this.engine ? this.engine.tfMs : 60e3;
      for (const s of TIME_STEPS) {
        if (s < tfMs) continue;
        if ((s / tfMs) * this.barW >= 78) return s;
      }
      return TIME_STEPS[TIME_STEPS.length - 1];
    }

    _tzOffset(t) {
      return this.opt.tz === 'utc' ? 0 : -new Date(t).getTimezoneOffset() * 60e3;
    }

    _timeTickIdx(i0, i1) {
      const cs = this._candles();
      const step = this._timeStep();
      const out = [];
      for (let i = i0; i <= i1; i++) {
        const c = cs[i];
        if (!c) continue;
        const lt = c.t + this._tzOffset(c.t);
        if (lt % step === 0) out.push(i);
      }
      // продлеваем сетку вправо в пустую область
      const last = cs[cs.length - 1];
      if (last && i1 >= cs.length - 1) {
        const tf = this.engine.tfMs;
        const endIdx = Math.ceil(this.idxAt(this.plotW));
        for (let i = cs.length; i <= endIdx; i++) {
          const t = last.t + (i - (cs.length - 1)) * tf;
          if ((t + this._tzOffset(t)) % step === 0) out.push(i);
        }
      }
      return out;
    }

    _drawGrid(ctx, i0, i1) {
      ctx.strokeStyle = rgba(this.C.border, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      const { ticks } = this._priceTicks();
      for (const p of ticks) {
        const y = Math.round(this.yOf(p)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(this.plotW, y);
      }
      for (const i of this._timeTickIdx(i0, i1)) {
        const x = Math.round(this.xOf(i)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.mainH);
      }
      ctx.stroke();
    }

    _drawTimeGrid(ctx, i0, i1, y, h) {
      ctx.strokeStyle = rgba(this.C.border, 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const i of this._timeTickIdx(i0, i1)) {
        const x = Math.round(this.xOf(i)) + 0.5;
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + h);
      }
      ctx.stroke();
    }

    // ------------------------------------------------------- candles
    _drawCandles(ctx, i0, i1) {
      const cs = this._candles();
      const bw = this.barW;
      const body = Math.max(1, Math.round(bw * (this.opt.view === 'depthmap' ? 0.55 : 0.65)));
      for (let i = i0; i <= i1; i++) {
        const c = cs[i];
        if (!c) continue;
        const x = Math.round(this.xOf(i));
        const up = c.c >= c.o;
        const col = up ? this.C.up : this.C.down;
        ctx.fillStyle = rgba(col, 1);
        const yh = this.yOf(c.h);
        const yl = this.yOf(c.l);
        ctx.fillRect(x, Math.round(yh), 1, Math.max(1, Math.round(yl - yh)));
        const yo = this.yOf(c.o);
        const yc = this.yOf(c.c);
        const top = Math.min(yo, yc);
        const hgt = Math.max(1, Math.abs(yc - yo));
        if (body >= 3) {
          ctx.fillRect(Math.round(x - body / 2 + 0.5), Math.round(top), body, Math.round(hgt) || 1);
        } else {
          ctx.fillRect(x - 1, Math.round(top), 3, Math.round(hgt) || 1);
        }
      }
    }

    // ------------------------------------------------ cluster profiles
    _rowsVisible(c) {
      return this.engine.rowsFor(c, this.opt.rowSize);
    }

    _drawProfiles(ctx, i0, i1) {
      const cs = this._candles();
      const bw = this.barW;
      const rs = this.opt.rowSize;
      const rowPx = rs / (this.pMax - this.pMin) * this.mainH;
      const signed = this._isSignedMetric();
      // засечка: короткая, не длиннее ~60 % шага свечи и 14 px
      const maxLen = Math.max(2, Math.min(bw * 0.6, 14));
      const h = Math.max(1, Math.min(rowPx - (rowPx > 3 ? 1 : 0), 3));
      for (let i = i0; i <= i1; i++) {
        const c = cs[i];
        if (!c) continue;
        const xc = Math.round(this.xOf(i));
        // тень свечи — тонкая светлая линия, как в оригинале
        const yh = this.yOf(c.h);
        const yl = this.yOf(c.l);
        ctx.fillStyle = rgba(c.c >= c.o ? this.C.up : this.C.down, 0.8);
        ctx.fillRect(xc, Math.round(yh), 1, Math.max(1, Math.round(yl - yh)));

        const rows = this._rowsVisible(c);
        if (!rows.length) continue;
        let max = 0;
        let pocIdx = -1;
        let pocV = -1;
        for (let j = 0; j < rows.length; j++) {
          const r = rows[j];
          const v = Math.abs(this._rowMetric(r));
          if (v > max) max = v;
          const vol = r.b + r.s;
          if (vol > pocV) { pocV = vol; pocIdx = j; }
        }
        if (max <= 0) continue;
        for (let j = 0; j < rows.length; j++) {
          const r = rows[j];
          const yMid = this.yOf(r.p + rs / 2);
          if (yMid > this.mainH + 2 || yMid < -2) continue;
          const val = this._rowMetric(r);
          const frac = Math.abs(val) / max;
          if (frac < 0.18) continue;
          const len = Math.max(1, Math.round(frac * maxLen));
          const y = Math.round(yMid - h / 2);
          if (this.opt.metric === 'buysell') {
            const vol = r.b + r.s;
            const lb = vol > 0 ? Math.round(len * r.b / vol) : 0;
            ctx.fillStyle = rgba(this.C.up, 0.9);
            ctx.fillRect(xc + 1, y, lb, h);
            ctx.fillStyle = rgba(this.C.down, 0.9);
            ctx.fillRect(xc + 1 + lb, y, len - lb, h);
          } else {
            let col;
            if (signed) col = val >= 0 ? this.C.up : this.C.down;
            else col = (r.b >= r.s) ? this.C.up : this.C.down;
            ctx.fillStyle = rgba(col, 0.45 + 0.5 * frac);
            ctx.fillRect(xc + 1, y, len, h);
          }
          if (j === pocIdx && rowPx >= 2) {
            ctx.fillStyle = rgba(this.C.text, 0.85);
            ctx.fillRect(xc - 1, y, 3, h);
          }
        }
      }
    }

    _drawFootprint(ctx, i0, i1) {
      const cs = this._candles();
      const bw = this.barW;
      const rs = this.opt.rowSize;
      const rowPx = rs / (this.pMax - this.pMin) * this.mainH;
      if (bw < 44 || rowPx < 10) { this._drawProfiles(ctx, i0, i1); return; }
      const signed = this._isSignedMetric();
      const fontPx = Math.max(9, Math.min(12, Math.floor(rowPx - 2)));
      ctx.font = fontPx + 'px ' + FONT_MONO;
      ctx.textBaseline = 'middle';
      for (let i = i0; i <= i1; i++) {
        const c = cs[i];
        if (!c) continue;
        const xc = this.xOf(i);
        const x0 = Math.floor(xc - bw / 2) + 1;
        const w = Math.max(1, bw - 2);
        const up = c.c >= c.o;
        const rows = this._rowsVisible(c);
        let max = 0;
        let pocIdx = -1;
        let pocV = -1;
        for (let j = 0; j < rows.length; j++) {
          const v = Math.abs(this._rowMetric(rows[j]));
          if (v > max) max = v;
          const vol = rows[j].b + rows[j].s;
          if (vol > pocV) { pocV = vol; pocIdx = j; }
        }
        // свеча-индикатор слева
        const yh = this.yOf(c.h);
        const yl = this.yOf(c.l);
        const yo = this.yOf(c.o);
        const yc = this.yOf(c.c);
        ctx.fillStyle = rgba(up ? this.C.up : this.C.down, 0.9);
        ctx.fillRect(x0, Math.round(yh), 1, Math.max(1, Math.round(yl - yh)));
        ctx.fillRect(x0 - 1, Math.round(Math.min(yo, yc)), 3, Math.max(1, Math.round(Math.abs(yc - yo))));
        const cx0 = x0 + 4;
        const cw = w - 4;
        for (let j = 0; j < rows.length; j++) {
          const r = rows[j];
          const yTop = this.yOf(r.p + rs);
          if (yTop > this.mainH || yTop + rowPx < 0) continue;
          const val = this._rowMetric(r);
          const frac = max > 0 ? Math.abs(val) / max : 0;
          let col;
          if (this.opt.metric === 'buysell' || this.opt.metric === 'volume' || this.opt.metric === 'trades') col = r.b >= r.s ? this.C.up : this.C.down;
          else col = val >= 0 ? this.C.up : this.C.down;
          ctx.fillStyle = rgba(col, 0.06 + 0.28 * frac);
          ctx.fillRect(cx0, Math.round(yTop) + 0.5, cw, Math.max(1, rowPx - 1));
          if (j === pocIdx) {
            ctx.strokeStyle = rgba(this.C.text, 0.75);
            ctx.lineWidth = 1;
            ctx.strokeRect(cx0 + 0.5, Math.round(yTop) + 0.5, cw - 1, Math.max(1, rowPx - 1));
          }
          const yMid = yTop + rowPx / 2;
          if (this.opt.metric === 'buysell') {
            ctx.textAlign = 'right';
            ctx.fillStyle = rgba(this.C.down, 0.95);
            ctx.fillText(fmtCompact(r.s), cx0 + cw / 2 - 4, yMid);
            ctx.fillStyle = rgba(this.C.faint, 0.9);
            ctx.textAlign = 'center';
            ctx.fillText('×', cx0 + cw / 2, yMid);
            ctx.textAlign = 'left';
            ctx.fillStyle = rgba(this.C.up, 0.95);
            ctx.fillText(fmtCompact(r.b), cx0 + cw / 2 + 4, yMid);
          } else {
            ctx.textAlign = 'center';
            ctx.fillStyle = rgba(signed ? col : this.C.text, 0.92);
            const txt = signed ? fmtSigned(val, fmtCompact) : fmtCompact(val);
            ctx.fillText(txt, cx0 + cw / 2, yMid);
          }
        }
      }
    }

    _drawLastPriceLine(ctx) {
      const cs = this._candles();
      const last = cs[cs.length - 1];
      if (!last) return;
      const y = Math.round(this.yOf(last.c)) + 0.5;
      const col = last.c >= last.o ? this.C.up : this.C.down;
      ctx.strokeStyle = rgba(col, 0.7);
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ------------------------------------------------------- sub panes
    _drawPriceAxis(ctx) {
      const x = this.plotW;
      ctx.fillStyle = rgba(this.C.bg, 1);
      ctx.fillRect(x + 1, 0, AXIS_W, this.mainH);
      const { ticks, step } = this._priceTicks();
      const dec = Math.max(stepDecimals(step), 0);
      ctx.font = '11px ' + FONT_MONO;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = rgba(this.C.muted, 1);
      for (const p of ticks) {
        const y = this.yOf(p);
        if (y < 6 || y > this.mainH - 26) continue;
        ctx.fillText(fmtNum(p, Math.min(dec, this.opt.priceDecimals)), x + 8, y);
      }
      const cs = this._candles();
      const last = cs[cs.length - 1];
      if (last) {
        const y = Math.max(8, Math.min(this.mainH - 8, this.yOf(last.c)));
        const col = last.c >= last.o ? this.C.up : this.C.down;
        ctx.fillStyle = rgba(col, 1);
        ctx.fillRect(x + 2, Math.round(y - 9), AXIS_W - 4, 18);
        ctx.fillStyle = rgba(this.C.bg, 1);
        ctx.font = '600 11px ' + FONT_MONO;
        ctx.fillText(fmtNum(last.c, this.opt.priceDecimals), x + 8, y + 0.5);
      }
    }

    _drawSubAxes(ctx) {
      ctx.font = '10px ' + FONT_MONO;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (const p of this.panes) {
        if (p.id === 'main') continue;
        ctx.fillStyle = rgba(this.C.bg, 1);
        ctx.fillRect(this.plotW + 1, p.y + 1, AXIS_W, p.h - 1);
        const yOf = (v) => p.bot - (v - p.min) / (p.max - p.min) * (p.bot - p.top);
        const f = p.def.fmtAxis ? (v) => p.def.fmtAxis(v, this) : (v) => fmtShort(v);
        ctx.fillStyle = rgba(this.C.faint, 1);
        let labels;
        if (p.def.axisLabels) labels = p.def.axisLabels(p.inst, this);
        else labels = [[p.max, null], [(p.min < 0 && p.max > 0) ? 0 : (p.min + p.max) / 2, null], [p.min, null]];
        for (const lb of labels) {
          const v = lb[0];
          const y = Math.max(p.top + 4, Math.min(p.bot - 3, yOf(v)));
          const t = lb[1] !== null ? lb[1] : (v > 0 && p.min < 0 ? '+' : '') + f(v);
          ctx.fillText(t, this.plotW + 8, y);
        }
      }
    }

    _fmtTime(t, withDate) {
      const d = new Date(t + this._tzOffset(t));
      const hh = pad2(d.getUTCHours());
      const mm = pad2(d.getUTCMinutes());
      if (withDate) return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + ' ' + hh + ':' + mm;
      if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1);
      return hh + ':' + mm;
    }

    _timeOfIdx(i) {
      const cs = this._candles();
      if (!cs.length) return 0;
      if (i <= cs.length - 1 && i >= 0) return cs[Math.round(i)].t;
      const tf = this.engine.tfMs;
      if (i < 0) return cs[0].t + Math.round(i) * tf;
      return cs[cs.length - 1].t + (Math.round(i) - (cs.length - 1)) * tf;
    }

    _drawTimeAxis(ctx, i0, i1) {
      const y = this.timeY;
      ctx.fillStyle = rgba(this.C.bg, 1);
      ctx.fillRect(0, y + 1, this.W, TIME_H);
      ctx.font = '11px ' + FONT_MONO;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      for (const i of this._timeTickIdx(i0, i1)) {
        const x = this.xOf(i);
        if (x < 20 || x > this.plotW - 20) continue;
        const t = this._timeOfIdx(i);
        const label = this._fmtTime(t, false);
        const isDate = label.indexOf('.') > 0;
        ctx.fillStyle = rgba(isDate ? this.C.text : this.C.muted, 1);
        ctx.fillText(label, x, y + TIME_H / 2);
      }
    }

    // ------------------------------------------------ legends (HTML)
    _legendIdx() {
      const cs = this._candles();
      if (this.hover && this.hover.idx >= 0 && this.hover.idx < cs.length) return this.hover.idx;
      return cs.length - 1;
    }

    _updatePaneLegends() {
      const cs = this._candles();
      const i = this._legendIdx();
      if (!cs[i]) return;
      // общая метка времени: все панели читают одну и ту же свечу
      if (this.els.legendLayer) {
        this.els.legendLayer.dataset.time = 'свеча ' + this._fmtTime(cs[i].t, true) + (this.opt.tz === 'utc' ? ' UTC' : '');
      }
      for (const p of this.panes) {
        if (p.id === 'main' || !p.legendEl || !p.series) continue;
        let out;
        try { out = p.def.legend(this, p.inst, p.series, i) || {}; } catch (e) { out = {}; }
        const vals = out.vals || '';
        const right = out.right || '';
        if (p._lastVals !== vals) { p.valsEl.innerHTML = vals; p._lastVals = vals; }
        if (p._lastRight !== right) { p.rvEl.innerHTML = right; p._lastRight = right; }
      }
    }


    _drawProfileCol() {
      const cv = this.els.profile;
      const ctx = cv.getContext('2d');
      const dpr = this.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.PW, this.PH);
      ctx.fillStyle = rgba(this.C.bg, 1);
      ctx.fillRect(0, 0, this.PW, this.PH);
      const cs = this._candles();
      if (!cs.length || !this.vis) return;
      const [i0, i1] = this.vis;
      // строку профиля укрупняем до ≥ 2 px
      const pxPerPrice = this.mainH / (this.pMax - this.pMin);
      let rs = this.opt.rowSize;
      const mult = Math.max(1, Math.ceil(2 / (rs * pxPerPrice)));
      rs = rs * mult;
      const agg = new Map();
      const first = Math.max(i0, 0);
      for (let i = first; i <= i1; i++) {
        const c = cs[i];
        if (!c) continue;
        const rows = this.engine.rowsFor(c, this.opt.rowSize);
        for (const r of rows) {
          const key = Math.floor(r.p / rs + 1e-9);
          let a = agg.get(key);
          if (!a) { a = { b: 0, s: 0, n: 0, nb: 0, ns: 0 }; agg.set(key, a); }
          a.b += r.b; a.s += r.s; a.n += r.n; a.nb += r.nb; a.ns += r.ns;
        }
      }
      let max = 0;
      let pocKey = null;
      let pocV = -1;
      for (const [key, a] of agg) {
        const v = Math.abs(this._rowMetric({ b: a.b, s: a.s, n: a.n, nb: a.nb, ns: a.ns }));
        if (v > max) max = v;
        if (a.b + a.s > pocV) { pocV = a.b + a.s; pocKey = key; }
      }
      if (max <= 0) return;
      const W = Math.round((this.PW - 6) * 0.7);
      const h = Math.max(1, rs * pxPerPrice - (rs * pxPerPrice > 3 ? 1 : 0));
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, this.PW, this.mainH);
      ctx.clip();
      for (const [key, a] of agg) {
        const yTop = this.yOf((key + 1) * rs);
        if (yTop > this.mainH || yTop + h < 0) continue;
        const r = { b: a.b, s: a.s, n: a.n, nb: a.nb, ns: a.ns };
        const val = this._rowMetric(r);
        const len = Math.abs(val) / max * W;
        if (this.opt.metric === 'buysell' || this.opt.metric === 'volume') {
          const vol = a.b + a.s;
          const lb = vol > 0 ? len * a.b / vol : 0;
          ctx.fillStyle = rgba(this.C.up, 0.8);
          ctx.fillRect(2, Math.round(yTop), lb, h);
          ctx.fillStyle = rgba(this.C.down, 0.8);
          ctx.fillRect(2 + lb, Math.round(yTop), len - lb, h);
        } else if (this.opt.metric === 'trades') {
          ctx.fillStyle = rgba(a.nb >= a.ns ? this.C.up : this.C.down, 0.75);
          ctx.fillRect(2, Math.round(yTop), Math.max(1, len), h);
        } else {
          ctx.fillStyle = rgba(val >= 0 ? this.C.up : this.C.down, 0.85);
          ctx.fillRect(2, Math.round(yTop), Math.max(1, len), h);
        }
        if (key === pocKey) {
          ctx.fillStyle = rgba(this.C.text, 0.9);
          ctx.fillRect(2, Math.round(yTop + h / 2), W, 1);
        }
      }
      ctx.restore();
      // разделитель подвалов
      ctx.strokeStyle = rgba(this.C.border, 1);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(this.mainH) + 0.5);
      ctx.lineTo(this.PW, Math.round(this.mainH) + 0.5);
      ctx.stroke();
    }

    // ===================================================== OVERLAY
    _drawOverlay() {
      const ctx = this.els.overlay.getContext('2d');
      const dpr = this.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);
      const cs = this._candles();
      if (!cs.length) { this._hideTooltip(); return; }

      this._drawRuler(ctx);

      const h = this.hover;
      if (!h) { this._hideTooltip(); return; }
      const x = Math.round(this.xOf(h.idx)) + 0.5;
      ctx.strokeStyle = rgba(this.C.muted, 0.6);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      if (x >= 0 && x <= this.plotW) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.timeY);
      }
      if (h.y < this.timeY) {
        const y = Math.round(h.y) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(this.plotW, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // метка времени
      if (x >= 0 && x <= this.plotW) {
        const label = this._fmtTime(this._timeOfIdx(h.idx), true);
        ctx.font = '600 11px ' + FONT_MONO;
        const tw = ctx.measureText(label).width + 14;
        const lx = Math.max(0, Math.min(this.plotW - tw, x - tw / 2));
        ctx.fillStyle = rgba(this.C.bone, 0.92);
        ctx.fillRect(lx, this.timeY + 4, tw, TIME_H - 8);
        ctx.fillStyle = rgba(this.C.bg, 1);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, lx + tw / 2, this.timeY + TIME_H / 2);
      }

      // метка значения на оси
      if (h.y < this.timeY) {
        let label = null;
        if (h.pane === 'main') label = fmtNum(this.pAt(h.y), this.opt.priceDecimals);
        else {
          const s = this.panes.find((p) => p.id === h.pane);
          if (s && s.def && h.y >= s.top && h.y <= s.bot) {
            const v = s.min + (s.bot - h.y) / (s.bot - s.top) * (s.max - s.min);
            label = s.def.fmtAxis ? s.def.fmtAxis(v, this) : fmtShort(v);
          }
        }
        if (label) {
          ctx.font = '600 11px ' + FONT_MONO;
          ctx.fillStyle = rgba(this.C.bone, 0.92);
          ctx.fillRect(this.plotW + 2, Math.round(h.y - 9), AXIS_W - 4, 18);
          ctx.fillStyle = rgba(this.C.bg, 1);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, this.plotW + 8, h.y + 0.5);
        }
      }

      // подсветка строки кластера + тултип
      if (h.pane === 'main' && !this.drag && !this.ruler.active && this.opt.layers.clusters) {
        const c = cs[h.idx];
        const price = this.pAt(h.y);
        if (c && price <= c.h + this.opt.rowSize && price >= c.l - this.opt.rowSize) {
          const rows = this.engine.rowsFor(c, this.opt.rowSize);
          const key = Math.floor(price / this.opt.rowSize + 1e-9) * this.opt.rowSize;
          const row = rows.find((r) => Math.abs(r.p - key) < this.opt.rowSize * 1e-6);
          if (row) {
            const yTop = this.yOf(row.p + this.opt.rowSize);
            const yBot = this.yOf(row.p);
            const bw = this.barW;
            ctx.strokeStyle = rgba(this.C.text, 0.9);
            ctx.lineWidth = 1;
            ctx.strokeRect(Math.floor(this.xOf(h.idx) - bw / 2) + 0.5, Math.round(yTop) + 0.5, Math.max(2, bw - 1), Math.max(1, Math.round(yBot - yTop)));
            this._showTooltip(c, row, h);
            return;
          }
        }
      }
      this._hideTooltip();
    }

    _drawRuler(ctx) {
      const r = this.ruler;
      if (!r.a || !r.b) return;
      const xa = this.xOf(r.a.idx);
      const xb = this.xOf(r.b.idx);
      const ya = this.yOf(r.a.p);
      const yb = this.yOf(r.b.p);
      const up = r.b.p >= r.a.p;
      const col = up ? this.C.up : this.C.down;
      ctx.fillStyle = rgba(col, 0.12);
      ctx.fillRect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya));
      ctx.strokeStyle = rgba(col, 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xa, ya);
      ctx.lineTo(xb, yb);
      ctx.stroke();
      const dp = r.b.p - r.a.p;
      const pct = dp / r.a.p * 100;
      const bars = Math.round(r.b.idx - r.a.idx);
      const dt = Math.abs(bars) * this.engine.tfMs;
      const hrs = Math.floor(dt / 3600e3);
      const mins = Math.round((dt % 3600e3) / 60e3);
      // объём между точками
      let vol = 0;
      let delta = 0;
      const cs = this._candles();
      for (let i = Math.max(0, Math.min(r.a.idx, r.b.idx)); i <= Math.min(cs.length - 1, Math.max(r.a.idx, r.b.idx)); i++) {
        vol += cs[i].v;
        delta += 2 * cs[i].buy - cs[i].v;
      }
      const lines = [
        fmtSigned(dp, (v) => fmtNum(v, this.opt.priceDecimals)) + ' (' + fmtSigned(pct, (v) => fmtNum(v, 2)) + ' %)',
        bars + ' св. · ' + (hrs ? hrs + ' ч ' : '') + mins + ' мин',
        'об. ' + fmtCompact(vol) + ' · Δ ' + fmtSigned(delta, fmtCompact) + ' ' + this.opt.baseAsset
      ];
      ctx.font = '11px ' + FONT_MONO;
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
      const th = lines.length * 15 + 8;
      let bx = (xa + xb) / 2 - tw / 2;
      let by = (up ? Math.min(ya, yb) - th - 6 : Math.max(ya, yb) + 6);
      bx = Math.max(2, Math.min(this.plotW - tw - 2, bx));
      by = Math.max(2, Math.min(this.mainH - th - 2, by));
      ctx.fillStyle = rgba(col, 0.92);
      ctx.fillRect(bx, by, tw, th);
      ctx.fillStyle = rgba(this.C.bg, 1);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((l, k) => ctx.fillText(l, bx + 7, by + 5 + k * 15));
    }

    _showTooltip(c, row, h) {
      const el = this.els.tooltip;
      const vol = row.b + row.s;
      const bPct = vol > 0 ? row.b / vol * 100 : 0;
      const sPct = vol > 0 ? row.s / vol * 100 : 0;
      const d = row.b - row.s;
      const dPct = vol > 0 ? d / vol * 100 : 0;
      const cDelta = 2 * c.buy - c.v;
      const asset = this.opt.baseAsset;
      const tf = this.opt.tfLabel;
      // Z-полоса под курсором
      const price = row.p + this.opt.rowSize / 2;
      const side = price >= c.c ? 1 : 0;
      const dist = Math.abs(price - c.c) / c.c * 100;
      let zTxt = '';
      if (c.z && this.zEnabled) {
        let b = -1;
        for (let k = 0; k < NB; k++) if (dist >= Z_BANDS[k] && dist < Z_BANDS[k + 1]) { b = k; break; }
        if (b >= 0) {
          const z = c.z[side * NB + b];
          if (isFinite(z)) {
            const name = side === 1 ? 'аск' : 'бид';
            zTxt = '<div class="ct-tt-row"><span>Z ' + name + ' ' + fmtNum(Z_BANDS[b], 2).replace(/,?0+$/, '') + '–' + fmtNum(Z_BANDS[b + 1], 2).replace(/,?0+$/, '') + ' %</span><b style="color:' + rgba(this.zColor(side, z), 1) + '">' + fmtSigned(z, (v) => fmtNum(v, 2)) + '</b></div>';
          }
        }
      }
      const synthetic = !(c.covered && c.clusters);
      el.innerHTML =
        '<div class="ct-tt-head">' + this._fmtTime(c.t, true) + (this.opt.tz === 'utc' ? ' UTC' : '') + ' · ' + tf + '</div>' +
        '<div class="ct-tt-price">' + fmtNum(row.p, this.opt.priceDecimals) + '</div>' +
        '<div class="ct-tt-row"><span>Объём</span><b>' + fmtCompact(vol) + ' ' + asset + '</b></div>' +
        '<div class="ct-tt-row"><span>Покупки</span><b class="ct-up">' + fmtCompact(row.b) + ' <span class="ct-tt-pct">· ' + fmtNum(bPct, 0) + ' %</span></b></div>' +
        '<div class="ct-tt-bar"><i style="width:' + bPct.toFixed(1) + '%;background:var(--color-up)"></i></div>' +
        '<div class="ct-tt-row"><span>Продажи</span><b class="ct-down">' + fmtCompact(row.s) + ' <span class="ct-tt-pct">· ' + fmtNum(sPct, 0) + ' %</span></b></div>' +
        '<div class="ct-tt-bar"><i style="width:' + sPct.toFixed(1) + '%;background:var(--color-down)"></i></div>' +
        '<div class="ct-tt-row"><span>Дельта объёма</span><b class="' + (d >= 0 ? 'ct-up' : 'ct-down') + '">' + fmtSigned(d, fmtCompact) + ' · ' + fmtSigned(dPct, (v) => fmtNum(v, 0)) + ' %</b></div>' +
        '<div class="ct-tt-row"><span>Сделки</span><b>' + fmtNum(Math.round(row.n), 0) + '</b></div>' +
        zTxt +
        '<div class="ct-tt-sep"></div>' +
        '<div class="ct-tt-row"><span>Свеча</span><b>об. ' + fmtCompact(c.v) + ' · Δ <span class="' + (cDelta >= 0 ? 'ct-up' : 'ct-down') + '">' + fmtSigned(cDelta, fmtCompact) + '</span></b></div>' +
        (synthetic ? '<div class="ct-tt-note">оценка по OHLCV — свеча старше загруженной ленты сделок</div>' : '');
      el.setAttribute('data-show', 'true');
      const tw = el.offsetWidth;
      const th = el.offsetHeight;
      let lx = h.x + 18;
      let ly = h.y + 14;
      if (lx + tw > this.plotW - 4) lx = h.x - tw - 18;
      if (ly + th > this.mainH - 4) ly = Math.max(4, this.mainH - th - 4);
      el.style.left = Math.max(4, lx) + 'px';
      el.style.top = Math.max(4, ly) + 'px';
    }

    _hideTooltip() {
      this.els.tooltip.setAttribute('data-show', 'false');
    }

    // ===================================================== INPUT
    _paneAt(y) {
      for (const p of this.panes) if (y >= p.y && y < p.y + p.h) return p.id;
      return y >= this.timeY ? 'time' : 'main';
    }

    _bind() {
      const ov = this.els.overlay;
      const host = this.els.host;
      const pos = (e) => {
        const r = ov.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };

      ov.addEventListener('pointermove', (e) => {
        const { x, y } = pos(e);
        if (this.drag) { this._dragMove(x, y); return; }
        host.classList.toggle('ct-axis-hover', x > this.plotW && y < this.mainH);
        host.classList.toggle('ct-time-hover', y >= this.timeY);
        if (x > this.plotW || y >= this.timeY) {
          this.hover = x <= this.plotW ? { x, y, idx: Math.round(this.idxAt(x)), pane: this._paneAt(y) } : null;
        } else {
          this.hover = { x, y, idx: Math.round(this.idxAt(x)), pane: this._paneAt(y) };
        }
        if (this.ruler.active && this.hover && this.hover.pane === 'main') {
          this.ruler.b = { idx: this.hover.idx, p: this.pAt(y) };
        }
        this.overlayDirty = true;
        this._updatePaneLegends();
      });

      ov.addEventListener('pointerleave', () => {
        if (this.drag) return;
        this.hover = null;
        this.overlayDirty = true;
        this._updatePaneLegends();
      });

      ov.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const { x, y } = pos(e);
        ov.setPointerCapture(e.pointerId);
        if (this.ruler.on && y < this.mainH && x < this.plotW) {
          if (!this.ruler.active) {
            const a = { idx: Math.round(this.idxAt(x)), p: this.pAt(y) };
            this.ruler.a = a;
            this.ruler.b = Object.assign({}, a);
            this.ruler.active = true;
          } else {
            this.ruler.active = false;
          }
          this.overlayDirty = true;
          return;
        }
        if (this.ruler.a && !this.ruler.on) { this.ruler.a = null; this.ruler.b = null; }
        let mode = 'pan';
        if (x > this.plotW && y < this.mainH) mode = 'yscale';
        else if (y >= this.timeY) mode = 'xscale';
        this.drag = { mode, x0: x, y0: y, viewEnd: this.viewEnd, barW: this.barW, pMin: this.pMin, pMax: this.pMax };
        host.classList.add('ct-dragging');
        this._hideTooltip();
      });

      const end = (e) => {
        if (!this.drag) return;
        this.drag = null;
        host.classList.remove('ct-dragging');
        try { ov.releasePointerCapture(e.pointerId); } catch (err) { /* нет захвата */ }
        this.overlayDirty = true;
      };
      ov.addEventListener('pointerup', end);
      ov.addEventListener('pointercancel', end);

      ov.addEventListener('wheel', (e) => {
        e.preventDefault();
        const { x, y } = pos(e);
        if ((x > this.plotW && y < this.mainH) || e.ctrlKey) {
          const f = Math.exp(e.deltaY * 0.0015);
          const center = x > this.plotW ? (this.pMax + this.pMin) / 2 : this.pAt(y);
          this.pMin = center - (center - this.pMin) * f;
          this.pMax = center + (this.pMax - center) * f;
          this.setAuto(false);
          return;
        }
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const d = e.shiftKey ? e.deltaY : e.deltaX;
          this.viewEnd += d / this.barW * 0.6;
          this.requestDraw(true);
          return;
        }
        const ax = Math.min(x, this.plotW);
        const idx = this.idxAt(ax);
        const f = Math.exp(-e.deltaY * 0.0015);
        this.barW = Math.max(1, Math.min(220, this.barW * f));
        this.viewEnd = idx + (this.plotW - ax) / this.barW;
        this.requestDraw(true);
      }, { passive: false });

      ov.addEventListener('dblclick', (e) => {
        const { x, y } = pos(e);
        if (x > this.plotW && y < this.mainH) { this.setAuto(true); return; }
        this.resetView();
      });

      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
        if (e.key === 'Escape' && (this.ruler.a || this.ruler.on)) {
          this.ruler.a = null; this.ruler.b = null; this.ruler.active = false;
          this.overlayDirty = true;
        }
      });
    }

    _dragMove(x, y) {
      const d = this.drag;
      const dx = x - d.x0;
      const dy = y - d.y0;
      if (d.mode === 'pan') {
        this.viewEnd = d.viewEnd - dx / this.barW;
        if (!this.auto) {
          const shift = dy / this.mainH * (d.pMax - d.pMin);
          this.pMin = d.pMin + shift;
          this.pMax = d.pMax + shift;
        }
      } else if (d.mode === 'yscale') {
        const f = Math.exp(dy * 0.006);
        const mid = (d.pMax + d.pMin) / 2;
        const half = (d.pMax - d.pMin) / 2 * f;
        this.pMin = mid - half;
        this.pMax = mid + half;
        if (this.auto) this.setAuto(false);
      } else if (d.mode === 'xscale') {
        const f = Math.exp(-dx * 0.006);
        this.barW = Math.max(1, Math.min(220, d.barW * f));
      }
      this.hover = null;
      this.requestDraw(true);
    }

    setRuler(on) {
      this.ruler.on = on;
      if (!on) { this.ruler.active = false; }
      this.overlayDirty = true;
    }
  }

  global.ChartRenderer = ChartRenderer;
  global.CTFormat = { fmtNum, fmtCompact, fmtSigned, fmtShort };
})(window);
