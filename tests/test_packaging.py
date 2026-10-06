"""Packaging: the sdist must ship the test suite together with its fixtures; the wheel ships only the package.

Both archives are built with ``setuptools.build_meta`` (the configured build backend) into a temporary directory — the
same way ``pip`` or ``python -m build`` build them — and inspected with ``tarfile``/``zipfile``. ``scripts/check_archive.py``
applies the same checks and additionally runs the suite from the extracted sdist and the CLI from the extracted wheel.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tarfile
import zipfile
from collections.abc import Iterable
from pathlib import Path

import pytest

from abkit import __version__

ROOT = Path(__file__).resolve().parents[1]
PREFIX = f"abkit-{__version__}/"
# The output directory is captured before the first build call: setuptools rewrites ``sys.argv`` while building.
BUILD = "import sys; out = sys.argv[1]; from setuptools.build_meta import build_sdist, build_wheel; build_sdist(out); build_wheel(out)"
MODULES = {"__init__", "cli", "data", "ranking", "sequential", "simulate", "stats"}


def relative(paths: Iterable[Path]) -> list[str]:
    """Checkout-relative POSIX paths of the regular files in ``paths`` (byte-code caches skipped)."""
    return sorted(p.relative_to(ROOT).as_posix() for p in paths if p.is_file() and "__pycache__" not in p.parts)


@pytest.fixture(scope="module")
def archives(tmp_path_factory: pytest.TempPathFactory) -> tuple[set[str], set[str]]:
    """Member names of a freshly built sdist and wheel (built once per module, never into the checkout)."""
    out = tmp_path_factory.mktemp("dist")
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    proc = subprocess.run([sys.executable, "-c", BUILD, str(out)], cwd=ROOT, env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr[-2000:]
    sdists, wheels = sorted(out.glob("*.tar.gz")), sorted(out.glob("*.whl"))
    assert len(sdists) == 1 and len(wheels) == 1, (sorted(p.name for p in out.iterdir()), proc.stderr[-800:])
    sdist, wheel = sdists[0], wheels[0]
    with tarfile.open(sdist) as tar:
        sdist_members = {m.name for m in tar.getmembers() if m.isfile()}
    with zipfile.ZipFile(wheel) as whl:
        wheel_members = set(whl.namelist())
    return sdist_members, wheel_members


def test_sdist_ships_every_test_fixture(archives: tuple[set[str], set[str]]) -> None:
    fixtures = relative((ROOT / "tests" / "fixtures").rglob("*"))
    assert fixtures, "no fixture files found in the checkout"
    missing = [f for f in fixtures if PREFIX + f not in archives[0]]
    assert missing == [], f"sdist is missing {len(missing)} fixture file(s) the test suite reads: {missing}"


def test_sdist_ships_tests_and_metadata(archives: tuple[set[str], set[str]]) -> None:
    expected = ["LICENSE", "README.md", "pyproject.toml", "MANIFEST.in", *relative((ROOT / "tests").glob("test_*.py"))]
    missing = [f for f in expected if PREFIX + f not in archives[0]]
    assert missing == [], f"sdist is missing: {missing}"
    assert [m for m in archives[0] if m.endswith((".pyc", ".pyo"))] == []


def test_wheel_ships_only_the_package(archives: tuple[set[str], set[str]]) -> None:
    wheel = archives[1]
    assert {p.stem for p in (ROOT / "abkit").glob("*.py")} == MODULES
    assert {f"abkit/{m}.py" for m in MODULES} <= wheel, sorted(wheel)
    assert any(n.endswith(".dist-info/licenses/LICENSE") for n in wheel), sorted(wheel)
    assert [n for n in wheel if n.startswith("tests/") or "/tests/" in n] == []
