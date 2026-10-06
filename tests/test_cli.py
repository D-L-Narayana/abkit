"""Tests for the command-line interface.

Every test drives ``abkit.cli.main(argv)`` in-process and reads stdout/stderr through capsys — no subprocesses and no
``sys.argv`` mutation — so the suite stays fast and portable.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

import pytest
from scipy import stats as sps

from abkit import __version__, cli, simulate

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "csv" / "conversion_per_user.csv"
Z975 = float(sps.norm.ppf(0.975))


def run(capsys: pytest.CaptureFixture[str], argv: list[str]) -> tuple[int, str, str]:
    """Run the CLI the way the console script does; argparse exits (--version, usage errors) become return codes."""
    try:
        code = cli.main(argv)
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    out, err = capsys.readouterr()
    return code, out, err


def test_version_prints_package_version(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run(capsys, ["--version"])
    assert code == 0
    assert out.strip() == f"abkit {__version__}"
    assert err == ""


def test_version_matches_pyproject() -> None:
    text = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match is not None
    assert match.group(1) == __version__


def test_ztest_json_includes_delta_method_relative_ci(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run(capsys, ["ztest", "1000", "10000", "1100", "10000"])
    assert code == 0 and err == ""
    r = json.loads(out)
    assert r["rate_a"] == pytest.approx(0.10) and r["rate_b"] == pytest.approx(0.11)
    assert r["lift_rel"] == pytest.approx(0.10)
    assert r["significant"] is True
    assert "relative_lift" in r, "delta-method relative lift block missing"
    rel = r["relative_lift"]
    assert rel["method"] == "delta"
    assert rel["lift_rel"] == pytest.approx(0.10)
    assert rel["ci_low"] < 0.10 < rel["ci_high"]
    # delta method: Var(p̂B / p̂A) = se_B² / p_A² + p_B² · se_A² / p_A⁴
    se_a2, se_b2 = 0.10 * 0.90 / 10_000, 0.11 * 0.89 / 10_000
    se_rel = math.sqrt(se_b2 / 0.10**2 + 0.11**2 * se_a2 / 0.10**4)
    assert rel["ci_high"] - rel["ci_low"] == pytest.approx(2 * Z975 * se_rel, rel=1e-9)


def test_samplesize_conversion_and_mean(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, _ = run(capsys, ["samplesize", "0.10", "0.10"])
    assert code == 0
    r = json.loads(out)
    assert r.get("metric") == "conversion"
    assert r["per_arm"] == 14_751 and r["total"] == 29_502
    code, out, _ = run(capsys, ["samplesize", "--metric", "mean", "--std", "1.0", "0.1"])
    assert code == 0
    r = json.loads(out)
    assert r.get("metric") == "mean"
    assert r["per_arm"] == 1570 and r["std"] == 1.0 and r["mde_abs"] == 0.1


def test_power_at_planned_sample_size(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run(capsys, ["power", "--n", "14751", "0.10", "0.10"])
    assert code == 0, err
    r = json.loads(out)
    assert r["n_per_arm"] == 14_751 and r["baseline"] == 0.10 and r["mde_rel"] == 0.10
    assert 0.80 <= r["power"] <= 0.81  # the planned size delivers the promised 80 %
    code, out, err = run(capsys, ["power", "--metric", "mean", "--std", "1.0", "--n", "1570", "0.1"])
    assert code == 0, err
    assert 0.80 <= json.loads(out)["power"] <= 0.81


def test_power_solve_mde_inverts_sample_size(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run(capsys, ["power", "--n", "14751", "0.10", "--solve-mde"])
    assert code == 0, err
    r = json.loads(out)
    assert r["target_power"] == 0.8 and r["baseline"] == 0.10
    assert r["mde_rel"] == pytest.approx(0.10, abs=1e-3)
    code, out, err = run(capsys, ["power", "--metric", "mean", "--std", "1.0", "--n", "1570", "--solve-mde"])
    assert code == 0, err
    assert json.loads(out)["mde_abs"] == pytest.approx(0.1, abs=1e-3)


def test_ttest_from_summary_statistics_matches_scipy(capsys: pytest.CaptureFixture[str]) -> None:
    argv = ["ttest", "--mean-a", "10", "--sd-a", "2", "--n-a", "300", "--mean-b", "10.4", "--sd-b", "3", "--n-b", "200"]
    code, out, err = run(capsys, argv)
    assert code == 0, err
    r = json.loads(out)
    ref = sps.ttest_ind_from_stats(10.4, 3, 200, 10, 2, 300, equal_var=False)
    assert r["diff"] == pytest.approx(0.4)
    assert r["t"] == pytest.approx(ref.statistic)
    assert r["p_value"] == pytest.approx(ref.pvalue)
    assert r["ci_low"] < 0.4 < r["ci_high"]
    assert r["relative_lift"]["lift_rel"] == pytest.approx(0.04)
    assert r["relative_lift"]["ci_low"] < 0.04 < r["relative_lift"]["ci_high"]


def test_srm_json(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, _ = run(capsys, ["srm", "100000", "101200"])
    assert code == 0
    r = json.loads(out)
    assert r["mismatch"] is False and r["observed"] == [100_000, 101_200]
    code, out, _ = run(capsys, ["srm", "98000", "102000"])
    assert code == 0 and json.loads(out)["mismatch"] is True
    code, out, _ = run(capsys, ["srm", "500", "250", "250", "--ratios", "0.5", "0.25", "0.25"])
    assert code == 0 and json.loads(out)["chi2"] == 0


def test_holm_rejections(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, _ = run(capsys, ["holm", "0.01", "0.04"])
    assert code == 0
    r = json.loads(out)
    assert r["alpha"] == 0.05 and r["p_values"] == [0.01, 0.04]
    assert r["reject"] == [True, True]  # 0.01 < 0.05/2, then 0.04 < 0.05/1
    code, out, _ = run(capsys, ["holm", "0.01", "0.04", "0.03", "0.2"])
    assert code == 0 and json.loads(out)["reject"] == [True, False, False, False]
    code, out, err = run(capsys, ["holm", "1.5"])
    assert code == 2 and out == "" and "p-values" in err


def test_interleave_uses_exact_binomial_test(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run(capsys, ["interleave", "100", "120"])
    assert code == 0, err
    r = json.loads(out)
    assert r["wins_a"] == 100 and r["wins_b"] == 120 and r["ties"] == 0
    assert r["p_value"] == pytest.approx(sps.binomtest(120, 220, 0.5).pvalue)
    assert r["p_value"] > 0.1  # 100 vs 120 is not evidence of a better ranker
    assert r["winner"] == "tie"
    assert r["ci_low"] < r["preference"] < r["ci_high"]
    assert r["preference"] == pytest.approx(20 / 220)


def test_ndcg(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, _ = run(capsys, ["ndcg", "3", "2", "0", "1", "--k", "3"])
    assert code == 0
    r = json.loads(out)
    dcg = (2**3 - 1) / math.log2(2) + (2**2 - 1) / math.log2(3) + 0
    idcg = (2**3 - 1) / math.log2(2) + (2**2 - 1) / math.log2(3) + (2**1 - 1) / math.log2(4)
    assert r["k"] == 3 and r["dcg"] == pytest.approx(dcg) and r["idcg"] == pytest.approx(idcg)
    assert r["ndcg"] == pytest.approx(dcg / idcg)
    code, out, err = run(capsys, ["ndcg", "1", "--k", "0"])
    assert code == 2 and out == "" and err.count("\n") == 1


def test_analyze_fixture_outputs_relative_lift_and_sequential(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run(capsys, ["analyze", str(FIXTURE)])
    assert code == 0, err
    r = json.loads(out)
    assert r["metric_type"] == "conversion"
    assert r["n_a"] > 0 and r["n_b"] > 0
    assert {"lift_rel", "ci_low", "ci_high"} <= set(r["relative_lift"])
    assert "always_valid_p" in r["sequential"]
    assert r["verdict"]["decision"] in {"winner", "loser", "flat", "collecting", "invalid"}


def test_analyze_missing_file_is_a_clean_error(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    code, out, err = run(capsys, ["analyze", str(tmp_path / "nope.csv")])
    assert code == 2 and out == ""
    assert err.startswith("abkit analyze: error:") and err.count("\n") == 1


def test_invalid_input_is_one_line_error_without_traceback(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run(capsys, ["ztest", "10", "5", "1", "5"])  # more conversions than visitors
    assert code == 2 and out == ""
    assert err.startswith("abkit ztest: error:")
    assert err.count("\n") == 1 and "Traceback" not in err


def test_unknown_command_exits_2(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run(capsys, ["frobnicate"])
    assert code == 2 and out == "" and "invalid choice" in err


def test_simulate_subcommand_forwards_options_and_writes_report(capsys: pytest.CaptureFixture[str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: dict[str, object] = {}

    def fake_run_all(seed: int = 2026, quick: bool = False, scale: float | None = None) -> dict[str, object]:
        calls.update(seed=seed, quick=quick, scale=scale)
        return {"seed": seed, "demo": True}

    monkeypatch.setattr(simulate, "run_all", fake_run_all)
    out_file = tmp_path / "q.json"
    code, out, _ = run(capsys, ["simulate", "--quick", "--scale", "0.5", "--out", str(out_file)])
    assert code == 0
    assert calls == {"seed": 2026, "quick": True, "scale": 0.5}
    assert json.loads(out) == {"seed": 2026, "demo": True}
    assert json.loads(out_file.read_text(encoding="utf-8")) == {"seed": 2026, "demo": True}
