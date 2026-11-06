#!/usr/bin/env python3
"""
CryptoTerminal — локальный сервер.

1. Раздаёт файлы терминала (index.html, *.js, styles.css) без кэширования.
2. Если задан API-ключ Binance (только чтение), раз в минуту опрашивает
   пул кросс-маржи  GET /sapi/v1/margin/available-inventory?type=MARGIN
   и выводит из изменений пула займы (пул уменьшился) и погашения
   (пул вырос). История пишется в data/inventory-YYYYMMDD.jsonl и
   переживает перезапуск.
3. Отдаёт странице «Маржа» готовые расчёты:
     /api/margin/status             состояние сборщика
     /api/margin/table?win=24&base=7  займы, погашения, Z-оценки, пул
     /api/margin/series?asset=BTC&days=7   ряды по одному активу
     /api/margin/events?...         «пул пуст» и «всплеск займов»

Ключ берётся из переменных окружения BINANCE_API_KEY / BINANCE_API_SECRET
или из файла config.local.json рядом со скриптом:
    {"binance_api_key": "...", "binance_api_secret": "..."}
Файл исключён из git. Ключу нужно только право чтения (Enable Reading).

Запуск:  python server.py            (порт 8765)
         python server.py --port 9000
"""
import argparse
import hashlib
import hmac
import http.server
import json
import math
import os
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(ROOT, 'config.local.json')
DATA_DIR = os.path.join(ROOT, 'data')
BUCKET = 300              # 5 минут
POLL_SEC = 60             # опрос пула
PRICE_SEC = 300           # обновление цен
KEEP_DAYS = 15            # сколько дней держать историю
UA = 'CryptoTerminal/1.0 (local)'


# ---------------------------------------------------------------- config
def load_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
        except (OSError, ValueError) as e:
            print('[config] не удалось прочитать config.local.json:', e, file=sys.stderr)
    key = os.environ.get('BINANCE_API_KEY') or cfg.get('binance_api_key') or ''
    secret = os.environ.get('BINANCE_API_SECRET') or cfg.get('binance_api_secret') or ''
    return key.strip(), secret.strip()


# ---------------------------------------------------------------- http
def http_json(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers=dict({'User-Agent': UA}, **(headers or {})))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


TIME_OFFSET = {'ms': 0, 'synced': 0.0}


def sync_time(force=False):
    """Поправка к локальным часам по серверу Binance (ошибка -1021, если часы ПК спешат)."""
    if not force and time.time() - TIME_OFFSET['synced'] < 600:
        return
    t0 = time.time() * 1000
    srv = http_json('https://api.binance.com/api/v3/time')['serverTime']
    t1 = time.time() * 1000
    TIME_OFFSET['ms'] = int(srv - (t0 + t1) / 2)
    TIME_OFFSET['synced'] = time.time()


def signed_get(key, secret, path, params):
    sync_time()
    p = dict(params)
    p['timestamp'] = int(time.time() * 1000) + TIME_OFFSET['ms']
    p['recvWindow'] = 10000
    q = urllib.parse.urlencode(p)
    sig = hmac.new(secret.encode(), q.encode(), hashlib.sha256).hexdigest()
    try:
        return http_json('https://api.binance.com' + path + '?' + q + '&signature=' + sig, {'X-MBX-APIKEY': key})
    except urllib.error.HTTPError as e:
        if e.code == 400 and b'-1021' in e.read():
            sync_time(force=True)       # часы ушли — пересинхронизироваться и повторить один раз
            return signed_get_once(key, secret, path, params)
        raise


def signed_get_once(key, secret, path, params):
    p = dict(params)
    p['timestamp'] = int(time.time() * 1000) + TIME_OFFSET['ms']
    p['recvWindow'] = 10000
    q = urllib.parse.urlencode(p)
    sig = hmac.new(secret.encode(), q.encode(), hashlib.sha256).hexdigest()
    return http_json('https://api.binance.com' + path + '?' + q + '&signature=' + sig, {'X-MBX-APIKEY': key})


# ---------------------------------------------------------------- stats
def mean_std(xs):
    n = len(xs)
    if n < 2:
        return None, None
    m = sum(xs) / n
    v = sum((x - m) ** 2 for x in xs) / (n - 1)
    return m, math.sqrt(v)


def zscore(x, xs):
    m, s = mean_std(xs)
    if m is None or not s or s <= 0:
        return None
    return (x - m) / s


# ---------------------------------------------------------------- collector
class Collector:
    def __init__(self, key, secret):
        self.key = key
        self.secret = secret
        self.lock = threading.Lock()
        self.pool = {}            # текущий пул: asset -> количество
        self.pool_hist = {}       # asset -> [(t, pool)] только при изменении
        self.flows = {}           # asset -> {bucket: [borrow, repay]}
        self.prices = {}          # asset -> цена в USDT
        self.first_t = None
        self.last_poll = None
        self.last_error = None
        self.polls = 0
        self.started = time.time()
        self._day_file = None
        self._day = None
        os.makedirs(DATA_DIR, exist_ok=True)
        self._replay()

    @property
    def configured(self):
        return bool(self.key and self.secret)

    # -------------------------------------------------- storage
    def _replay(self):
        cutoff = time.time() - KEEP_DAYS * 86400
        files = sorted(f for f in os.listdir(DATA_DIR) if f.startswith('inventory-') and f.endswith('.jsonl'))
        prev = {}
        for name in files:
            path = os.path.join(DATA_DIR, name)
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rec = json.loads(line)
                        except ValueError:
                            continue   # обрезанная строка после сбоя питания
                        t = rec.get('t')
                        if not t or t < cutoff:
                            if 'full' in rec:
                                prev = {k: float(v) for k, v in rec['full'].items()}
                            elif 'd' in rec:
                                for k, v in rec['d'].items():
                                    prev[k] = float(v)
                            continue
                        if 'full' in rec:
                            snap = {k: float(v) for k, v in rec['full'].items()}
                        else:
                            snap = dict(prev)
                            for k, v in rec.get('d', {}).items():
                                snap[k] = float(v)
                        self._ingest(t, prev, snap, persist=False)
                        prev = snap
            except OSError as e:
                print('[replay]', name, e, file=sys.stderr)
        self.pool = prev
        if self.first_t:
            print('[replay] история с', time.strftime('%Y-%m-%d %H:%M', time.gmtime(self.first_t)), 'UTC,', len(self.pool), 'активов')

    def _write(self, t, rec):
        day = time.strftime('%Y%m%d', time.gmtime(t))
        if day != self._day:
            if self._day_file:
                self._day_file.close()
            self._day = day
            self._day_file = open(os.path.join(DATA_DIR, 'inventory-' + day + '.jsonl'), 'a', encoding='utf-8')
            rec = {'t': t, 'full': self.pool}       # первая строка дня — полный снимок
        self._day_file.write(json.dumps(rec, separators=(',', ':')) + '\n')
        self._day_file.flush()
        try:
            os.fsync(self._day_file.fileno())
        except OSError:
            pass

    # -------------------------------------------------- ingest
    def _ingest(self, t, prev, snap, persist=True):
        if self.first_t is None:
            self.first_t = t
        b = int(t // BUCKET)
        changed = {}
        for asset, val in snap.items():
            old = prev.get(asset)
            if old is None:
                self.pool_hist.setdefault(asset, []).append((t, val))
                changed[asset] = val
                continue
            d = val - old
            if d == 0:
                continue
            changed[asset] = val
            self.pool_hist.setdefault(asset, []).append((t, val))
            fl = self.flows.setdefault(asset, {}).setdefault(b, [0.0, 0.0])
            if d < 0:
                fl[0] += -d       # пул уменьшился — займ
            else:
                fl[1] += d        # пул вырос — погашение
        if persist:
            self.pool = snap
            self._write(t, {'t': t, 'd': changed})

    def _prune(self):
        cutoff_b = int((time.time() - KEEP_DAYS * 86400) // BUCKET)
        for asset, fl in self.flows.items():
            for k in [k for k in fl if k < cutoff_b]:
                del fl[k]
        cutoff_t = time.time() - KEEP_DAYS * 86400
        for asset, h in self.pool_hist.items():
            i = 0
            while i < len(h) - 1 and h[i][0] < cutoff_t:
                i += 1
            if i:
                del h[:i]

    # -------------------------------------------------- loops
    def poll_once(self):
        res = signed_get(self.key, self.secret, '/sapi/v1/margin/available-inventory', {'type': 'MARGIN'})
        assets = res.get('assets') or {}
        snap = {k: float(v) for k, v in assets.items()}
        t = int(time.time())
        with self.lock:
            prev = self.pool
            if not prev:
                self.pool = snap
                if self.first_t is None:
                    self.first_t = t
                for a, v in snap.items():
                    self.pool_hist.setdefault(a, []).append((t, v))
                self._write(t, {'t': t, 'full': snap})
            else:
                self._ingest(t, prev, snap)
            self.last_poll = t
            self.polls += 1
            self.last_error = None
            if self.polls % 60 == 0:
                self._prune()

    def refresh_prices(self):
        rows = http_json('https://api.binance.com/api/v3/ticker/price')
        px = {r['symbol']: float(r['price']) for r in rows}
        btc = px.get('BTCUSDT', 0)
        out = {'USDT': 1.0}
        with self.lock:
            assets = set(self.pool.keys()) | set(self.flows.keys())
        for a in assets:
            if a == 'USDT':
                continue
            if a + 'USDT' in px:
                out[a] = px[a + 'USDT']
            elif a + 'USDC' in px:
                out[a] = px[a + 'USDC']
            elif a + 'FDUSD' in px:
                out[a] = px[a + 'FDUSD']
            elif a + 'BTC' in px and btc:
                out[a] = px[a + 'BTC'] * btc
            elif 'USDT' + a in px and px['USDT' + a] > 0:
                out[a] = 1.0 / px['USDT' + a]
        with self.lock:
            self.prices = out

    def run(self):
        last_price = 0
        while True:
            if self.configured:
                try:
                    if time.time() - last_price > PRICE_SEC or not self.prices:
                        self.refresh_prices()
                        last_price = time.time()
                    self.poll_once()
                    if len(self.prices) < 2:
                        self.refresh_prices()
                except urllib.error.HTTPError as e:
                    body = e.read().decode('utf-8', 'replace')[:300]
                    self.last_error = 'HTTP %s: %s' % (e.code, body)
                    print('[poll]', self.last_error, file=sys.stderr)
                except Exception as e:  # сеть, таймаут, неверный ответ
                    self.last_error = str(e)
                    print('[poll]', e, file=sys.stderr)
            time.sleep(POLL_SEC)

    # -------------------------------------------------- queries
    def status(self):
        with self.lock:
            return {
                'configured': self.configured,
                'lastPoll': self.last_poll,
                'lastError': self.last_error,
                'firstData': self.first_t,
                'assets': len(self.pool),
                'polls': self.polls,
                'bucketSec': BUCKET,
                'pollSec': POLL_SEC,
                'startedAt': int(self.started),
                'now': int(time.time())
            }

    def _bucket_array(self, asset, b0, b1):
        """Займы/погашения по корзинам b0..b1 включительно."""
        fl = self.flows.get(asset, {})
        n = b1 - b0 + 1
        bor = [0.0] * n
        rep = [0.0] * n
        for k, (vb, vr) in fl.items():
            if b0 <= k <= b1:
                bor[k - b0] = vb
                rep[k - b0] = vr
        return bor, rep

    def table(self, win_h=24, base_d=7):
        now = time.time()
        per_h = 3600 // BUCKET
        win = win_h * per_h
        end = int(now // BUCKET)
        span = base_d * 24 * per_h + win + per_h
        b0 = end - span
        rows = []
        with self.lock:
            first_b = int(self.first_t // BUCKET) if self.first_t else end
            hours_cov = max(0.0, (end - first_b) / per_h)
            assets = sorted(set(self.pool.keys()) | set(self.flows.keys()))
            for a in assets:
                bor, rep = self._bucket_array(a, b0, end)
                pb = [0.0]
                pr = [0.0]
                for i in range(len(bor)):
                    pb.append(pb[-1] + bor[i])
                    pr.append(pr[-1] + rep[i])
                last = len(bor)          # индекс конца (исключительно) в префиксах

                def window_sum(pref, e):
                    s = max(0, e - win)
                    return pref[e] - pref[s]

                B = window_sum(pb, last)
                R = window_sum(pr, last)
                # распределение 24-часовых сумм с шагом 1 ч на базе
                sb, sr, db, dr = [], [], [], []
                for k in range(1, base_d * 24 + 1):
                    e = last - k * per_h
                    if e - win < 0 or e - per_h < 0:
                        break
                    if (b0 + e) < first_b + win:
                        break                    # нет полной истории окна
                    xb = window_sum(pb, e)
                    xr = window_sum(pr, e)
                    sb.append(xb)
                    sr.append(xr)
                    db.append(xb - window_sum(pb, e - per_h))
                    dr.append(xr - window_sum(pr, e - per_h))
                Bh = window_sum(pb, last - per_h)
                Rh = window_sum(pr, last - per_h)
                full_win = hours_cov >= win_h
                rows.append({
                    'asset': a,
                    'price': self.prices.get(a),
                    'borrow': B,
                    'repay': R,
                    'pool': self.pool.get(a),
                    'bz': zscore(B, sb) if full_win else None,
                    'rz': zscore(R, sr) if full_win else None,
                    'bd': ((B / Bh - 1) * 100) if Bh > 0 else None,
                    'rd': ((R / Rh - 1) * 100) if Rh > 0 else None,
                    'bdz': zscore(B - Bh, db) if full_win else None,
                    'rdz': zscore(R - Rh, dr) if full_win else None,
                    'samples': len(sb)
                })
        return {'win': win_h, 'base': base_d, 'coverageHours': hours_cov, 'now': int(now), 'rows': rows}

    def series(self, asset, days=7):
        now = time.time()
        end = int(now // BUCKET)
        b0 = end - int(days * 86400 // BUCKET)
        with self.lock:
            bor, rep = self._bucket_array(asset, b0, end)
            hist = list(self.pool_hist.get(asset, []))
            price = self.prices.get(asset)
        t = [(b0 + i) * BUCKET for i in range(len(bor))]
        pool = []
        j = 0
        cur = None
        for i, tt in enumerate(t):
            while j < len(hist) and hist[j][0] < tt + BUCKET:
                cur = hist[j][1]
                j += 1
            pool.append(cur)
        return {'asset': asset, 'bucketSec': BUCKET, 't': t, 'borrow': bor, 'repay': rep, 'pool': pool, 'price': price}

    def events(self, days=7, min24=10000.0, win_min=15, growth=100.0):
        now = time.time()
        per_h = 3600 // BUCKET
        win24 = 24 * per_h
        step = max(1, int(win_min * 60 // BUCKET))
        end = int(now // BUCKET)
        b0 = end - int(days * 86400 // BUCKET) - win24 - step
        out = []
        with self.lock:
            first_b = int(self.first_t // BUCKET) if self.first_t else end
            assets = list(set(self.flows.keys()) | set(self.pool_hist.keys()))
            for a in assets:
                px = self.prices.get(a)
                bor, _ = self._bucket_array(a, b0, end)
                pref = [0.0]
                for v in bor:
                    pref.append(pref[-1] + v)
                last_evt = -10 ** 9
                for e in range(win24 + step, len(bor) + 1, step):
                    if b0 + e - step - win24 < first_b:
                        continue           # окно 24 ч ещё не заполнено историей
                    s24 = pref[e] - pref[max(0, e - win24)]
                    prev24 = pref[e - step] - pref[max(0, e - step - win24)]
                    usd = s24 * px if px else None
                    if usd is None or usd < min24 or prev24 <= 0:
                        continue
                    g = (s24 / prev24 - 1) * 100
                    if g < growth:
                        continue
                    t = (b0 + e) * BUCKET
                    if t - last_evt < 3600:
                        continue
                    last_evt = t
                    out.append({'t': t, 'asset': a, 'type': 'spike', 'borrow24': usd, 'growth': g, 'pool': self._pool_at(a, t)})
                # пул опустел: переход > 0 → 0
                h = self.pool_hist.get(a, [])
                for i in range(1, len(h)):
                    if h[i][1] <= 0 < h[i - 1][1] and h[i][0] >= now - days * 86400:
                        t = h[i][0]
                        bi = int(t // BUCKET) - b0
                        s24 = pref[min(len(pref) - 1, max(0, bi + 1))] - pref[max(0, bi + 1 - win24)] if 0 <= bi < len(bor) else None
                        out.append({'t': t, 'asset': a, 'type': 'empty', 'borrow24': (s24 * px) if (s24 is not None and px) else None, 'growth': None, 'pool': 0.0})
        out.sort(key=lambda x: -x['t'])
        return {'events': out[:500], 'min24': min24, 'winMin': win_min, 'growth': growth, 'days': days}

    def _pool_at(self, asset, t):
        h = self.pool_hist.get(asset, [])
        val = None
        for tt, v in h:
            if tt > t:
                break
            val = v
        return val


# ---------------------------------------------------------------- web
COLLECTOR = None


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if '/api/' in (self.path or ''):
            return
        sys.stderr.write('[http] ' + (fmt % args) + '\n')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, separators=(',', ':'), allow_nan=False, default=lambda x: None).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith('/api/'):
            q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
            try:
                if u.path == '/api/margin/status':
                    return self._json(COLLECTOR.status())
                if u.path == '/api/margin/table':
                    return self._json(clean(COLLECTOR.table(int(q.get('win', 24)), int(q.get('base', 7)))))
                if u.path == '/api/margin/series':
                    return self._json(clean(COLLECTOR.series(q.get('asset', 'BTC').upper(), float(q.get('days', 7)))))
                if u.path == '/api/margin/events':
                    return self._json(clean(COLLECTOR.events(float(q.get('days', 7)), float(q.get('min24', 10000)), int(q.get('win', 15)), float(q.get('growth', 100)))))
            except (ValueError, KeyError) as e:
                return self._json({'error': str(e)}, 400)
            return self._json({'error': 'not found'}, 404)
        # корень и любые пути без расширения — index.html
        if u.path in ('', '/') or ('.' not in os.path.basename(u.path) and not u.path.startswith('/ref')):
            self.path = '/index.html'
        # секреты и сырые данные не раздаём
        if os.path.basename(u.path) == 'config.local.json' or u.path.startswith('/data/') or u.path.startswith('/.git'):
            return self._json({'error': 'forbidden'}, 403)
        return super().do_GET()


def clean(o):
    """NaN/inf → None, чтобы JSON был валидным."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [clean(v) for v in o]
    return o


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    global COLLECTOR
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description='CryptoTerminal local server')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()
    key, secret = load_config()
    COLLECTOR = Collector(key, secret)
    if COLLECTOR.configured:
        print('[margin] ключ найден — опрос пула Binance каждые', POLL_SEC, 'с')
    else:
        print('[margin] ключ не задан — страница «Маржа» работает на публичных ставках Binance')
    threading.Thread(target=COLLECTOR.run, daemon=True).start()
    srv = Server((args.host, args.port), Handler)
    print('CryptoTerminal: http://%s:%d' % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
