# Cycvar speed project — briefing for Claude Code

## What this is
Carlos is benchmarking a **Minecraft cycvar** he built and wants to understand / predict its speed.
A *cycvar* ("cyclical variable sorter", Storage Tech community term) takes **mixed shulker boxes**
and outputs **single-item-type boxes**, aiming for the fewest partially-filled boxes ("ideal output").
The design is built from repeatable **slices**; the main question is how speed scales with slice count
and what the "best" slice count is.

Goal of the next phase: **a Python script that theoretically simulates the cycvar's speed**
from the item sets and the machine's mechanics, including the fact that **speed is random run to run**.

## Glossary
- **Slice**: one repeatable module of the machine. Tested 2–8 slices.
- **Hopper speed / "xhs"**: 1 item per 8 game ticks = 2.5 items/s = **9,000 items/h**. Speeds are often
  quoted as multiples of this (e.g. 6.24x hopper).
- **gt**: game tick, 20 per second at normal TPS; 1 h of game time = 72,000 gt. Always measure in gt.
- **Test set**: a fixed collection of mixed boxes used as input (see table below).
- **Ideal output**: per item type, ceil(count / (stack_size × 27)) boxes.

## Test sets (items per set)
| Test (display name) | Raw name in Carlos's tooling | Items |
|---|---|---|
| Wavetech Project 1 | WaveTechProject1 / Wave1 | 43,650 |
| Wavetech Project 5 | Wave5 | 26,991 |
| Quarry | Quarry | 71,322 |
| SciCraftMooshroom | SciCraftMooshroom | 43,623 |
| Hermit 1 Set | Hermit1 | 59,118 |
| Hermit 2 Set | Hermit2 | 50,261 |
| EasyTest | EasyTest | 11,692 |

Hermit sets are likely from the public "Hermitcraft Item Set" (storagecatalog.org TG001 — real player
inventories, many item types). Composition (item types per box) of the other sets is **unknown** —
Carlos has them in-game / as schematics. Ask for them.

## How Carlos measures speed
He already has his own in-game timing script (don't build one). Its output looks like:
```
WaveTechProject1 finished
Speed: 52553 items/h (5.84x hopper)
Items: 43650
Game time: 59802 gt | 2990.10 s | 49.84 min | 0.8306 h
Real time: 302.18 s
```
Speed = items / game_time_h. Runs are done sped up (real time ≈ 5 min for a ~50 min game-time run).
Pasted outputs sometimes contain OCR/paste junk (e.g. a stray "54" prefix, "©" for "0") — clean it.

## Files
```
CLAUDE.md                         this briefing
data/runs.csv                     MASTER DATA: one row per measured run (test, slices, speed_items_per_h, note)
spreadsheet/Cycvar_Speed_Tests.xlsx      Carlos's dashboard (one value per test/slice; see note)
spreadsheet/build_spreadsheet.py         regenerates the xlsx from original/ + hardcoded 6-slice runs
spreadsheet/original/...xlsx             Carlos's original workbook (pre-redesign)
model/cycvar_model.py             statistical speed model (v1, see below)
model/results/                    report.txt, predictions.csv, model_charts.png from v1
model/cycvar_sim.py               v2 mechanistic Monte Carlo simulator (--demo = self-check)
web/server.py, web/index.html     local web UI for cycvar_sim.py: `npm start` → http://127.0.0.1:8765
data/sets/*.litematic             item sets (1.21); uploads from the web UI land here
.venv/                            uv venv (`npm run setup`); package.json scripts: start, test, sim, model
```
**runs.csv is the source of truth.** The spreadsheet holds a single value per test×slice (the first
measured run); repeat runs exist only in runs.csv. If you update the spreadsheet, keep that in mind
(an "average of runs" view would be a sensible future change — ask first).

### Data history (important)
- Carlos's original sheet labelled a group of rows "6 slices" that were really **5 slices**; the true
  6-slice gap was later filled. Fixed in the current data.
- The first 6-slice values came from rounded in-game signs; they were **replaced** by measured runs
  (Carlos's request). Current 6-slice rows in the sheet are measured.
- Repeat runs (same set & slices) so far: Wavetech Project 1 @6 ×3, EasyTest @6 ×3, Quarry @6 ×3, Quarry @8 ×4.

### Spreadsheet layout (single sheet "Dashboard", prints on 1 page)
Left: "Items per test" table, then "Raw data" table (Slice Count, Test Name, Speed, Hopper Multiplier
= Speed/9000 formula, Time). Right: matrices built with SUMIFS from raw data — Speed, % Gain vs 2
slices, % Gain vs previous slice count, Scaling efficiency vs perfect scaling (speed / (speed@2 × N/2)) —
and 4 charts (speed all tests, % gain all tests, gain-vs-previous bar chart, efficiency). Carlos's
colours/fonts: blue 3B5F90, green 3A6939, Montserrat headers, Roboto body.

## Model v1 (model/cycvar_model.py) — statistical, already done
- Per test: `time_per_item = s + p/N` → `speed = 1/(s + p/N)` (Amdahl-style). Fitted on log speed.
- Run-to-run noise: lognormal, σ estimated from repeat runs per set, shrunk toward a typical σ
  (dof-weighted mean of log-variances; raw pooling let the noisy Quarry dominate).
- Parametric bootstrap for parameter uncertainty; outputs expected speed, single-run 90% range,
  P(N beats N−1 in one run), runs needed to confirm a one-slice step (two-sample, α=.05, power=.8).
- `python cycvar_model.py ../data/runs.csv` · `--simulate Quarry 8 --runs 5` · `--max-slices 16`

Key findings so far:
- Speed ≈ grows with ~√slices; fits within ~1–2% for 5 of 7 sets.
- Run-to-run noise ≈ ±6% (1σ) typical, **Quarry ≈ ±12%** (6-slice runs ranged 75k–111k).
- ~35–39% of the work at 2 slices doesn't parallelise (common internal limit). Ceilings with infinite
  slices: ~9.5–11x hopper (Wavetech, SciCraft), ~22x Quarry, 4.8x/3.6x Hermit 1/2, 9.3x EasyTest.
- One-slice steps at 6+ slices (~5–8%) are below single-run noise: confirming them needs 20–40 runs each.
  Earlier "6 beats 7" anomalies are consistent with noise.
- Limitation: v1 describes results; it can't predict new item sets or design changes. That's v2.

## Next task: v2 mechanistic Monte Carlo simulator
Simulate the machine from item-set contents + mechanics, then calibrate timing constants to runs.csv.

Proposed structure (confirm mechanics with Carlos BEFORE coding the core):
1. **Load item sets** — from Litematica schematics (Python `litemapy`, read container block entities and
   shulker box contents; note 1.20.5+ uses data components, older versions NBT `BlockEntityTag`),
   or from a simple JSON/CSV export if easier. Need per box: list of (item_id, count, stack_size).
2. **Cycle model (assumed, unconfirmed)**: boxes processed in batches (the catalogued VIP011 cycvar uses
   ≤54-box batches and a 29-box buffer). Items stream past the slices; each free slice claims the first
   item type that reaches it; items with no matching slice go to a buffer and are re-cycled. Count item
   passes, cycles, output boxes, partial boxes.
3. **Randomness**: model it mechanistically where possible (e.g. droppers pick a random non-empty slot →
   randomised item order → different types claim slices → different cycle counts). Run many Monte Carlo
   trials per (set, N) and compare the *distribution* to measured repeats (Quarry's large spread is a
   good test).
4. **Time model**: `T = a·item_passes + b·cycles + c·output_boxes + d` (gt), constants fitted to runs.csv
   (49+ points, 4 params). Good fit across all sets ⇒ mechanics are right; misfits show what's missing.
5. **Outputs**: predicted speed distribution for any set × slice count (incl. >8), per-set explanation
   (types per batch, cycles, extra passes), design what-ifs (batch size, buffer, input rate, slice count),
   optional cost-per-slice optimisation.

## Open questions for Carlos (ask these first)
1. Does the cycle description above match his design? Specifically: how slices get their filter, what
   happens to unmatched items, batch size, buffer size.
2. Input rate into the slices (hopper speed? how many lanes?), how unstackables / 16-stackables are handled,
   per-slice throughput, any fixed per-cycle overhead (gt) he knows.
3. Known sources of randomness in the design.
4. Item sets as schematics (.litematic) or another export; Minecraft version.
5. Cost of one slice (materials/space/lag), if he wants a cost-optimal slice count.
6. Should more repeat runs be scripted/planned (the model can say how many are needed)?

## Working with Carlos
- Works in small, independently shippable milestones; minimal commentary — report when a milestone is done.
- Prefers reading the actual code/data before editing and verifying with tests/harnesses before shipping.
- Communicates in English (lives in Spain; original sheet was in Spanish, e.g. "Hoja 1").
