"""Command-line interface — ``abkit <command> …`` (console script) or ``python -m abkit.cli <command> …``.

Commands (every one prints a single JSON document to stdout)::

    ztest CONV_A N_A CONV_B N_B [--alpha A] [--alternative two-sided|larger|smaller]
    ttest --mean-a M --sd-a S --n-a N --mean-b M --sd-b S --n-b N [--alpha A]
    samplesize BASELINE MDE_REL [--alpha A] [--power P]                conversion metric
    samplesize --metric mean --std S MDE_ABS [--alpha A] [--power P]   continuous metric
    power --n N BASELINE MDE_REL [--alpha A]                           power at a planned sample size per arm
    power --n N BASELINE --solve-mde [--alpha A] [--power P]           smallest detectable relative lift at N
    power --metric mean --std S --n N MDE_ABS | --solve-mde
    srm COUNT [COUNT …] [--ratios R …] [--alpha A]
    holm P [P …] [--alpha A]
    interleave WINS_A WINS_B [--ties T] [--alpha A]
    ndcg REL [REL …] [--k K]
    analyze FILE.csv [--alpha A] [--split S] [--mde M] [--control-label L] [--planned-per-arm N]
    simulate [--quick] [--scale F] [--out PATH] [--seed S]
    --version

Invalid input — a ``ValueError`` raised by the library or an unreadable file — is reported as one line on stderr,
``abkit <command>: error: <message>``, with exit status 2 and no traceback. Non-finite numbers (for example an
undefined relative lift when the control rate is 0) are emitted as ``null`` so the output is always strict JSON.
``main(argv)`` never touches ``sys.argv``; tests and other programs can call it directly.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import math
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from . import __version__, simulate
from .ranking import dcg, ndcg_at_k
from .stats import bonferroni, holm, sample_size_mean, sample_size_proportion, srm_check, two_proportion_ztest

Handler = Callable[[argparse.Namespace], dict[str, Any]]


# --------------------------------------------------------------------------- helpers
def _as_dict(result: Any) -> dict[str, Any]:
    """Result dataclass → dict (``as_dict()`` when the class provides it, ``dataclasses.asdict`` otherwise)."""
    if hasattr(result, "as_dict"):
        return dict(result.as_dict())
    return dataclasses.asdict(result)


def _jsonable(value: Any) -> Any:
    """Plain JSON types only: numpy scalars/arrays → Python, tuples → lists, non-finite floats → ``null``."""
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "tolist"):  # numpy scalar or array
        return _jsonable(value.tolist())
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return value


def _solve_monotone(f: Callable[[float], float], target: float, lo: float, hi: float) -> float:
    """Root of the increasing function ``f(x) = target`` on [lo, hi] by bisection (``hi`` is doubled until f(hi) ≥ target)."""
    for _ in range(64):
        if f(hi) >= target:
            break
        lo, hi = hi, hi * 2
    else:
        raise ValueError("could not bracket the solution")
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(mid) < target:
            lo = mid
        else:
            hi = mid
        if hi - lo <= 1e-12 * max(1.0, hi):
            break
    return (lo + hi) / 2


def _one_line(exc: BaseException) -> str:
    text = " ".join(str(exc).split())
    return text or exc.__class__.__name__


# --------------------------------------------------------------------------- commands
def _cmd_ztest(a: argparse.Namespace) -> dict[str, Any]:
    from .stats import relative_lift_proportions

    result = _as_dict(two_proportion_ztest(a.conv_a, a.n_a, a.conv_b, a.n_b, a.alpha, alternative=a.alternative))
    result["relative_lift"] = _as_dict(relative_lift_proportions(a.conv_a, a.n_a, a.conv_b, a.n_b, a.alpha))
    return result


def _cmd_ttest(a: argparse.Namespace) -> dict[str, Any]:
    from .stats import MeanStats, relative_lift_means, welch_ttest_from_stats

    if a.sd_a < 0 or a.sd_b < 0:
        raise ValueError("standard deviations must be >= 0")
    stats_a = MeanStats(n=a.n_a, mean=a.mean_a, var=a.sd_a**2)
    stats_b = MeanStats(n=a.n_b, mean=a.mean_b, var=a.sd_b**2)
    result = _as_dict(welch_ttest_from_stats(stats_a, stats_b, a.alpha))
    result["relative_lift"] = _as_dict(relative_lift_means(stats_a, stats_b, a.alpha))
    return result


def _cmd_samplesize(a: argparse.Namespace) -> dict[str, Any]:
    if a.metric == "mean":
        if a.std is None:
            raise ValueError("--std is required for --metric mean")
        if len(a.values) != 1:
            raise ValueError("usage: samplesize --metric mean --std STD MDE_ABS")
        mde_abs = a.values[0]
        n = sample_size_mean(a.std, mde_abs, a.alpha, a.power)
        return {"metric": "mean", "std": a.std, "mde_abs": mde_abs, "alpha": a.alpha, "power": a.power, "per_arm": n, "total": 2 * n}
    if len(a.values) != 2:
        raise ValueError("usage: samplesize BASELINE MDE_REL (or --metric mean --std STD MDE_ABS)")
    baseline, mde_rel = a.values
    n = sample_size_proportion(baseline, mde_rel, a.alpha, a.power)
    return {
        "metric": "conversion",
        "baseline": baseline,
        "mde_rel": mde_rel,
        "treatment_rate": baseline * (1 + mde_rel),
        "alpha": a.alpha,
        "power": a.power,
        "per_arm": n,
        "total": 2 * n,
    }


def _cmd_samplesize_mean(a: argparse.Namespace) -> dict[str, Any]:
    a.metric, a.values = "mean", [a.mde_abs]
    return _cmd_samplesize(a)


def _cmd_power(a: argparse.Namespace) -> dict[str, Any]:
    from .stats import mde_at_n, power_mean, power_proportion

    if a.n <= 0:
        raise ValueError("--n must be a positive number of users per arm")
    common = {"alpha": a.alpha, "n_per_arm": a.n}
    if a.metric == "mean":
        if a.std is None:
            raise ValueError("--std is required for --metric mean")
        if a.solve_mde:
            if a.values:
                raise ValueError("--solve-mde takes no MDE argument (usage: power --metric mean --std STD --n N --solve-mde)")
            mde_abs = _solve_monotone(lambda m: power_mean(a.std, m, a.n, a.alpha), a.power, 0.0, a.std)
            return {"metric": "mean", "std": a.std, **common, "target_power": a.power, "mde_abs": mde_abs}
        if len(a.values) != 1:
            raise ValueError("usage: power --metric mean --std STD --n N MDE_ABS")
        mde_abs = a.values[0]
        return {"metric": "mean", "std": a.std, "mde_abs": mde_abs, **common, "power": power_mean(a.std, mde_abs, a.n, a.alpha)}
    if a.solve_mde:
        if len(a.values) != 1:
            raise ValueError("usage: power --n N BASELINE --solve-mde")
        baseline = a.values[0]
        mde_rel = mde_at_n(baseline, a.n, a.alpha, a.power)
        return {"metric": "conversion", "baseline": baseline, **common, "target_power": a.power, "mde_rel": mde_rel, "mde_abs": baseline * mde_rel}
    if len(a.values) != 2:
        raise ValueError("usage: power --n N BASELINE MDE_REL (add --solve-mde to solve for the MDE instead)")
    baseline, mde_rel = a.values
    return {"metric": "conversion", "baseline": baseline, "mde_rel": mde_rel, **common, "power": power_proportion(baseline, mde_rel, a.n, a.alpha)}


def _cmd_srm(a: argparse.Namespace) -> dict[str, Any]:
    return _as_dict(srm_check(a.counts, a.ratios, a.alpha))


def _cmd_holm(a: argparse.Namespace) -> dict[str, Any]:
    if any(not 0 <= p <= 1 for p in a.p_values):
        raise ValueError("p-values must be in [0, 1]")
    if not 0 < a.alpha < 1:
        raise ValueError("alpha must be in (0, 1)")
    return {"alpha": a.alpha, "p_values": a.p_values, "reject": holm(a.p_values, a.alpha), "bonferroni": bonferroni(a.p_values, a.alpha)}


def _cmd_interleave(a: argparse.Namespace) -> dict[str, Any]:
    from .ranking import interleaving_test

    return _as_dict(interleaving_test(a.wins_a, a.wins_b, a.ties, a.alpha))


def _cmd_ndcg(a: argparse.Namespace) -> dict[str, Any]:
    rels = list(a.relevances)
    k = len(rels) if a.k is None else a.k
    ndcg = ndcg_at_k(rels, k)  # validates k
    return {"k": k, "relevances": rels, "dcg": dcg(rels[:k]), "idcg": dcg(sorted(rels, reverse=True)[:k]), "ndcg": ndcg}


def _cmd_analyze(a: argparse.Namespace) -> dict[str, Any]:
    path = Path(a.file)
    if not path.is_file():
        raise ValueError(f"file not found: {path}")
    from .data import analyze, read_csv

    data = read_csv(path, control_label=a.control_label)
    return analyze(data, alpha=a.alpha, split=a.split, mde_rel=a.mde, planned_per_arm=a.planned_per_arm)


def _cmd_simulate(a: argparse.Namespace) -> dict[str, Any]:
    out = a.out if a.out is not None else simulate.default_output_path(a.quick)
    report = simulate.run_all(seed=a.seed, quick=a.quick, scale=a.scale)
    simulate.write_report(report, out)
    print(f"written {out}", file=sys.stderr)
    return report


HANDLERS: dict[str, Handler] = {
    "ztest": _cmd_ztest,
    "ttest": _cmd_ttest,
    "samplesize": _cmd_samplesize,
    "samplesize-mean": _cmd_samplesize_mean,
    "power": _cmd_power,
    "srm": _cmd_srm,
    "holm": _cmd_holm,
    "interleave": _cmd_interleave,
    "ndcg": _cmd_ndcg,
    "analyze": _cmd_analyze,
    "simulate": _cmd_simulate,
}


# --------------------------------------------------------------------------- parser
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="abkit", description="A/B-testing and ranking-evaluation toolkit. Every command prints JSON.")
    p.add_argument("--version", action="version", version=f"abkit {__version__}")
    sub = p.add_subparsers(dest="cmd", metavar="COMMAND", required=True)

    def alpha_arg(parser: argparse.ArgumentParser, default: float = 0.05) -> None:
        parser.add_argument("--alpha", type=float, default=default, help=f"significance level (default {default})")

    z = sub.add_parser("ztest", help="two-proportion z-test with a delta-method relative-lift CI: conversions and visitors for control (A) and treatment (B)")
    z.add_argument("conv_a", type=int, help="conversions in A (control)")
    z.add_argument("n_a", type=int, help="visitors in A")
    z.add_argument("conv_b", type=int, help="conversions in B (treatment)")
    z.add_argument("n_b", type=int, help="visitors in B")
    alpha_arg(z)
    z.add_argument("--alternative", choices=["two-sided", "larger", "smaller"], default="two-sided", help="H1: B differs from / is larger than / is smaller than A")

    t = sub.add_parser("ttest", help="Welch's t-test from per-arm summary statistics (mean, standard deviation, n) with a relative-lift CI")
    for arm in ("a", "b"):
        t.add_argument(f"--mean-{arm}", type=float, required=True, help=f"mean of arm {arm.upper()}")
        t.add_argument(f"--sd-{arm}", type=float, required=True, help=f"sample standard deviation of arm {arm.upper()}")
        t.add_argument(f"--n-{arm}", type=int, required=True, help=f"observations in arm {arm.upper()}")
    alpha_arg(t)

    s = sub.add_parser("samplesize", help="users per arm: BASELINE MDE_REL for a conversion rate, or --metric mean --std STD MDE_ABS for a continuous metric")
    s.add_argument("values", type=float, nargs="+", metavar="VALUE", help="BASELINE MDE_REL (conversion) or MDE_ABS (mean)")
    s.add_argument("--metric", choices=["conversion", "mean"], default="conversion")
    s.add_argument("--std", type=float, default=None, help="standard deviation of the metric (--metric mean)")
    alpha_arg(s)
    s.add_argument("--power", type=float, default=0.8, help="target power (default 0.8)")

    m = sub.add_parser("samplesize-mean", help="alias of `samplesize --metric mean --std STD MDE_ABS`")
    m.add_argument("std", type=float)
    m.add_argument("mde_abs", type=float)
    alpha_arg(m)
    m.add_argument("--power", type=float, default=0.8)

    w = sub.add_parser("power", help="power at a planned sample size per arm, or (--solve-mde) the smallest effect detectable at that size")
    w.add_argument("values", type=float, nargs="*", metavar="VALUE", help="BASELINE [MDE_REL] (conversion) or [MDE_ABS] (mean)")
    w.add_argument("--n", type=int, required=True, help="planned users per arm")
    w.add_argument("--metric", choices=["conversion", "mean"], default="conversion")
    w.add_argument("--std", type=float, default=None, help="standard deviation of the metric (--metric mean)")
    w.add_argument("--solve-mde", action="store_true", help="solve for the minimum detectable effect at --power instead of reporting power")
    alpha_arg(w)
    w.add_argument("--power", type=float, default=0.8, help="target power for --solve-mde (default 0.8)")

    r = sub.add_parser("srm", help="sample-ratio-mismatch check on arm sizes (chi-square goodness of fit)")
    r.add_argument("counts", type=int, nargs="+", help="users per arm")
    r.add_argument("--ratios", type=float, nargs="*", default=None, help="intended split (default: equal)")
    alpha_arg(r, 0.001)

    h = sub.add_parser("holm", help="Holm–Bonferroni step-down rejections for a family of p-values (plus plain Bonferroni)")
    h.add_argument("p_values", type=float, nargs="+", metavar="P")
    alpha_arg(h)

    i = sub.add_parser("interleave", help="interleaving decision: exact binomial test on per-session wins with a preference CI")
    i.add_argument("wins_a", type=int, help="sessions won by ranker A")
    i.add_argument("wins_b", type=int, help="sessions won by ranker B")
    i.add_argument("--ties", type=int, default=0, help="tied sessions (reported, not tested)")
    alpha_arg(i)

    n = sub.add_parser("ndcg", help="NDCG@k of one ranked list of relevance grades (position 1 first)")
    n.add_argument("relevances", type=float, nargs="+", metavar="REL")
    n.add_argument("--k", type=int, default=None, help="cut-off (default: list length)")

    an = sub.add_parser("analyze", help="analyse an experiment CSV (per-user or aggregated daily, see docs) — z/Welch test, relative lift, SRM, CUPED, always-valid p")
    an.add_argument("file", help="CSV file")
    alpha_arg(an)
    an.add_argument("--split", type=float, default=0.5, help="intended share of users in control (default 0.5)")
    an.add_argument("--mde", type=float, default=0.05, help="planned relative MDE, sets the sequential test's tau (default 0.05)")
    an.add_argument("--control-label", default=None, help="variant label of the control arm when it is not a/control/0")
    an.add_argument("--planned-per-arm", type=int, default=None, help="planned users per arm (progress and verdict basis)")

    sim = sub.add_parser("simulate", help="run the Monte-Carlo validation studies and write a JSON report")
    sim.add_argument("--quick", action="store_true", help="10 %% of the simulation counts (writes reports/simulation-quick.json)")
    sim.add_argument("--scale", type=float, default=None, help="multiply every study's simulation count by this factor (overrides --quick)")
    sim.add_argument("--out", type=Path, default=None, help="output path (default: reports/simulation.json or simulation-quick.json)")
    sim.add_argument("--seed", type=int, default=simulate.SEED, help=f"random seed (default {simulate.SEED})")
    return p


def main(argv: Sequence[str] | None = None) -> int:
    """Parse ``argv`` (``sys.argv[1:]`` when None), run the command, print JSON; return the exit status."""
    parser = build_parser()
    args = parser.parse_args(None if argv is None else list(argv))
    try:
        result = HANDLERS[args.cmd](args)
    except (ValueError, OSError) as exc:
        print(f"abkit {args.cmd}: error: {_one_line(exc)}", file=sys.stderr)
        return 2
    print(json.dumps(_jsonable(result), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
