#!/usr/bin/env python3
"""
Cycvar v2 — mechanistic Monte Carlo simulator.

Mechanics (confirmed with Carlos, see flowchart.png):
  * Input is sent in batches of up to 54 boxes. Next batch only after the whole batch is sorted.
  * Each cycle every remaining box streams through the Lead Unstackable Item Filter (LUIF): 16 gt per box,
    +8 gt per leading unstackable removed (it removes until a stackable leads); empty boxes leave.
  * Then through groupers 1..N. An unset grouper takes the first item of the first box it sees as its
    filter (that box goes to its slice); afterwards it takes any box containing that item anywhere.
    Boxes no grouper takes go to the buffer.
  * No overlap: slices start pulling only after every box has passed the groupers.
  * Slice cart core: one cart cycle (~70 gt) pulls up to stack-1 items of the filter item from the current
    box (one item always stays as the variable filter). When a box runs out, the next cart cycle comes back
    empty and triggers the box replacement, so each box costs ceil(n/(stack-1)) + 1 cart cycles.
    Unstackables in the box are assumed removed by the cart core (CART_TAKES_UNSTACKABLES, unconfirmed).
    Leftover boxes go to the buffer. Partial output boxes are ejected at cycle end.
  * Cycle ends when all slices finish; filters reset; buffer boxes start the next cycle.
Randomness: input box order (shuffled per run) and dropper random slot (buffer order shuffled per cycle).

Time model (gt), constants in T from Carlos's estimates, to be checked against measured runs:
  cycle  = stream + max over slices(slice time) + reset
  stream = boxes * luif_gt + unstackables_removed * unstack_gt
  slice  = sum over its boxes of (ceil(n / (stack-1)) + 1) * cart_gt

Usage:
  python cycvar_sim.py set.litematic --slices 2-8 --trials 200
  python cycvar_sim.py --synthetic 120 400 --slices 2-8      # 120 item types, 400 boxes (no file needed)
"""
import argparse, os, random, statistics, sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from functools import cache

T = dict(luif_gt=16, unstack_gt=8, cart_gt=70, reset_gt=10)
CART_TAKES_UNSTACKABLES = True
BATCH = 54

UNSTACK_SUFFIX = ('_sword', '_pickaxe', '_axe', '_shovel', '_hoe', '_helmet', '_chestplate', '_leggings',
                  '_boots', '_bed', '_boat', '_raft', 'minecart', '_bucket', 'shulker_box', '_horse_armor',
                  '_stew', '_soup', '_banner_pattern', '_on_a_stick')
UNSTACK = {'potion', 'splash_potion', 'lingering_potion', 'enchanted_book', 'written_book', 'writable_book',
           'totem_of_undying', 'saddle', 'elytra', 'shield', 'bow', 'crossbow', 'trident', 'fishing_rod',
           'flint_and_steel', 'shears', 'cake', 'spyglass', 'brush', 'mace', 'bundle', 'goat_horn',
           'debug_stick', 'knowledge_book', 'wolf_armor', 'compass_lodestone'}
STACK16 = {'ender_pearl', 'snowball', 'egg', 'blue_egg', 'brown_egg', 'bucket', 'honey_bottle', 'armor_stand'}


@cache
def stack_size(item):
    n = item.removeprefix('minecraft:')
    if n in UNSTACK or n.endswith(UNSTACK_SUFFIX) or n.startswith('music_disc_'):
        return 1 if n != 'bucket' else 16
    if n in STACK16 or n.endswith(('_sign', '_banner')):
        return 16
    return 64


# ---------------------------------------------------------------- item sets
def _box_contents(item):
    """Slot-ordered [(id, count)] of a shulker box item (1.21 components or pre-1.20.5 NBT)."""
    comp = item.get('components', {}).get('minecraft:container')
    if comp is not None:
        slots = sorted((int(e['slot']), e['item']) for e in comp)
        return [(str(it['id']), int(it.get('count', 1))) for _, it in slots]
    items = item.get('tag', {}).get('BlockEntityTag', {}).get('Items', [])
    return [(str(it['id']), int(it.get('Count', it.get('count', 1))))
            for it in sorted(items, key=lambda it: int(it['Slot']))]


def load_litematic(path):
    """Boxes in a schematic: shulker items inside containers/minecarts and placed shulker blocks."""
    from litemapy import Schematic
    boxes = []
    for reg in Schematic.load(path).regions.values():
        holders = [t.data for t in reg.tile_entities] + [e.data for e in reg.entities]
        holders.sort(key=lambda d: (int(d.get('y', 0)), int(d.get('z', 0)), int(d.get('x', 0))))
        for d in holders:
            if 'shulker_box' in str(d.get('id', '')) and 'Items' in d:   # placed box
                boxes.append([(str(it['id']), int(it.get('count', it.get('Count', 1))))
                              for it in sorted(d['Items'], key=lambda it: int(it['Slot']))])
                continue
            for it in sorted(d.get('Items', []), key=lambda it: int(it.get('Slot', 0))):
                if str(it['id']).endswith('shulker_box'):
                    if c := _box_contents(it):
                        boxes.append(c)
    return boxes


def synthetic(types, n_boxes, seed=0):
    """Random mixed boxes: Zipf-ish type popularity, full stacks of 64."""
    r = random.Random(seed)
    names = [f'item{i}' for i in range(types)]
    w = [1 / (i + 1) for i in range(types)]
    return [[(t, 64) for t in r.choices(names, w, k=27)] for _ in range(n_boxes)]


# ---------------------------------------------------------------- simulation
def _totals(slots):
    tot = {}
    for it, c in slots:
        tot[it] = tot.get(it, 0) + c
    return tot


def run(boxes, n_slices, rng, t=T, shuffle_input=True, shuffle_buffer=True, batch=BATCH,
        cart_takes_unstackables=CART_TAKES_UNSTACKABLES):
    """One run. Returns dict of gt and counters."""
    boxes = [(list(b), _totals(b)) for b in boxes]      # box = (slot-ordered [(id, n)], {id: total})
    if shuffle_input:
        rng.shuffle(boxes)
    items = sum(sum(tot.values()) for _, tot in boxes)
    s = Counter(gt=0, cycles=0, batches=0, box_passes=0, pulls=0, unstack=0, outputs=0)
    for k in range(0, len(boxes), batch):
        cur = boxes[k:k + batch]
        s['batches'] += 1
        while cur:
            s['cycles'] += 1
            filt = [None] * n_slices
            taken = [[] for _ in range(n_slices)]
            buffer, clock = [], 0.0
            for box in cur:
                slots, tot = box
                clock += t['luif_gt']; s['box_passes'] += 1
                while slots and stack_size(slots[0][0]) == 1:      # LUIF
                    it, c = slots.pop(0)
                    tot[it] -= c
                    if not tot[it]:
                        del tot[it]
                    s['unstack'] += 1; clock += t['unstack_gt']
                if not slots:
                    continue
                for i in range(n_slices):
                    if filt[i] is None:
                        filt[i] = slots[0][0]
                    if filt[i] in tot:
                        taken[i].append(box)
                        break
                else:
                    buffer.append(box)
            slowest = 0
            for i, bs in enumerate(taken):
                if not bs:
                    continue
                f, ss = filt[i], stack_size(filt[i])
                n = sum(tot[f] for _, tot in bs)
                cart_cycles = sum(-(-tot[f] // (ss - 1)) + 1 for _, tot in bs)
                s['pulls'] += cart_cycles; s['outputs'] += -(-n // (ss * 27))
                slowest = max(slowest, cart_cycles * t['cart_gt'])
                for slots, _ in bs:
                    rest = [(it, c) for it, c in slots if it != f]
                    if cart_takes_unstackables:
                        stackable = [(it, c) for it, c in rest if stack_size(it) > 1]
                        s['unstack'] += len(rest) - len(stackable)
                        rest = stackable
                    if rest:
                        buffer.append((rest, _totals(rest)))
            finish = clock + slowest
            s['gt'] += finish + t['reset_gt']
            if shuffle_buffer:
                rng.shuffle(buffer)
            cur = buffer
    s['items'] = items
    s['speed'] = items / (s['gt'] / 72000) if s['gt'] else 0.0
    return s


def ideal_outputs(boxes):
    tot = Counter()
    for b in boxes:
        for it, c in b:
            tot[it] += c
    return sum(-(-c // (stack_size(it) * 27)) for it, c in tot.items() if stack_size(it) > 1)


def _trial(args):
    boxes, n, seed = args
    return run(boxes, n, random.Random(seed))


def parse_range(r):
    a, _, b = r.partition('-')
    return list(range(int(a), int(b or a) + 1))


def demo():
    """Self-check of the mechanics on tiny hand-made batches."""
    rng = random.Random(1)
    # one type per box: cycles = ceil(types / slices)
    boxes = [[('a', 64)] * 27, [('b', 64)] * 27, [('c', 64)] * 27]
    cyc = [run(boxes, n, rng, shuffle_input=False)['cycles'] for n in (1, 2, 3)]
    assert cyc == [3, 2, 1], cyc
    # mixed box goes to the first matching slice; its other item waits for the next cycle
    s = run([[('a', 64)] * 27, [('b', 64)] * 27, [('a', 64), ('b', 64)]], 2, rng, shuffle_input=False)
    assert s['cycles'] == 2 and s['box_passes'] == 4 and s['pulls'] == 29 * 2 + 3 * 2, s  # 64 items = 2 pulls + empty
    # leading unstackables stripped, empty box dropped
    s = run([[('minecraft:diamond_sword', 1)] * 3, [('minecraft:shears', 1), ('stone', 64)]], 1, rng,
            shuffle_input=False)
    assert s['unstack'] == 4 and s['cycles'] == 1 and s['pulls'] == 3
    assert stack_size('minecraft:ender_pearl') == 16 and stack_size('minecraft:bucket') == 16
    assert stack_size('minecraft:water_bucket') == 1 and stack_size('minecraft:oak_sign') == 16
    # more slices never needs more cycles on average
    syn = synthetic(60, 150)
    c = [statistics.mean(run(syn, n, random.Random(i))['cycles'] for i in range(20)) for n in (2, 4, 8)]
    assert c[0] > c[1] > c[2], c
    print('demo ok')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('litematic', nargs='?')
    ap.add_argument('--synthetic', nargs=2, type=int, metavar=('TYPES', 'BOXES'))
    ap.add_argument('--slices', default='2-8')
    ap.add_argument('--trials', type=int, default=200)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--demo', action='store_true')
    a = ap.parse_args()
    if a.demo:
        demo(); sys.exit()
    if a.litematic:
        boxes = load_litematic(a.litematic)
    elif a.synthetic:
        boxes = synthetic(*a.synthetic, seed=a.seed)
    else:
        ap.error('give a .litematic, --synthetic or --demo')
    items = sum(c for b in boxes for _, c in b)
    types = len({it for b in boxes for it, _ in b})
    print(f'{len(boxes)} boxes, {items:,} items, {types} item types, ideal output {ideal_outputs(boxes)} boxes')
    print(f'{"N":>3} {"speed":>9} {"x hop":>6} {"90% range":>19} {"cycles":>7} {"passes/box":>10} {"outputs":>8}')
    for n in parse_range(a.slices):
        with ProcessPoolExecutor() as ex:
            rs = list(ex.map(_trial, [(boxes, n, a.seed * 1_000_003 + n * 10_007 + i) for i in range(a.trials)],
                             chunksize=max(1, a.trials // (4 * (os.cpu_count() or 1)))))
        sp = sorted(r['speed'] for r in rs)
        lo, hi = sp[len(sp) // 20], sp[-len(sp) // 20 - 1]
        m = statistics.mean(sp)
        print(f'{n:>3} {m:>9,.0f} {m/9000:6.2f} {lo:>9,.0f}–{hi:<9,.0f} '
              f'{statistics.mean(r["cycles"] for r in rs):7.1f} '
              f'{statistics.mean(r["box_passes"] for r in rs)/len(boxes):10.2f} '
              f'{statistics.mean(r["outputs"] for r in rs):8.0f}')
