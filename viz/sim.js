// Multithreaded cycvar simulation, used by index.html. One step() = one game tick.
// ---------------------------------------------------------------- items
const UNSTACK_SUFFIX = ['_sword', '_pickaxe', '_axe', '_shovel', '_hoe', '_helmet', '_chestplate', '_leggings',
  '_boots', '_bed', '_boat', '_raft', 'minecart', '_bucket', 'shulker_box', '_horse_armor', '_stew', '_soup',
  '_banner_pattern', '_on_a_stick'];
const UNSTACK = new Set(['potion', 'splash_potion', 'lingering_potion', 'enchanted_book', 'written_book',
  'writable_book', 'totem_of_undying', 'saddle', 'elytra', 'shield', 'bow', 'crossbow', 'trident', 'fishing_rod',
  'flint_and_steel', 'shears', 'cake', 'spyglass', 'brush', 'mace', 'bundle', 'goat_horn', 'debug_stick',
  'knowledge_book', 'wolf_armor', 'compass_lodestone']);
const STACK16 = new Set(['ender_pearl', 'snowball', 'egg', 'blue_egg', 'brown_egg', 'bucket', 'honey_bottle', 'armor_stand']);
const ssCache = new Map();
function stackSize(id) {
  let v = ssCache.get(id);
  if (v !== undefined) return v;
  const n = short(id);
  if (UNSTACK.has(n) || UNSTACK_SUFFIX.some(s => n.endsWith(s)) || n.startsWith('music_disc_')) v = n !== 'bucket' ? 1 : 16;
  else if (STACK16.has(n) || n.endsWith('_sign') || n.endsWith('_banner')) v = 16;
  else v = 64;
  ssCache.set(id, v);
  return v;
}
const short = id => id.startsWith('minecraft:') ? id.slice(10) : id;
const niceName = id => short(id).split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

// ---------------------------------------------------------------- .litematic reading (gzip NBT)
function readNBT(dv) {
  let o = 0;
  const td = new TextDecoder();
  const str = () => { const n = dv.getUint16(o); o += 2; const s = td.decode(new Uint8Array(dv.buffer, dv.byteOffset + o, n)); o += n; return s; };
  function pay(t) {
    switch (t) {
      case 1: return dv.getInt8(o++);
      case 2: { const v = dv.getInt16(o); o += 2; return v; }
      case 3: { const v = dv.getInt32(o); o += 4; return v; }
      case 4: o += 8; return 0;
      case 5: o += 4; return 0;
      case 6: o += 8; return 0;
      case 7: { const n = dv.getInt32(o); o += 4 + n; return null; }
      case 8: return str();
      case 9: { const et = dv.getUint8(o++), n = dv.getInt32(o); o += 4; const a = []; for (let i = 0; i < n; i++) a.push(pay(et)); return a; }
      case 10: { const c = {}; for (;;) { const tt = dv.getUint8(o++); if (!tt) return c; const k = str(); c[k] = pay(tt); } }
      case 11: { const n = dv.getInt32(o); o += 4 + 4 * n; return null; }
      case 12: { const n = dv.getInt32(o); o += 4; const a = []; for (let i = 0; i < n; i++, o += 8) a.push(dv.getBigUint64(o)); return a; }
      default: throw new Error('unknown NBT tag ' + t);
    }
  }
  const t = dv.getUint8(o++); str();
  return pay(t);
}
async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new DataView(await new Response(stream).arrayBuffer());
}
function slotsOf(list, slotKey, get) {          // -> 27 slots, null = empty
  const s = new Array(27).fill(null);
  for (const e of list || []) { const k = e[slotKey] ?? e.Slot ?? e.slot; const it = get(e); if (k >= 0 && k < 27 && it) s[k] = [String(it.id), it.count ?? it.Count ?? 1]; }
  return s;
}
// block state at a region position (x, y, z relative to the region's min corner)
function stateReader(reg) {
  const pal = reg.BlockStatePalette || [], L = reg.BlockStates || [], sx = Math.abs(reg.Size?.x ?? 0), sz = Math.abs(reg.Size?.z ?? 0);
  const bits = BigInt(Math.max(2, 32 - Math.clz32(Math.max(1, pal.length - 1)))), mask = (1n << bits) - 1n;
  return (x, y, z) => {
    const start = BigInt((y * sz + z) * sx + x) * bits, i = Number(start >> 6n), off = start & 63n;
    if (i >= L.length) return null;
    let v = L[i] >> off;
    if (off + bits > 64n && i + 1 < L.length) v |= L[i + 1] << (64n - off);
    return pal[Number(v & mask)] || null;
  };
}
// containers in the order the game reads them: by position, and a double chest's right half (its top rows) before its left half
function containerOrder(reg) {
  const tes = [...(reg.TileEntities || [])].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const state = stateReader(reg), at = new Map(tes.map(d => [`${d.x},${d.y},${d.z}`, d]));
  const half = d => { const s = state(d.x, d.y, d.z); return s && String(s.Name).endsWith('chest') && s.Properties ? s.Properties : null; };
  const partner = d => {
    const h = half(d);
    if (!h || h.type === 'single') return null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = at.get(`${d.x + dx},${d.y},${d.z + dz}`), nh = n && half(n);
      if (nh && nh.facing === h.facing && nh.type !== h.type && nh.type !== 'single') return n;
    }
    return null;
  };
  const out = [], used = new Set();
  for (const d of tes) {
    if (used.has(d)) continue;
    const p = partner(d), pair = !p || used.has(p) ? [d] : half(d).type === 'right' ? [d, p] : [p, d];
    for (const e of pair) { used.add(e); out.push(e); }
  }
  return [...out, ...(reg.Entities || [])];
}
async function loadLitematic(buf) {
  const root = readNBT(await gunzip(buf));
  if (!root || !root.Regions) throw new Error('no Regions found');
  const boxes = [];
  for (const reg of Object.values(root.Regions)) {
    for (const d of containerOrder(reg)) {
      if (String(d.id ?? '').includes('shulker_box') && d.Items) { boxes.push(slotsOf(d.Items, 'Slot', e => e)); continue; }
      for (const it of [...(d.Items || [])].sort((a, b) => (a.Slot ?? 0) - (b.Slot ?? 0))) {
        if (!String(it.id).endsWith('shulker_box')) continue;
        const comp = it.components?.['minecraft:container'];
        const s = comp ? slotsOf(comp, 'slot', e => e.item) : slotsOf(it.tag?.BlockEntityTag?.Items, 'Slot', e => e);
        if (s.some(Boolean)) boxes.push(s);
      }
    }
  }
  return boxes;
}

// ---------------------------------------------------------------- simulation (one game tick per step)
// [key, label, default gt, group]; cart slices have their own pass and reset times (newSim swaps them in)
const TIMINGS = [
  ['input', 'Input chest, per box', 8, 'front'], ['link', 'Front-end travel', 20, 'front'],
  ['luif', 'LUIF per box', 16, 'front'], ['unst', 'LUIF per unstackable', 8, 'front'],
  ['grouper', 'Grouper per box', 8, 'group'], ['hop', 'Grouper → next grouper/core', 16, 'group'],
  ['toSlice', 'Global grouper to slice', 40, 'group'], ['back', 'Leftovers back to LUIF', 40, 'group'],
  ['swap', 'Box swap', 8, 'hopper'], ['pull', 'Hopper per item', 8, 'hopper'], ['pass', 'Slice to next slice', 8, 'hopper'], ['reset', 'Slice reset', 32, 'hopper'],
  ['cartGap', 'Gap between carts', 8, 'cart'], ['dwell', 'Min time under box', 22, 'cart'], ['ss', 'Cart detection (SS)', 15, 'cart'],
  ['cartPass', 'Slice to next slice', 8, 'cart'], ['cartReset', 'Slice reset', 32, 'cart'],
];
const CART_KEYS = ['ss', 'cartGap'];                   // shown in the toolbar for the cart logic
function rng32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } }
const firstItem = b => { for (const s of b.slots) if (s) return s[0]; return null; };
const hasItem = (b, f) => b.slots.some(s => s && s[0] === f);
const isEmpty = b => !b.slots.some(Boolean);

function idealOutputs(boxes) {
  const tot = new Map();
  for (const b of boxes) for (const s of b.slots) if (s) tot.set(s[0], (tot.get(s[0]) || 0) + s[1]);
  let n = 0;
  for (const [it, c] of tot) { const ss = stackSize(it); if (ss > 1) n += Math.ceil(c / (ss * 27)); }
  return n;
}

function newSim(src, N, mode, p, seed) {
  if (mode.startsWith('cart')) p = { ...p, pass: p.cartPass ?? p.pass, reset: p.cartReset ?? p.reset };   // cart slices' own times
  const boxes = src.map((slots, i) => ({ id: i, slots: slots.map(s => s && [s[0], s[1]]) }));
  if (seed) shuffle(boxes, rng32(seed));          // seed 0 = boxes in schematic order
  let total = 0;
  for (const b of boxes) for (const s of b.slots) if (s) total += s[1];
  let perBatch = 0;
  for (let i = 0; i < boxes.length; i += p.batch) perBatch += idealOutputs(boxes.slice(i, i + p.batch));
  // per item: total count, ideal boxes for the whole set and with batches
  const items = new Map();
  for (let i = 0; i < boxes.length; i += p.batch) {
    const batch = new Map();
    for (const b of boxes.slice(i, i + p.batch)) for (const s of b.slots) if (s) batch.set(s[0], (batch.get(s[0]) || 0) + s[1]);
    for (const [it, c] of batch) {
      const e = items.get(it) || { items: 0, idealBatch: 0, full: 0, partial: 0, out: 0 };
      e.items += c; e.idealBatch += Math.ceil(c / (stackSize(it) * 27));
      items.set(it, e);
    }
  }
  for (const [it, e] of items) e.ideal = Math.ceil(e.items / (stackSize(it) * 27));
  return {
    tick: 0, N, mode, p, total, nBoxes: boxes.length, ideal: idealOutputs(boxes), perBatch, items,
    input: boxes, batchNo: 0, dispensing: 0, dispenseT: 0, inSystem: 0,
    travel: [], luifQ: [], luif: null, buffer: [], pending: [],
    grp: { state: 'idle', filter: null, group: [], snap: [], idx: 0, t: 0, checking: null },
    slices: Array.from({ length: N }, (_, i) => ({ i, state: 'idle', filter: null, queue: [], cur: null, t: 0, held: false, out: 0, busy: 0, flash: -1, full: 0, partial: 0, recent: [] })),
    outFull: 0, outPartial: 0, empties: 0, unstack: 0, sorted: 0, grpBusy: 0, done: false, lastOut: [], outBoxes: [], outSeq: 0, feeding: [], feedFrom: 'in', cycleOn: false, cycles: 0, phase: 'idle',
    gq: Array.from({ length: N }, () => []), gcur: new Array(N).fill(null),
  };
}

// mode families: cart variants reuse the hopper logic's flow with cart cores
const isHyper = S => S.mode === 'hyper' || S.mode === 'cartH' || S.mode === 'cartHU';
const isLocal = S => S.mode === 'local' || S.mode === 'cartML';
const ownLuif = S => S.mode === 'cart' || S.mode === 'cartH';          // a LUIF in front of every cart slice
const selfName = S => S.mode === 'cartU' || S.mode === 'cartHU';        // the first cart takes the box's first item
function travel(S, what, path, T, arrive) { S.travel.push({ what, path, t: 0, T: Math.max(1, T), arrive }); }

function step(S) {
  if (S.done) return;
  if (S.mode === 'classic' || S.mode === 'cart' || S.mode === 'cartU') return stepClassic(S);
  if (isHyper(S)) return stepHyper(S);
  if (S.mode === 'grouped' || S.mode === 'cartG' || S.mode === 'cartGU') return stepGrouped(S);
  if (S.mode === 'cgg' || S.mode === 'cartGG' || S.mode === 'cartGGo') return stepCGG(S);
  if (isLocal(S)) return stepLocal(S);
  const p = S.p;
  S.tick++;
  // boxes on the move (first, so every trip takes exactly its travel time)
  for (let i = S.travel.length - 1; i >= 0; i--) {
    const m = S.travel[i];
    if (++m.t >= m.T) { S.travel.splice(i, 1); m.arrive(); }
  }
  // input chest: next batch only when the previous batch has fully left the machine
  if (!S.dispensing && S.inSystem === 0 && S.input.length) { S.batchNo++; S.dispensing = Math.min(p.batch, S.input.length); S.dispenseT = 0; S.batchIn = false; }
  if (S.dispensing && --S.dispenseT <= 0) {
    const b = S.input.shift();
    S.dispensing--; S.inSystem++; S.dispenseT = p.input;
    travel(S, b, 'in', p.link, () => S.luifQ.push(b));
  }
  // LUIF: strips leading unstackables, drops empty boxes
  if (!S.luif && S.luifQ.length) S.luif = { box: S.luifQ.shift(), t: p.luif };
  else if (S.luif && --S.luif.t <= 0) {
    const b = S.luif.box, k = b.slots.findIndex(Boolean);
    if (k >= 0 && stackSize(b.slots[k][0]) === 1) {
      S.unstack += b.slots[k][1]; S.sorted += b.slots[k][1]; b.slots[k] = null; S.luif.t = p.unst;
    } else {
      S.luif = S.luifQ.length ? { box: S.luifQ.shift(), t: p.luif } : null;
      if (k < 0) { S.empties++; S.inSystem--; }
      else travel(S, b, 'buf', p.link, () => S.buffer.push(b));
    }
  }
  grouperStep(S);
  // send waiting groups to free slices, lowest slice first
  for (const sl of S.slices) {
    if (sl.state !== 'idle' || !S.pending.length) continue;
    const g = S.pending.shift();
    sl.state = 'incoming'; sl.filter = g.filter;
    travel(S, g, 'to' + sl.i, p.toSlice, () => { sl.queue = g.boxes; nextBox(S, sl); });
  }
  for (const sl of S.slices) (S.mode === 'cartMG' ? cartQSlice : sliceStep)(S, sl);
  if (!S.input.length && !S.dispensing && S.inSystem === 0 && S.slices.every(s => s.state === 'idle')) S.done = true;
}

function grouperStep(S) {
  const g = S.grp, p = S.p;
  if (g.state === 'idle') {
    if (!S.buffer.length) return;
    // first grouping of a batch waits until the whole batch has passed the LUIF into the buffer
    if (!S.batchIn) S.batchIn = !S.dispensing && !S.luif && !S.luifQ.length && !S.travel.some(m => m.path === 'in' || m.path === 'buf');
    if (!S.batchIn) return;
    if (S.pending.length) return;                // keep only one group ready; group again once it has gone to a slice
    // option: only group when a slice is free and every leftover box from finished slices is back in the buffer
    if (p.waitSlice && (!S.slices.some(sl => sl.state === 'idle') || S.luif || S.luifQ.length || S.travel.some(m => m.path === 'buf' || m.path.startsWith('back')))) return;
    const lead = S.buffer.shift();
    Object.assign(g, { state: 'lead', filter: firstItem(lead), group: [lead], t: p.grouper, checking: lead });
    S.grpBusy++;
    return;
  }
  S.grpBusy++;
  if (--g.t > 0) return;
  g.t = p.grouper;
  if (g.state === 'lead') {
    g.snap = S.buffer.slice(); g.idx = 0; g.state = 'scan';
  } else if (g.state === 'scan') {
    const b = g.snap[g.idx++];
    if (hasItem(b, g.filter)) { S.buffer.splice(S.buffer.indexOf(b), 1); g.group.push(b); }
  }
  if (g.state !== 'lead' && g.idx >= g.snap.length) {
    S.pending.push({ filter: g.filter, boxes: g.group });
    Object.assign(g, { state: 'idle', group: [], snap: [], checking: null, filter: null });
  } else g.checking = g.state === 'lead' ? g.group[0] : g.snap[g.idx];
}

function nextBox(S, sl) {
  if (sl.queue.length) { sl.cur = sl.queue.shift(); sl.state = 'place'; sl.t = S.p.swap; sl.since = S.tick; }
  else { sl.cur = null; sl.state = 'reset'; sl.t = S.p.reset; }
}
function outSlots(item, n) {
  const ss = stackSize(item), slots = new Array(27).fill(null);
  for (let k = 0; n > 0 && k < 27; k++, n -= ss) slots[k] = [item, Math.min(ss, n)];
  return slots;
}
function emit(S, sl, n, full) {               // a finished output box leaves the slice
  const b = { id: 'o' + S.outSeq++, out: true, full, slice: sl.i, slots: outSlots(sl.filter, n) };
  sl.recent.unshift(b); S.lastOut.unshift(b); S.outBoxes.push(b);
  const e = S.items.get(sl.filter); e.out += n; if (full) e.full++; else e.partial++;
  if (sl.recent.length > 200) sl.recent.length = 200;
  if (S.lastOut.length > 18) S.lastOut.length = 18;
}
function addOut(S, sl, n) {
  sl.out += n; S.sorted += n;
  const cap = stackSize(sl.filter) * 27;
  if (sl.out >= cap) { sl.out -= cap; S.outFull++; sl.full++; emit(S, sl, cap, true); }
}
function sliceStep(S, sl) {
  if (sl.state !== 'idle') sl.busy++;
  if (sl.state === 'place') { if (sl.since !== S.tick && --sl.t <= 0) { sl.state = 'pull'; sl.t = S.p.pull; } return; }
  if (sl.state === 'pull') {
    if (--sl.t > 0) return;
    sl.t = S.p.pull;
    const k = sl.cur.slots.findIndex(s => s && s[0] === sl.filter);
    if (k < 0) {                          // filter hopper stopped pulling: break the box
      const b = sl.cur;
      if (isEmpty(b)) { S.empties++; S.inSystem--; }
      else travel(S, b, 'back' + sl.i, S.p.back, () => S.luifQ.push(b));
      sl.flash = -1;
      nextBox(S, sl);
      return;
    }
    const s = sl.cur.slots[k];
    if (--s[1] === 0) sl.cur.slots[k] = null;
    sl.flash = k;
    if (!sl.held) sl.held = true; else addOut(S, sl, 1);
    return;
  }
  if (sl.state === 'reset' && --sl.t <= 0) {
    if (sl.held) { sl.held = false; addOut(S, sl, 1); }
    if (sl.out > 0) { S.outPartial++; sl.partial++; emit(S, sl, sl.out, false); sl.out = 0; }
    sl.filter = null; sl.state = 'idle';
  }
}


// ---------------------------------------------------------------- classic cycvar: no grouper, no LUIF
// Boxes go through slice 1, 2, ... N in a line. A slice without an item strips leading unstackables (like a LUIF)
// and takes the box's first item as its filter. A slice that wants an item in the box keeps the box until the
// hopper has pulled all of it; boxes behind it wait. Other boxes pass in `pass` gt. After the last slice boxes go
// to the buffer. When every box of the cycle has gone through every slice, all slices reset and the buffer
// feeds slice 1 again. A new batch only starts when the previous one has fully left.
function stepClassic(S) {
  const p = S.p;
  S.tick++;
  for (let i = S.travel.length - 1; i >= 0; i--) {
    const m = S.travel[i];
    if (++m.t >= m.T) { S.travel.splice(i, 1); m.arrive(); }
  }
  // start a cycle: from the input chest (new batch) or from the buffer
  if (!S.feeding.length && !S.cycleOn && S.slices.every(s => s.state === 'idle')) {
    if (S.buffer.length) { S.feeding = S.buffer.splice(0); S.feedFrom = 'buf'; }
    else if (S.inSystem === 0 && S.input.length) {
      S.batchNo++;
      S.feeding = S.input.splice(0, Math.min(p.batch, S.input.length)); S.feedFrom = 'in';
      S.inSystem += S.feeding.length;
    }
    if (S.feeding.length) { S.cycleOn = true; S.cycles = (S.cycles || 0) + 1; S.dispenseT = 0; }
  }
  if (S.feeding.length && --S.dispenseT <= 0) {
    const b = S.feeding.shift(), sl0 = S.slices[0];
    S.dispenseT = p.input;
    travel(S, b, S.feedFrom, p.link, () => sl0.queue.push(b));
  }
  for (const sl of S.slices) classicSlice(S, sl);
  // cycle over: nothing left to feed, travelling or waiting at a slice -> every slice resets
  if (S.cycleOn && !S.feeding.length && !S.travel.length && S.slices.every(s => s.state === 'idle' && !s.queue.length && !s.lu)) {
    S.cycleOn = false;
    for (const sl of S.slices) if (sl.filter || sl.held) { sl.state = 'reset'; sl.t = p.reset; }
  }
  if (!S.input.length && !S.feeding.length && S.inSystem === 0 && !S.cycleOn && S.slices.every(s => s.state === 'idle')) S.done = true;
}
function classicSlice(S, sl) {
  if (sl.state !== 'idle') { sl.busy++; classicTimer(S, sl); }
  if (ownLuif(S)) return cartLuifStep(S, sl);
  // a free slice takes the next waiting box straight away (also on the tick its last box left)
  if (sl.state === 'idle' && sl.queue.length && !(!isHyper(S) && !S.cycleOn)) {
    sl.cur = sl.queue.shift();
    classicArrive(S, sl);
  }
}
function classicTimer(S, sl) {
  const p = S.p;
  if (sl.state === 'cart') return cartTick(S, sl);
  if (--sl.t > 0 && sl.state !== 'pull') return;
  switch (sl.state) {
    case 'strip': {                                   // remove one leading unstackable, then look again
      const k = sl.cur.slots.findIndex(Boolean);
      S.unstack += sl.cur.slots[k][1]; S.sorted += sl.cur.slots[k][1]; sl.cur.slots[k] = null;
      return classicArrive(S, sl);
    }
    case 'place':
      if (S.mode !== 'classic' && S.mode !== 'hyper') return startCart(sl);
      sl.state = 'pull'; sl.t = p.pull; return;
    case 'pull': {
      if (sl.t > 0) return;
      sl.t = p.pull;
      const k = sl.cur.slots.findIndex(s => s && s[0] === sl.filter);
      if (k < 0) { sl.flash = -1; return classicLeave(S, sl); }
      const s = sl.cur.slots[k];
      if (--s[1] === 0) sl.cur.slots[k] = null;
      sl.flash = k;
      if (!sl.held) sl.held = true; else addOut(S, sl, 1);
      return;
    }
    case 'pass': {                                    // box moves on to the next slice, or to the buffer
      const b = sl.cur;
      if (isHyper(S) && !ownLuif(S) && sl.i < S.N - 1 && !canEnter(S, sl.i + 1, b.cyc)) { sl.t = 1; return; }   // keep the gap
      sl.cur = null; sl.state = 'idle';
      if (sl.i < S.N - 1) S.slices[sl.i + 1].queue.push(b);
      else travel(S, b, 'last', p.link, () => S.buffer.push(b));
      return;
    }
    case 'reset':
      if (sl.held) { sl.held = false; addOut(S, sl, 1); }
      if (sl.out > 0) { S.outPartial++; sl.partial++; emit(S, sl, sl.out, false); sl.out = 0; }
      sl.filter = null; sl.cyc = null; sl.state = 'idle';
  }
}
function classicArrive(S, sl) {                       // decide what to do with the box now in the slice
  const b = sl.cur, k = b.slots.findIndex(Boolean);
  if (k < 0) { S.empties++; S.inSystem--; sl.cur = null; sl.state = 'idle'; return; }
  if (!sl.filter && !selfName(S)) {            // cart slices with unstackable handling: the first cart takes the item
    if (stackSize(b.slots[k][0]) === 1) { sl.state = 'strip'; sl.t = S.p.unst; return; }
    sl.filter = b.slots[k][0]; sl.cyc = b.cyc;
  }
  if (S.mode.startsWith('cart')) startCart(sl);   // a cart slice can't tell without a cart cycle; the box is swapped in during the cart gap
  else if (hasItem(b, sl.filter)) { sl.state = 'place'; sl.t = S.p.swap; }
  else { sl.state = 'pass'; sl.t = S.p.pass; }
}
function classicLeave(S, sl) {                        // unloading done: empty boxes leave, others pass on
  if (isEmpty(sl.cur)) { S.empties++; S.inSystem--; sl.cur = null; sl.state = 'idle'; return; }
  sl.state = 'pass'; sl.t = S.p.pass;
}


// ---------------------------------------------------------------- classic with cart slices
// Same line as classic, but slices empty boxes with hopper minecarts instead of a hopper. A new box is swapped in
// while the next cart arrives (during the cart gap), so carts have no separate box-swap time. Carts are loaded
// 0-U-U-U-U: slot 1 = the variable filter, slots 2-5 hold unstackables, so a cart holding just its filter item
// already reads SS12. A cart cycle is `cartGap` gt with no cart pulling, then the cart sits under the box pulling 1
// matching item per gt (up to a full stack) for max(`dwell`, gt needed to reach SS `ss`), then leaves. If it reached
// `ss` the next cart (already carrying the filter item) comes; if not, the box has run out of the item and moves on.
// So every box costs at least one cart cycle at every slice. Defaults fit Carlos's numbers: SS15 = 8 + 63 = 71 gt,
// SS2 (always on) = 8 + 22 = 30 gt.
//   'cart'  (no unstackable handling): a LUIF in front of every slice strips leading unstackables (luif gt + unst gt
//           each); it works on the next box while the slice is busy and hands it over when the slice is free.
//   'cartU' (slices handle unstackables): no LUIF. A slice without an item lets its cart take the box's first item:
//           an unstackable fills the cart at once, so it costs one whole cart cycle (gap + dwell) and the slice stays
//           free; the first stackable becomes the filter.
function cartFill(stack, ss) {          // items in the cart's filter slot for comparator signal >= ss
  ss = Math.min(15, Math.max(13, ss));   // 0-U-U-U-U carts read SS12 even when they come back empty
  for (let n = 1; n <= stack; n++) if (Math.floor(14 * (4 + n / stack) / 5) + 1 >= ss) return n;
  return stack;
}
function cartLuifStep(S, sl) {           // the slice's own LUIF ('cart'): sl.lu = { box, t } until the slice takes it
  const p = S.p;
  if (sl.lu && sl.lu.t > 0 && --sl.lu.t <= 0) {
    const b = sl.lu.box, k = b.slots.findIndex(Boolean);
    if (k >= 0 && stackSize(b.slots[k][0]) === 1) { S.unstack += b.slots[k][1]; S.sorted += b.slots[k][1]; b.slots[k] = null; sl.lu.t = p.unst; }
  }
  if (!S.cycleOn && !isHyper(S)) return;
  // into the slice once it's free; cart hyper keeps the gap here, at the slice itself (a box may wait in the LUIF)
  if (sl.lu && sl.lu.t <= 0 && sl.state === 'idle' && !(isHyper(S) && !canEnter(S, sl.i, sl.lu.box.cyc))) { sl.cur = sl.lu.box; sl.lu = null; classicArrive(S, sl); }
  if (!sl.lu && sl.queue.length) sl.lu = { box: sl.queue.shift(), t: p.luif };
}
function cartDone(S, sl) {              // the cart core is finished with this box
  if (S.mode === 'cartG' || S.mode === 'cartGGo') cartGLeave(S, sl);    // back to the front LUIF
  else if (S.mode === 'cartGU' || S.mode === 'cartGG') coreNext(S, sl); // on to the next core
  else if (S.mode === 'cartMG' || S.mode === 'cartML') cartQNext(S, sl); // leftovers to the LUIF, next box of the group
  else classicLeave(S, sl);                     // on along the slice line
}
// multithreaded cart slices: a slice gets a group (global grouper) or claimed boxes (local groupers) whose first box
// leads with the slice's item, so the first cart names it. When a box is done its leftovers go back to the LUIF
// (`back` gt); with no box left the slice resets on its own.
function cartQSlice(S, sl) {
  const p = S.p;
  if (sl.state !== 'idle') sl.busy++;
  if (sl.state === 'place') { startCart(sl); return; }   // group's first box: swapped in during the first cart's gap
  if (sl.state === 'cart') return cartTick(S, sl);
  if (sl.state === 'reset' && --sl.t <= 0) {
    if (sl.held) { sl.held = false; addOut(S, sl, 1); }
    if (sl.out > 0) { S.outPartial++; sl.partial++; emit(S, sl, sl.out, false); sl.out = 0; }
    sl.filter = null; sl.state = 'idle';
  }
  if (isLocal(S) && sl.state === 'idle' && sl.queue.length) { sl.cur = sl.queue.shift(); startCart(sl); }
}
function cartQNext(S, sl) {
  const b = sl.cur;
  sl.cur = null;
  if (isEmpty(b)) { S.empties++; S.inSystem--; }
  else travel(S, b, 'back' + sl.i, S.p.back, () => S.luifQ.push(b));
  if (sl.queue.length) { sl.cur = sl.queue.shift(); startCart(sl); }   // next box swapped in during the next cart's gap
  else { sl.state = 'reset'; sl.t = S.p.reset; }
}
function startCart(sl) { sl.state = 'cart'; sl.ct = 0; sl.cn = sl.held ? 1 : 0; sl.need = null; }
function cartTick(S, sl) {
  const p = S.p;
  if (!sl.filter) {                      // 'cartU', free filter slot: this cart takes the box's first item
    if (++sl.ct === p.cartGap + 1) {
      const b = sl.cur, k = b.slots.findIndex(Boolean);
      if (k >= 0 && stackSize(b.slots[k][0]) === 1) { S.unstack += b.slots[k][1]; S.sorted += b.slots[k][1]; b.slots[k] = null; }
      else if (k >= 0) {
        sl.filter = b.slots[k][0]; sl.cyc = b.cyc; sl.need = cartFill(stackSize(sl.filter), p.ss);
        if (--b.slots[k][1] === 0) b.slots[k] = null;
        sl.held = true; sl.cn = 1;
        return;
      }
    }
    if (!sl.filter && sl.ct >= p.cartGap + p.dwell) { if (isEmpty(sl.cur)) cartDone(S, sl); else startCart(sl); }
    return;
  }
  const st = stackSize(sl.filter), fill = cartFill(st, p.ss);
  if (sl.need == null) sl.need = fill - sl.cn;
  sl.ct++;
  if (sl.ct > p.cartGap && sl.cn < st) {
    const k = sl.cur.slots.findIndex(s => s && s[0] === sl.filter);
    if (k >= 0) {
      const s = sl.cur.slots[k];
      if (--s[1] === 0) sl.cur.slots[k] = null;
      if (!sl.held) sl.held = true; else addOut(S, sl, 1);
      sl.cn++;
    }
  }
  if (sl.ct >= p.cartGap + Math.max(p.dwell, sl.need)) {
    if (sl.cn >= fill) return startCart(sl);
    cartDone(S, sl);
  }
}

// ---------------------------------------------------------------- hyperthreaded classic
// Same line of slices, but the next cycle doesn't wait for the whole line to empty: each slice resets as soon as the
// last box of its cycle has passed it, and cycle F+1 starts entering slice 1 once slices 1 and 2 are free. Cycle F+1
// is made of exactly the boxes leaving cycle F, streamed in as they come out, so every box still goes through every
// cycle in order (ideal output per batch, like classic). A box only moves into a slice when that slice and the one
// after it are free or belong to its own cycle, so one empty slice always separates two cycles.
function owner(S, j) {
  const sl = S.slices[j];
  if (!sl) return null;
  if (sl.filter || sl.held || sl.state === 'reset') return sl.cyc;
  if (sl.cur) return sl.cur.cyc;
  if (ownLuif(S)) return null;            // cart hyper with a LUIF per slice: only the slice itself counts for the gap
  if (sl.queue.length) return sl.queue[0].cyc;
  return null;
}
function canEnter(S, j, c) {
  const a = owner(S, j), b = owner(S, j + 1);
  return (a === null || a === c) && (b === null || b === c);
}
const toSlice1 = m => m.path === 'in' || m.path === 'buf';
function liveIn(S, c) {               // any box of cycle c still in the line or on its way to the buffer?
  return S.slices.some(sl => sl.cur?.cyc === c || sl.lu?.box.cyc === c || sl.queue.some(b => b.cyc === c)) || S.travel.some(m => m.what.cyc === c);
}
function stepHyper(S) {
  const p = S.p;
  S.tick++;
  for (let i = S.travel.length - 1; i >= 0; i--) {
    const m = S.travel[i];
    if (++m.t >= m.T) { S.travel.splice(i, 1); m.arrive(); }
  }
  // open a new cycle: something to feed, nothing still on its way to slice 1, slices 1 and 2 free
  if (S.feedCyc == null && !S.travel.some(toSlice1)) {
    if (!S.feeding.length && S.inSystem === 0 && S.input.length) {
      S.batchNo++;
      S.feeding = S.input.splice(0, Math.min(p.batch, S.input.length));
      for (const b of S.feeding) b.cyc = S.cycles;              // a new batch counts as leaving the last cycle
      S.inSystem += S.feeding.length;
    }
    const ready = S.feeding.length || S.buffer.some(b => b.cyc === S.cycles);
    if (ready && owner(S, 0) === null && owner(S, 1) === null) { S.feedCyc = ++S.cycles; S.dispenseT = 0; }
  }
  // stream boxes into the open cycle, one per `input` gt
  if (S.feedCyc != null && --S.dispenseT <= 0) {
    const prev = S.feedCyc - 1, k = S.buffer.findIndex(b => b.cyc === prev);
    if (!S.feeding.length && k < 0) {
      if (liveIn(S, prev)) S.dispenseT = 1;                          // boxes of the previous cycle still on their way out
      else S.feedCyc = null;                                         // every box of the previous cycle is in: it closes
    }
    else if (!canEnter(S, 0, S.feedCyc)) S.dispenseT = 1;           // keep the gap to the cycle ahead
    else {
      const from = S.feeding.length ? 'in' : 'buf', b = from === 'in' ? S.feeding.shift() : S.buffer.splice(k, 1)[0];
      b.cyc = S.feedCyc; S.dispenseT = p.input;
      travel(S, b, from, p.link, () => S.slices[0].queue.push(b));
    }
  }
  for (const sl of S.slices) classicSlice(S, sl);
  // a slice resets once no box of its cycle can still reach it
  for (const sl of S.slices) {
    if (sl.state !== 'idle' || sl.cur || sl.lu || sl.queue.length || !(sl.filter || sl.held)) continue;
    const c = sl.cyc;
    const coming = S.feedCyc === c || S.travel.some(m => toSlice1(m) && m.what.cyc === c)
      || S.slices.some(o => o.i < sl.i && (o.cur?.cyc === c || o.lu?.box.cyc === c || o.queue.some(b => b.cyc === c)));
    if (!coming) { sl.state = 'reset'; sl.t = p.reset; }
  }
  if (!S.input.length && !S.feeding.length && S.inSystem === 0 && S.feedCyc == null && S.slices.every(s => s.state === 'idle' && !s.filter)) S.done = true;
}

// ---------------------------------------------------------------- classic with groupers (hopper-speed slices)
// Each cycle every box goes through the LUIF (groupers break on a leading unstackable, and a core can leave one at the
// front), then grouper 1..N: a check takes `grouper` gt, moving on to the next grouper `hop` gt. Grouper i sends boxes
// holding slice i's item down to core i (`hop` gt); a grouper whose slice has no item yet takes the box's first item.
// Boxes no grouper wants go to the buffer. From a core a box walks core i+1..N (see groupedSlice) and then to the
// buffer. A slice gets its item from whichever box reaches it first. When every box is through, all slices reset
// and the buffer goes through the LUIF again.
function stepGrouped(S) {
  const p = S.p;
  S.tick++;
  for (let i = S.travel.length - 1; i >= 0; i--) {
    const m = S.travel[i];
    if (++m.t >= m.T) { S.travel.splice(i, 1); m.arrive(); }
  }
  // start a cycle: buffer back through the LUIF, or a new batch from the input chest
  if (S.phase === 'idle') {
    if (S.buffer.length) { S.feeding = S.buffer.splice(0); S.feedFrom = 'rebuf'; }
    else if (S.inSystem === 0 && S.input.length) {
      S.batchNo++;
      S.feeding = S.input.splice(0, Math.min(p.batch, S.input.length)); S.feedFrom = 'in';
      S.inSystem += S.feeding.length;
    }
    if (S.feeding.length) { S.phase = 'stream'; S.cycles++; S.dispenseT = 0; for (const sl of S.slices) { sl.gDone = false; sl.gf = null; } }
  }
  if (S.feeding.length && --S.dispenseT <= 0) {
    const b = S.feeding.shift();
    S.dispenseT = p.input;
    travel(S, b, S.feedFrom, p.link, () => S.luifQ.push(b));
  }
  // LUIF
  if (!S.luif && S.luifQ.length) S.luif = { box: S.luifQ.shift(), t: p.luif };
  else if (S.luif && --S.luif.t <= 0) {
    const b = S.luif.box, k = b.slots.findIndex(Boolean);
    if (k >= 0 && stackSize(b.slots[k][0]) === 1) {
      S.unstack += b.slots[k][1]; S.sorted += b.slots[k][1]; b.slots[k] = null; S.luif.t = p.unst;
    } else {
      S.luif = S.luifQ.length ? { box: S.luifQ.shift(), t: p.luif } : null;
      if (k < 0) { S.empties++; S.inSystem--; }
      else travel(S, b, 'g', p.link, () => groupAt(S, 0, b));
    }
  }
  for (let i = 0; i < S.N; i++) { groupTick(S, i); (S.mode.startsWith('cartG') ? cartGSlice : groupedSlice)(S, S.slices[i]); }
  if (S.mode === 'cartG') for (let i = 0; i < S.N; i++) {   // a grouper that has seen every box lets its kept box go
    const sl = S.slices[i];
    if (sl.gHeld && seenAll(S, i)) { const b = sl.gHeld; sl.gHeld = null; sl.gDone = true; travel(S, b, 'down' + i, p.hop, () => sl.queue.push(b)); }
  }
  // every box of the cycle is through (all in the buffer or out): reset all slices
  if (S.phase === 'stream' && !S.feeding.length && !S.luif && !S.luifQ.length && S.gcur.every(g => !g) && S.gq.every(q => !q.length)
      && S.slices.every(sl => sl.state === 'idle' && !sl.queue.length && !sl.gHeld) && !S.travel.length) {
    S.phase = 'reset';
    for (const sl of S.slices) if (sl.filter) { sl.state = 'reset'; sl.t = p.reset; }
  } else if (S.phase === 'reset') {
    for (const sl of S.slices) if (sl.state === 'reset' && --sl.t <= 0) {
      if (sl.held) { sl.held = false; addOut(S, sl, 1); }
      if (sl.out > 0) { S.outPartial++; sl.partial++; emit(S, sl, sl.out, false); sl.out = 0; }
      sl.filter = null; sl.state = 'idle';
    }
    if (S.slices.every(sl => sl.state === 'idle')) S.phase = 'idle';
  }
  for (const sl of S.slices) if (sl.state !== 'idle') sl.busy++;
  if (!S.input.length && S.inSystem === 0 && S.phase === 'idle' && !S.feeding.length) S.done = true;
}
// local groupers (classic with groupers, multithreaded local groupers): a box reaching grouper i waits in its queue;
// each check takes `grouper` gt, the next box starts on the tick the previous one leaves.
function groupAt(S, i, b) { S.gq[i].push(b); }
function groupTick(S, i) {
  const p = S.p;
  if (!S.gcur[i]) { if (S.gq[i].length) { S.gcur[i] = { box: S.gq[i].shift(), t: p.grouper }; S.grpBusy++; } return; }
  S.grpBusy++;
  if (--S.gcur[i].t > 0) return;
  const b = S.gcur[i].box;
  S.gcur[i] = S.gq[i].length ? { box: S.gq[i].shift(), t: p.grouper } : null;
  const sl = S.slices[i];
  if (sl.state !== 'reset' && !sl.gDone) {           // resetting slices (and finished cartG groupers) let boxes pass
    // the filter takes the first stackable item (a box can lead with an unstackable after an earlier slice).
    // Grouper and core are separate machines: a classic grouper keeps its own item (gf) and never sees which item its
    // core took; the core names itself from the first box that reaches it (from the grouper or the core line), so
    // the two can differ. Multithreaded local groupers claim for a free slice, so there the item is the slice's.
    const fk = isLocal(S) ? 'filter' : 'gf';
    if (!sl[fk] && (!isLocal(S) || sl.state === 'idle')) sl[fk] = b.slots.find(x => x && stackSize(x[0]) > 1)?.[0] ?? null;
    if (sl[fk] && hasItem(b, sl[fk])) {
      if (S.mode === 'cartG') {                     // the grouper keeps its latest match (its filter); the one before goes down
        const prev = sl.gHeld; sl.gHeld = b;
        if (prev) travel(S, prev, 'down' + i, p.hop, () => sl.queue.push(prev));
      } else if (!isLocal(S)) travel(S, b, 'down' + i, p.hop, () => sl.queue.push(b));   // grouper i -> core i
      else travel(S, b, 'down' + i, p.hop, () => sl.queue.push(b));   // multithreaded local: grouper i -> core i too
      return;
    }
  }
  if (i < S.N - 1) travel(S, b, 'hop' + i, p.hop, () => groupAt(S, i + 1, b));
  else travel(S, b, 'last', p.link, () => S.buffer.push(b));
}
// Classic with groupers: core i = slice i's hopper. A box comes in from grouper i or from core i-1 (one queue, first
// come first served). A core without an item strips the box's leading unstackables (unst gt each) and takes its first
// item; a core with an item unloads boxes holding it. Then the box goes on to core i+1 (hop gt), the last to the buffer:
// once in the core line a box never goes back to a grouper.
function groupedSlice(S, sl) {
  const p = S.p;
  if (sl.state === 'reset') return;                     // handled by the cycle reset
  if (sl.state !== 'idle' && --sl.t <= 0) {
    if (sl.state === 'strip') {
      const k = sl.cur.slots.findIndex(Boolean);
      S.unstack += sl.cur.slots[k][1]; S.sorted += sl.cur.slots[k][1]; sl.cur.slots[k] = null;
      coreArrive(S, sl);
    } else if (sl.state === 'place') { sl.state = 'pull'; sl.t = p.pull; }
    else {                                              // pull
      sl.t = p.pull;
      const k = sl.cur.slots.findIndex(s => s && s[0] === sl.filter);
      if (k < 0) coreNext(S, sl);
      else {
        const s = sl.cur.slots[k];
        if (--s[1] === 0) sl.cur.slots[k] = null;
        if (!sl.held) sl.held = true; else addOut(S, sl, 1);
      }
    }
  }
  if (sl.state === 'idle' && sl.queue.length) { sl.cur = sl.queue.shift(); coreArrive(S, sl); }
}
function coreArrive(S, sl) {
  const b = sl.cur, k = b.slots.findIndex(Boolean);
  if (k < 0) return coreNext(S, sl);
  if (!sl.filter) {
    if (stackSize(b.slots[k][0]) === 1) { sl.state = 'strip'; sl.t = S.p.unst; return; }
    sl.filter = b.slots[k][0];
  }
  if (hasItem(b, sl.filter)) { sl.state = 'place'; sl.t = S.p.swap; }
  else coreNext(S, sl);
}
function coreNext(S, sl) {                              // box leaves core i: empty boxes out, others to core i+1 / buffer
  const b = sl.cur, i = sl.i;
  sl.cur = null; sl.state = 'idle';
  if (isEmpty(b)) { S.empties++; S.inSystem--; }
  else if (i < S.N - 1) travel(S, b, 'core' + i, S.p.hop, () => S.slices[i + 1].queue.push(b));
  else travel(S, b, 'last', S.p.link, () => S.buffer.push(b));
}

// ---------------------------------------------------------------- cart classic, local groupers, no unstackable handling
// The cycle, front LUIF and grouper line of classic with groupers, but the cores are cart slices that can't take a box
// leading with an unstackable, so a box can't go on to the next core. Grouper i keeps its latest matching box (its
// filter) until it has seen every box of the cycle, including ones coming round from earlier cores (see seenAll);
// each earlier match goes down to the core. Grouper i claims boxes with slice i's item (a
// free slice takes the box's first item) and they queue in front of core i (`hop` gt); the grouper keeps checking.
// Once the cart core is done with a box it goes back to the front LUIF (`back` gt) and through grouper 1..N again:
// a box that comes back can't say which slice it came from, but it no longer holds any item it already met, so only
// later groupers can claim it. Boxes past grouper N go to the buffer; when every box is through, all slices reset.
// 'cartGU' (cart cores that handle unstackables): same grouper line, but cores work like classic with groupers: a box
// that reaches a core without an item gets its first item taken by the cart (an unstackable costs a whole cart cycle,
// see cartTick), and a finished box walks on to core i+1 (`hop` gt), the last one to the buffer.
// cartG: grouper i can only let go of its kept box once no box can reach it any more: nothing left to enter the
// LUIF, every grouper up to i idle, and every earlier core done (its boxes come round again through the LUIF).
function seenAll(S, i) {
  if (S.feeding.length || S.luif || S.luifQ.length) return false;
  for (let j = 0; j <= i; j++) if (S.gcur[j] || S.gq[j].length) return false;
  for (let j = 0; j < i; j++) { const o = S.slices[j]; if (o.gHeld || o.state !== 'idle' || o.queue.length) return false; }
  return !S.travel.some(m => m.path === 'g' || m.path === 'in' || m.path === 'rebuf'
    || ['hop', 'down', 'back'].some(k => m.path.startsWith(k) && +m.path.slice(k.length) < i));
}
function cartGSlice(S, sl) {
  if (sl.state === 'reset') return;                     // handled by the cycle reset
  if (sl.state === 'cart') cartTick(S, sl);
  else if (sl.state === 'place' && --sl.t <= 0) startCart(sl);
  if (sl.state === 'idle' && sl.queue.length) { sl.cur = sl.queue.shift(); startCart(sl); }   // box swapped in during the cart gap
}
function cartGLeave(S, sl) {                            // core done: empty boxes out, others back to the front LUIF
  const b = sl.cur;
  sl.cur = null; sl.state = 'idle';
  if (isEmpty(b)) { S.empties++; S.inSystem--; }
  else travel(S, b, 'back' + sl.i, S.p.back, () => S.luifQ.push(b));
}

// ---------------------------------------------------------------- classic with a global grouper
// Cycles like classic. All boxes of the cycle go through the LUIF into the buffer; once the whole cycle is there the
// global grouper forms group 1..N in turn: group k's item is the first item of the first buffer box (checked first,
// `grouper` gt); then every box in the buffer is checked (`grouper` gt each) and the matching ones go to core k
// (`toSlice` gt). The grouper can't see the cores: a core names itself from the first box that reaches it.
// Cores work as in classic with groupers: after core k a box walks core k+1..N (`hop` gt each), a core without an item
// takes the first item of the box that reaches it, and the last core sends boxes back to the buffer. Boxes coming back
// may still hold items; the grouper only looks at them again in a later cycle; boxes that arrive during a scan wait
// for the next one. When the grouper is done and every box is through, all slices reset, and the buffer (unpicked +
// returned boxes) goes through the LUIF again.
function stepCGG(S) {
  const p = S.p, g = S.grp;
  S.tick++;
  for (let i = S.travel.length - 1; i >= 0; i--) {
    const m = S.travel[i];
    if (++m.t >= m.T) { S.travel.splice(i, 1); m.arrive(); }
  }
  if (S.phase === 'idle') {
    if (S.buffer.length) { S.feeding = S.buffer.splice(0); S.feedFrom = 'rebuf'; }
    else if (S.inSystem === 0 && S.input.length) {
      S.batchNo++;
      S.feeding = S.input.splice(0, Math.min(p.batch, S.input.length)); S.feedFrom = 'in';
      S.inSystem += S.feeding.length;
    }
    if (S.feeding.length) { S.phase = 'stream'; S.cycles++; S.dispenseT = 0; S.gk = -1; S.gItems = []; }
  }
  if (S.feeding.length && --S.dispenseT <= 0) {
    const b = S.feeding.shift();
    S.dispenseT = p.input;
    travel(S, b, S.feedFrom, p.link, () => S.luifQ.push(b));
  }
  if (!S.luif && S.luifQ.length) S.luif = { box: S.luifQ.shift(), t: p.luif };
  else if (S.luif && --S.luif.t <= 0) {
    const b = S.luif.box, k = b.slots.findIndex(Boolean);
    if (k >= 0 && stackSize(b.slots[k][0]) === 1) {
      S.unstack += b.slots[k][1]; S.sorted += b.slots[k][1]; b.slots[k] = null; S.luif.t = p.unst;
    } else {
      S.luif = S.luifQ.length ? { box: S.luifQ.shift(), t: p.luif } : null;
      if (k < 0) { S.empties++; S.inSystem--; }
      else travel(S, b, 'buf', p.link, () => S.buffer.push(b));
    }
  }
  // global grouper: starts once the whole cycle is in the buffer, then forms group 0..N-1
  if (S.phase === 'stream' && S.gk === -1 && !S.feeding.length && !S.luif && !S.luifQ.length && !S.travel.length) S.gk = 0;
  if (S.phase === 'stream' && S.gk >= 0 && S.gk < S.N) cggGrouper(S);
  for (const sl of S.slices) (S.mode === 'cgg' ? groupedSlice : cartGSlice)(S, sl);
  const rechecking = S.mode === 'cartGGo' && (S.luif || S.luifQ.length);   // boxes coming back through the LUIF
  if (S.phase === 'stream' && S.gk >= S.N && g.state === 'idle' && !rechecking && !S.travel.length && S.slices.every(sl => sl.state === 'idle' && !sl.queue.length)) {
    S.phase = 'reset';
    for (const sl of S.slices) if (sl.filter) { sl.state = 'reset'; sl.t = p.reset; }
  } else if (S.phase === 'reset') {
    for (const sl of S.slices) if (sl.state === 'reset' && --sl.t <= 0) {
      if (sl.held) { sl.held = false; addOut(S, sl, 1); }
      if (sl.out > 0) { S.outPartial++; sl.partial++; emit(S, sl, sl.out, false); sl.out = 0; }
      sl.filter = null; sl.state = 'idle';
    }
    if (S.slices.every(sl => sl.state === 'idle')) S.phase = 'idle';
  }
  for (const sl of S.slices) if (sl.state !== 'idle') sl.busy++;
  if (!S.input.length && S.inSystem === 0 && S.phase === 'idle' && !S.feeding.length) S.done = true;
}
// cartGGo (cart cores without unstackable handling): a box a core is done with can't go on to the next core (it might
// now lead with an unstackable), so it goes back through the LUIF into the buffer and waits for the next cycle. Like
// every global grouper, the grouper sends groups off and doesn't keep their items, so an item a box still holds for a
// later slice is only picked up if that box is back in the buffer before that slice's group is formed.
function cggGrouper(S) {
  const g = S.grp, p = S.p, sl = S.slices[S.gk];
  if (g.state === 'idle') {                          // start group gk
    if (!S.buffer.length) { S.gk = S.N; return; }   // nothing left to group this cycle
    g.snap = S.buffer.slice(); g.idx = 0; g.group = []; g.t = p.grouper;
    // first box of the buffer names the item (a box back from the cores can lead with an unstackable: skip those)
    // the grouper names group k's item itself from the first buffer box; it can't see which item core k may have
    // taken already from a box of the core line
    g.filter = S.gItems[S.gk] = g.snap[0].slots.find(x => x && stackSize(x[0]) > 1)?.[0] ?? null; g.state = 'scan'; g.checking = g.snap[0]; S.grpBusy++;
    return;
  }
  S.grpBusy++;
  if (--g.t > 0) return;
  g.t = p.grouper;
  const b = g.snap[g.idx++];
  if (hasItem(b, g.filter)) { S.buffer.splice(S.buffer.indexOf(b), 1); g.group.push(b); }
  if (g.idx < g.snap.length) { g.checking = g.snap[g.idx]; return; }
  const k = S.gk, boxes = g.group;
  if (boxes.length) travel(S, { filter: g.filter, boxes }, 'to' + k, p.toSlice, () => S.slices[k].queue.push(...boxes));
  Object.assign(g, { state: 'idle', group: [], snap: [], checking: null, filter: null });
  S.gk++;
}

// ---------------------------------------------------------------- multithreaded, local groupers
// Boxes circle constantly: input chest -> LUIF -> buffer -> grouper 1..N -> back to the buffer. Each slice has its own
// grouper (`grouper` gt per check, `hop` gt to the next one). A free slice's grouper takes the first stackable item of the next
// box; a slice keeps claiming boxes with its item while it works and resets on its own once it has no boxes left.
// Resetting slices let boxes pass. Leftover boxes from slices go to the LUIF, then the buffer. Boxes that pass every
// grouper go straight back to the buffer. The buffer sends a box (one per `input` gt) whenever a slice is free;
// with waitSlice it also waits until leftovers from finished slices are back in the buffer.
function stepLocal(S) {
  const p = S.p;
  S.tick++;
  for (let i = S.travel.length - 1; i >= 0; i--) {
    const m = S.travel[i];
    if (++m.t >= m.T) { S.travel.splice(i, 1); m.arrive(); }
  }
  if (!S.dispensing && S.inSystem === 0 && S.input.length) { S.batchNo++; S.dispensing = Math.min(p.batch, S.input.length); S.dispenseT = 0; }
  if (S.dispensing && --S.dispenseT <= 0) {
    const b = S.input.shift();
    S.dispensing--; S.inSystem++; S.dispenseT = p.input;
    travel(S, b, 'in', p.link, () => S.luifQ.push(b));
  }
  // LUIF -> buffer
  if (!S.luif && S.luifQ.length) S.luif = { box: S.luifQ.shift(), t: p.luif };
  else if (S.luif && --S.luif.t <= 0) {
    const b = S.luif.box, k = b.slots.findIndex(Boolean);
    if (k >= 0 && stackSize(b.slots[k][0]) === 1) {
      S.unstack += b.slots[k][1]; S.sorted += b.slots[k][1]; b.slots[k] = null; S.luif.t = p.unst;
    } else {
      S.luif = S.luifQ.length ? { box: S.luifQ.shift(), t: p.luif } : null;
      if (k < 0) { S.empties++; S.inSystem--; }
      else travel(S, b, 'buf', p.link, () => S.buffer.push(b));
    }
  }
  // buffer -> grouper 1 while a slice is free
  if (S.releaseT > 0) S.releaseT--;
  const free = S.slices.some(sl => sl.state === 'idle' && !sl.filter);
  const back = p.waitSlice && (S.luif || S.luifQ.length || S.travel.some(m => m.path === 'buf' || m.path.startsWith('back')));
  if (S.buffer.length && free && !back && !(S.releaseT > 0)) {
    const b = S.buffer.shift();
    S.releaseT = p.input;
    travel(S, b, 'g', p.link, () => groupAt(S, 0, b));
  }
  for (let i = 0; i < S.N; i++) { groupTick(S, i); (S.mode === 'cartML' ? cartQSlice : localSlice)(S, S.slices[i]); }
  if (!S.input.length && !S.dispensing && S.inSystem === 0 && S.slices.every(s => s.state === 'idle' && !s.filter)) S.done = true;
}
function localSlice(S, sl) {
  const p = S.p;
  if (sl.state !== 'idle') sl.busy++;
  if (sl.state === 'idle') {
    if (!sl.queue.length) return;
    sl.cur = sl.queue.shift(); sl.state = 'place'; sl.t = p.swap;
    return;
  }
  if (--sl.t > 0) return;
  if (sl.state === 'reset') {
    if (sl.held) { sl.held = false; addOut(S, sl, 1); }
    if (sl.out > 0) { S.outPartial++; sl.partial++; emit(S, sl, sl.out, false); sl.out = 0; }
    sl.filter = null; sl.state = 'idle';
    return;
  }
  if (sl.state === 'place') { sl.state = 'pull'; sl.t = p.pull; return; }
  sl.t = p.pull;
  const k = sl.cur.slots.findIndex(s => s && s[0] === sl.filter);
  if (k < 0) {                                          // out of this item: leftovers to the LUIF, then the next box or reset
    const b = sl.cur;
    sl.cur = null; sl.flash = -1;
    if (isEmpty(b)) { S.empties++; S.inSystem--; }
    else travel(S, b, 'back' + sl.i, p.back, () => S.luifQ.push(b));
    if (sl.queue.length) { sl.cur = sl.queue.shift(); sl.state = 'place'; sl.t = p.swap; }
    else { sl.state = 'reset'; sl.t = p.reset; }
    return;
  }
  const s = sl.cur.slots[k];
  if (--s[1] === 0) sl.cur.slots[k] = null;
  sl.flash = k;
  if (!sl.held) sl.held = true; else addOut(S, sl, 1);
}
