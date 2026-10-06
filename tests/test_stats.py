import dataclasses
import json
import math
import pathlib

import numpy as np
import pytest
from scipy import stats

import abkit.stats as abstats
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
from abkit.stats import (
    MeanStats,
    Sums,
    cuped_from_sums,
    mde_at_n,
    power_mean,
    power_proportion,
    ratio_metric_delta,
    relative_lift_ci,
    relative_lift_means,
    relative_lift_proportions,
    welch_ttest_from_stats,
)

FIXTURE = json.loads((pathlib.Path(__file__).parent / "fixtures" / "stats.json").read_text())
_CASES = FIXTURE["cases"] + FIXTURE["python_only"]


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


# --------------------------------------------------------------------------- sufficient statistics
def test_sufficient_statistics_containers():
    rng = np.random.default_rng(5)
    x, y = rng.normal(50, 10, 40), rng.normal(20, 6, 40)
    ms = MeanStats.from_array(y)
    assert ms.n == 40 and ms.mean == pytest.approx(y.mean()) and ms.var == pytest.approx(y.var(ddof=1))
    s = Sums.from_arrays(x, y)
    assert (s.n, s.sx, s.sy, s.sxx, s.syy, s.sxy) == pytest.approx((40, x.sum(), y.sum(), (x * x).sum(), (y * y).sum(), (x * y).sum()))
    parts = Sums.from_arrays(x[:15], y[:15]) + Sums.from_arrays(x[15:], y[15:])  # per-day sums add up to the cumulative ones
    assert parts.as_dict() == pytest.approx(s.as_dict(), rel=1e-12)
    assert Sums.empty() + s == s
    mv = s.mean_var()  # twin of the web app's meanVar(): mean and sample variance recovered from the sums
    assert mv.n == 40 and mv.mean == pytest.approx(ms.mean, rel=1e-12) and mv.var == pytest.approx(ms.var, rel=1e-9)
    assert json.loads(json.dumps(s.as_dict()))["sxy"] == s.sxy
    with pytest.raises(ValueError):
        Sums.from_arrays([1.0, 2.0], [1.0])
    with pytest.raises(ValueError):
        MeanStats.from_array([1.0])
    with pytest.raises(dataclasses.FrozenInstanceError):
        s.n = 3


# --------------------------------------------------------------------------- relative lift (delta method)
def test_relative_lift_ci_delta_method_matches_reference():
    r = relative_lift_proportions(1000, 10_000, 1100, 10_000)
    assert r.lift_rel == pytest.approx(0.10, rel=1e-12)
    assert r.se == pytest.approx(0.045475268003608287, rel=1e-12)
    assert (r.ci_low, r.ci_high) == pytest.approx((0.010870112525620937, 0.1891298874743788), rel=1e-12)
    assert r.alpha == 0.05 and r.method == "delta"
    # the proportion helper is the generic delta-method CI fed with binomial standard errors
    se_a, se_b = math.sqrt(0.1 * 0.9 / 10_000), math.sqrt(0.11 * 0.89 / 10_000)
    g = relative_lift_ci(0.1, se_a, 0.11, se_b)
    for key in ("lift_rel", "ci_low", "ci_high", "se"):
        assert getattr(g, key) == pytest.approx(getattr(r, key), rel=1e-12), key
    # hand formula: R = mean_b / mean_a, Var(R) = se_b^2 / mean_a^2 + mean_b^2 se_a^2 / mean_a^4
    a, b = MeanStats(300, 10.1, 4.2), MeanStats(200, 10.6, 9.1)
    m = relative_lift_means(a, b)
    ratio = 10.6 / 10.1
    var = (9.1 / 200) / 10.1**2 + 10.6**2 * (4.2 / 300) / 10.1**4
    assert m.lift_rel == pytest.approx(ratio - 1, rel=1e-12)
    assert m.se == pytest.approx(math.sqrt(var), rel=1e-12)
    assert m.ci_low == pytest.approx(ratio - 1 - stats.norm.ppf(0.975) * math.sqrt(var), rel=1e-12)
    assert m.ci_high == pytest.approx(ratio - 1 + stats.norm.ppf(0.975) * math.sqrt(var), rel=1e-12)
    ref = relative_lift_ci(10.1, math.sqrt(4.2 / 300), 10.6, math.sqrt(9.1 / 200))
    assert (m.lift_rel, m.ci_low, m.ci_high, m.se) == pytest.approx((ref.lift_rel, ref.ci_low, ref.ci_high, ref.se), rel=1e-12)
    # alpha moves the band; the delta band is wider than the naive "absolute CI / control rate" band
    assert relative_lift_proportions(1000, 10_000, 1100, 10_000, alpha=0.01).ci_high > r.ci_high
    z = two_proportion_ztest(1000, 10_000, 1100, 10_000)
    assert r.ci_high - r.ci_low > (z.ci_high - z.ci_low) / z.rate_a


def test_relative_lift_validation():
    with pytest.raises(ValueError):
        relative_lift_ci(0.0, 0.01, 0.1, 0.01)  # control mean zero: relative lift undefined
    with pytest.raises(ValueError):
        relative_lift_ci(0.1, -0.01, 0.1, 0.01)  # negative standard error
    with pytest.raises(ValueError):
        relative_lift_ci(0.1, 0.01, 0.1, 0.01, alpha=1.0)
    with pytest.raises(ValueError):
        relative_lift_proportions(0, 100, 5, 100)  # zero control conversions
    with pytest.raises(ValueError):
        relative_lift_proportions(5, 100, 105, 100)  # conversions > visitors
    with pytest.raises(ValueError):
        relative_lift_means(MeanStats(1, 1.0, 0.0), MeanStats(10, 1.0, 1.0))  # fewer than two observations
    with pytest.raises(ValueError):
        relative_lift_means(MeanStats(10, 1.0, -1.0), MeanStats(10, 1.0, 1.0))  # negative variance


def test_relative_lift_ci_coverage_is_nominal():
    # 2,000 seeded A/B draws with a true +10 % relative lift: the delta-method 95 % band must cover it ~95 % of the time.
    # The naive band (absolute Wald CI divided by the observed control rate) ignores the control-rate noise: it has the
    # same centre but is narrower whenever the observed lift is positive, so in this draw it covers the truth less often.
    rng = np.random.default_rng(20241006)
    n, p_a, p_b = 10_000, 0.10, 0.11
    conv_a = rng.binomial(n, p_a, 2000)
    conv_b = rng.binomial(n, p_b, 2000)
    true_lift = p_b / p_a - 1
    covered = naive_covered = 0
    for ca, cb in zip(conv_a.tolist(), conv_b.tolist(), strict=True):
        r = relative_lift_proportions(ca, n, cb, n)
        covered += r.ci_low <= true_lift <= r.ci_high
        z = two_proportion_ztest(ca, n, cb, n)
        naive_low, naive_high = z.ci_low / z.rate_a, z.ci_high / z.rate_a
        naive_covered += naive_low <= true_lift <= naive_high
        assert (r.ci_low + r.ci_high) / 2 == pytest.approx(z.lift_rel, rel=1e-9)
        if z.lift_rel > 0:
            assert r.ci_low < naive_low and r.ci_high > naive_high
    assert 0.93 <= covered / 2000 <= 0.97
    assert naive_covered < covered


# --------------------------------------------------------------------------- power and MDE at a given n
def test_power_proportion_inverts_sample_size():
    assert 0.80 <= power_proportion(0.1, 0.1, 14_751) <= 0.81
    assert power_proportion(0.1, 0.1, 14_751) == pytest.approx(0.8000055710998799, rel=1e-12)
    assert power_proportion(0.1, 0.1, 14_750) < 0.8
    for baseline, mde, alpha, power in [(0.1, 0.1, 0.05, 0.8), (0.1, 0.2, 0.05, 0.8), (0.05, -0.1, 0.01, 0.9), (0.3, 0.05, 0.1, 0.8)]:
        n = sample_size_proportion(baseline, mde, alpha, power)
        assert power_proportion(baseline, mde, n, alpha) >= power
        assert power_proportion(baseline, mde, n - 1, alpha) < power
    assert power_proportion(0.1, 0.1, 14_751, two_sided=False) > power_proportion(0.1, 0.1, 14_751)
    assert power_proportion(0.1, 0.0, 14_751) == pytest.approx(0.025, rel=1e-9)  # no effect: one tail of alpha
    with pytest.raises(ValueError):
        power_proportion(0.1, 0.1, 0)
    with pytest.raises(ValueError):
        power_proportion(1.2, 0.1, 100)
    with pytest.raises(ValueError):
        power_proportion(0.5, 1.5, 100)  # treatment rate above 1


def test_power_mean_inverts_sample_size():
    n = sample_size_mean(1.0, 0.1)  # 1570
    assert power_mean(1.0, 0.1, n) >= 0.8 > power_mean(1.0, 0.1, n - 1)
    assert power_mean(1.0, 0.1, n) == pytest.approx(stats.norm.cdf(0.1 * math.sqrt(n / 2) - stats.norm.ppf(0.975)), rel=1e-12)
    assert power_mean(2.5, -0.3, 5000) == power_mean(2.5, 0.3, 5000)
    assert power_mean(1.0, 0.1, n, two_sided=False) > power_mean(1.0, 0.1, n)
    assert power_mean(1.0, 0.0, n) == pytest.approx(0.025, rel=1e-9)
    with pytest.raises(ValueError):
        power_mean(0.0, 0.1, 100)
    with pytest.raises(ValueError):
        power_mean(1.0, 0.1, 0)


def test_mde_at_n_round_trips_power():
    m = mde_at_n(0.1, 14_751)
    assert m == pytest.approx(0.10, abs=1e-3)
    assert power_proportion(0.1, m, 14_751) == pytest.approx(0.8, abs=1e-9)
    assert mde_at_n(0.1, 5_000) > m > mde_at_n(0.1, 50_000)
    assert mde_at_n(0.1, 14_751, two_sided=False) < m < mde_at_n(0.1, 14_751, power=0.9)
    m2 = mde_at_n(0.05, 20_000, power=0.9)
    assert power_proportion(0.05, m2, 20_000) == pytest.approx(0.9, abs=1e-9)
    with pytest.raises(ValueError):
        mde_at_n(0.1, 1)  # one visitor per arm cannot reach 80 % power for any lift
    with pytest.raises(ValueError):
        mde_at_n(0.1, 1000, power=0.01)  # below the no-effect rejection rate alpha / 2
    with pytest.raises(ValueError):
        mde_at_n(0.1, 1000, power=1.0)


# --------------------------------------------------------------------------- sufficient-statistics twins
def test_welch_from_stats_matches_array_version():
    rng = np.random.default_rng(1)
    a, b = rng.normal(10, 2, 300), rng.normal(10.4, 3, 200)
    arr = welch_ttest(a, b)
    sa, sb = MeanStats.from_array(a), MeanStats.from_array(b)
    agg = welch_ttest_from_stats(sa, sb)
    for key, value in arr.as_dict().items():
        assert agg.as_dict()[key] == (value if isinstance(value, bool) else pytest.approx(value, rel=1e-12)), key
    ref = stats.ttest_ind_from_stats(sb.mean, math.sqrt(sb.var), sb.n, sa.mean, math.sqrt(sa.var), sa.n, equal_var=False)
    assert agg.t == pytest.approx(ref.statistic) and agg.p_value == pytest.approx(ref.pvalue)
    with pytest.raises(ValueError):
        welch_ttest_from_stats(MeanStats(1, 1.0, 1.0), MeanStats(10, 1.0, 1.0))
    with pytest.raises(ValueError):
        welch_ttest_from_stats(MeanStats(10, 1.0, 0.0), MeanStats(10, 1.0, 0.0))  # zero variance in both groups
    with pytest.raises(ValueError):
        welch_ttest_from_stats(MeanStats(10, 1.0, -1.0), MeanStats(10, 1.0, 1.0))


def test_cuped_from_sums_is_exact_twin_of_array_cuped():
    rng = np.random.default_rng(7)
    n, rho = 5_000, 0.7
    cov = [[1, rho], [rho, 1]]
    pre_a, y_a = rng.multivariate_normal([0, 0], cov, n).T
    pre_b, y_b = rng.multivariate_normal([0, 0], cov, n).T
    y_b = y_b + 0.2
    arr = cuped(y_a, pre_a, y_b, pre_b)
    agg = cuped_from_sums(Sums.from_arrays(pre_a, y_a), Sums.from_arrays(pre_b, y_b))
    assert agg.theta == pytest.approx(arr.theta, rel=1e-9)
    assert agg.var_before == pytest.approx(arr.var_before, rel=1e-9)
    assert agg.var_after == pytest.approx(arr.var_after, rel=1e-9)
    assert agg.variance_reduction == pytest.approx(arr.variance_reduction, rel=1e-9)
    for adj, raw in ((agg.adj_a, arr.adjusted_a), (agg.adj_b, arr.adjusted_b)):
        assert adj.n == n
        assert adj.mean == pytest.approx(raw.mean(), rel=1e-9, abs=1e-12)
        assert adj.var == pytest.approx(raw.var(ddof=1), rel=1e-9)
    # sums are additive, so per-day aggregates give the same answer as one big batch
    split_a = Sums.from_arrays(pre_a[:2000], y_a[:2000]) + Sums.from_arrays(pre_a[2000:], y_a[2000:])
    assert cuped_from_sums(split_a, Sums.from_arrays(pre_b, y_b)).theta == pytest.approx(agg.theta, rel=1e-9)
    # hand-checkable case: x = [1, 2, 3], y_a = x + 1, y_b = x + 2 -> theta = 1, within-arm residual variance 0 (floored to 1e-12)
    tiny = cuped_from_sums(Sums(3, 6.0, 9.0, 14.0, 29.0, 20.0), Sums(3, 6.0, 12.0, 14.0, 50.0, 26.0))
    assert tiny.theta == pytest.approx(1.0) and tiny.adj_a.mean == pytest.approx(3.0) and tiny.adj_b.mean == pytest.approx(4.0)
    assert tiny.adj_a.var == 1e-12 and tiny.adj_b.var == 1e-12
    assert tiny.var_before == pytest.approx(1.1) and tiny.var_after == pytest.approx(0.3) and tiny.variance_reduction == pytest.approx(1 - 0.3 / 1.1)
    # a constant covariate means no adjustment (theta 0), exactly like the web app, instead of an exception
    flat = cuped_from_sums(Sums.from_arrays(np.ones(n), y_a), Sums.from_arrays(np.ones(n), y_b))
    assert flat.theta == 0 and flat.variance_reduction == 0 and flat.adj_a.mean == pytest.approx(y_a.mean())
    with pytest.raises(ValueError):
        cuped_from_sums(Sums(1, 1.0, 1.0, 1.0, 1.0, 1.0), Sums(3, 6.0, 12.0, 14.0, 50.0, 26.0))


def test_cuped_result_as_dict_serialises_arrays():
    rng = np.random.default_rng(3)
    x_a, x_b = rng.normal(size=50), rng.normal(size=60)
    res = cuped(x_a + rng.normal(size=50), x_a, x_b + rng.normal(size=60), x_b)
    d = res.as_dict()
    assert set(d) == {"theta", "var_before", "var_after", "variance_reduction", "adjusted_a", "adjusted_b"}
    assert isinstance(d["adjusted_a"], list) and len(d["adjusted_a"]) == 50 and len(d["adjusted_b"]) == 60
    assert all(isinstance(v, float) for v in d["adjusted_a"] + d["adjusted_b"])
    assert d["adjusted_a"] == res.adjusted_a.tolist() and d["adjusted_b"] == res.adjusted_b.tolist()
    assert json.loads(json.dumps(d))["theta"] == res.theta


# --------------------------------------------------------------------------- one-sided z-test and ratio metrics
def test_one_sided_ztest_alternatives():
    two = two_proportion_ztest(1000, 10_000, 1100, 10_000)
    assert two == two_proportion_ztest(1000, 10_000, 1100, 10_000, alternative="two-sided")  # default output unchanged
    larger = two_proportion_ztest(1000, 10_000, 1100, 10_000, alternative="larger")
    smaller = two_proportion_ztest(1000, 10_000, 1100, 10_000, alternative="smaller")
    assert larger.p_value == pytest.approx(two.p_value / 2, rel=1e-12)
    assert larger.p_value + smaller.p_value == pytest.approx(1.0, rel=1e-12)
    assert larger.z == two.z and larger.lift_rel == two.lift_rel and larger.rate_b == two.rate_b
    se_u = math.sqrt(0.1 * 0.9 / 10_000 + 0.11 * 0.89 / 10_000)
    assert larger.ci_low == pytest.approx(0.01 - stats.norm.ppf(0.95) * se_u, rel=1e-12) and larger.ci_high == math.inf
    assert smaller.ci_low == -math.inf and smaller.ci_high == pytest.approx(0.01 + stats.norm.ppf(0.95) * se_u, rel=1e-12)
    assert larger.significant and not smaller.significant
    assert two_proportion_ztest(1100, 10_000, 1000, 10_000, alternative="smaller").significant
    weak = two_proportion_ztest(1000, 10_000, 1075, 10_000)  # z ~ 1.74: only the directional test rejects at 5 %
    assert not weak.significant and two_proportion_ztest(1000, 10_000, 1075, 10_000, alternative="larger").significant
    with pytest.raises(ValueError):
        two_proportion_ztest(1000, 10_000, 1100, 10_000, alternative="greater")


def test_ratio_metric_delta_method():
    num_a, den_a = [3, 1, 0, 4, 2, 2, 5, 1, 0, 3, 2, 1], [5, 3, 2, 6, 4, 3, 8, 2, 1, 5, 4, 3]
    num_b, den_b = [4, 2, 1, 4, 3, 2, 6, 1, 1, 3, 2, 2], [5, 3, 2, 6, 4, 3, 8, 2, 1, 5, 4, 3]
    r = ratio_metric_delta(num_a, den_a, num_b, den_b)
    ratio_a, ratio_b = sum(num_a) / sum(den_a), sum(num_b) / sum(den_b)
    assert r.lift_rel == pytest.approx(ratio_b / ratio_a - 1, rel=1e-12)

    def se_ratio(num, den):  # textbook delta method for a ratio of per-user sums
        x, d = np.asarray(num, dtype=float), np.asarray(den, dtype=float)
        ratio, c = x.sum() / d.sum(), np.cov(x, d)
        return math.sqrt((c[0, 0] - 2 * ratio * c[0, 1] + ratio**2 * c[1, 1]) / (len(x) * d.mean() ** 2))

    ref = relative_lift_ci(ratio_a, se_ratio(num_a, den_a), ratio_b, se_ratio(num_b, den_b))
    assert (r.se, r.ci_low, r.ci_high) == pytest.approx((ref.se, ref.ci_low, ref.ci_high), rel=1e-12)
    same = ratio_metric_delta(num_a, den_a, num_a, den_a)
    assert same.lift_rel == pytest.approx(0.0, abs=1e-15) and same.ci_low == pytest.approx(-same.ci_high, rel=1e-12)
    with pytest.raises(ValueError):
        ratio_metric_delta(num_a, den_a[:-1], num_b, den_b)
    with pytest.raises(ValueError):
        ratio_metric_delta([1.0], [2.0], num_b, den_b)
    with pytest.raises(ValueError):
        ratio_metric_delta(num_a, [0] * 12, num_b, den_b)
    # coverage: sessions and bookings per user; the true ratio is the per-session booking rate
    rng = np.random.default_rng(99)
    users, p_a, p_b, sims = 2_000, 0.30, 0.33, 400
    covered = 0
    for _ in range(sims):
        d_a, d_b = rng.poisson(4, users) + 1, rng.poisson(4, users) + 1
        n_a, n_b = rng.binomial(d_a, p_a), rng.binomial(d_b, p_b)
        ci = ratio_metric_delta(n_a, d_a, n_b, d_b)
        covered += ci.ci_low <= p_b / p_a - 1 <= ci.ci_high
    assert 0.92 <= covered / sims <= 0.98


def test_new_result_types_are_frozen_and_serialisable():
    r = relative_lift_ci(0.1, 0.003, 0.11, 0.0031)
    assert set(r.as_dict()) == {"lift_rel", "ci_low", "ci_high", "se", "alpha", "method"}
    assert r.method == "delta" and r.se > 0
    c = cuped_from_sums(Sums(3, 6.0, 9.0, 14.0, 29.0, 20.0), Sums(3, 6.0, 12.0, 14.0, 50.0, 26.0))
    d = c.as_dict()
    assert set(d) == {"theta", "var_before", "var_after", "variance_reduction", "adj_a", "adj_b"}
    assert set(d["adj_a"]) == {"n", "mean", "var"} and d["adj_a"]["n"] == 3
    for obj in (r, c, MeanStats(2, 0.0, 1.0), Sums.empty()):
        assert json.loads(json.dumps(obj.as_dict())) == obj.as_dict()
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(obj, dataclasses.fields(obj)[0].name, 1)


# --------------------------------------------------------------------------- reference fixture (shared with the web app)
def test_fixture_distribution_tables_match_scipy():
    assert [row["z"] for row in FIXTURE["norm_sf"]] == [0, 0.5, 1, 1.96, 2.5758, 3, 4, 5, 6, 8]
    for row in FIXTURE["norm_sf"]:
        assert row["sf"] == pytest.approx(stats.norm.sf(row["z"]), rel=1e-10)
    for row in FIXTURE["norm_ppf"]:
        assert row["ppf"] == pytest.approx(stats.norm.ppf(row["p"]), rel=1e-10, abs=1e-15)
    for row in FIXTURE["t_sf2"]:
        assert row["p"] == pytest.approx(2 * stats.t.sf(row["t"], row["df"]), rel=1e-9)
    for row in FIXTURE["t_ppf"]:
        assert row["ppf"] == pytest.approx(stats.t.ppf(row["p"], row["df"]), rel=1e-9)
    for row in FIXTURE["chi2_sf"]:
        assert row["sf"] == pytest.approx(stats.chi2.sf(row["x"], row["df"]), rel=1e-9)
    by_z = {row["z"]: row["sf"] for row in FIXTURE["norm_sf"]}
    assert by_z[1.96] == pytest.approx(0.024997895148220435, rel=1e-10)
    assert by_z[8] == pytest.approx(6.22096057427174e-16, rel=1e-10)


def _decode(value):
    """Turn fixture JSON into call arguments: {n, mean, var} objects become MeanStats, sum objects become Sums."""
    if isinstance(value, dict):
        if set(value) == {"n", "mean", "var"}:
            return MeanStats(**value)
        if set(value) == {"n", "sx", "sy", "sxx", "syy", "sxy"}:
            return Sums(**value)
        return {k: _decode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_decode(v) for v in value]
    return value


def _assert_close(actual, expected, fn, tol, path):
    if isinstance(expected, (bool, int)):
        assert actual == expected, path
    elif isinstance(expected, float):
        rel = tol["p_value"] if path.endswith("p_value") else tol.get(fn, tol["default"])
        assert actual == pytest.approx(expected, rel=rel, abs=1e-15), path
    elif isinstance(expected, str):  # one-sided bounds are encoded as "Infinity" / "-Infinity"
        assert actual == {"Infinity": math.inf, "-Infinity": -math.inf}.get(expected, expected), path
    elif isinstance(expected, dict):
        assert set(actual) == set(expected), path
        for key, value in expected.items():
            _assert_close(actual[key], value, fn, tol, f"{path}.{key}")
    else:
        assert len(actual) == len(expected), path
        for i, (a, e) in enumerate(zip(actual, expected, strict=True)):
            _assert_close(a, e, fn, tol, f"{path}[{i}]")


@pytest.mark.parametrize("case", _CASES, ids=[f"{c['fn']}-{i}" for i, c in enumerate(_CASES)])
def test_fixture_case_recomputes(case):
    fn = getattr(abstats, case["fn"])
    result = fn(**{k: _decode(v) for k, v in case["args"].items()})
    actual = result.as_dict() if hasattr(result, "as_dict") else {"value": result}
    _assert_close(actual, case["expected"], case["fn"], FIXTURE["tolerances"], case["fn"])
