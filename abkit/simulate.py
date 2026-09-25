"""Monte-Carlo checks that the statistics behave as advertised.

Run `python -m abkit.simulate` (or `abkit simulate`) — writes reports/simulation.json.
Each study answers a question an experimentation team actually argues about:

1. A/A tests: does the z-test really reject 5 % of the time when nothing changed?
2. Power: does sample_size_proportion() deliver the promised 80 % power at the MDE?
3. Peeking: how badly does "check every day, stop when p < 0.05" inflate false positives?
4. CUPED: how much variance does a pre-period covariate remove, and does it keep the lift unbiased?
5. SRM: how reliably does the chi-square check catch a 1 % bucketing skew at scale?
6. Interleaving vs A/B: how many sessions does each need to pick the better ranker 95 % of the time?
"""
from __future__ import annotations

import json
import pathlib
import time

import numpy as np
from scipy import stats

from .ranking import interleaving_outcome, team_draft_interleave
from .stats import cuped, sample_size_proportion, srm_check, two_proportion_ztest

SEED = 2026


def aa_false_positive_rate(rng: np.random.Generator, sims: int = 20_000, n: int = 20_000, p: float = 0.1, alpha: float = 0.05) -> float:
    conv_a = rng.binomial(n, p, sims)
    conv_b = rng.binomial(n, p, sims)
    rejects = sum(two_proportion_ztest(int(a), n, int(b), n, alpha).significant for a, b in zip(conv_a, conv_b))
    return rejects / sims


def power_at_mde(rng: np.random.Generator, baseline: float = 0.1, mde_rel: float = 0.1, sims: int = 20_000, alpha: float = 0.05) -> dict:
    n = sample_size_proportion(baseline, mde_rel, alpha, 0.8)
    conv_a = rng.binomial(n, baseline, sims)
    conv_b = rng.binomial(n, baseline * (1 + mde_rel), sims)
    power = sum(two_proportion_ztest(int(a), n, int(b), n, alpha).significant for a, b in zip(conv_a, conv_b)) / sims
    return {"n_per_arm": n, "empirical_power": power, "target_power": 0.8}


def peeking_inflation(rng: np.random.Generator, sims: int = 4_000, n: int = 20_000, p: float = 0.1, looks: int = 10, alpha: float = 0.05) -> dict:
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


def cuped_study(rng: np.random.Generator, sims: int = 2_000, n: int = 5_000, rho: float = 0.6, lift: float = 0.05) -> dict:
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


def srm_study(rng: np.random.Generator, sims: int = 5_000, n: int = 200_000, skew: float = 0.01) -> dict:
    ok, caught = 0, 0
    for _ in range(sims):
        arm_a = rng.binomial(n, 0.5)
        ok += srm_check([arm_a, n - arm_a]).mismatch  # false alarms under a fair split
        arm_a = rng.binomial(n, 0.5 - skew)  # 49 / 51 bucketing bug
        caught += srm_check([arm_a, n - arm_a]).mismatch
    return {"users": n, "skew": skew, "false_alarm_rate": ok / sims, "detection_rate": caught / sims, "alpha": 0.001}


def interleaving_vs_ab(rng: np.random.Generator, sims: int = 200, max_sessions: int = 3_000, check_every: int = 25) -> dict:
    """Two rankers over 20 items with slightly different quality; how fast does each method find the better one?"""
    items = np.arange(20)

    def session_pair():
        # ranker B is a slightly better estimate of the hidden relevance than ranker A
        rel = rng.random(20)
        rank_a = list(items[np.argsort(-(rel + rng.normal(0, 0.55, 20)))])
        rank_b = list(items[np.argsort(-(rel + rng.normal(0, 0.45, 20)))])
        return rel, rank_a, rank_b

    def user_clicks(rank, rel):
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


def run_all(seed: int = SEED, quick: bool = False) -> dict:
    rng = np.random.default_rng(seed)
    scale = 0.1 if quick else 1.0
    t0 = time.time()
    report = {
        "seed": seed,
        "aa_false_positive_rate": {"alpha": 0.05, "fpr": aa_false_positive_rate(rng, sims=int(20_000 * scale))},
        "power_at_mde": power_at_mde(rng, sims=int(20_000 * scale)),
        "peeking": peeking_inflation(rng, sims=int(4_000 * scale)),
        "cuped": cuped_study(rng, sims=int(2_000 * scale)),
        "srm": srm_study(rng, sims=int(5_000 * scale)),
        "interleaving_vs_ab": interleaving_vs_ab(rng, sims=max(20, int(200 * scale))),
    }
    report["elapsed_sec"] = round(time.time() - t0, 1)
    return report


def main() -> None:
    import sys

    quick = "--quick" in sys.argv
    report = run_all(quick=quick)
    out = pathlib.Path(__file__).resolve().parents[1] / "reports" / ("simulation-quick.json" if quick else "simulation.json")
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"\nwritten {out}")


if __name__ == "__main__":
    main()
