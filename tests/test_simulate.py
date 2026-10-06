"""Tests for the Monte-Carlo validation runner.

The report is produced once per module at ``--scale 0.02`` (2 % of the full simulation counts) so the whole file runs in
well under a minute of CPU time while still exercising every study end to end. The bound is on CPU time consumed by this
process (``time.process_time``), i.e. on the work the simulation does, so other processes sharing the machine cannot
turn it into a false failure.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import pytest

from abkit import simulate

SCALE = 0.02
STUDIES = ["aa_false_positive_rate", "power_at_mde", "peeking", "cuped", "srm", "interleaving_vs_ab", "msprt_peeking", "relative_ci_coverage"]


@pytest.fixture(scope="module")
def quick_report(tmp_path_factory: pytest.TempPathFactory) -> tuple[dict, float]:
    """(report, CPU seconds) of one in-process ``simulate --scale 0.02`` run written to a temporary file."""
    out = tmp_path_factory.mktemp("sim") / "report.json"
    c0 = time.process_time()
    code = simulate.main(["--scale", str(SCALE), "--out", str(out)])
    cpu = time.process_time() - c0
    assert code == 0
    return json.loads(out.read_text(encoding="utf-8")), cpu


def test_scaled_run_is_fast_and_complete(quick_report: tuple[dict, float]) -> None:
    report, cpu = quick_report
    assert cpu < 60  # CPU time of the simulation itself; the isolated wall-clock time is about 15 s
    assert report["seed"] == simulate.SEED and report["scale"] == SCALE
    missing = [k for k in STUDIES if k not in report]
    assert missing == [], f"studies missing from the report: {missing}"
    assert [k for k in report if k in STUDIES] == STUDIES  # new studies are appended after the original six
    assert report["elapsed_sec"] >= 0
    assert report["aa_false_positive_rate"]["fpr"] <= 0.05 + 3 * math.sqrt(0.05 * 0.95 / (20_000 * SCALE))


def test_msprt_false_positive_rate_is_controlled(quick_report: tuple[dict, float]) -> None:
    study = quick_report[0].get("msprt_peeking")
    assert study is not None, "study 7 (msprt_peeking) missing"
    alpha, sims = study["alpha"], study["sims"]
    se = math.sqrt(alpha * (1 - alpha) / sims)
    assert study["looks"] == 10 and sims >= 100
    assert 0 <= study["fpr_always_valid"] <= alpha + 3 * se


def test_msprt_power_at_mde_is_reported(quick_report: tuple[dict, float]) -> None:
    study = quick_report[0].get("msprt_peeking")
    assert study is not None, "study 7 (msprt_peeking) missing"
    power = study["power_at_mde"]
    assert power["n_per_arm"] >= 14_000  # the fixed-horizon size for 80 % power at +10 % on a 10 % baseline
    assert 0 < power["power_msprt"] <= 1
    assert 0.65 <= power["power_fixed_horizon"] <= 0.95  # nominal 0.8 ± sampling noise
    assert 1 <= power["median_decision_look"] <= study["looks"]
    assert power["target_power"] == 0.8


def test_relative_ci_delta_coverage_near_nominal(quick_report: tuple[dict, float]) -> None:
    study = quick_report[0].get("relative_ci_coverage")
    assert study is not None, "study 8 (relative_ci_coverage) missing"
    nominal, sims = study["nominal_coverage"], study["sims"]
    se = math.sqrt(nominal * (1 - nominal) / sims)
    assert nominal == pytest.approx(0.95) and len(study["scenarios"]) >= 2
    for row in study["scenarios"]:
        assert row["coverage_delta"] >= nominal - 3 * se, row
        assert row["mean_width_delta"] > 0
    big_lift = max(study["scenarios"], key=lambda r: r["lift_rel"])
    assert big_lift["lift_rel"] >= 0.3
    assert big_lift["coverage_naive"] <= big_lift["coverage_delta"]  # dividing the absolute CI by p̂A under-covers
    assert big_lift["mean_width_naive"] < big_lift["mean_width_delta"]


def test_run_all_is_deterministic_and_matches_cli_output(quick_report: tuple[dict, float]) -> None:
    report, _ = quick_report
    again = simulate.run_all(seed=report["seed"], scale=SCALE)
    for key in STUDIES:
        assert again[key] == report[key], key


def test_default_output_paths() -> None:
    reports = Path(simulate.__file__).resolve().parents[1] / "reports"
    assert simulate.default_output_path(quick=True) == reports / "simulation-quick.json"
    assert simulate.default_output_path(quick=False) == reports / "simulation.json"


def test_scale_validation(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        simulate.run_all(scale=0)
    code = simulate.main(["--scale", "-1", "--out", str(tmp_path / "x.json")])
    out, err = capsys.readouterr()
    assert code == 2 and out == ""
    assert err.count("\n") == 1 and "scale" in err and "Traceback" not in err
