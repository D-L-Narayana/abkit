"""Monte-Carlo checks that the statistics behave as advertised.

Run ``python -m abkit.simulate [--quick] [--scale F] [--out PATH]`` (or ``abkit simulate …``) — writes
``reports/simulation.json`` (``reports/simulation-quick.json`` with ``--quick``).
Each study answers a question an experimentation team actually argues about:

1. A/A tests: does the z-test really reject 5 % of the time when nothing changed?
2. Power: does sample_size_proportion() deliver the promised 80 % power at the MDE?
3. Peeking: how badly does "check every day, stop when p < 0.05" inflate false positives?
4. CUPED: how much variance does a pre-period covariate remove, and does it keep the lift unbiased?
5. SRM: how reliably does the chi-square check catch a 1 % bucketing skew at scale?
6. Interleaving vs A/B: how many sessions does each need to pick the better ranker 95 % of the time?
7. mSPRT peeking: does the always-valid p-value keep the false-positive rate under alpha when you look 10 times,
   and how much power does legal peeking cost at the planned sample size?
8. Relative-lift CI: does the delta-method interval cover the true relative lift 95 % of the time, and how badly does
   the naive "absolute CI divided by the control rate" interval under-cover for large lifts?

Studies 1–6 consume ``default_rng(seed)`` exactly as in version 1.0 so their numbers are reproducible; studies 7–8 draw
from ``default_rng(seed + 1)`` and are appended after them.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
from collections.abc import Sequence
from typing import Any

import numpy as np
from scipy import stats

from .ranking import interleaving_outcome, team_draft_interleave
from .sequential import msprt_proportions, tau_from_mde
from .stats import cuped, sample_size_proportion, srm_check, two_proportion_ztest

SEED = 2026


def aa_false_positive_rate(rng: np.random.Generator, sims: int = 20_000, n: int = 20_000, p: float = 0.1, alpha: float = 0.05) -> float:
    conv_a = rng.binomial(n, p, sims)
    conv_b = rng.binomial(n, p, sims)
    rejects = sum(two_proportion_ztest(int(a), n, int(b), n, alpha).significant for a, b in zip(conv_a, conv_b, strict=True))
    return rejects / sims


def power_at_mde(rng: np.random.Generator, baseline: float = 0.1, mde_rel: float = 0.1, sims: int = 20_000, alpha: float = 0.05) -> dict[str, Any]:
    n = sample_size_proportion(baseline, mde_rel, alpha, 0.8)
    conv_a = rng.binomial(n, baseline, sims)
    conv_b = rng.binomial(n, baseline * (1 + mde_rel), sims)
    power = sum(two_proportion_ztest(int(a), n, int(b), n, alpha).significant for a, b in zip(conv_a, conv_b, strict=True)) / sims
    return {"n_per_arm": n, "empirical_power": power, "target_power": 0.8}


def peeking_inflation(rng: np.random.Generator, sims: int = 4_000, n: int = 20_000, p: float = 0.1, looks: int = 10, alpha: float = 0.05) -> dict[str, Any]:
    """A/A tests analysed after each of `looks` equal chunks; stop at the first p < alpha."""
    false_positive = 0
    for _ in range(sims):
        a = rng.random(n) < p
        b = rng.random(n) < p
        for k in range(1, looks + 1):
            m = n * k // looks
            if two_proportion_ztest(int(a[:m].sum()), m, int(b[:m].sum()), m, alpha).significant:
                false_positive += 1
                break
    # Bonferroni-style fix: alpha / looks per look
    fixed = 0
    for _ in range(sims):
        a = rng.random(n) < p
        b = rng.random(n) < p
        for k in range(1, looks + 1):
            m = n * k // looks
            if two_proportion_ztest(int(a[:m].sum()), m, int(b[:m].sum()), m, alpha / looks).significant:
                fixed += 1
                break
    return {"looks": looks, "fpr_peeking": false_positive / sims, "fpr_bonferroni_per_look": fixed / sims, "nominal_alpha": alpha}


def cuped_study(rng: np.random.Generator, sims: int = 2_000, n: int = 5_000, rho: float = 0.6, lift: float = 0.05) -> dict[str, Any]:
    """Continuous metric (e.g. revenue per user) with a pre-period covariate correlated at rho."""
    reductions, raw_sig, cuped_sig, bias = [], 0, 0, []
    for _ in range(sims):
        cov = [[1, rho], [rho, 1]]
        pre_a, y_a = rng.multivariate_normal([0, 0], cov, n).T
        pre_b, y_b = rng.multivariate_normal([0, 0], cov, n).T
        y_b = y_b + lift
        res = cuped(y_a, pre_a, y_b, pre_b)
        reductions.append(res.variance_reduction)
        bias.append((res.adjusted_b.mean() - res.adjusted_a.mean()) - lift)
        raw_sig += stats.ttest_ind(y_b, y_a, equal_var=False).pvalue < 0.05
        cuped_sig += stats.ttest_ind(res.adjusted_b, res.adjusted_a, equal_var=False).pvalue < 0.05
    return {
        "rho_pre_period": rho,
        "mean_variance_reduction": float(np.mean(reductions)),
        "theory_variance_reduction": rho**2,
        "power_raw": raw_sig / sims,
        "power_cuped": cuped_sig / sims,
        "mean_bias_of_lift": float(np.mean(bias)),
    }


def srm_study(rng: np.random.Generator, sims: int = 5_000, n: int = 200_000, skew: float = 0.01) -> dict[str, Any]:
    ok, caught = 0, 0
    for _ in range(sims):
        arm_a = rng.binomial(n, 0.5)
        ok += srm_check([arm_a, n - arm_a]).mismatch  # false alarms under a fair split
        arm_a = rng.binomial(n, 0.5 - skew)  # 49 / 51 bucketing bug
        caught += srm_check([arm_a, n - arm_a]).mismatch
    return {"users": n, "skew": skew, "false_alarm_rate": ok / sims, "detection_rate": caught / sims, "alpha": 0.001}


def interleaving_vs_ab(rng: np.random.Generator, sims: int = 200, max_sessions: int = 3_000, check_every: int = 25) -> dict[str, Any]:
    """Two rankers over 20 items with slightly different quality; how fast does each method find the better one?"""
    items = np.arange(20)

    def session_pair() -> tuple[np.ndarray, list[int], list[int]]:
        # ranker B is a slightly better estimate of the hidden relevance than ranker A
        rel = rng.random(20)
        rank_a = list(items[np.argsort(-(rel + rng.normal(0, 0.55, 20)))])
        rank_b = list(items[np.argsort(-(rel + rng.normal(0, 0.45, 20)))])
        return rel, rank_a, rank_b

    def user_clicks(rank: Sequence[Any], rel: np.ndarray) -> list[int]:
        clicks = []
        for pos, item in enumerate(rank[:10]):
            if rng.random() < rel[item] * 0.6 / np.sqrt(pos + 1):
                clicks.append(pos)
        return clicks

    def sessions_needed(kind: str) -> int:
        wins_b = wins_a = 0
        clicks_a: list[int] = []
        clicks_b: list[int] = []
        for s in range(1, max_sessions + 1):
            rel, ra, rb = session_pair()
            if kind == "interleaving":
                merged, teams = team_draft_interleave(ra, rb, rng)
                outcome = interleaving_outcome(user_clicks(merged, rel), teams)
                wins_a += outcome == "A"
                wins_b += outcome == "B"
                decided = wins_a + wins_b
                if s % check_every == 0 and decided >= 30 and stats.binomtest(wins_b, decided, 0.5).pvalue < 0.05:
                    return s
            else:  # A/B: alternate sessions between rankers, compare click-through
                (clicks_a if s % 2 else clicks_b).append(len(user_clicks(ra if s % 2 else rb, rel)))
                if s % check_every == 0 and len(clicks_a) >= 30 and len(clicks_b) >= 30 and stats.ttest_ind(clicks_b, clicks_a, equal_var=False).pvalue < 0.05:
                    return s
        return max_sessions

    il = [sessions_needed("interleaving") for _ in range(sims)]
    ab = [sessions_needed("ab") for _ in range(sims)]
    return {
        "sims": sims,
        "median_sessions_interleaving": float(np.median(il)),
        "median_sessions_ab": float(np.median(ab)),
        "p95_sessions_interleaving": float(np.percentile(il, 95)),
        "p95_sessions_ab": float(np.percentile(ab, 95)),
        "capped_at": max_sessions,
    }


def _cumulative_looks(rng: np.random.Generator, n: int, p: float, sims: int, looks: int) -> tuple[np.ndarray, list[int]]:
    """Cumulative conversion counts after each of ``looks`` equal chunks of an arm with ``n`` users (sims × looks) and the cumulative sizes."""
    sizes = [n * k // looks for k in range(1, looks + 1)]
    increments = np.diff(np.asarray(sizes), prepend=0)
    cumulative = rng.binomial(increments, p, size=(sims, looks)).cumsum(axis=1)
    return cumulative, sizes


def msprt_peeking(rng: np.random.Generator, sims: int = 10_000, n: int = 20_000, p: float = 0.1, looks: int = 10, alpha: float = 0.05, mde_rel: float = 0.1) -> dict[str, Any]:
    """Study 7 — legal peeking with the mSPRT always-valid p-value (``abkit.sequential``).

    Same design as the ``peeking`` study: A/A data at rate ``p``, ``n`` users per arm, analysed after each of ``looks``
    equal chunks, stopping at the first look whose always-valid p is below ``alpha`` (``decided_at``). The mixing scale is
    τ = tau_from_mde(p · mde_rel), the planned effect. Under H0 the false-positive rate must stay ≤ alpha however often you
    look. The power block runs the same procedure at the fixed-horizon sample size for 80 % power at the MDE and reports
    how often the mSPRT decides (and at which look, as a fraction of the sample) next to the fixed-horizon z-test at the
    last look — the honest price of peeking legally.
    """
    tau = tau_from_mde(p * mde_rel)
    cum_a, sizes = _cumulative_looks(rng, n, p, sims, looks)
    cum_b, _ = _cumulative_looks(rng, n, p, sims, looks)
    false_positive = 0
    for i in range(sims):
        false_positive += msprt_proportions(cum_a[i].tolist(), sizes, cum_b[i].tolist(), sizes, tau=tau, alpha=alpha).decided_at is not None

    n_planned = sample_size_proportion(p, mde_rel, alpha, 0.8)
    cum_a, sizes = _cumulative_looks(rng, n_planned, p, sims, looks)
    cum_b, _ = _cumulative_looks(rng, n_planned, p * (1 + mde_rel), sims, looks)
    decided_looks: list[int] = []
    fixed_horizon = 0
    for i in range(sims):
        decided = msprt_proportions(cum_a[i].tolist(), sizes, cum_b[i].tolist(), sizes, tau=tau, alpha=alpha).decided_at
        if decided is not None:
            decided_looks.append(decided)
        fixed_horizon += two_proportion_ztest(int(cum_a[i, -1]), n_planned, int(cum_b[i, -1]), n_planned, alpha).significant
    return {
        "looks": looks,
        "alpha": alpha,
        "sims": sims,
        "n_per_arm_aa": n,
        "tau": tau,
        "fpr_always_valid": false_positive / sims,
        "power_at_mde": {
            "baseline": p,
            "mde_rel": mde_rel,
            "n_per_arm": n_planned,
            "power_msprt": len(decided_looks) / sims,
            "power_fixed_horizon": fixed_horizon / sims,
            "median_decision_look": float(np.median(decided_looks)) if decided_looks else None,
            "mean_fraction_of_sample_at_decision": float(np.mean([sizes[k - 1] / n_planned for k in decided_looks])) if decided_looks else None,
            "target_power": 0.8,
        },
    }


def relative_ci_coverage(
    rng: np.random.Generator,
    sims: int = 10_000,
    alpha: float = 0.05,
    scenarios: Sequence[tuple[float, float, int]] = ((0.10, 0.10, 14_751), (0.05, 0.50, 4_000), (0.20, -0.10, 5_000)),
) -> dict[str, Any]:
    """Study 8 — coverage of the relative-lift confidence interval (``abkit.stats.relative_lift_proportions``).

    For each scenario (baseline, true relative lift, users per arm) the delta-method interval is compared with the naive
    one that divides the absolute-difference CI by the observed control rate (what dashboards usually show): the naive
    interval ignores the control rate's own sampling error, so for a positive lift it is too narrow and under-covers.
    Reports the fraction of simulations whose interval contains the true lift and the mean interval width.
    """
    from .stats import relative_lift_proportions

    rows: list[dict[str, Any]] = []
    for baseline, lift_rel, n in scenarios:
        conv_a = rng.binomial(n, baseline, sims)
        conv_b = rng.binomial(n, baseline * (1 + lift_rel), sims)
        covered_delta = covered_naive = 0
        width_delta = width_naive = 0.0
        for ca, cb in zip(conv_a, conv_b, strict=True):
            rel = relative_lift_proportions(int(ca), n, int(cb), n, alpha)
            covered_delta += rel.ci_low <= lift_rel <= rel.ci_high
            width_delta += rel.ci_high - rel.ci_low
            z = two_proportion_ztest(int(ca), n, int(cb), n, alpha)
            naive_low, naive_high = z.ci_low / z.rate_a, z.ci_high / z.rate_a
            covered_naive += naive_low <= lift_rel <= naive_high
            width_naive += naive_high - naive_low
        rows.append(
            {
                "baseline": baseline,
                "lift_rel": lift_rel,
                "n_per_arm": n,
                "coverage_delta": covered_delta / sims,
                "coverage_naive": covered_naive / sims,
                "mean_width_delta": width_delta / sims,
                "mean_width_naive": width_naive / sims,
            }
        )
    return {"alpha": alpha, "nominal_coverage": 1 - alpha, "sims": sims, "scenarios": rows}


def run_all(seed: int = SEED, quick: bool = False, scale: float | None = None) -> dict[str, Any]:
    """Run every study and return the report dict.

    ``scale`` multiplies the simulation counts of every study (1.0 = the published full run, ``--quick`` = 0.1); an
    explicit ``scale`` overrides ``quick``. Studies 1–6 share ``default_rng(seed)`` in the original order so a given
    (seed, scale) reproduces the historical numbers; studies 7–8 draw from ``default_rng(seed + 1)`` (7 before 8) and
    are appended after them.
    """
    if scale is None:
        scale = 0.1 if quick else 1.0
    if not scale > 0:
        raise ValueError("scale must be > 0")
    rng = np.random.default_rng(seed)
    t0 = time.time()
    report: dict[str, Any] = {
        "seed": seed,
        "scale": scale,
        "aa_false_positive_rate": {"alpha": 0.05, "fpr": aa_false_positive_rate(rng, sims=int(20_000 * scale))},
        "power_at_mde": power_at_mde(rng, sims=int(20_000 * scale)),
        "peeking": peeking_inflation(rng, sims=int(4_000 * scale)),
        "cuped": cuped_study(rng, sims=int(2_000 * scale)),
        "srm": srm_study(rng, sims=int(5_000 * scale)),
        "interleaving_vs_ab": interleaving_vs_ab(rng, sims=max(20, int(200 * scale))),
    }
    rng_new = np.random.default_rng(seed + 1)
    report["msprt_peeking"] = msprt_peeking(rng_new, sims=max(100, int(10_000 * scale)))
    report["relative_ci_coverage"] = relative_ci_coverage(rng_new, sims=max(100, int(10_000 * scale)))
    report["elapsed_sec"] = round(time.time() - t0, 1)
    return report


def default_output_path(quick: bool) -> pathlib.Path:
    """``reports/simulation.json`` next to the package (``simulation-quick.json`` for quick runs)."""
    return pathlib.Path(__file__).resolve().parents[1] / "reports" / ("simulation-quick.json" if quick else "simulation.json")


def write_report(report: dict[str, Any], out: pathlib.Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="abkit simulate", description="Run the Monte-Carlo validation studies and write a JSON report.")
    p.add_argument("--quick", action="store_true", help="10 %% of the simulation counts (writes reports/simulation-quick.json)")
    p.add_argument("--scale", type=float, default=None, help="multiply every study's simulation count by this factor (overrides --quick)")
    p.add_argument("--out", type=pathlib.Path, default=None, help="output path (default: reports/simulation.json or simulation-quick.json)")
    p.add_argument("--seed", type=int, default=SEED, help=f"random seed (default {SEED})")
    return p


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point for ``python -m abkit.simulate``; prints the report as JSON and writes it to ``--out``."""
    args = build_parser().parse_args(argv)
    out = args.out if args.out is not None else default_output_path(args.quick)
    try:
        report = run_all(seed=args.seed, quick=args.quick, scale=args.scale)
        write_report(report, out)
    except (ValueError, OSError) as exc:
        print(f"abkit simulate: error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2))
    print(f"written {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
