#!/usr/bin/env python3
"""
Cycvar speed model — stochastic, fitted to measured runs.

Model (per test set):
    time per item  =  s  +  p / N          (N = slices)
    speed          =  1 / (s + p/N)        (items/h)
    measured run   =  speed * exp(e),  e ~ Normal(0, sigma_set)

  s  = part of the work slices can't parallelise  -> ceiling = 1/s
  p  = part that is split across slices
  sigma_set = run-to-run randomness (log scale), estimated from repeated runs
              of the same set & slice count, shrunk toward the pooled value
              when a set has few or no repeats.

Uncertainty in s and p comes from a parametric bootstrap, so predictions
include both "the model might be a bit off" and "each run is random".

Usage:
    python cycvar_model.py runs.csv                       # full report + charts
    python cycvar_model.py runs.csv --max-slices 16
    python cycvar_model.py runs.csv --simulate Quarry 8 --runs 5
Add new runs to runs.csv (one row per run) and re-run.
"""
import argparse, csv, math, os, sys
from collections import defaultdict
import numpy as np
from scipy.optimize import least_squares
from scipy.stats import norm

HOPPER = 9000.0          # items/h of one hopper
PRIOR_STRENGTH = 2.0     # how many "pseudo degrees of freedom" the pooled noise gets
BOOT = 2000
rng = np.random.default_rng(42)


# ---------------------------------------------------------------- data
def load_runs(path):
    runs = defaultdict(list)                    # test -> [(N, speed)]
    with open(path, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            runs[row['test'].strip()].append((int(row['slices']), float(row['speed_items_per_h'])))
    return dict(runs)


# ---------------------------------------------------------------- fitting
def fit_curve(N, V):
    """Least squares on log speed; s,p > 0."""
    N, y = np.asarray(N, float), np.log(np.asarray(V, float))
    # linear start: 1/V = s + p/N
    A = np.vstack([np.ones_like(N), 1 / N]).T
    s0, p0 = np.linalg.lstsq(A, 1 / np.exp(y), rcond=None)[0]
    x0 = np.log([max(s0, 1e-9), max(p0, 1e-9)])
    res = least_squares(lambda x: -np.log(np.exp(x[0]) + np.exp(x[1]) / N) - y, x0)
    return np.exp(res.x)                        # s, p


def speed(s, p, N):
    return 1.0 / (s + p / np.asarray(N, float))


def within_noise(pairs):
    """Sum of squares and dof of log speeds within (N) groups that have repeats."""
    g = defaultdict(list)
    for N, V in pairs:
        g[N].append(math.log(V))
    ss = sum(((np.array(v) - np.mean(v)) ** 2).sum() for v in g.values() if len(v) > 1)
    dof = sum(len(v) - 1 for v in g.values() if len(v) > 1)
    return ss, dof


def build_models(runs):
    # typical run-to-run noise: sets differ a lot (Quarry is much noisier), so average the
    # per-set variances on a log scale (dof-weighted) instead of pooling raw sums of squares,
    # which would let the noisiest set dominate.
    logv, w = [], []
    tot_dof = 0
    for pairs in runs.values():
        ss, d = within_noise(pairs)
        if d > 0 and ss > 0:
            logv.append(math.log(ss / d)); w.append(d); tot_dof += d
    if not w:
        sys.exit('Need at least one repeated run (same test & slices) to estimate randomness.')
    sigma_pool = math.sqrt(math.exp(np.average(logv, weights=w)))

    models = {}
    for test, pairs in runs.items():
        N = np.array([p[0] for p in pairs], float); V = np.array([p[1] for p in pairs], float)
        s, p = fit_curve(N, V)
        ss, d = within_noise(pairs)
        sigma = math.sqrt((ss + PRIOR_STRENGTH * sigma_pool ** 2) / (d + PRIOR_STRENGTH))
        resid = np.log(V) - np.log(speed(s, p, N))
        # bootstrap: regenerate the same experiment with noise, refit
        boot = np.empty((BOOT, 2))
        mu = np.log(speed(s, p, N))
        for b in range(BOOT):
            boot[b] = fit_curve(N, np.exp(mu + rng.normal(0, sigma, len(N))))
        models[test] = dict(s=s, p=p, sigma=sigma, repeats_dof=d, N=N, V=V,
                            resid=resid, boot=boot)
    return models, sigma_pool, tot_dof


# ---------------------------------------------------------------- predictions
def predictive(m, N, draws=20000):
    """Samples of a single run's speed at N slices (model + run noise)."""
    idx = rng.integers(0, BOOT, draws)
    s, p = m['boot'][idx, 0], m['boot'][idx, 1]
    return speed(s, p, N) * np.exp(rng.normal(0, m['sigma'], draws))


def mean_curve_band(m, Ns):
    curves = np.array([speed(s, p, Ns) for s, p in m['boot']])
    return np.percentile(curves, [5, 50, 95], axis=0)


def runs_needed(gain, sigma, alpha=0.05, power=0.8):
    """Runs per configuration to tell a relative gain apart from noise (two-sample)."""
    if gain <= 0: return math.inf
    d = math.log(1 + gain)
    z = norm.ppf(1 - alpha / 2) + norm.ppf(power)
    return max(2, math.ceil(2 * (z * sigma / d) ** 2))


# ---------------------------------------------------------------- report
def fmt(v): return f'{v:,.0f}'


def report(models, sigma_pool, dof, max_n, outdir):
    os.makedirs(outdir, exist_ok=True)
    Ns = np.arange(2, max_n + 1)
    lines = []
    P = lines.append
    P(f'Typical run-to-run randomness: ±{sigma_pool*100:.1f}% (1 std; used for sets without repeats; '
      f'{dof} repeat degrees of freedom in total)\n')
    pred_rows = []
    for test, m in models.items():
        s, p, sig = m['s'], m['p'], m['sigma']
        ceil_b = 1 / m['boot'][:, 0]
        P(f'=== {test} ===')
        P(f'  randomness per run : ±{sig*100:.1f}%  (repeat dof for this set: {m["repeats_dof"]})')
        P(f'  ceiling (∞ slices) : {fmt(1/s)} items/h = {1/s/HOPPER:.1f}x hopper '
          f'(90% range {fmt(np.percentile(ceil_b,5))}–{fmt(np.percentile(ceil_b,95))})')
        P(f'  non-parallel share at 2 slices: {s/(s+p/2)*100:.0f}%')
        P(f'  slices for 90% of ceiling: {9*p/s:.0f}')
        worst = np.argsort(-np.abs(m['resid']))[:3]
        P('  most unusual runs  : ' + ', '.join(
            f'{int(m["N"][i])} slices {fmt(m["V"][i])} ({(math.exp(m["resid"][i])-1)*100:+.1f}% vs model, '
            f'{m["resid"][i]/sig:+.1f}σ)' for i in worst))
        P(f'  {"N":>3} {"expected":>9} {"x hop":>6} {"single run 90% range":>22} {"P(N beats N-1)":>15} '
          f'{"step gain":>9} {"runs to confirm":>15}')
        prev = None
        for N in Ns:
            smp = predictive(m, N)
            lo, med, hi = np.percentile(smp, [5, 50, 95])
            exp_mid = speed(s, p, N)
            if prev is not None:
                pbeat = (smp > prev[1]).mean()
                gain = exp_mid / prev[0] - 1
                need = runs_needed(gain, sig)
                extra = f'{pbeat*100:14.0f}% {gain*100:8.1f}% {need:>15}'
            else:
                extra = f'{"–":>15} {"–":>9} {"–":>15}'
                pbeat = gain = need = None
            P(f'  {N:>3} {fmt(exp_mid):>9} {exp_mid/HOPPER:6.2f} {fmt(lo):>10} – {fmt(hi):<9} {extra}')
            pred_rows.append([test, N, round(exp_mid), round(exp_mid / HOPPER, 2), round(lo), round(hi),
                              '' if pbeat is None else round(pbeat, 3),
                              '' if gain is None else round(gain, 4), '' if need is None else need])
            prev = (exp_mid, smp)
        P('')
    with open(os.path.join(outdir, 'predictions.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['test', 'slices', 'expected_speed', 'x_hopper', 'single_run_p5', 'single_run_p95',
                    'p_single_run_beats_previous', 'expected_step_gain', 'runs_needed_to_confirm_step'])
        w.writerows(pred_rows)
    txt = '\n'.join(lines)
    open(os.path.join(outdir, 'report.txt'), 'w', encoding='utf-8').write(txt)
    print(txt)
    plot(models, Ns, outdir)


def plot(models, Ns, outdir):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    k = len(models); cols = 4; rows = math.ceil(k / cols)
    fig, axes = plt.subplots(rows, cols, figsize=(4.2 * cols, 3.4 * rows), squeeze=False)
    for ax, (test, m) in zip(axes.flat, models.items()):
        lo, med, hi = mean_curve_band(m, Ns)
        run_lo = np.array([np.percentile(predictive(m, N, 8000), 5) for N in Ns])
        run_hi = np.array([np.percentile(predictive(m, N, 8000), 95) for N in Ns])
        ax.fill_between(Ns, run_lo / HOPPER, run_hi / HOPPER, color='#3B5F90', alpha=.15, lw=0,
                        label='single run, 90%')
        ax.fill_between(Ns, lo / HOPPER, hi / HOPPER, color='#3B5F90', alpha=.35, lw=0,
                        label='expected, 90%')
        ax.plot(Ns, speed(m['s'], m['p'], Ns) / HOPPER, color='#3B5F90', lw=2, label='model')
        ax.scatter(m['N'], m['V'] / HOPPER, s=18, color='#C0392B', zorder=3, label='measured runs')
        ax.axhline(1 / m['s'] / HOPPER, color='grey', ls=':', lw=1)
        ax.set_title(test, fontsize=10); ax.set_xlabel('slices'); ax.set_ylabel('x hopper')
        ax.grid(alpha=.3); ax.set_ylim(bottom=0)
    for ax in list(axes.flat)[k:]: ax.axis('off')
    axes.flat[0].legend(fontsize=7, loc='lower right')
    fig.suptitle('Cycvar speed model — dotted line = ceiling with unlimited slices', fontsize=11)
    fig.tight_layout()
    fig.savefig(os.path.join(outdir, 'model_charts.png'), dpi=130)


def simulate(models, test, N, n_runs):
    m = models.get(test) or sys.exit(f'Unknown test {test!r}. Known: {", ".join(models)}')
    smp = predictive(m, N, n_runs)
    print(f'{n_runs} simulated runs of {test} with {N} slices:')
    for i, v in enumerate(smp, 1):
        print(f'  run {i}: {fmt(v)} items/h ({v/HOPPER:.2f}x hopper)')
    print(f'  average {fmt(smp.mean())}, spread {fmt(smp.min())}–{fmt(smp.max())}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('runs_csv')
    ap.add_argument('--max-slices', type=int, default=16)
    ap.add_argument('--out', default='results')
    ap.add_argument('--simulate', nargs=2, metavar=('TEST', 'SLICES'))
    ap.add_argument('--runs', type=int, default=5)
    a = ap.parse_args()
    models, sigma_pool, dof = build_models(load_runs(a.runs_csv))
    if a.simulate:
        simulate(models, a.simulate[0], int(a.simulate[1]), a.runs)
    else:
        report(models, sigma_pool, dof, a.max_slices, a.out)
