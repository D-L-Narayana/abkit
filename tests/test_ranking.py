"""Tests for the interleaving part of ``abkit.ranking``: exact binomial test, Wilson preference interval, mean NDCG,
shared-pool rankings and the session simulator.

``python3 tests/test_ranking.py`` regenerates ``tests/fixtures/ranking.json`` — the SciPy-backed parity fixture that
``webapp/src/lib/interleaving.test.ts`` checks the TypeScript twin against (relative tolerance 1e-12).
"""
from __future__ import annotations

import json
import math
import sys
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from scipy import stats

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:  # lets `python3 tests/test_ranking.py` import the package without installing it
    sys.path.insert(0, str(ROOT))

from abkit.ranking import (  # noqa: E402
    InterleavingResult,
    build_rankings,
    interleaving_test,
    mean_ndcg_at_k,
    mrr,
    ndcg_at_k,
    precision_at_k,
    simulate_interleaving_sessions,
    wilson_interval,
)

FIXTURE = ROOT / "tests" / "fixtures" / "ranking.json"
REL = 1e-12

# What the web app used to report for 100 vs 120 wins: a two-proportion z-test on the complementary shares 100/220 and
# 120/220 of ONE sample. Its statistic is inflated by sqrt(2), so it claimed p ~ 0.057 where the exact test gives ~ 0.200.
WRONG_ZTEST_P_100_120 = 0.05653027716740425
DEFAULT_A = [3, 2, 3, 0, 1, 2, 0, 0, 1, 0]
DEFAULT_B = [3, 3, 2, 2, 1, 0, 1, 0, 0, 0]
LONG_A = [1, 2, 3, 3, 2, 1, 0, 0, 0, 0, 1, 2, 3, 0, 0, 1, 2, 3, 0, 1]  # 20 positions (the web app's maximum)
LONG_B = [3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]


def exact_two_sided_p(k: int, n: int) -> float:
    """Two-sided binomial p-value at p0 = 1/2 in exact rational arithmetic, rounded once at the end."""
    if n == 0:
        return 1.0
    m = min(k, n - k)
    if 2 * m == n:
        return 1.0
    lower = sum(math.comb(n, i) for i in range(m + 1))
    return float(min(Fraction(1), Fraction(2 * lower, 2**n)))


def complementary_ztest_p(wins_a: int, wins_b: int) -> float:
    """The incorrect formula (two-proportion z-test on the two shares of one sample), kept only as a reference."""
    decided = wins_a + wins_b
    pa, pb = wins_a / decided, wins_b / decided
    se = math.sqrt(0.5 * 0.5 * (2 / decided))
    return float(2 * stats.norm.sf(abs((pb - pa) / se)))


# ----------------------------------------------------------------------------------------------------------------------
# interleaving_test
# ----------------------------------------------------------------------------------------------------------------------


def test_interleaving_test_is_exact_binomial_not_complementary_ztest() -> None:
    r = interleaving_test(100, 120)
    ref = stats.binomtest(120, 220, 0.5).pvalue
    assert r.p_value == pytest.approx(ref, rel=REL)
    assert r.p_value == pytest.approx(0.2000922290282712, rel=REL)
    assert r.p_value > 0.1
    assert complementary_ztest_p(100, 120) == pytest.approx(WRONG_ZTEST_P_100_120, rel=1e-9)
    assert r.p_value != pytest.approx(WRONG_ZTEST_P_100_120, rel=1e-2)
    assert (r.wins_a, r.wins_b, r.ties, r.alpha) == (100, 120, 0, 0.05)
    assert r.decided == 220


def test_preference_and_wilson_interval() -> None:
    r = interleaving_test(100, 120, ties=30)
    assert r.preference == pytest.approx(20 / 220, rel=REL)
    lo, hi = wilson_interval(120, 220)
    assert (lo, hi) == pytest.approx((0.4794400540419267, 0.6099088990312428), rel=REL)
    assert r.ci_low == pytest.approx(2 * lo - 1, rel=REL)
    assert r.ci_high == pytest.approx(2 * hi - 1, rel=REL)
    assert -1 <= r.ci_low < r.preference < r.ci_high <= 1
    assert r.winner == "tie" and r.ties == 30
    # Wilson basics: stays inside [0, 1], no information for n = 0, wider for a smaller alpha
    assert wilson_interval(0, 10)[0] == pytest.approx(0.0, abs=1e-12)
    assert wilson_interval(10, 10)[1] == pytest.approx(1.0, abs=1e-12)
    assert wilson_interval(0, 0) == (0.0, 1.0)
    narrow, wide = wilson_interval(500, 1000, alpha=0.05), wilson_interval(500, 1000, alpha=0.01)
    assert wide[0] < narrow[0] < 0.5 < narrow[1] < wide[1]


def test_winner_rule_and_edge_cases() -> None:
    assert interleaving_test(100, 150).winner == "B"
    assert interleaving_test(150, 100).winner == "A"
    assert interleaving_test(100, 150).p_value < 0.05
    assert interleaving_test(100, 120, alpha=0.25).winner == "B"  # p = 0.200 < 0.25
    none = interleaving_test(0, 0, ties=5)
    assert (none.p_value, none.preference, none.ci_low, none.ci_high, none.winner, none.ties) == (1.0, 0.0, -1.0, 1.0, "tie", 5)
    assert interleaving_test(5, 5).p_value == 1.0
    assert interleaving_test(0, 1).p_value == 1.0
    assert interleaving_test(0, 12).p_value == pytest.approx(0.00048828125, rel=REL)
    assert interleaving_test(0, 12).preference == 1.0 and interleaving_test(12, 0).preference == -1.0
    d = interleaving_test(100, 120).as_dict()
    assert set(d) == {"wins_a", "wins_b", "ties", "p_value", "preference", "ci_low", "ci_high", "winner", "alpha"}
    assert isinstance(interleaving_test(1, 2), InterleavingResult)
    assert interleaving_test(np.int64(100), np.int64(120)).p_value == pytest.approx(0.2000922290282712, rel=REL)


def test_validation() -> None:
    with pytest.raises(ValueError):
        interleaving_test(-1, 3)
    with pytest.raises(ValueError):
        interleaving_test(1.5, 3)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        interleaving_test(1, 3, ties=-1)
    with pytest.raises(ValueError):
        interleaving_test(1, 3, alpha=0.0)
    with pytest.raises(ValueError):
        interleaving_test(1, 3, alpha=1.0)
    with pytest.raises(ValueError):
        wilson_interval(5, 3)
    with pytest.raises(ValueError):
        mean_ndcg_at_k([[1, 0]], 0)
    rng = np.random.default_rng(0)
    with pytest.raises(ValueError):
        simulate_interleaving_sessions([3, 4], [1, 0], 10, rng)  # grade 4 is out of range
    with pytest.raises(ValueError):
        simulate_interleaving_sessions([3, 1], [1, 0], -1, rng)
    with pytest.raises(ValueError):
        simulate_interleaving_sessions([3, 1], [1, 0], 10, rng, click_scale=1.5)


def test_exact_binomial_matches_rational_arithmetic() -> None:
    for n in range(1, 41):
        for k in range(n + 1):
            assert interleaving_test(n - k, k).p_value == pytest.approx(exact_two_sided_p(k, n), rel=REL), (k, n)
    for k, n, ref in [(60, 100, 0.05688793364098089), (7, 10, 0.34375), (250, 400, 6.531819212838477e-07)]:
        p = interleaving_test(n - k, k).p_value
        assert p == pytest.approx(ref, rel=REL)
        assert p == pytest.approx(exact_two_sided_p(k, n), rel=REL)


# ----------------------------------------------------------------------------------------------------------------------
# offline metrics, rankings and the simulator
# ----------------------------------------------------------------------------------------------------------------------


def test_mean_ndcg_at_k() -> None:
    qs = [[3, 2, 3, 0, 1], [0, 0, 3], [0, 0, 0]]
    assert mean_ndcg_at_k(qs, 3) == pytest.approx(sum(ndcg_at_k(q, 3) for q in qs) / 3)
    assert mean_ndcg_at_k([[3, 2, 1]], 3) == pytest.approx(1.0)
    assert mean_ndcg_at_k([], 3) == 0.0
    assert mean_ndcg_at_k(qs, 1) == pytest.approx(1 / 3)
    assert mean_ndcg_at_k([[3, 2, 3, 0, 1], [3, 0, 0], [0, 0, 0]], 1) == pytest.approx(2 / 3)


def test_build_rankings_shared_pool() -> None:
    grades, oa, ob = build_rankings(DEFAULT_A, DEFAULT_B)
    assert grades == sorted(DEFAULT_A, reverse=True) == sorted(DEFAULT_B, reverse=True)
    assert sorted(oa) == list(range(10)) and sorted(ob) == list(range(10))
    assert [grades[i] for i in oa] == DEFAULT_A  # both grade-by-position sequences are realised exactly ...
    assert [grades[i] for i in ob] == DEFAULT_B  # ... because the inputs are permutations of each other
    # not permutations of each other: the pool takes the better grade at each rank, positions get the nearest grade
    assert build_rankings([3, 3, 0], [0, 0, 3]) == ([3, 3, 0], [0, 1, 2], [2, 0, 1])
    # the shorter input is padded with grade 0
    assert build_rankings([3, 2], [1]) == ([3, 2], [0, 1], [1, 0])
    assert build_rankings([], []) == ([], [], [])


def test_simulate_interleaving_sessions_is_deterministic_and_sensible() -> None:
    first = simulate_interleaving_sessions(DEFAULT_A, DEFAULT_B, 400, np.random.default_rng(1))
    assert first == simulate_interleaving_sessions(DEFAULT_A, DEFAULT_B, 400, np.random.default_rng(1))
    assert sum(first) == 400 and min(first) >= 0
    assert simulate_interleaving_sessions(DEFAULT_A, DEFAULT_B, 0, np.random.default_rng(1)) == (0, 0, 0)
    # identical rankers: no preference should be found
    wa, wb, _ = simulate_interleaving_sessions(DEFAULT_A, DEFAULT_A, 2000, np.random.default_rng(1))
    assert interleaving_test(wa, wb).p_value > 0.01
    # B shows every relevant document first and A shows them last: only B's documents can be clicked
    wa, wb, ties = simulate_interleaving_sessions([0, 0, 0, 0, 3, 3, 3, 3], [3, 3, 3, 3, 0, 0, 0, 0], 400, np.random.default_rng(1))
    assert wa == 0 and wb > 300 and wa + wb + ties == 400
    assert interleaving_test(wa, wb, ties).winner == "B"
    # nobody clicks when click_scale is 0, so every session is a tie
    assert simulate_interleaving_sessions(DEFAULT_A, DEFAULT_B, 50, np.random.default_rng(1), click_scale=0.0) == (0, 0, 50)


# ----------------------------------------------------------------------------------------------------------------------
# parity fixture for the TypeScript twin
# ----------------------------------------------------------------------------------------------------------------------


def _binomial_table() -> dict[str, float]:
    """Two-sided p-values keyed "k/n". Skips results in the subnormal range (reduced precision) and keeps exact zeros
    only when every IEEE-754 implementation underflows by a wide margin."""
    table: dict[str, float] = {}

    def add(k: int, n: int) -> None:
        if n == 0:
            table["0/0"] = 1.0
            return
        p = float(stats.binomtest(k, n, 0.5).pvalue)
        if p == 0.0:
            m = min(k, n - k)
            log_pmf_top = math.lgamma(n + 1) - math.lgamma(m + 1) - math.lgamma(n - m + 1) - n * math.log(2)
            if math.log(2) + math.log(m + 1) + log_pmf_top > -760:  # upper bound on log p
                return
        elif p < 1e-290:
            return
        table[f"{k}/{n}"] = p

    for n in range(21):
        for k in range(n + 1):
            add(k, n)
    for n in (25, 30, 37, 50, 64, 100, 150, 220, 300, 400, 500, 750, 1000, 1500, 1999, 2000):
        ks = {0, 1, n // 10, n // 4, n // 3, (3 * n) // 8, n // 2 - 3, n // 2 - 1, n // 2, n // 2 + 2, n - 1, n}
        ks |= {120 if n == 220 else n // 2 + 10, 250 if n == 400 else n // 2 + 7}
        for k in sorted(ks):
            add(k, n)
    return table


def build_fixture() -> dict[str, Any]:
    ppf_points = [1e-12, 1e-6, 0.001, 0.005, 0.025, 0.05, 0.1, 0.2, 0.5, 0.875, 0.95, 0.975, 0.995, 0.9995, 1 - 1e-9]
    wilson_cases = [(120, 220, 0.05), (0, 10, 0.05), (10, 10, 0.05), (1, 1, 0.05), (500, 1000, 0.01), (3, 7, 0.1), (60, 100, 0.05), (0, 0, 0.05), (7, 1999, 0.05)]
    interleaving_cases = [
        (100, 120, 0, 0.05), (100, 120, 30, 0.05), (100, 120, 0, 0.25), (100, 150, 0, 0.05), (150, 100, 12, 0.05), (0, 0, 7, 0.05),
        (0, 12, 0, 0.05), (12, 0, 0, 0.05), (60, 40, 0, 0.05), (7, 3, 1, 0.05), (1, 0, 0, 0.05), (1000, 1050, 100, 0.01), (950, 1050, 0, 0.05),
    ]
    ranking_cases = [(DEFAULT_A, DEFAULT_B), ([3, 3, 0], [0, 0, 3]), ([3, 2], [1]), ([0, 0], [0, 0]), (LONG_A, LONG_B)]
    # beyond the exact-arithmetic range of the TypeScript twin (it switches to a log-gamma recurrence there; tolerance 1e-9)
    large_cases = [(14_500, 30_000), (14_800, 30_000), (15_000, 30_000), (15_100, 30_000), (49_000, 100_000), (49_800, 100_000), (40_000, 100_000)]
    log_choose_cases = [(2000, 1000), (220, 120), (200_000, 100_000), (50, 3), (100_000, 7), (30, 0), (64, 32), (20_001, 9_000), (40, 20), (4097, 1)]
    ndcg_cases = [(DEFAULT_A, 5), (DEFAULT_B, 5), (DEFAULT_A, 10), ([0, 0, 3], 3), ([0, 0, 0], 4), ([3, 2, 1], 3), ([1, 3], 1)]
    mrr_cases = [[[False, True], [True], [False, False]], [[False, False, False, True]], [[True, True]]]
    precision_cases = [([True, False, True, True], 2), ([True, False, True, True], 3), ([False, False], 2)]
    mean_ndcg_cases = [([[3, 2, 3, 0, 1], [0, 0, 3], [0, 0, 0]], 3), ([DEFAULT_A, DEFAULT_B], 5)]
    return {
        "_note": "Generated by `python3 tests/test_ranking.py` from SciPy reference values (repr precision). Consumed by webapp/src/lib/interleaving.test.ts at relative tolerance 1e-12.",
        "binomial_two_sided": _binomial_table(),
        "binomial_two_sided_large": {f"{k}/{n}": float(stats.binomtest(k, n, 0.5).pvalue) for k, n in large_cases},
        "log_choose": {f"{n}/{k}": math.log(math.comb(n, k)) for n, k in log_choose_cases},  # exact integer, one rounding in log()
        "norm_ppf": {repr(p): float(stats.norm.ppf(p)) for p in ppf_points},
        "wilson": {f"{k}/{n}/{alpha}": list(wilson_interval(k, n, alpha)) for k, n, alpha in wilson_cases},
        "interleaving": [
            {"wins_a": a, "wins_b": b, "ties": t, "alpha": alpha, "result": interleaving_test(a, b, t, alpha).as_dict()} for a, b, t, alpha in interleaving_cases
        ],
        "rankings": [dict(zip(("rel_a", "rel_b", "grades", "order_a", "order_b"), (a, b, *build_rankings(a, b)), strict=True)) for a, b in ranking_cases],
        "offline": {
            "ndcg": [{"rels": rels, "k": k, "value": ndcg_at_k(rels, k)} for rels, k in ndcg_cases],
            "mrr": [{"flags": flags, "value": mrr(flags)} for flags in mrr_cases],
            "precision": [{"flags": flags, "k": k, "value": precision_at_k(flags, k)} for flags, k in precision_cases],
            "mean_ndcg": [{"queries": qs, "k": k, "value": mean_ndcg_at_k(qs, k)} for qs, k in mean_ndcg_cases],
        },
        "wrong_ztest_p_100_120": complementary_ztest_p(100, 120),
    }


def _assert_close(got: Any, want: Any, path: str) -> None:
    if isinstance(want, dict):
        assert isinstance(got, dict) and got.keys() == want.keys(), path
        for key in want:
            _assert_close(got[key], want[key], f"{path}.{key}")
    elif isinstance(want, list):
        assert isinstance(got, list) and len(got) == len(want), path
        for i, (g, w) in enumerate(zip(got, want, strict=True)):
            _assert_close(g, w, f"{path}[{i}]")
    elif isinstance(want, float):
        assert got == pytest.approx(want, rel=REL, abs=1e-300), path
    else:
        assert got == want, path


def test_fixture_is_current() -> None:
    assert FIXTURE.exists(), "generate the parity fixture with: python3 tests/test_ranking.py"
    stored = json.loads(FIXTURE.read_text())
    fresh = build_fixture()
    _assert_close(stored, fresh, "fixture")
    assert stored["binomial_two_sided"]["120/220"] == pytest.approx(0.2000922290282712, rel=REL)
    assert stored["binomial_two_sided"]["0/0"] == 1.0
    assert len(stored["binomial_two_sided"]) >= 300
    assert stored["wrong_ztest_p_100_120"] == pytest.approx(WRONG_ZTEST_P_100_120, rel=1e-9)
    assert FIXTURE.stat().st_size < 200_000


if __name__ == "__main__":
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(build_fixture(), indent=1) + "\n")
    print(f"wrote {FIXTURE.relative_to(ROOT)} ({FIXTURE.stat().st_size} bytes)")
