#!/usr/bin/env python3
"""
Local web interface for model/cycvar_sim.py (same engine, no copy of the mechanics).

    .venv/bin/python web/server.py            # then open http://127.0.0.1:8765
    .venv/bin/python web/server.py --port 9000 --host 0.0.0.0   # reachable from other devices on your network

Item sets are every .litematic in data/sets/. Files uploaded in the page are saved there too.
"""
import argparse, json, random, re, statistics, sys, time
from concurrent.futures import ProcessPoolExecutor, as_completed
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'model'))
import cycvar_sim as sim  # noqa: E402

SETS = ROOT / 'data' / 'sets'
PAGE = Path(__file__).with_name('index.html')
MAX_UPLOAD = 64 << 20
POOL = None


def set_names():
    return sorted(p.stem for p in SETS.glob('*.litematic'))


@lru_cache(maxsize=8)
def _load(name, mtime):
    return sim.load_litematic(str(SETS / f'{name}.litematic'))


def boxes_of(name):
    if name not in set_names():
        raise KeyError(f'unknown item set {name!r}')
    return _load(name, (SETS / f'{name}.litematic').stat().st_mtime)


def _job(name, n, seeds, t, batch, cartun):
    """Runs in a worker process; each worker loads a set once and keeps it cached."""
    boxes = boxes_of(name)
    out = []
    for seed in seeds:
        r = sim.run(boxes, n, random.Random(seed), t=t, batch=batch, cart_takes_unstackables=cartun)
        out.append((r['speed'], r['gt'], r['cycles'], r['box_passes'], r['outputs']))
    return n, out


def summary(name, batch):
    boxes = boxes_of(name)
    tot = {}
    for b in boxes:
        for it, c in b:
            tot[it] = tot.get(it, 0) + c
    rng, reps = random.Random(12345), 20 if len(boxes) > batch else 1
    per_batch = 0
    for _ in range(reps):
        o = boxes[:]
        rng.shuffle(o)
        per_batch += sum(sim.ideal_outputs(o[k:k + batch]) for k in range(0, len(o), batch))
    return dict(name=name, boxes=len(boxes), items=sum(tot.values()), types=len(tot),
                unstackable_items=sum(c for it, c in tot.items() if sim.stack_size(it) == 1),
                ideal=sim.ideal_outputs(boxes), ideal_per_batch=per_batch / reps)


def stats(n, rows, n_boxes):
    sp = sorted(r[0] for r in rows)
    q = lambda f: sp[round(f * (len(sp) - 1))]
    m = statistics.mean(sp)
    return dict(n=n, mean=m, lo=q(.05), hi=q(.95), sd=(statistics.stdev(sp) / m if len(sp) > 1 and m else 0),
                gt=statistics.mean(r[1] for r in rows), cycles=statistics.mean(r[2] for r in rows),
                passes=statistics.mean(r[3] for r in rows) / n_boxes, outputs=statistics.mean(r[4] for r in rows))


def num(d, key, default, lo, hi, cast=float):
    try:
        v = cast(d.get(key, default))
    except (TypeError, ValueError):
        raise ValueError(f'{key} must be a number')
    if not lo <= v <= hi:
        raise ValueError(f'{key} must be between {lo} and {hi}')
    return v


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            return self.send(200, PAGE.read_bytes(), 'text/html; charset=utf-8')
        if self.path == '/api/sets':
            return self.send(200, set_names())
        self.send(404, {'error': 'not found'})

    def do_POST(self):
        try:
            if self.path == '/api/summary':
                d = self.body_json()
                return self.send(200, summary(str(d.get('set')), num(d, 'batch', 54, 1, 10**6, int)))
            if self.path == '/api/upload':
                return self.upload()
            if self.path == '/api/simulate':
                return self.simulate()
            self.send(404, {'error': 'not found'})
        except (KeyError, ValueError) as e:
            self.send(400, {'error': str(e.args[0]) if e.args else str(e)})

    def upload(self):
        size = int(self.headers.get('Content-Length') or 0)
        if not 0 < size <= MAX_UPLOAD:
            raise ValueError(f'file must be between 1 byte and {MAX_UPLOAD >> 20} MB')
        stem = re.sub(r'[^A-Za-z0-9._ -]', '_', Path(self.headers.get('X-Filename', 'upload')).stem).strip(' .')[:80] or 'upload'
        name, i = stem, 2
        while (SETS / f'{name}.litematic').exists():
            name, i = f'{stem}-{i}', i + 1
        path = SETS / f'{name}.litematic'
        path.write_bytes(self.rfile.read(size))
        try:
            boxes = sim.load_litematic(str(path))
            if not boxes:
                raise ValueError('no shulker boxes found in it')
        except Exception as e:
            path.unlink(missing_ok=True)
            raise ValueError(f"couldn't read it as a .litematic with shulker boxes ({e})")
        self.send(200, {'name': name})

    def simulate(self):
        d = self.body_json()
        name = str(d.get('set'))
        n_boxes = len(boxes_of(name))
        smin = num(d, 'smin', 2, 1, 64, int)
        smax = num(d, 'smax', 8, smin, 64, int)
        trials = num(d, 'trials', 100, 1, 5000, int)
        batch = num(d, 'batch', 54, 1, 10**6, int)
        seed = num(d, 'seed', 0, -2**31, 2**31, int)
        t = {k: num(d, k, sim.T[k], 0, 10**5) for k in sim.T}
        cartun = bool(d.get('cartun', True))
        chunk = max(1, -(-trials // (POOL._max_workers * 2)))
        futs = [POOL.submit(_job, name, n, [seed * 1_000_003 + n * 10_007 + i + k for k in range(min(chunk, trials - i))],
                            t, batch, cartun)
                for n in range(smin, smax + 1) for i in range(0, trials, chunk)]
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()
        rows, done, sim_gt, t0 = {}, 0, 0.0, time.perf_counter()
        try:
            for f in as_completed(futs):
                n, out = f.result()
                rows.setdefault(n, []).extend(out)
                sim_gt += sum(o[1] for o in out)
                done += 1
                msg = {'progress': done / len(futs)}
                if len(rows[n]) == trials:
                    msg['result'] = stats(n, rows[n], n_boxes)
                self.wfile.write(json.dumps(msg).encode() + b'\n')
                self.wfile.flush()
            secs = time.perf_counter() - t0
            self.wfile.write(json.dumps({'done': True, 'seconds': secs, 'tps': sim_gt / secs,
                                         'runs': trials * (smax - smin + 1)}).encode() + b'\n')
        except (BrokenPipeError, ConnectionResetError):        # page closed or new run started
            for f in futs:
                f.cancel()


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8765)
    a = ap.parse_args()
    SETS.mkdir(parents=True, exist_ok=True)
    POOL = ProcessPoolExecutor()
    print(f'Cycvar simulator on http://{a.host}:{a.port}  (item sets: {SETS})')
    try:
        ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        POOL.shutdown(cancel_futures=True)
