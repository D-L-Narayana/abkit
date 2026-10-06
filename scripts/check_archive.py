#!/usr/bin/env python3
"""Build the distribution archives and prove they are complete and usable on their own.

Why: setuptools adds ``tests/test_*.py`` to a source distribution by itself but never the data files those tests read, so
an sdist can look complete and still fail ``pytest`` once extracted (``MANIFEST.in`` grafts ``tests/fixtures``). This
script is the executable form of that guarantee; ``tests/test_packaging.py`` asserts the same archive contents in the suite.

Steps — one summary line each; exit status 0 only when every step passed::

  1. build        sdist + wheel via ``setuptools.build_meta`` (the configured backend) into a temporary directory, or
                  ``--out DIR`` to keep them; prints every archive member and the SHA-256 of both files
  2. sdist        every file under tests/fixtures/**, every tests/test_*.py, LICENSE, README.md, pyproject.toml and
                  MANIFEST.in are members; no byte-code
  3. wheel        the abkit modules and ``*.dist-info/licenses/LICENSE`` are members; no tests
  4. sdist tests  extract the sdist and run the whole test suite from it with coverage ≥ 85 % in a fresh interpreter
                  (cwd = the extracted tree, PYTHONPATH unset), asserting afterwards that the package the tests imported
                  lives in the extracted tree — never the checkout
  5. wheel CLI    extract the wheel, put it first on ``sys.path`` in a fresh interpreter, assert the import location, then
                  run ``--version``, ``ztest`` and ``analyze`` (on a fixture from the extracted sdist) via ``abkit.cli.main``

usage: python3 scripts/check_archive.py [--out DIR]
Needs setuptools, pytest and pytest-cov (``pip install -e ".[dev]"``); everything else is the standard library.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MODULES = ["__init__", "cli", "data", "ranking", "sequential", "simulate", "stats"]
FIXTURE_CSV = Path("tests") / "fixtures" / "csv" / "conversion_per_user.csv"

# ``out`` is read before the first build call: setuptools rewrites ``sys.argv`` while it builds.
BUILD = (
    "import json, sys; out = sys.argv[1]; from setuptools.build_meta import build_sdist, build_wheel; "
    "print('BUILT ' + json.dumps([build_sdist(out), build_wheel(out)]))"
)

# Runs with cwd = extracted sdist root (so ``''`` on sys.path is that tree) and PYTHONPATH unset. pytest runs FIRST so
# that pytest-cov is already measuring when the package's module-level code executes (importing ``abkit`` beforehand
# would leave every import/def/dataclass line unmeasured and fail the coverage threshold); the import location of the
# module object the tests actually used is asserted afterwards.
SDIST_TESTS = """\
import pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
import pytest
code = int(pytest.main(["-q", "-p", "no:cacheprovider", "--cov=abkit", "--cov-fail-under=85"]))
mod = sys.modules.get("abkit")
assert mod is not None, "the test suite never imported abkit"
location = pathlib.Path(mod.__file__).resolve()
assert location.is_relative_to(root), f"the tests imported abkit from {location}, outside the extracted sdist {root}"
print(f"abkit {mod.__version__} used by the tests was imported from {location}")
sys.exit(code)
"""

# Runs with cwd = a scratch directory; the extracted wheel directory is put first on sys.path.
WHEEL_CLI = """\
import contextlib, io, json, pathlib, sys
root, csv = pathlib.Path(sys.argv[1]).resolve(), sys.argv[2]
sys.path.insert(0, str(root))
import abkit
from abkit.cli import main
location = pathlib.Path(abkit.__file__).resolve()
assert location.is_relative_to(root), f"abkit imported from {location}, outside the extracted wheel {root}"
print(f"abkit {abkit.__version__} imported from {location}")

def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = main(argv)
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
    return code, out.getvalue(), err.getvalue()

code, out, err = run(["--version"])
assert code == 0 and out.strip() == f"abkit {abkit.__version__}", (code, out, err)
print(f"--version -> {out.strip()}")
code, out, err = run(["ztest", "1000", "10000", "1100", "10000"])
assert code == 0, err
z = json.loads(out)
assert z["significant"] is True and z["relative_lift"]["method"] == "delta", z
print(f"ztest -> p = {z['p_value']:.6f}, relative lift {z['relative_lift']['lift_rel']:+.4f} [{z['relative_lift']['ci_low']:+.4f}, {z['relative_lift']['ci_high']:+.4f}]")
code, out, err = run(["analyze", csv])
assert code == 0, err
a = json.loads(out)
assert {"test", "relative_lift", "srm", "sequential", "verdict"} <= set(a), sorted(a)
print(f"analyze -> {a['metric_type']} metric, n_a = {a['n_a']}, n_b = {a['n_b']}, decision = {a['verdict']['decision']}")
"""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative(paths: Iterable[Path]) -> list[str]:
    """Checkout-relative POSIX paths of the regular files in ``paths`` (byte-code caches skipped)."""
    return sorted(p.relative_to(ROOT).as_posix() for p in paths if p.is_file() and "__pycache__" not in p.parts)


def run(cmd: Sequence[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run ``cmd`` in a clean interpreter environment: PYTHONPATH unset, no byte-code written into extracted trees."""
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(list(cmd), cwd=cwd, env=env, capture_output=True, text=True)


def build(out: Path) -> tuple[Path, Path]:
    """Build sdist and wheel into ``out``; returns their paths. Raises ``RuntimeError`` with the backend output on failure."""
    out.mkdir(parents=True, exist_ok=True)
    proc = run([sys.executable, "-c", BUILD, str(out)], cwd=ROOT)
    built = [line for line in proc.stdout.splitlines() if line.startswith("BUILT ")]
    if proc.returncode != 0 or not built:
        raise RuntimeError(f"archive build failed (exit {proc.returncode})\n{proc.stdout[-3000:]}\n{proc.stderr[-3000:]}")
    sdist, wheel = json.loads(built[-1][len("BUILT ") :])
    return out / sdist, out / wheel


def sdist_problems(members: Sequence[str]) -> tuple[str, list[str]]:
    """(top-level directory, problems) for the sdist member list."""
    tops = {m.split("/", 1)[0] for m in members}
    if len(tops) != 1:
        return "", [f"members do not share one top-level directory: {sorted(tops)}"]
    top = tops.pop()
    fixtures = relative((ROOT / "tests" / "fixtures").rglob("*"))
    required = fixtures + relative((ROOT / "tests").glob("test_*.py")) + ["LICENSE", "README.md", "pyproject.toml", "MANIFEST.in"]
    problems = ["no fixture files found under tests/fixtures in the checkout"] if not fixtures else []
    problems += [f"missing: {f}" for f in required if f"{top}/{f}" not in members]
    problems += [f"byte-code inside the archive: {m}" for m in members if m.endswith((".pyc", ".pyo"))]
    return top, problems


def wheel_problems(members: Sequence[str]) -> list[str]:
    modules = sorted(set(MODULES) | {p.stem for p in (ROOT / "abkit").glob("*.py")})
    problems = [f"missing: abkit/{m}.py" for m in modules if f"abkit/{m}.py" not in members]
    if not any(m.endswith(".dist-info/licenses/LICENSE") for m in members):
        problems.append("missing: *.dist-info/licenses/LICENSE")
    problems += [f"tests inside the wheel: {m}" for m in members if m.startswith("tests/") or "/tests/" in m]
    return problems


def extract(sdist: Path, wheel: Path, dest: Path) -> tuple[Path, Path]:
    sdist_dir, wheel_dir = dest / "sdist", dest / "wheel"
    with tarfile.open(sdist) as tar:
        kwargs: dict[str, Any] = {"filter": "data"}
        try:
            tar.extractall(sdist_dir, **kwargs)
        except TypeError:  # interpreters without extraction filters (Python < 3.10.12 / 3.11.4)
            tar.extractall(sdist_dir)
    with zipfile.ZipFile(wheel) as whl:
        whl.extractall(wheel_dir)
    return sdist_dir, wheel_dir


def report(step: str, problems: Sequence[str], detail: str) -> bool:
    for problem in problems:
        print(f"FAIL {step}: {problem}")
    if not problems:
        print(f"ok   {step}: {detail}")
    return not problems


def show(proc: subprocess.CompletedProcess[str]) -> None:
    sys.stdout.write(proc.stdout)
    if proc.returncode != 0 and proc.stderr:
        sys.stdout.write(proc.stderr)


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Build the sdist and wheel, check their contents, run the suite from the sdist and the CLI from the wheel.")
    p.add_argument("--out", type=Path, default=None, help="keep the built archives in this directory (default: a temporary directory)")
    a = p.parse_args(argv)
    ok = True
    with tempfile.TemporaryDirectory(prefix="abkit-archive-") as tmp:
        work = Path(tmp)
        try:
            sdist, wheel = build(a.out.resolve() if a.out else work / "dist")
        except RuntimeError as exc:
            print(f"FAIL build: {exc}")
            return 1
        with tarfile.open(sdist) as tar:
            sdist_members = sorted(m.name for m in tar.getmembers() if m.isfile())
        with zipfile.ZipFile(wheel) as whl:
            wheel_members = sorted(whl.namelist())
        for path, members in ((sdist, sdist_members), (wheel, wheel_members)):
            print(f"{path.name}: {path.stat().st_size} bytes, sha256 {sha256(path)}, {len(members)} members")
            for m in members:
                print(f"  {m}")
        print(f"ok   build: {sdist.name} and {wheel.name} written to {sdist.parent}")

        top, problems = sdist_problems(sdist_members)
        fixtures = len(relative((ROOT / "tests" / "fixtures").rglob("*")))
        ok &= report("sdist", problems, f"{fixtures} fixture files, {len(relative((ROOT / 'tests').glob('test_*.py')))} test modules, metadata and MANIFEST.in present, no byte-code")
        ok &= report("wheel", wheel_problems(wheel_members), f"{len(MODULES)} modules + licenses/LICENSE, no tests")
        if not top:
            return 1

        sdist_dir, wheel_dir = extract(sdist, wheel, work)
        sdist_root = sdist_dir / top
        proc = run([sys.executable, "-c", SDIST_TESTS, str(sdist_root)], cwd=sdist_root)
        show(proc)
        passed = re.search(r"^(\d+ passed[^\n]*)$", proc.stdout, re.MULTILINE)
        coverage = re.search(r"Total coverage: ([\d.]+%)", proc.stdout)
        parts = [passed.group(1) if passed else "passed"] + ([f"coverage {coverage.group(1)}"] if coverage else [])
        ok &= report("sdist tests", [] if proc.returncode == 0 else [f"pytest exit {proc.returncode} in {sdist_root}"], f"{', '.join(parts)} from {sdist_root}")

        proc = run([sys.executable, "-c", WHEEL_CLI, str(wheel_dir), str(sdist_root / FIXTURE_CSV)], cwd=work)
        show(proc)
        ok &= report("wheel CLI", [] if proc.returncode == 0 else [f"exit {proc.returncode}"], f"--version, ztest and analyze ran from {wheel_dir}")
    print("archive check passed" if ok else "archive check FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
