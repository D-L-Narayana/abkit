"""Frequentist A/B-test statistics used day to day on an experimentation platform.

Everything here is deliberately explicit (no statsmodels) so each formula can be
read, checked against a textbook and unit-tested.

Two flavours of most tests exist: the array versions take per-user observations,
the ``*_from_stats`` / ``*_from_sums`` twins take sufficient statistics (``MeanStats``,
``Sums``) so that aggregated exports and the web app compute identical numbers.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
from scipy import stats

_ALTERNATIVES = ("two-sided", "larger", "smaller")
_ADJ_VAR_FLOOR = 1e-12  # per-arm CUPED-adjusted variance floor shared with the web app


# --------------------------------------------------------------------------- results
@dataclass(frozen=True)
class ZTestResult:
    rate_a: float
    rate_b: float
    lift_abs: float
    lift_rel: float
    z: float
    p_value: float
    ci_low: float
    ci_high: float
    alpha: float
    significant: bool

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class TTestResult:
    mean_a: float
    mean_b: float
    diff: float
    t: float
    df: float
    p_value: float
    ci_low: float
    ci_high: float
    alpha: float
    significant: bool

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SRMResult:
    observed: tuple[int, ...]
    expected: tuple[float, ...]
    chi2: float
    p_value: float
    mismatch: bool

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class CupedResult:
    theta: float
    var_before: float
    var_after: float
    variance_reduction: float  # fraction, e.g. 0.36 == 36 % less variance
    adjusted_a: np.ndarray
    adjusted_b: np.ndarray

    def as_dict(self) -> dict[str, Any]:
        """JSON-friendly view: the adjusted per-user arrays become lists of floats."""
        return {
            "theta": self.theta,
            "var_before": self.var_before,
            "var_after": self.var_after,
            "variance_reduction": self.variance_reduction,
            "adjusted_a": [float(v) for v in np.asarray(self.adjusted_a, dtype=float).ravel()],
            "adjusted_b": [float(v) for v in np.asarray(self.adjusted_b, dtype=float).ravel()],
        }


# --------------------------------------------------------------------------- sufficient statistics
@dataclass(frozen=True)
class MeanStats:
    """Sufficient statistics of one arm for a mean: count, sample mean and sample variance (ddof=1)."""

    n: int
    mean: float
    var: float

    @classmethod
    def from_array(cls, values: Sequence[float] | np.ndarray) -> MeanStats:
        x = np.asarray(values, dtype=float)
        if x.ndim != 1 or len(x) < 2:
            raise ValueError("need a 1-d array with at least two observations")
        return cls(int(len(x)), float(x.mean()), float(x.var(ddof=1)))

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Sums:
    """Aggregate sums of one arm for CUPED: x = pre-period covariate, y = experiment metric.

    Sums are additive, so per-day aggregates can be combined with ``+`` into cumulative ones,
    and they are exactly what the web app and the aggregated CSV format carry.
    """

    n: int
    sx: float
    sy: float
    sxx: float
    syy: float
    sxy: float

    @classmethod
    def from_arrays(cls, x: Sequence[float] | np.ndarray, y: Sequence[float] | np.ndarray) -> Sums:
        xa, ya = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
        if xa.ndim != 1 or xa.shape != ya.shape:
            raise ValueError("x and y must be 1-d arrays of the same length (paired per user)")
        return cls(int(len(xa)), float(xa.sum()), float(ya.sum()), float((xa * xa).sum()), float((ya * ya).sum()), float((xa * ya).sum()))

    @classmethod
    def empty(cls) -> Sums:
        return cls(0, 0.0, 0.0, 0.0, 0.0, 0.0)

    def __add__(self, other: Sums) -> Sums:
        return Sums(self.n + other.n, self.sx + other.sx, self.sy + other.sy, self.sxx + other.sxx, self.syy + other.syy, self.sxy + other.sxy)

    def mean_var(self) -> MeanStats:
        """Mean and sample variance of y recovered from the sums (variance clipped at 0 against rounding)."""
        if self.n < 2:
            raise ValueError("need at least two observations")
        mean = self.sy / self.n
        return MeanStats(self.n, mean, max(0.0, (self.syy - self.n * mean * mean) / (self.n - 1)))

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RelativeLiftResult:
    lift_rel: float
    ci_low: float
    ci_high: float
    se: float
    alpha: float
    method: str = "delta"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class CupedSumsResult:
    theta: float
    var_before: float
    var_after: float
    variance_reduction: float
    adj_a: MeanStats
    adj_b: MeanStats

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


# --------------------------------------------------------------------------- tests
def two_proportion_ztest(conv_a: int, n_a: int, conv_b: int, n_b: int, alpha: float = 0.05, alternative: str = "two-sided") -> ZTestResult:
    """Pooled z-test for the difference of two conversion rates.

    A = control, B = treatment. The CI uses the unpooled standard error (Wald), the
    test statistic uses the pooled one, as is standard.

    ``alternative``: "two-sided" (default), "larger" (H1: B > A, p = P(Z >= z), CI is the
    one-sided lower bound with ci_high = +inf) or "smaller" (H1: B < A, mirror image).
    """
    _check_counts(conv_a, n_a, "A")
    _check_counts(conv_b, n_b, "B")
    if not 0 < alpha < 1:
        raise ValueError("alpha must be in (0, 1)")
    if alternative not in _ALTERNATIVES:
        raise ValueError(f"alternative must be one of {_ALTERNATIVES}")
    p_a, p_b = conv_a / n_a, conv_b / n_b
    pooled = (conv_a + conv_b) / (n_a + n_b)
    se_pooled = math.sqrt(pooled * (1 - pooled) * (1 / n_a + 1 / n_b))
    z = (p_b - p_a) / se_pooled if se_pooled > 0 else 0.0
    se_unpooled = math.sqrt(p_a * (1 - p_a) / n_a + p_b * (1 - p_b) / n_b)
    diff = p_b - p_a
    if alternative == "two-sided":
        p_value = float(2 * stats.norm.sf(abs(z)))
        zc = float(stats.norm.ppf(1 - alpha / 2))
        ci_low, ci_high = float(diff - zc * se_unpooled), float(diff + zc * se_unpooled)
    elif alternative == "larger":
        p_value = float(stats.norm.sf(z))
        zc = float(stats.norm.ppf(1 - alpha))
        ci_low, ci_high = float(diff - zc * se_unpooled), math.inf
    else:
        p_value = float(stats.norm.cdf(z))
        zc = float(stats.norm.ppf(1 - alpha))
        ci_low, ci_high = -math.inf, float(diff + zc * se_unpooled)
    return ZTestResult(
        rate_a=p_a,
        rate_b=p_b,
        lift_abs=diff,
        lift_rel=diff / p_a if p_a > 0 else math.inf,
        z=z,
        p_value=p_value,
        ci_low=ci_low,
        ci_high=ci_high,
        alpha=alpha,
        significant=bool(p_value < alpha),
    )


def welch_ttest(a: Sequence[float], b: Sequence[float], alpha: float = 0.05) -> TTestResult:
    """Welch's unequal-variance t-test for continuous metrics (revenue per visitor, nights booked...)."""
    x, y = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    if len(x) < 2 or len(y) < 2:
        raise ValueError("each group needs at least two observations")
    return _welch(MeanStats(len(x), float(x.mean()), float(x.var(ddof=1))), MeanStats(len(y), float(y.mean()), float(y.var(ddof=1))), alpha)


def welch_ttest_from_stats(a: MeanStats, b: MeanStats, alpha: float = 0.05) -> TTestResult:
    """Welch's t-test from per-arm sufficient statistics (same formulas as ``welch_ttest``).

        se = sqrt(var_a / n_a + var_b / n_b),  t = (mean_b - mean_a) / se,
        df = (var_a/n_a + var_b/n_b)^2 / ((var_a/n_a)^2 / (n_a - 1) + (var_b/n_b)^2 / (n_b - 1))   (Welch-Satterthwaite)
    """
    _check_mean_stats(a, "A")
    _check_mean_stats(b, "B")
    if not 0 < alpha < 1:
        raise ValueError("alpha must be in (0, 1)")
    return _welch(a, b, alpha)


def _welch(a: MeanStats, b: MeanStats, alpha: float) -> TTestResult:
    va, vb = a.var / a.n, b.var / b.n
    se = math.sqrt(va + vb)
    if se == 0:
        raise ValueError("zero variance in both groups")
    df = (va + vb) ** 2 / (va**2 / (a.n - 1) + vb**2 / (b.n - 1))
    diff = b.mean - a.mean
    t = diff / se
    p = float(2 * stats.t.sf(abs(t), df))
    tc = float(stats.t.ppf(1 - alpha / 2, df))
    return TTestResult(float(a.mean), float(b.mean), float(diff), float(t), float(df), p, float(diff - tc * se), float(diff + tc * se), alpha, bool(p < alpha))


# --------------------------------------------------------------------------- relative lift (delta method)
def relative_lift_ci(mean_a: float, se_a: float, mean_b: float, se_b: float, alpha: float = 0.05) -> RelativeLiftResult:
    """Delta-method confidence interval for the relative lift mean_b / mean_a - 1.

    Unlike dividing the absolute CI by the control mean, this accounts for the sampling
    noise of the control mean as well:

        R = mean_b / mean_a,  Var(R) = se_b^2 / mean_a^2 + mean_b^2 * se_a^2 / mean_a^4
        lift_rel = R - 1,  CI = lift_rel -/+ z_{1-alpha/2} * sqrt(Var(R))

    The arms are assumed independent (no covariance term).
    """
    if mean_a == 0:
        raise ValueError("control mean must be non-zero for a relative lift")
    if se_a < 0 or se_b < 0:
        raise ValueError("standard errors must be non-negative")
    if not 0 < alpha < 1:
        raise ValueError("alpha must be in (0, 1)")
    ratio = mean_b / mean_a
    var = se_b**2 / mean_a**2 + mean_b**2 * se_a**2 / mean_a**4
    se = math.sqrt(var)
    zc = float(stats.norm.ppf(1 - alpha / 2))
    lift = ratio - 1
    return RelativeLiftResult(float(lift), float(lift - zc * se), float(lift + zc * se), float(se), alpha, "delta")


def relative_lift_proportions(conv_a: int, n_a: int, conv_b: int, n_b: int, alpha: float = 0.05) -> RelativeLiftResult:
    """Delta-method CI for the relative lift of a conversion rate; se_i = sqrt(p_i (1 - p_i) / n_i)."""
    _check_counts(conv_a, n_a, "A")
    _check_counts(conv_b, n_b, "B")
    p_a, p_b = conv_a / n_a, conv_b / n_b
    if p_a == 0:
        raise ValueError("control conversions must be > 0 for a relative lift")
    return relative_lift_ci(p_a, math.sqrt(p_a * (1 - p_a) / n_a), p_b, math.sqrt(p_b * (1 - p_b) / n_b), alpha)


def relative_lift_means(a: MeanStats, b: MeanStats, alpha: float = 0.05) -> RelativeLiftResult:
    """Delta-method CI for the relative lift of a mean; se_i = sqrt(var_i / n_i)."""
    _check_mean_stats(a, "A")
    _check_mean_stats(b, "B")
    return relative_lift_ci(a.mean, math.sqrt(a.var / a.n), b.mean, math.sqrt(b.var / b.n), alpha)


def ratio_metric_delta(
    num_a: Sequence[float] | np.ndarray,
    den_a: Sequence[float] | np.ndarray,
    num_b: Sequence[float] | np.ndarray,
    den_b: Sequence[float] | np.ndarray,
    alpha: float = 0.05,
) -> RelativeLiftResult:
    """Relative lift of a ratio metric (e.g. bookings per session) built from per-user numerators and denominators.

    Each arm's metric is the ratio of sums R = sum(num) / sum(den); its variance comes from the
    delta method on the per-user pairs (sample covariances, ddof=1):

        Var(R) = (s_num^2 - 2 R s_num,den + R^2 s_den^2) / (n * mean(den)^2)

    The two arm estimates then go through ``relative_lift_ci``.
    """
    r_a, se_a = _ratio_arm(num_a, den_a, "A")
    r_b, se_b = _ratio_arm(num_b, den_b, "B")
    return relative_lift_ci(r_a, se_a, r_b, se_b, alpha)


# --------------------------------------------------------------------------- planning
def sample_size_proportion(baseline: float, mde_rel: float, alpha: float = 0.05, power: float = 0.8, two_sided: bool = True) -> int:
    """Visitors *per arm* to detect a relative lift `mde_rel` on a conversion rate.

    Classic two-proportion formula:
        n = ((z_{1-α/2} sqrt(2 p̄ q̄) + z_{power} sqrt(p1 q1 + p2 q2)) / (p2 - p1))²
    Example: baseline 10 %, MDE +10 % relative (→ 11 %), α = 0.05, power 0.8 → 14,751 per arm.
    """
    if not 0 < baseline < 1:
        raise ValueError("baseline must be in (0, 1)")
    if mde_rel == 0:
        raise ValueError("mde_rel must be non-zero")
    p1 = baseline
    p2 = baseline * (1 + mde_rel)
    if not 0 < p2 < 1:
        raise ValueError("baseline * (1 + mde_rel) must stay in (0, 1)")
    z_a = float(stats.norm.ppf(1 - alpha / (2 if two_sided else 1)))
    z_b = float(stats.norm.ppf(power))
    p_bar = (p1 + p2) / 2
    num = z_a * math.sqrt(2 * p_bar * (1 - p_bar)) + z_b * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
    return math.ceil((num / (p2 - p1)) ** 2)


def sample_size_mean(std: float, mde_abs: float, alpha: float = 0.05, power: float = 0.8, two_sided: bool = True) -> int:
    """Observations per arm to detect an absolute difference `mde_abs` in a mean with known std."""
    if std <= 0 or mde_abs == 0:
        raise ValueError("std must be > 0 and mde_abs non-zero")
    z_a = float(stats.norm.ppf(1 - alpha / (2 if two_sided else 1)))
    z_b = float(stats.norm.ppf(power))
    return math.ceil(2 * ((z_a + z_b) * std / mde_abs) ** 2)


def power_proportion(baseline: float, mde_rel: float, n_per_arm: int, alpha: float = 0.05, two_sided: bool = True) -> float:
    """Power of the two-proportion z-test at `n_per_arm` visitors per arm (inverse of ``sample_size_proportion``).

        power = Phi( (|p2 - p1| sqrt(n) - z_a sqrt(2 pbar qbar)) / sqrt(p1 q1 + p2 q2) ),   p2 = p1 (1 + mde_rel)

    with z_a = z_{1-alpha/2} (two-sided) or z_{1-alpha} (one-sided). A zero effect is allowed and
    returns the rejection rate under H0 in the tested direction (alpha/2 two-sided, alpha one-sided).
    """
    if not 0 < baseline < 1:
        raise ValueError("baseline must be in (0, 1)")
    if n_per_arm <= 0:
        raise ValueError("n_per_arm must be positive")
    if not 0 < alpha < 1:
        raise ValueError("alpha must be in (0, 1)")
    p1 = baseline
    p2 = baseline * (1 + mde_rel)
    if not 0 < p2 < 1:
        raise ValueError("baseline * (1 + mde_rel) must stay in (0, 1)")
    z_a = float(stats.norm.ppf(1 - alpha / (2 if two_sided else 1)))
    p_bar = (p1 + p2) / 2
    num = abs(p2 - p1) * math.sqrt(n_per_arm) - z_a * math.sqrt(2 * p_bar * (1 - p_bar))
    den = math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
    return float(stats.norm.cdf(num / den))


def power_mean(std: float, mde_abs: float, n_per_arm: int, alpha: float = 0.05, two_sided: bool = True) -> float:
    """Power of the two-sample z/t-test for a mean difference at `n_per_arm` (inverse of ``sample_size_mean``).

        power = Phi( |mde_abs| sqrt(n / 2) / std - z_a )
    """
    if std <= 0:
        raise ValueError("std must be > 0")
    if n_per_arm <= 0:
        raise ValueError("n_per_arm must be positive")
    if not 0 < alpha < 1:
        raise ValueError("alpha must be in (0, 1)")
    z_a = float(stats.norm.ppf(1 - alpha / (2 if two_sided else 1)))
    return float(stats.norm.cdf(abs(mde_abs) * math.sqrt(n_per_arm / 2) / std - z_a))


def mde_at_n(baseline: float, n_per_arm: int, alpha: float = 0.05, power: float = 0.8, two_sided: bool = True) -> float:
    """Smallest *relative* lift detectable with the requested power at `n_per_arm` visitors per arm.

    Solves power_proportion(baseline, mde, n_per_arm) = power for mde: the first sign change on a
    256-point grid over (0, (1 - baseline) / baseline) is bracketed, then refined by bisection to
    floating-point precision. The grid step guards against the slightly non-monotone power curve
    that very small samples can show; raises ValueError when no lift reaches the requested power.
    """
    if not 0 < baseline < 1:
        raise ValueError("baseline must be in (0, 1)")
    if n_per_arm <= 0:
        raise ValueError("n_per_arm must be positive")
    if not 0 < alpha < 1:
        raise ValueError("alpha must be in (0, 1)")
    if not 0 < power < 1:
        raise ValueError("power must be in (0, 1)")
    floor = power_proportion(baseline, 0.0, n_per_arm, alpha, two_sided)
    if power <= floor:
        raise ValueError("power must exceed the rejection rate under no effect (alpha/2 two-sided, alpha one-sided)")

    def excess(m: float) -> float:
        return power_proportion(baseline, m, n_per_arm, alpha, two_sided) - power

    top = (1 - baseline) / baseline * (1 - 1e-9)  # keeps the treatment rate strictly below 1
    steps = 256
    lo, hi = 0.0, math.nan
    for k in range(1, steps + 1):
        m = top * k / steps
        if excess(m) >= 0:
            hi = m
            break
        lo = m
    if math.isnan(hi):
        raise ValueError("n_per_arm is too small to reach the requested power for any lift")
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if mid <= lo or mid >= hi:
            break
        if excess(mid) >= 0:
            hi = mid
        else:
            lo = mid
    return float(hi)


# --------------------------------------------------------------------------- guardrails
def srm_check(observed: Sequence[int], expected_ratios: Sequence[float] | None = None, alpha: float = 0.001) -> SRMResult:
    """Sample-ratio-mismatch check: chi-square goodness of fit of arm sizes vs the intended split.

    Uses a strict alpha (0.001 by default) because an SRM invalidates the whole test.
    """
    obs = np.asarray(observed, dtype=float)
    if obs.ndim != 1 or len(obs) < 2 or (obs < 0).any():
        raise ValueError("observed must be >= 2 non-negative counts")
    ratios = np.full(len(obs), 1 / len(obs)) if expected_ratios is None else np.asarray(expected_ratios, dtype=float)
    if len(ratios) != len(obs) or not math.isclose(ratios.sum(), 1.0, abs_tol=1e-9):
        raise ValueError("expected_ratios must match observed length and sum to 1")
    exp = ratios * obs.sum()
    chi2 = float(((obs - exp) ** 2 / exp).sum())
    p = float(stats.chi2.sf(chi2, df=len(obs) - 1))
    return SRMResult(tuple(int(v) for v in obs), tuple(float(v) for v in exp), chi2, p, bool(p < alpha))


def cuped(y_a: Sequence[float], x_a: Sequence[float], y_b: Sequence[float], x_b: Sequence[float]) -> CupedResult:
    """CUPED variance reduction (Deng et al., 2013).

    y = experiment-period metric, x = the same metric in the pre-period (a covariate
    that is independent of the treatment). Both arms share one theta = cov(x, y) / var(x)
    so the adjustment stays unbiased for the treatment effect.
    """
    ya, xa, yb, xb = (np.asarray(v, dtype=float) for v in (y_a, x_a, y_b, x_b))
    if len(ya) != len(xa) or len(yb) != len(xb) or len(ya) < 2 or len(yb) < 2:
        raise ValueError("y and x must be paired per user and have >= 2 users per arm")
    y = np.concatenate([ya, yb])
    x = np.concatenate([xa, xb])
    var_x = x.var(ddof=1)
    if var_x == 0:
        raise ValueError("covariate has zero variance")
    theta = float(np.cov(x, y, ddof=1)[0, 1] / var_x)
    x_mean = x.mean()
    adj_a = ya - theta * (xa - x_mean)
    adj_b = yb - theta * (xb - x_mean)
    var_before = float(y.var(ddof=1))
    var_after = float(np.concatenate([adj_a, adj_b]).var(ddof=1))
    return CupedResult(theta, var_before, var_after, 1 - var_after / var_before if var_before > 0 else 0.0, adj_a, adj_b)


def cuped_from_sums(a: Sums, b: Sums) -> CupedSumsResult:
    """CUPED from per-arm aggregate sums (same estimator as ``cuped``, identical to the web app's ``cuped``).

    theta = cov(x, y) / var(x) over both arms pooled (sample moments, ddof=1); each arm's adjusted
    mean is mean_y - theta (mean_x - pooled mean_x) and its adjusted variance

        var_y + theta^2 var_x - 2 theta cov_xy      (per arm, floored at 1e-12)

    A constant covariate gives theta = 0 (no adjustment) instead of an error, like the web app.
    var_before / var_after are the pooled y variance and var_y - theta^2 var_x.
    """
    if a.n < 2 or b.n < 2:
        raise ValueError("each arm needs at least two users")
    both = a + b
    mx, my = both.sx / both.n, both.sy / both.n
    var_x = (both.sxx - both.n * mx * mx) / (both.n - 1)
    cov_xy = (both.sxy - both.n * mx * my) / (both.n - 1)
    theta = cov_xy / var_x if var_x > 0 else 0.0
    var_y = (both.syy - both.n * my * my) / (both.n - 1)
    var_adj = var_y - theta * theta * var_x

    def adjust(s: Sums) -> MeanStats:
        mxs, mys = s.sx / s.n, s.sy / s.n
        vy = (s.syy - s.n * mys * mys) / (s.n - 1)
        vx = (s.sxx - s.n * mxs * mxs) / (s.n - 1)
        cxy = (s.sxy - s.n * mxs * mys) / (s.n - 1)
        return MeanStats(s.n, float(mys - theta * (mxs - mx)), float(max(_ADJ_VAR_FLOOR, vy + theta * theta * vx - 2 * theta * cxy)))

    reduction = 1 - var_adj / var_y if var_y > 0 else 0.0
    return CupedSumsResult(float(theta), float(var_y), float(var_adj), float(reduction), adjust(a), adjust(b))


def bonferroni(p_values: Sequence[float], alpha: float = 0.05) -> list[bool]:
    """Reject H0 for each p-value at the Bonferroni-adjusted threshold alpha / m."""
    m = len(p_values)
    return [p < alpha / m for p in p_values]


def holm(p_values: Sequence[float], alpha: float = 0.05) -> list[bool]:
    """Holm–Bonferroni step-down procedure (uniformly more powerful than Bonferroni, same FWER)."""
    m = len(p_values)
    order = sorted(range(m), key=lambda i: p_values[i])
    reject = [False] * m
    for k, i in enumerate(order):
        if p_values[i] < alpha / (m - k):
            reject[i] = True
        else:
            break
    return reject


# --------------------------------------------------------------------------- helpers
def _check_counts(conv: int, n: int, name: str) -> None:
    if n <= 0 or conv < 0 or conv > n:
        raise ValueError(f"group {name}: need 0 <= conversions <= visitors and visitors > 0")


def _check_mean_stats(s: MeanStats, name: str) -> None:
    if s.n < 2:
        raise ValueError(f"group {name}: need at least two observations")
    if not (math.isfinite(s.mean) and math.isfinite(s.var)) or s.var < 0:
        raise ValueError(f"group {name}: mean and variance must be finite and the variance non-negative")


def _ratio_arm(num: Sequence[float] | np.ndarray, den: Sequence[float] | np.ndarray, name: str) -> tuple[float, float]:
    """Ratio of sums and its delta-method standard error for one arm."""
    x, d = np.asarray(num, dtype=float), np.asarray(den, dtype=float)
    if x.ndim != 1 or x.shape != d.shape:
        raise ValueError(f"group {name}: numerators and denominators must be 1-d arrays of the same length (paired per user)")
    n = len(x)
    if n < 2:
        raise ValueError(f"group {name}: need at least two users")
    den_sum = float(d.sum())
    if den_sum <= 0:
        raise ValueError(f"group {name}: denominators must sum to a positive value")
    ratio = float(x.sum()) / den_sum
    c = np.cov(x, d, ddof=1)
    var_ratio = (c[0, 0] - 2 * ratio * c[0, 1] + ratio * ratio * c[1, 1]) / (n * float(d.mean()) ** 2)
    return ratio, math.sqrt(max(float(var_ratio), 0.0))
