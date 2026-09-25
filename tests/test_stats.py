import math

import numpy as np
import pytest
from scipy import stats

from abkit import (
    bonferroni,
    cuped,
    dcg,
    holm,
    interleaving_outcome,
    mrr,
    ndcg_at_k,
    precision_at_k,
    sample_size_mean,
    sample_size_proportion,
    srm_check,
    team_draft_interleave,
    two_proportion_ztest,
    welch_ttest,
)


def test_ztest_matches_hand_calculation():
    r = two_proportion_ztest(1000, 10_000, 1100, 10_000)
    pooled = 2100 / 20_000
    se = math.sqrt(pooled * (1 - pooled) * 2 / 10_000)
    assert r.z == pytest.approx(0.01 / se)
    assert r.p_value == pytest.approx(2 * stats.norm.sf(abs(r.z)))
    assert r.lift_rel == pytest.approx(0.10)
    assert r.ci_low < 0.01 < r.ci_high
    assert r.significant is True  # z ~ 2.29


def test_ztest_no_difference_and_validation():
    r = two_proportion_ztest(500, 5000, 500, 5000)
    assert r.z == 0 and r.p_value == pytest.approx(1.0) and not r.significant
    with pytest.raises(ValueError):
        two_proportion_ztest(10, 5, 1, 5)
    with pytest.raises(ValueError):
        two_proportion_ztest(1, 5, 1, 5, alpha=1.5)


def test_welch_matches_scipy():
    rng = np.random.default_rng(1)
    a, b = rng.normal(10, 2, 300), rng.normal(10.4, 3, 200)
    r = welch_ttest(a, b)
    ref = stats.ttest_ind(b, a, equal_var=False)
    assert r.t == pytest.approx(ref.statistic)
    assert r.p_value == pytest.approx(ref.pvalue)
    assert r.ci_low < r.diff < r.ci_high


def test_sample_size_textbook_example():
    # 10 % baseline, +10 % relative, alpha 0.05 two-sided, power 0.8 -> ~14.7k per arm
    n = sample_size_proportion(0.10, 0.10)
    assert 14_500 <= n <= 15_000
    assert sample_size_proportion(0.10, 0.20) < n  # bigger effect, fewer users
    assert sample_size_proportion(0.10, 0.10, power=0.9) > n
    assert sample_size_mean(1.0, 0.1) == 1570  # 2 * ((1.95996 + 0.84162) / 0.1)^2 = 1569.8 -> 1570
    with pytest.raises(ValueError):
        sample_size_proportion(0.5, 1.5)


def test_srm_detects_skew_but_not_fair_split():
    fair = srm_check([100_000, 100_200])
    assert not fair.mismatch and fair.p_value > 0.1
    skewed = srm_check([98_000, 102_000])
    assert skewed.mismatch and skewed.p_value < 1e-6
    three = srm_check([500, 250, 250], [0.5, 0.25, 0.25])
    assert three.chi2 == 0 and not three.mismatch
    with pytest.raises(ValueError):
        srm_check([1, 2], [0.7, 0.7])


def test_cuped_reduces_variance_and_keeps_lift_unbiased():
    rng = np.random.default_rng(7)
    n, rho, lift = 20_000, 0.7, 0.2
    cov = [[1, rho], [rho, 1]]
    pre_a, y_a = rng.multivariate_normal([0, 0], cov, n).T
    pre_b, y_b = rng.multivariate_normal([0, 0], cov, n).T
    res = cuped(y_a, pre_a, y_b + lift, pre_b)
    assert res.theta == pytest.approx(rho, abs=0.03)
    assert res.variance_reduction == pytest.approx(rho**2, abs=0.03)
    assert (res.adjusted_b.mean() - res.adjusted_a.mean()) == pytest.approx(lift, abs=0.03)


def test_multiple_comparisons():
    p = [0.01, 0.04, 0.03, 0.2]
    assert bonferroni(p) == [True, False, False, False]
    assert holm(p) == [True, False, False, False]
    assert holm([0.001, 0.01, 0.02]) == [True, True, True]


def test_ranking_metrics():
    assert dcg([3, 2, 0]) == pytest.approx((2**3 - 1) + (2**2 - 1) / math.log2(3))
    assert ndcg_at_k([3, 2, 1], 3) == pytest.approx(1.0)
    assert ndcg_at_k([0, 0, 3], 3) < ndcg_at_k([3, 0, 0], 3)
    assert ndcg_at_k([0, 0, 0], 5) == 0.0
    assert mrr([[False, True], [True], [False, False]]) == pytest.approx((0.5 + 1 + 0) / 3)
    assert precision_at_k([True, False, True, True], 2) == 0.5
    with pytest.raises(ValueError):
        ndcg_at_k([1], 0)


def test_team_draft_interleaving_is_fair_and_complete():
    rng = np.random.default_rng(3)
    a = list(range(10))
    b = list(range(9, -1, -1))
    merged, teams = team_draft_interleave(a, b, rng)
    assert sorted(merged) == a  # every item exactly once
    assert abs(teams.count("A") - teams.count("B")) <= 1
    firsts = sum(team_draft_interleave(a, b, rng)[1][0] == "A" for _ in range(2000))
    assert 900 < firsts < 1100  # coin flip decides who picks first
    assert interleaving_outcome([0, 1], teams) in {"A", "B", "tie"}
    assert interleaving_outcome([], teams) == "tie"
