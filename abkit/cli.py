"""Command-line interface: `abkit ztest|ttest|samplesize|srm|simulate`."""
from __future__ import annotations

import argparse
import json
import sys

from . import simulate
from .stats import sample_size_mean, sample_size_proportion, srm_check, two_proportion_ztest


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="abkit", description="A/B-testing toolkit")
    sub = p.add_subparsers(dest="cmd", required=True)

    z = sub.add_parser("ztest", help="two-proportion z-test: conversions and visitors for control (A) and treatment (B)")
    z.add_argument("conv_a", type=int)
    z.add_argument("n_a", type=int)
    z.add_argument("conv_b", type=int)
    z.add_argument("n_b", type=int)
    z.add_argument("--alpha", type=float, default=0.05)

    s = sub.add_parser("samplesize", help="visitors per arm for a conversion-rate test")
    s.add_argument("baseline", type=float, help="baseline conversion rate, e.g. 0.10")
    s.add_argument("mde_rel", type=float, help="minimum detectable relative lift, e.g. 0.05 for +5 %%")
    s.add_argument("--alpha", type=float, default=0.05)
    s.add_argument("--power", type=float, default=0.8)

    m = sub.add_parser("samplesize-mean", help="observations per arm for a continuous metric")
    m.add_argument("std", type=float)
    m.add_argument("mde_abs", type=float)
    m.add_argument("--alpha", type=float, default=0.05)
    m.add_argument("--power", type=float, default=0.8)

    r = sub.add_parser("srm", help="sample-ratio-mismatch check on arm sizes")
    r.add_argument("counts", type=int, nargs="+")
    r.add_argument("--ratios", type=float, nargs="*", default=None)

    sim = sub.add_parser("simulate", help="run the Monte-Carlo validation studies")
    sim.add_argument("--quick", action="store_true")

    a = p.parse_args(argv)
    if a.cmd == "ztest":
        print(json.dumps(two_proportion_ztest(a.conv_a, a.n_a, a.conv_b, a.n_b, a.alpha).as_dict(), indent=2))
    elif a.cmd == "samplesize":
        print(json.dumps({"per_arm": sample_size_proportion(a.baseline, a.mde_rel, a.alpha, a.power), "total": 2 * sample_size_proportion(a.baseline, a.mde_rel, a.alpha, a.power)}))
    elif a.cmd == "samplesize-mean":
        print(json.dumps({"per_arm": sample_size_mean(a.std, a.mde_abs, a.alpha, a.power)}))
    elif a.cmd == "srm":
        print(json.dumps(srm_check(a.counts, a.ratios).as_dict(), indent=2))
    elif a.cmd == "simulate":
        sys.argv = ["abkit-simulate"] + (["--quick"] if a.quick else [])
        simulate.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
