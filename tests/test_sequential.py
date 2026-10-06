"""Tests for abkit.sequential — mSPRT always-valid p-values (legal peeking).

Running this file directly (``python3 tests/test_sequential.py``) regenerates the cross-language parity fixture
``tests/fixtures/sequential.json`` from the Python implementation. The TypeScript twin
(``webapp/src/lib/sequential.ts``) asserts the same numbers to a relative tolerance of 1e-12.
"""
from __future__ import annotations

import json
import math
import sys
from collections.abc import Sequence
from dataclasses import FrozenInstanceError
from itertools import pairwise
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from scipy import stats

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:  # lets `python3 tests/test_sequential.py` import the package without installing it
    sys.path.insert(0, str(ROOT))

from abkit.sequential import (  # noqa: E402
    SequentialResult,
    always_valid_p,
    mixture_likelihood_ratio,
    msprt_means,
    msprt_proportions,
    tau_from_mde,
)
from abkit.stats import MeanStats  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "sequential.json"
REL = 1e-12


# --------------------------------------------------------------------------- mixture likelihood ratio
def test_mixture_lr_matches_hand_calculation() -> None:
    diff, v, tau = 0.004, 1.8e-6, 0.01
    lr = mixture_likelihood_ratio(diff, v, tau)
    assert lr == pytest.approx(10.467207377136294, rel=REL)
    # the same number from the defining formula ...
    by_formula = math.sqrt(v / (v + tau**2)) * math.exp(diff**2 * tau**2 / (2 * v * (v + tau**2)))
    assert lr == pytest.approx(by_formula, rel=REL)
    # ... and from its derivation: ratio of the marginal density N(0, V + τ²) to the null density N(0, V)
    by_density = stats.norm.pdf(diff, 0, math.sqrt(v + tau**2)) / stats.norm.pdf(diff, 0, math.sqrt(v))
    assert lr == pytest.approx(by_density, rel=1e-9)
    assert mixture_likelihood_ratio(-diff, v, tau) == lr  # two-sided: the sign of the effect does not matter
    assert mixture_likelihood_ratio(0.0, v, tau) == pytest.approx(math.sqrt(v / (v + tau**2)), rel=REL)
    assert 0 < mixture_likelihood_ratio(0.0, v, tau) < 1  # no observed difference is (mild) evidence for H0


def test_mixture_lr_validation_and_degenerate_variance() -> None:
    for bad_args in ((0.1, -1e-6, 0.01), (0.1, 1e-6, 0.0), (0.1, 1e-6, -0.01), (math.nan, 1e-6, 0.01), (0.1, math.inf, 0.01), (0.1, 1e-6, math.nan)):
        with pytest.raises(ValueError):
            mixture_likelihood_ratio(*bad_args)
    # zero variance is the limit of the formula: no difference → 0 (contributes nothing), any difference → +inf
    assert mixture_likelihood_ratio(0.0, 0.0, 0.01) == 0.0
    assert mixture_likelihood_ratio(1e-9, 0.0, 0.01) == math.inf
    # overwhelming evidence overflows exp(); it must come back as +inf, not as an exception
    assert mixture_likelihood_ratio(0.5, 1e-9, 0.01) == math.inf


def test_lr_has_unit_expectation_under_null() -> None:
    # Under H0 (diff ~ N(0, V) with the true V) the mixture LR is a martingale with E[Λ] = 1 — the fact behind the
    # always-valid guarantee. τ² < V keeps the variance of Λ finite so the Monte-Carlo mean is well behaved.
    rng = np.random.default_rng(11)
    v, tau = 4e-4, 0.01
    diffs = rng.normal(0.0, math.sqrt(v), 100_000)
    mean_lr = float(np.mean([mixture_likelihood_ratio(float(d), v, tau) for d in diffs]))
    assert mean_lr == pytest.approx(1.0, abs=0.01)


# --------------------------------------------------------------------------- always-valid p
def test_always_valid_p_is_monotone_and_bounded() -> None:
    rng = np.random.default_rng(3)
    lrs = np.exp(rng.normal(0, 2, 500)).tolist()
    p = always_valid_p(lrs)
    assert len(p) == len(lrs)
    assert all(0 < x <= 1 for x in p)
    assert all(a >= b for a, b in pairwise(p))  # non-increasing
    running = 0.0
    for lr, pk in zip(lrs, p, strict=True):
        running = max(running, lr)
        assert pk == pytest.approx(min(1.0, 1.0 / running), rel=REL)
    assert always_valid_p([]) == []
    assert always_valid_p([0.0, 0.5, 1.0]) == [1.0, 1.0, 1.0]  # never above 1, never undefined
    assert always_valid_p([0.0, 4.0, 2.0, math.inf]) == [1.0, 0.25, 0.25, 0.0]
    with pytest.raises(ValueError):
        always_valid_p([1.0, -0.1])
    with pytest.raises(ValueError):
        always_valid_p([math.nan])


def test_tau_from_mde_heuristic() -> None:
    assert tau_from_mde(0.01) == 0.01
    assert tau_from_mde(-0.01) == 0.01  # a planned decrease has the same magnitude
    assert tau_from_mde(0.1 * 0.1) == pytest.approx(0.01, rel=REL)  # 10 % baseline, +10 % relative → τ = 0.01
    for bad in (0.0, math.nan, math.inf):
        with pytest.raises(ValueError):
            tau_from_mde(bad)


# --------------------------------------------------------------------------- proportions
def test_msprt_proportions_uses_cumulative_counts() -> None:
    # 5 looks of CUMULATIVE counts (A = control, B = treatment); B pulls ahead from look 3 on
    conv_a, n_a = [95, 205, 310, 405, 500], [1000, 2000, 3000, 4000, 5000]
    conv_b, n_b = [110, 230, 370, 500, 640], [1000, 2000, 3000, 4000, 5000]
    res = msprt_proportions(conv_a, n_a, conv_b, n_b, tau=0.02, alpha=0.05)
    assert isinstance(res, SequentialResult)
    assert len(res.lr) == len(res.always_valid_p) == 5
    assert res.tau == 0.02 and res.alpha == 0.05
    for k in range(5):
        p_a, p_b = conv_a[k] / n_a[k], conv_b[k] / n_b[k]
        pooled = (conv_a[k] + conv_b[k]) / (n_a[k] + n_b[k])
        v = pooled * (1 - pooled) * (1 / n_a[k] + 1 / n_b[k])
        assert res.lr[k] == pytest.approx(mixture_likelihood_ratio(p_b - p_a, v, 0.02), rel=REL)
    assert list(res.always_valid_p) == pytest.approx(always_valid_p(res.lr), rel=REL)
    assert res.always_valid_p[0] == 1.0 and res.always_valid_p[1] == 1.0  # Λ < 1 at the first two looks
    assert res.always_valid_p[2] > 0.05 > res.always_valid_p[3] > res.always_valid_p[4]
    assert res.decided_at == 4  # 1-based first look with p < alpha
    assert msprt_proportions(conv_a, n_a, conv_b, n_b, tau=0.02, alpha=0.01).decided_at == 5
    assert msprt_proportions(conv_a, n_a, conv_b, n_b, tau=0.02, alpha=1e-4).decided_at is None
    d = res.as_dict()
    assert set(d) == {"tau", "alpha", "lr", "always_valid_p", "decided_at"}
    assert isinstance(d["lr"], list) and isinstance(d["always_valid_p"], list) and d["decided_at"] == 4
    assert json.loads(json.dumps(d)) == d  # JSON-serialisable as is
    with pytest.raises(FrozenInstanceError):
        res.tau = 1.0  # type: ignore[misc]
    # the inputs are running totals: per-look increments (or anything non-monotone) are rejected
    with pytest.raises(ValueError):
        msprt_proportions([10, 5], [100, 200], [10, 20], [100, 200], tau=0.01)
    with pytest.raises(ValueError):
        msprt_proportions([10, 20], [200, 100], [10, 20], [100, 200], tau=0.01)
    with pytest.raises(ValueError):
        msprt_proportions([10, 20], [100, 200], [10, 20], [100], tau=0.01)
    with pytest.raises(ValueError):
        msprt_proportions([10, 250], [100, 200], [10, 20], [100, 200], tau=0.01)
    with pytest.raises(ValueError):
        msprt_proportions([], [], [], [], tau=0.01)
    with pytest.raises(ValueError):
        msprt_proportions(conv_a, n_a, conv_b, n_b, tau=0.0)
    with pytest.raises(ValueError):
        msprt_proportions(conv_a, n_a, conv_b, n_b, tau=0.02, alpha=1.0)


def test_msprt_proportions_default_tau_from_final_baseline() -> None:
    conv_a, n_a = [40, 100, 160], [500, 1000, 1500]
    conv_b, n_b = [45, 110, 170], [500, 1000, 1500]
    res = msprt_proportions(conv_a, n_a, conv_b, n_b)
    base = 160 / 1500
    assert res.tau == pytest.approx(tau_from_mde(base * 0.05), rel=REL)  # default: 5 % relative MDE on p̂A at the last look
    res2 = msprt_proportions(conv_a, n_a, conv_b, n_b, mde_rel=0.1)
    assert res2.tau == pytest.approx(base * 0.1, rel=REL)
    explicit = msprt_proportions(conv_a, n_a, conv_b, n_b, tau=res2.tau)
    assert explicit.lr == res2.lr and explicit.always_valid_p == res2.always_valid_p
    with pytest.raises(ValueError):
        msprt_proportions([0, 0], [10, 20], [1, 2], [10, 20])  # zero baseline → τ cannot be derived
    with pytest.raises(ValueError):
        msprt_proportions(conv_a, n_a, conv_b, n_b, mde_rel=0.0)


def test_msprt_proportions_leading_looks_without_evidence() -> None:
    # no users at the first look, no conversions at the second: no evidence yet (Λ = 0, p = 1); later looks unaffected
    res = msprt_proportions([0, 0, 12, 30], [0, 50, 400, 1000], [0, 0, 20, 52], [0, 50, 400, 1000], tau=0.02)
    assert len(res.lr) == 4
    assert res.lr[0] == 0.0 and res.lr[1] == 0.0
    assert res.always_valid_p[0] == 1.0 and res.always_valid_p[1] == 1.0
    tail = msprt_proportions([12, 30], [400, 1000], [20, 52], [400, 1000], tau=0.02)
    assert res.lr[2:] == tail.lr and res.always_valid_p[2:] == tail.always_valid_p


# --------------------------------------------------------------------------- means
def test_msprt_means_matches_formula_and_validates() -> None:
    a = [MeanStats(200, 10.0, 4.0), MeanStats(400, 10.1, 4.2), MeanStats(800, 10.05, 4.1)]
    b = [MeanStats(200, 10.4, 4.5), MeanStats(400, 10.5, 4.4), MeanStats(800, 10.55, 4.3)]
    res = msprt_means(a, b, tau=0.5, alpha=0.05)
    assert len(res.lr) == 3
    for k in range(3):
        v = a[k].var / a[k].n + b[k].var / b[k].n  # Welch variance of the difference of means
        assert res.lr[k] == pytest.approx(mixture_likelihood_ratio(b[k].mean - a[k].mean, v, 0.5), rel=REL)
    assert res.always_valid_p == tuple(always_valid_p(res.lr))
    assert res.always_valid_p[0] > 0.05 and res.always_valid_p[1] > 0.05 and res.always_valid_p[2] < 0.001
    assert res.decided_at == 3
    with pytest.raises(ValueError):
        msprt_means(a, b[:2], tau=0.5)
    with pytest.raises(ValueError):
        msprt_means([], [], tau=0.5)
    with pytest.raises(ValueError):
        msprt_means(a, b, tau=0.0)
    with pytest.raises(ValueError):
        msprt_means(a, b, tau=0.5, alpha=0.0)
    with pytest.raises(ValueError):
        msprt_means([MeanStats(1, 10.0, 4.0)], [MeanStats(200, 10.4, 4.5)], tau=0.5)
    with pytest.raises(ValueError):
        msprt_means([MeanStats(200, 10.0, -4.0)], [MeanStats(200, 10.4, 4.5)], tau=0.5)
    with pytest.raises(ValueError):
        msprt_means([a[1], a[0]], [b[1], b[0]], tau=0.5)  # sample sizes must be cumulative too


# --------------------------------------------------------------------------- Monte-Carlo guarantees
def _simulate_cumulative(rng: np.random.Generator, sims: int, looks: int, per_look: int, p_a: float, p_b: float) -> tuple[np.ndarray, np.ndarray, list[int]]:
    inc_a = rng.binomial(per_look, p_a, size=(sims, looks))
    inc_b = rng.binomial(per_look, p_b, size=(sims, looks))
    return inc_a.cumsum(axis=1), inc_b.cumsum(axis=1), [per_look * (k + 1) for k in range(looks)]


def test_aa_any_look_false_positive_rate_stays_below_alpha() -> None:
    sims, looks, per_look, alpha = 2000, 20, 2000, 0.05
    rng = np.random.default_rng(20261)
    cum_a, cum_b, n_cum = _simulate_cumulative(rng, sims, looks, per_look, 0.1, 0.1)
    tau = tau_from_mde(0.1 * 0.1)  # tuned for a 10 % relative lift on a 10 % baseline
    results = [msprt_proportions(cum_a[i].tolist(), n_cum, cum_b[i].tolist(), n_cum, tau=tau, alpha=alpha) for i in range(sims)]
    assert all(len(r.always_valid_p) == looks for r in results)
    fpr = sum(r.decided_at is not None for r in results) / sims
    se = math.sqrt(alpha * (1 - alpha) / sims)
    assert fpr <= alpha + 3 * se
    # the naive rule "look after every chunk, stop at the first p < 0.05" on the very same data is far above alpha
    n = np.asarray(n_cum, dtype=float)
    pooled = (cum_a + cum_b) / (2 * n)
    z = (cum_b / n - cum_a / n) / np.sqrt(pooled * (1 - pooled) * (2 / n))
    naive = float((np.abs(z) > stats.norm.ppf(1 - alpha / 2)).any(axis=1).mean())
    assert naive > 0.10 and fpr < naive


def test_power_at_effect_equal_to_tau() -> None:
    sims, looks, per_look, alpha = 2000, 20, 2000, 0.05
    rng = np.random.default_rng(20262)
    tau = tau_from_mde(0.01)  # planned absolute MDE: 10 % → 11 %
    cum_a, cum_b, n_cum = _simulate_cumulative(rng, sims, looks, per_look, 0.10, 0.11)  # true effect = τ
    decided = [msprt_proportions(cum_a[i].tolist(), n_cum, cum_b[i].tolist(), n_cum, tau=tau, alpha=alpha).decided_at for i in range(sims)]
    power = sum(d is not None for d in decided) / sims
    assert power >= 0.8
    looks_used = [d for d in decided if d is not None]
    assert all(1 <= d <= looks for d in looks_used)
    assert np.median(looks_used) < looks  # most decisions arrive before the last look: early stopping saves data


# --------------------------------------------------------------------------- cross-language parity fixture
def _daily_counts(days: int, users_base: int, users_step: int, rate_permille: int, noise_mod: int, noise_mul: int, noise_off: int) -> tuple[list[int], list[int]]:
    """Deterministic arithmetic 'traffic' (no RNG, so the fixture never depends on a random-number stream)."""
    conv: list[int] = []
    n: list[int] = []
    tot_c = tot_n = 0
    for k in range(days):
        users = users_base + (k * users_step) % 900
        tot_n += users
        tot_c += users * rate_permille // 1000 + (k * noise_mul) % noise_mod - noise_off
        n.append(tot_n)
        conv.append(tot_c)
    return conv, n


def _proportion_case(name: str, conv_a: list[int], n_a: list[int], conv_b: list[int], n_b: list[int], tau: float | None, alpha: float, mde_rel: float | None) -> dict[str, Any]:
    res = msprt_proportions(conv_a, n_a, conv_b, n_b, tau=tau, alpha=alpha, mde_rel=mde_rel)
    return {"name": name, "conv_a": conv_a, "n_a": n_a, "conv_b": conv_b, "n_b": n_b, "tau": tau, "alpha": alpha, "mde_rel": mde_rel, "expected": res.as_dict()}


def _mean_case(name: str, a: Sequence[dict[str, Any]], b: Sequence[dict[str, Any]], tau: float, alpha: float) -> dict[str, Any]:
    res = msprt_means([MeanStats(**s) for s in a], [MeanStats(**s) for s in b], tau=tau, alpha=alpha)
    return {"name": name, "a": list(a), "b": list(b), "tau": tau, "alpha": alpha, "expected": res.as_dict()}


def _build_fixture() -> dict[str, Any]:
    lr_inputs = [
        (0.004, 1.8e-6, 0.01), (0.0, 1.8e-6, 0.01), (-0.004, 1.8e-6, 0.01), (0.001, 1.8e-6, 0.01), (0.01, 1.8e-6, 0.01),
        (0.004, 1.8e-6, 0.001), (0.004, 1.8e-6, 0.1), (0.004, 1e-4, 0.01), (0.004, 1e-7, 0.01), (0.5, 0.01, 0.5),
        (0.5, 0.0425, 0.5), (0.0, 0.0425, 0.5), (-0.25, 0.0105, 0.5), (2.0, 1.0, 1.0), (0.0, 1.0, 1.0),
        (1e-3, 1e-6, 1e-3), (3e-3, 2.5e-6, 5e-3), (0.02, 4.04e-5, 0.02), (0.0, 0.0, 0.01), (0.015, 1.84e-4, 0.02),
    ]
    p_inputs = [[0.5, 0.8, 1.0], [0.3, 2.0, 1.5, 8.0, 4.0, 40.0, 10.0], [0.0, 0.0, 3.0, 1e6, 2.0], [1.0]]
    tau_inputs = [0.01, -0.01, 0.0025, 2.5]
    fx_a_conv, fx_a_n = _daily_counts(14, 2500, 373, 100, 11, 7, 5)
    fx_b_conv, fx_b_n = _daily_counts(14, 2500, 521, 112, 9, 5, 4)
    flat_a_conv, flat_a_n = _daily_counts(10, 3000, 211, 100, 7, 3, 3)
    flat_b_conv, flat_b_n = _daily_counts(10, 3000, 307, 100, 5, 2, 2)
    three_a = [{"n": 200, "mean": 10.0, "var": 4.0}, {"n": 400, "mean": 10.1, "var": 4.2}, {"n": 800, "mean": 10.05, "var": 4.1}]
    three_b = [{"n": 200, "mean": 10.4, "var": 4.5}, {"n": 400, "mean": 10.5, "var": 4.4}, {"n": 800, "mean": 10.55, "var": 4.3}]
    six_n = [250, 500, 1000, 2000, 4000, 8000]
    six_a = [{"n": n, "mean": m, "var": v} for n, m, v in zip(six_n, [20.0, 20.1, 19.95, 20.02, 20.0, 19.99], [25.0, 24.5, 25.2, 24.9, 25.1, 25.0], strict=True)]
    six_b = [{"n": n, "mean": m, "var": v} for n, m, v in zip(six_n, [20.3, 20.25, 20.2, 20.22, 20.18, 20.19], [25.5, 25.1, 24.8, 25.0, 25.2, 25.1], strict=True)]
    return {
        "_note": "Generated by `python3 tests/test_sequential.py` from abkit.sequential (Python). Consumed by webapp/src/lib/sequential.test.ts "
        "at a relative tolerance of 1e-12. Count and mean inputs are CUMULATIVE per look; decided_at is the 1-based first look with p < alpha.",
        "lr_cases": [{"diff": d, "var_diff": v, "tau": t, "lr": mixture_likelihood_ratio(d, v, t)} for d, v, t in lr_inputs],
        "always_valid_p_cases": [{"lrs": lrs, "p": always_valid_p(lrs)} for lrs in p_inputs],
        "tau_cases": [{"mde_abs": m, "tau": tau_from_mde(m)} for m in tau_inputs],
        "proportion_cases": [
            _proportion_case("explicit_tau", [95, 205, 310, 405, 500], [1000, 2000, 3000, 4000, 5000], [110, 230, 370, 500, 640], [1000, 2000, 3000, 4000, 5000], 0.02, 0.05, None),
            _proportion_case("default_tau", [40, 100, 160], [500, 1000, 1500], [45, 110, 170], [500, 1000, 1500], None, 0.05, None),
            _proportion_case("default_tau_mde_rel", [40, 100, 160], [500, 1000, 1500], [45, 110, 170], [500, 1000, 1500], None, 0.01, 0.1),
            _proportion_case("leading_no_data", [0, 0, 12, 30], [0, 50, 400, 1000], [0, 0, 20, 52], [0, 50, 400, 1000], 0.02, 0.05, None),
            _proportion_case("fourteen_days_lift", fx_a_conv, fx_a_n, fx_b_conv, fx_b_n, None, 0.05, 0.1),
            _proportion_case("ten_days_flat", flat_a_conv, flat_a_n, flat_b_conv, flat_b_n, 0.01, 0.05, None),
        ],
        "mean_cases": [_mean_case("three_looks", three_a, three_b, 0.5, 0.05), _mean_case("six_looks_small_effect", six_a, six_b, 0.2, 0.01)],
    }


def _assert_close(a: object, b: object, path: str = "$") -> None:
    if isinstance(a, dict):
        assert isinstance(b, dict) and a.keys() == b.keys(), path
        for k in a:
            _assert_close(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        assert isinstance(b, list) and len(a) == len(b), f"{path}: length {len(a)} vs {len(b) if isinstance(b, list) else b!r}"
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            _assert_close(x, y, f"{path}[{i}]")
    elif isinstance(a, bool) or a is None or isinstance(a, str):
        assert a == b, f"{path}: {a!r} != {b!r}"
    elif isinstance(a, int | float):
        assert isinstance(b, int | float) and math.isclose(a, b, rel_tol=REL, abs_tol=0.0), f"{path}: {a!r} != {b!r}"
    else:
        raise AssertionError(f"{path}: unexpected type {type(a).__name__}")


def _all_finite(x: object) -> bool:
    if isinstance(x, dict):
        return all(_all_finite(v) for v in x.values())
    if isinstance(x, list):
        return all(_all_finite(v) for v in x)
    if isinstance(x, bool) or x is None or isinstance(x, str):
        return True
    return isinstance(x, int | float) and math.isfinite(x)


def test_fixture_matches_implementation() -> None:
    assert FIXTURE.exists(), "regenerate with: python3 tests/test_sequential.py"
    loaded = json.loads(FIXTURE.read_text())
    assert len(loaded["lr_cases"]) >= 20 and len(loaded["proportion_cases"]) >= 4 and len(loaded["mean_cases"]) >= 2
    _assert_close(loaded, _build_fixture())


def _dump(fixture: dict[str, Any]) -> str:
    """One case per line: readable, diff-friendly, exact (Python repr round-trips every float)."""
    keys = list(fixture)
    lines = ["{"]
    for i, key in enumerate(keys):
        value = fixture[key]
        comma = "," if i < len(keys) - 1 else ""
        if isinstance(value, list):
            lines.append(f' "{key}": [')
            for j, case in enumerate(value):
                lines.append("  " + json.dumps(case) + ("," if j < len(value) - 1 else ""))
            lines.append(" ]" + comma)
        else:
            lines.append(f' "{key}": {json.dumps(value)}{comma}')
    lines.append("}")
    return "\n".join(lines) + "\n"


def _write_fixture() -> None:
    fixture = _build_fixture()
    assert _all_finite(fixture), "fixture values must stay finite (JSON has no inf/nan)"
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(_dump(fixture))
    print(f"wrote {FIXTURE.relative_to(ROOT)}")


if __name__ == "__main__":  # pragma: no cover
    _write_fixture()
