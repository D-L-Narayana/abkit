"""Sequential testing: mixture sequential probability ratio test (mSPRT) with always-valid p-values.

A fixed-horizon test (z-test, Welch's t-test) is only valid when the data are analysed once, at the planned
sample size. Teams look at dashboards every day, and "stop at the first p < 0.05" inflates the false-positive
rate several-fold (the ``peeking`` study in ``abkit.simulate`` measures it). The mixture SPRT (Robbins, 1970;
Johari, Pekelis & Walsh, "Always valid inference") is a test whose type-I error stays below alpha no matter how
often or when you look, so stopping at the first look with p_k < alpha is legitimate ("legal peeking").

Model. At look k the observed difference (rate B - rate A, or mean B - mean A) is treated as δ̂_k ~ N(δ, V_k)
with V_k its estimated variance; H0 is δ = 0. Instead of one point alternative, the alternative is mixed over
a normal prior δ ~ N(0, τ²) (the "mixing distribution"), which gives the closed-form mixture likelihood ratio

    Λ_k = sqrt( V_k / (V_k + τ²) ) · exp( δ̂_k² · τ² / (2 · V_k · (V_k + τ²)) )

Under H0 the sequence (Λ_k) is a non-negative martingale with E[Λ_k] = 1, so Ville's inequality gives
P(max_k Λ_k ≥ 1/alpha) ≤ alpha. Hence

    p_k = min(1, 1 / max_{j ≤ k} Λ_j)

is an always-valid p-value: P(∃ k: p_k < alpha) ≤ alpha under H0 for any stopping rule, and the sequence is
non-increasing (evidence, once observed, is never un-observed).

τ heuristic. The test is most sensitive to effects of size ≈ τ; we use τ = |planned absolute MDE|, the effect the
experiment was designed to detect (``tau_from_mde``). A larger τ decides faster on big effects and slower on small ones.

Caveats. V_k is estimated, not known (fine for A/B sample sizes, not for n in the tens). The guarantee is
conservative — the realised false-positive rate is below alpha, not equal to it — so at the planned sample size the
always-valid p has less power than the fixed-horizon test: use it to stop early, and read the fixed-horizon p when
the planned sample size is reached.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any

from .stats import MeanStats


@dataclass(frozen=True)
class SequentialResult:
    """mSPRT output, one entry per look.

    ``lr[k]`` is the mixture likelihood ratio Λ_k, ``always_valid_p[k]`` = min(1, 1 / max_{j ≤ k} Λ_j) (non-increasing),
    ``decided_at`` the 1-based index of the first look with p_k < alpha (``None`` when no look crossed alpha).
    """

    tau: float
    alpha: float
    lr: tuple[float, ...]
    always_valid_p: tuple[float, ...]
    decided_at: int | None

    def as_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["lr"] = list(self.lr)
        d["always_valid_p"] = list(self.always_valid_p)
        return d


def mixture_likelihood_ratio(diff: float, var_diff: float, tau: float) -> float:
    """Mixture likelihood ratio Λ of an observed difference ``diff`` with variance ``var_diff`` under the N(0, τ²) prior.

        Λ = sqrt( V / (V + τ²) ) · exp( diff² · τ² / (2 · V · (V + τ²)) ),   V = var_diff

    This is the marginal density of diff under H1 (δ ~ N(0, τ²) ⇒ diff ~ N(0, V + τ²)) divided by its density under
    H0 (diff ~ N(0, V)); it depends on diff² only, so the test is two-sided. V = 0 (no users yet, or identical arms
    with no spread) returns the limit of the formula: 0 when diff == 0, +inf otherwise. Overflow returns +inf.
    """
    if not (math.isfinite(diff) and math.isfinite(var_diff) and math.isfinite(tau)):
        raise ValueError("diff, var_diff and tau must be finite numbers")
    if var_diff < 0:
        raise ValueError("var_diff must be >= 0")
    if tau <= 0:
        raise ValueError("tau must be > 0")
    if var_diff == 0:
        return 0.0 if diff == 0 else math.inf
    tau2 = tau * tau
    total = var_diff + tau2
    exponent = diff * diff * tau2 / (2 * var_diff * total)
    try:
        return math.sqrt(var_diff / total) * math.exp(exponent)
    except OverflowError:
        return math.inf


def always_valid_p(lrs: Sequence[float]) -> list[float]:
    """Always-valid p-values p_k = min(1, 1 / max_{j ≤ k} Λ_j) from the per-look mixture likelihood ratios.

    Non-increasing by construction; a running maximum ≤ 1 (including 0 = no evidence yet) gives p = 1, Λ = +inf gives p = 0.
    """
    out: list[float] = []
    running = 0.0
    for raw in lrs:
        lr = float(raw)
        if math.isnan(lr) or lr < 0:
            raise ValueError("likelihood ratios must be >= 0")
        running = max(running, lr)
        out.append(1.0 if running <= 1.0 else 1.0 / running)
    return out


def tau_from_mde(mde_abs: float) -> float:
    """Scale τ of the mixing prior N(0, τ²) from the planned absolute minimum detectable effect: τ = |mde_abs|.

    A documented heuristic rather than an optimum: the prior puts its mass on effects of the size the experiment was
    designed to detect, which is where the mSPRT reaches decisions fastest (for a conversion metric the absolute MDE
    is baseline * relative MDE, e.g. 10 % * 10 % = 0.01).
    """
    if not math.isfinite(mde_abs) or mde_abs == 0:
        raise ValueError("mde_abs must be a non-zero finite number")
    return abs(float(mde_abs))


def msprt_proportions(
    conv_a: Sequence[int],
    n_a: Sequence[int],
    conv_b: Sequence[int],
    n_b: Sequence[int],
    tau: float | None = None,
    alpha: float = 0.05,
    mde_rel: float | None = None,
) -> SequentialResult:
    """mSPRT for a conversion rate; one entry per look with CUMULATIVE counts (running totals, not per-look increments).

    Per look k: δ̂_k = p̂B_k - p̂A_k and V_k = p̄_k (1 - p̄_k) (1/nA_k + 1/nB_k) with the pooled rate p̄_k (the null
    variance, as in the pooled z-test). ``tau`` defaults to ``tau_from_mde(p̂A_final · mde_rel)`` with ``mde_rel`` = 0.05
    when neither is given — the absolute effect of a 5 % relative lift on the control rate at the last look; an explicit
    ``tau`` takes precedence over ``mde_rel``. Looks where an arm has no users yet contribute Λ = 0 (no evidence).
    """
    ca, na, cb, nb = (_as_counts(x, name) for x, name in ((conv_a, "conv_a"), (n_a, "n_a"), (conv_b, "conv_b"), (n_b, "n_b")))
    looks = len(na)
    if looks == 0 or not (len(ca) == len(cb) == len(nb) == looks):
        raise ValueError("conv_a, n_a, conv_b, n_b must be non-empty and of equal length (one entry per look)")
    _check_cumulative(ca, na, "A")
    _check_cumulative(cb, nb, "B")
    _check_alpha(alpha)
    if tau is None:
        rel = 0.05 if mde_rel is None else mde_rel
        if not math.isfinite(rel) or rel == 0:
            raise ValueError("mde_rel must be a non-zero finite number")
        if na[-1] == 0 or ca[-1] == 0:
            raise ValueError("cannot derive tau from a zero control rate at the last look; pass tau explicitly")
        tau = tau_from_mde(ca[-1] / na[-1] * rel)
    _check_tau(tau)
    lrs: list[float] = []
    for k in range(looks):
        if na[k] == 0 or nb[k] == 0:
            lrs.append(0.0)
            continue
        p_a, p_b = ca[k] / na[k], cb[k] / nb[k]
        pooled = (ca[k] + cb[k]) / (na[k] + nb[k])
        var_diff = pooled * (1 - pooled) * (1 / na[k] + 1 / nb[k])
        lrs.append(mixture_likelihood_ratio(p_b - p_a, var_diff, tau))
    return _result(lrs, tau, alpha)


def msprt_means(a: Sequence[MeanStats], b: Sequence[MeanStats], tau: float, alpha: float = 0.05) -> SequentialResult:
    """mSPRT for a continuous metric; one ``abkit.stats.MeanStats`` (n, mean, var with ddof=1) per look and arm, CUMULATIVE.

    Per look k: δ̂_k = mean_B - mean_A and V_k = var_A/n_A + var_B/n_B (the Welch variance of the difference of means).
    For CUPED pass the adjusted per-arm statistics. Every look needs n ≥ 2 per arm; sample sizes must be non-decreasing.
    """
    looks = len(a)
    if looks == 0 or len(b) != looks:
        raise ValueError("a and b must be non-empty and of equal length (one record per look)")
    _check_alpha(alpha)
    _check_tau(tau)
    lrs: list[float] = []
    prev_a = prev_b = 0
    for k, (sa, sb) in enumerate(zip(a, b, strict=True)):
        for s, name in ((sa, "A"), (sb, "B")):
            if s.n < 2 or not math.isfinite(s.mean) or not math.isfinite(s.var) or s.var < 0:
                raise ValueError(f"group {name}, look {k + 1}: need n >= 2, a finite mean and a finite variance >= 0")
        if sa.n < prev_a or sb.n < prev_b:
            raise ValueError(f"look {k + 1}: sample sizes must be cumulative (non-decreasing across looks)")
        prev_a, prev_b = sa.n, sb.n
        var_diff = sa.var / sa.n + sb.var / sb.n
        lrs.append(mixture_likelihood_ratio(sb.mean - sa.mean, var_diff, tau))
    return _result(lrs, tau, alpha)


# --------------------------------------------------------------------------- helpers
def _result(lrs: list[float], tau: float, alpha: float) -> SequentialResult:
    p = always_valid_p(lrs)
    decided = next((k + 1 for k, pk in enumerate(p) if pk < alpha), None)
    return SequentialResult(tau=float(tau), alpha=float(alpha), lr=tuple(lrs), always_valid_p=tuple(p), decided_at=decided)


def _as_counts(values: Sequence[int], name: str) -> list[int]:
    out: list[int] = []
    for v in values:
        f = float(v)
        if not f.is_integer() or f < 0:
            raise ValueError(f"{name}: counts must be non-negative integers")
        out.append(int(f))
    return out


def _check_cumulative(conv: list[int], n: list[int], name: str) -> None:
    for k, (c, m) in enumerate(zip(conv, n, strict=True)):
        if c > m:
            raise ValueError(f"group {name}, look {k + 1}: conversions exceed visitors")
        if k and (m < n[k - 1] or c < conv[k - 1]):
            raise ValueError(f"group {name}, look {k + 1}: inputs must be cumulative (non-decreasing running totals)")


def _check_alpha(alpha: float) -> None:
    if not 0 < alpha < 1:
        raise ValueError("alpha must be in (0, 1)")


def _check_tau(tau: float) -> None:
    if not (math.isfinite(tau) and tau > 0):
        raise ValueError("tau must be a positive finite number")
