// Precomputes every item set (except the huge Test_Set) x every logic x slice counts for the "Every set" table in index.html.
//   node viz/precompute.mjs            (writes viz/stats.json; default timings, batch 54)
// Each set runs in its own worker thread, so sets are simulated in parallel (one per CPU core).
import fs from 'fs'; import vm from 'vm'; import os from 'os';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
const here = new URL('.', import.meta.url).pathname;
vm.runInThisContext(fs.readFileSync(here + 'sim.js', 'utf8'));
const P = { batch: 54, ...Object.fromEntries(TIMINGS.map(([k, , d]) => [k, d])) };
const CONFIGS = [['multi', false], ['multi', true], ['local', false], ['local', true], ['classic', false], ['cartU', false], ['cart', false], ['hyper', false], ['grouped', false], ['cgg', false], ['cartG', false], ['cartGU', false], ['cartH', false], ['cartHU', false], ['cartGG', false], ['cartGGo', false], ['cartMG', false], ['cartMG', true], ['cartML', false], ['cartML', true]];
// cart logics run once per cart detection level; their results are stored as 'mode@13', 'mode@14', 'mode@15'
const RUNS = CONFIGS.flatMap(([m, w]) => m.startsWith('cart') ? [13, 14, 15].map(ss => [m, w, ss]) : [[m, w, 0]]);
const SLICES = [1, 2, 3, 4, 5, 6, 7, 8], SEEDS = [1, 2, 3];
const MAX_TICKS = 2e7;                    // a run this long is a stuck logic, not a slow one: report it instead of hanging
const dir = here + '../data/sets/';

if (!isMainThread) {                      // worker: every slice count x logic x seed for one set
  const { file, name } = workerData, src = await loadLitematic(fs.readFileSync(dir + file)), results = {};
  for (const N of SLICES) {
    results[N] = {};
    for (const [mode, wait, ss] of RUNS) {
      const r = { speed: 0, gt: 0, out: 0, full: 0, partial: 0, ideal: 0 };
      for (const seed of SEEDS) {
        const S = newSim(src, N, mode, { ...P, waitSlice: wait, ...(ss ? { ss } : {}) }, seed);
        let t = 0;
        while (!S.done && t++ < MAX_TICKS) step(S);
        if (!S.done) parentPort.postMessage({ log: `WARNING ${name}: ${mode}${wait ? '+wait' : ''}${ss ? ' SS' + ss : ''} ${N} slices seed ${seed} never finished (stopped at ${MAX_TICKS} gt)` });
        r.speed += S.sorted / (S.tick / 72000); r.gt += S.tick; r.out += S.outFull + S.outPartial;
        r.full += S.outFull; r.partial += S.outPartial; r.ideal += S.perBatch;
      }
      for (const k in r) r[k] = Math.round(r[k] / SEEDS.length * 10) / 10;
      results[N][mode + (wait ? '+wait' : '') + (ss ? '@' + ss : '')] = r;
    }
    parentPort.postMessage({ log: `${name} ${N} slices done` });
  }
  parentPort.postMessage({ results });
} else {
  const out = { generated: new Date().toISOString(), batch: P.batch, timings: P, seeds: SEEDS.length, slices: SLICES, sets: [] };
  const seen = new Map(), jobs = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.litematic') && !x.startsWith('Test_Set')).sort()) {
    const src = await loadLitematic(fs.readFileSync(dir + f)), name = f.replace(/\.litematic$/, '');
    const key = JSON.stringify(src), same = seen.get(key);
    if (!same) seen.set(key, name);
    const items = src.reduce((a, b) => a + b.reduce((x, s) => x + (s ? s[1] : 0), 0), 0);
    const set = { name, boxes: src.length, items, sameAs: same || null, results: {} };
    out.sets.push(set);
    if (same) console.log(name, '= copy of', same);
    else jobs.push({ file: f, name, set });
  }
  const run = job => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { file: job.file, name: job.name } });
    w.on('message', m => { if (m.log) console.log(m.log); if (m.results) { job.set.results = m.results; resolve(); } });
    w.on('error', reject);
  });
  const queue = [...jobs], lanes = Math.max(1, Math.min(os.cpus().length, queue.length));
  await Promise.all(Array.from({ length: lanes }, async () => { while (queue.length) await run(queue.shift()); }));
  for (const set of out.sets) if (set.sameAs) set.results = out.sets.find(s => s.name === set.sameAs).results;
  fs.writeFileSync(here + 'stats.json', JSON.stringify(out));
  console.log('wrote viz/stats.json');
}
