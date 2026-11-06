/* ==========================================================================
   storage-db.js — локальное хранилище истории стакана и Z-Score в IndexedDB.

   Хранилища:
     book   — минутные агрегаты стакана (сетка ликвидности по 0,05 % от mid,
              200 корзин на сторону = до 10 %), ключ id = "market|symbol|t".
     zscore — рассчитанные Z-Score полос по закрытым свечам,
              ключ id = "market|symbol|tf|base|t".
     meta   — служебные значения (время последней очистки и т.п.).
   ========================================================================== */
(function (global) {
  'use strict';

  const DB_NAME = 'cryptoterminal';
  const DB_VERSION = 1;
  const KEEP_MS = 8 * 24 * 3600 * 1000; // храним 8 суток (база до 7 дней + запас)

  let dbPromise = null;
  let available = typeof indexedDB !== 'undefined';

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  }

  function open() {
    if (!available) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        available = false;
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('book')) {
          const s = db.createObjectStore('book', { keyPath: 'id' });
          s.createIndex('bySym', ['ms', 't'], { unique: false });
          s.createIndex('byT', 't', { unique: false });
        }
        if (!db.objectStoreNames.contains('zscore')) {
          const s = db.createObjectStore('zscore', { keyPath: 'id' });
          s.createIndex('byKey', ['k', 't'], { unique: false });
          s.createIndex('byT', 't', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => {
        console.warn('[storage-db] IndexedDB недоступна:', req.error);
        available = false;
        resolve(null);
      };
      req.onblocked = () => console.warn('[storage-db] открытие БД заблокировано другой вкладкой');
    });
    return dbPromise;
  }

  function msKey(market, symbol) {
    return market + '|' + symbol;
  }

  function zKey(market, symbol, tf, base) {
    return market + '|' + symbol + '|' + tf + '|' + base;
  }

  /**
   * Сохранить минутный агрегат стакана.
   * rec = { market, symbol, t, mid, n, bid: Float32Array, ask: Float32Array }
   */
  async function putBookMinute(rec) {
    const db = await open();
    if (!db) return false;
    const ms = msKey(rec.market, rec.symbol);
    const row = {
      id: ms + '|' + rec.t,
      ms,
      t: rec.t,
      mid: rec.mid,
      n: rec.n,
      bid: rec.bid,
      ask: rec.ask
    };
    const tx = db.transaction('book', 'readwrite');
    tx.objectStore('book').put(row);
    await txDone(tx);
    return true;
  }

  /** Все минутные записи стакана символа в интервале [from, to]. */
  async function getBookMinutes(market, symbol, from, to) {
    const db = await open();
    if (!db) return [];
    const ms = msKey(market, symbol);
    const tx = db.transaction('book', 'readonly');
    const idx = tx.objectStore('book').index('bySym');
    const range = IDBKeyRange.bound([ms, from], [ms, to]);
    const rows = await reqToPromise(idx.getAll(range));
    return rows;
  }

  /**
   * Сохранить Z-Score закрытых свечей.
   * recs = [{ t, bid: Float32Array, ask: Float32Array, real: number(0..1) }]
   */
  async function putZScores(market, symbol, tf, base, recs) {
    if (!recs || !recs.length) return false;
    const db = await open();
    if (!db) return false;
    const k = zKey(market, symbol, tf, base);
    const tx = db.transaction('zscore', 'readwrite');
    const store = tx.objectStore('zscore');
    for (const r of recs) {
      store.put({ id: k + '|' + r.t, k, t: r.t, bid: r.bid, ask: r.ask, real: r.real });
    }
    await txDone(tx);
    return true;
  }

  /** Сохранённые Z-Score свечей в интервале [from, to]. Возвращает Map(t → rec). */
  async function getZScores(market, symbol, tf, base, from, to) {
    const out = new Map();
    const db = await open();
    if (!db) return out;
    const k = zKey(market, symbol, tf, base);
    const tx = db.transaction('zscore', 'readonly');
    const idx = tx.objectStore('zscore').index('byKey');
    const rows = await reqToPromise(idx.getAll(IDBKeyRange.bound([k, from], [k, to])));
    for (const r of rows) out.set(r.t, r);
    return out;
  }

  async function deleteOlderThan(storeName, cutoff) {
    const db = await open();
    if (!db) return 0;
    const tx = db.transaction(storeName, 'readwrite');
    const idx = tx.objectStore(storeName).index('byT');
    let removed = 0;
    await new Promise((resolve, reject) => {
      const cur = idx.openCursor(IDBKeyRange.upperBound(cutoff));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve(); return; }
        c.delete();
        removed++;
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    await txDone(tx);
    return removed;
  }

  /** Удалить записи старше KEEP_MS (по умолчанию 8 суток). */
  async function prune(now) {
    const cutoff = (now || Date.now()) - KEEP_MS;
    const a = await deleteOlderThan('book', cutoff);
    const b = await deleteOlderThan('zscore', cutoff);
    await setMeta('lastPrune', Date.now());
    return { book: a, zscore: b };
  }

  async function setMeta(key, value) {
    const db = await open();
    if (!db) return;
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    await txDone(tx);
  }

  async function getMeta(key) {
    const db = await open();
    if (!db) return undefined;
    const tx = db.transaction('meta', 'readonly');
    const row = await reqToPromise(tx.objectStore('meta').get(key));
    return row ? row.value : undefined;
  }

  /** Сводка: количество записей и первая/последняя минута стакана по символу. */
  async function stats(market, symbol) {
    const db = await open();
    if (!db) return { available: false, book: 0, zscore: 0, first: null, last: null };
    const tx = db.transaction(['book', 'zscore'], 'readonly');
    const book = await reqToPromise(tx.objectStore('book').count());
    const zscore = await reqToPromise(tx.objectStore('zscore').count());
    let first = null;
    let last = null;
    if (market && symbol) {
      const ms = msKey(market, symbol);
      const idx = tx.objectStore('book').index('bySym');
      const range = IDBKeyRange.bound([ms, 0], [ms, Number.MAX_SAFE_INTEGER]);
      const c1 = await reqToPromise(idx.openCursor(range, 'next'));
      if (c1) first = c1.value.t;
      const c2 = await reqToPromise(idx.openCursor(range, 'prev'));
      if (c2) last = c2.value.t;
    }
    return { available: true, book, zscore, first, last };
  }

  /** Полная очистка истории. */
  async function clearAll() {
    const db = await open();
    if (!db) return;
    const tx = db.transaction(['book', 'zscore'], 'readwrite');
    tx.objectStore('book').clear();
    tx.objectStore('zscore').clear();
    await txDone(tx);
  }

  global.StorageDB = {
    open,
    putBookMinute,
    getBookMinutes,
    putZScores,
    getZScores,
    prune,
    stats,
    clearAll,
    setMeta,
    getMeta,
    get available() { return available; },
    KEEP_MS
  };
})(window);
