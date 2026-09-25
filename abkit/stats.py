"""Frequentist A/B-test statistics used day to day on an experimentation platform.

Everything here is deliberately explicit (no statsmodels) so each formula can be
read, checked against a textbook and unit-tested.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Sequence

import numpy as np
from scipy import stats


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

    def as_dict(self) -> dict:
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

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class SRMResult:
    observed: tuple[int, ...]
    expected: tuple[float, ...]
    chi2: float
    p_value: float
    mismatch: bool

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class CupedResult:
    theta: float
    var_before: float
    var_after: float
    variance_reduction: float  # fraction, e.g. 0.36 == 36 % less variance
    adjusted_a: np.ndarray
    adjusted_b: np.ndarray


# --------------------------------------------------------------------------- tests
def two_proportion_ztest(conv_a: int, n_a: int, conv_b: int, n_b: int, alpha: float = 0.05) -> ZTestResult:
    """Two-sided pooled z-test for the difference of two conversion rates.

    A = control, B = treatment. The CI uses the unpooled standard error (Wald), the
    test statistic uses the pooled one, as is standard.
    """
    _check_counts(conv_a, n_a, "A")
    _check_counts(conv_b, n_b, "B")
    if not 0 < alpha < 1:
        raise ValueError("alpha must be in (0, 1)")
    p_a, p_b = conv_a / n_a, conv_b / n_b
    pooled = (conv_a + conv_b) / (n_a + n_b)
    se_pooled = math.sqrt(pooled * (1 - pooled) * (1 / n_a + 1 / n_b))
    z = (p_b - p_a) / se_pooled if se_pooled > 0 else 0.0
    p_value = float(2 * stats.norm.sf(abs(z)))
    se_unpooled = math.sqrt(p_a * (1 - p_a) / n_a + p_b * (1 - p_b) / n_b)
    zc = float(stats.norm.ppf(1 - alpha / 2))
    diff = p_b - p_a
    return ZTestResult(
        rate_a=p_a,
        rate_b=p_b,
        lift_abs=diff,
        lift_rel=diff / p_a if p_a > 0 else math.inf,
        z=z,
        p_value=p_value,
        ci_low=float(diff - zc * se_unpooled),
        ci_high=float(diff + zc * se_unpooled),
        alpha=alpha,
        significant=bool(p_value < alpha),
    )


def welch_ttest(a: Sequence[float], b: Sequence[float], alpha: float = 0.05) -> TTestResult:
    """Welch's unequal-variance t-test for continuous metrics (revenue per visitor, nights booked...)."""
    x, y = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    if len(x) < 2 or len(y) < 2:
        raise ValueError("each group needs at least two observations")
    va, vb = x.var(ddof=1) / len(x), y.var(ddof=1) / len(y)
    se = math.sqrt(va + vb)
    if se == 0:
        raise ValueError("zero variance in both groups")
    df = (va + vb) ** 2 / (va**2 / (len(x) - 1) + vb**2 / (len(y) - 1))
    diff = float(y.mean() - x.mean())
    t = diff / se
    p = float(2 * stats.t.sf(abs(t), df))
    tc = float(stats.t.ppf(1 - alpha / 2, df))
    return TTestResult(float(x.mean()), float(y.mean()), diff, float(t), float(df), p, float(diff - tc * se), float(diff + tc * se), alpha, bool(p < alpha))


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
    z_a = stats.norm.ppf(1 - alpha / (2 if two_sided else 1))
    z_b = stats.norm.ppf(power)
    p_bar = (p1 + p2) / 2
    num = z_a * math.sqrt(2 * p_bar * (1 - p_bar)) + z_b * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
    return int(math.ceil((num / (p2 - p1)) ** 2))


def sample_size_mean(std: float, mde_abs: float, alpha: float = 0.05, power: float = 0.8, two_sided: bool = True) -> int:
    """Observations per arm to detect an absolute difference `mde_abs` in a mean with known std."""
    if std <= 0 or mde_abs == 0:
        raise ValueError("std must be > 0 and mde_abs non-zero")
    z_a = stats.norm.ppf(1 - alpha / (2 if two_sided else 1))
    z_b = stats.norm.ppf(power)
    return int(math.ceil(2 * ((z_a + z_b) * std / mde_abs) ** 2))


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


def _check_counts(conv: int, n: int, name: str) -> None:
    if n <= 0 or conv < 0 or conv > n:
        raise ValueError(f"group {name}: need 0 <= conversions <= visitors and visitors > 0")
