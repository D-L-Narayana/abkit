"""Deterministic CSV fixtures shared by the Python importer (``abkit.data``) and the web app's importer (``lib/csv.ts``),
plus ``expected.json``, the cross-language parity reference.

Regenerate from the repository root with::

    python3 tests/fixtures/csv/make_fixtures.py

Every file derives from ``numpy.random.default_rng(2026)``, so the output is reproducible. ``expected.json`` holds
``abkit.data.analyze(abkit.data.read_csv(file))`` (default options, full-precision floats) for every importable fixture and
the error message for the one that must be rejected; the TypeScript tests assert the same numbers through ``parseCsvText``
and ``analyse``.

Files (all well under 200 KB):
  conversion_per_user.csv        per-user, variant/converted/day; labels A/B; ~4,000 rows over 7 days; 0/1 plus some true/false/yes/no
  continuous_per_user_cuped.csv  per-user, variant/value/pre_value/day with ISO dates; labels control/treatment; ~3,000 rows over 10 days
  aggregated_daily.csv           aggregated conversion, day/variant/users/conversions; 14 days; deliberately skewed split (sample-ratio mismatch)
  aggregated_continuous.csv      aggregated continuous with CUPED sums; 10 days
  semicolon_crlf_bom.csv         BOM + semicolons + CRLF, quoted cells, a non-standard label pair (old/new) and rows that must be skipped
  three_variants_error.csv       three variant labels — must be rejected with a message listing them
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SEED = 2026
FILES = ["conversion_per_user.csv", "continuous_per_user_cuped.csv", "aggregated_daily.csv", "aggregated_continuous.csv", "semicolon_crlf_bom.csv", "three_variants_error.csv"]
ERROR_FILE = "three_variants_error.csv"
BOOL_WORDS = {True: ("true", "yes"), False: ("false", "no")}


def conversion_per_user(rng: np.random.Generator) -> str:
    """~4,000 users over 7 days, A at 10.0 %, B at 11.5 %; every 25th row spells the outcome as a word."""
    lines = ["variant,converted,day"]
    for day in range(1, 8):
        users = 560 + int(rng.integers(0, 40))
        for _ in range(users):
            arm = "B" if rng.random() < 0.5 else "A"
            converted = bool(rng.random() < (0.115 if arm == "B" else 0.10))
            row = len(lines)
            token = BOOL_WORDS[converted][row % 2] if row % 25 == 0 else str(int(converted))
            lines.append(f"{arm},{token},{day}")
    return "\n".join(lines) + "\n"


def continuous_per_user_cuped(rng: np.random.Generator) -> str:
    """~3,000 users over 10 dated days; value ~ N(412 | 428.5, 160²) correlated 0.6 with pre_value ~ N(400, 150²)."""
    lines = ["variant,value,pre_value,day"]
    for offset in range(10):
        day = f"2026-09-{offset + 1:02d}"
        users = 280 + int(rng.integers(0, 40))
        for _ in range(users):
            arm = "treatment" if rng.random() < 0.5 else "control"
            z1, z2 = rng.standard_normal(), rng.standard_normal()
            pre = round(400 + 150 * z1, 2)
            mean = 412 * 1.04 if arm == "treatment" else 412.0
            value = round(mean + 160 * (0.6 * z1 + 0.8 * z2), 2)
            lines.append(f"{arm},{value:.2f},{pre:.2f},{day}")
    return "\n".join(lines) + "\n"


def aggregated_daily(rng: np.random.Generator) -> str:
    """14 days of daily counts; the control share is 49.4 % instead of 50 %, so the sample-ratio check must fire."""
    lines = ["day,variant,users,conversions"]
    for day in range(1, 15):
        traffic = int(rng.integers(36_000, 44_000))
        n_a = int(round(traffic * 0.494))
        n_b = traffic - n_a
        conv_a = int(round(n_a * 0.082 + math.sqrt(n_a * 0.082 * 0.918) * rng.standard_normal()))
        conv_b = int(round(n_b * 0.0845 + math.sqrt(n_b * 0.0845 * 0.9155) * rng.standard_normal()))
        lines.append(f"{day},A,{n_a},{conv_a}")
        lines.append(f"{day},B,{n_b},{conv_b}")
    return "\n".join(lines) + "\n"


def aggregated_continuous(rng: np.random.Generator) -> str:
    """10 days of per-arm sums (Σy, Σy², Σx, Σx², Σxy) from ~1,500 users per arm and day; +3 % effect, ρ = 0.6."""
    lines = ["day,variant,users,sum,sum_sq,pre_sum,pre_sum_sq,cross_sum"]
    for day in range(1, 11):
        for arm, mean in (("A", 100.0), ("B", 103.0)):
            n = 1_400 + int(rng.integers(0, 200))
            z1, z2 = rng.standard_normal(n), rng.standard_normal(n)
            x = np.round(100 + 30 * z1, 4)
            y = np.round(mean + 40 * (0.6 * z1 + 0.8 * z2), 4)
            sums = (float(y.sum()), float((y * y).sum()), float(x.sum()), float((x * x).sum()), float((x * y).sum()))
            lines.append(f"{day},{arm},{n}," + ",".join(repr(round(v, 6)) for v in sums))
    return "\n".join(lines) + "\n"


def semicolon_crlf_bom(rng: np.random.Generator) -> str:
    """Spreadsheet-style export: BOM, semicolons, CRLF, some quoted cells and spaces, labels old/new, five bad rows."""
    lines = ["variant;converted;day"]
    for day in range(1, 6):
        for i in range(60):
            arm = "old" if (i + day) % 2 else "new"  # "old" is the first label in the file → control (with a warning)
            converted = rng.random() < (0.21 if arm == "new" else 0.18)
            token = str(int(converted))
            if i % 15 == 7:
                token = BOOL_WORDS[bool(converted)][0]
            cell_arm = f'"{arm}"' if i % 20 == 3 else arm
            cell_day = f'"{day}"' if i % 30 == 9 else str(day)
            lines.append(f"{cell_arm};{token};{cell_day}")
        if day == 2:
            lines.append("old;maybe;2")  # converted is not a boolean
            lines.append("new;1")  # too few cells
        if day == 3:
            lines.append("")  # blank line (ignored, not an issue)
            lines.append("old;1;x")  # day is not a number
            lines.append(" old ; 0 ; 3 ")  # padding around cells is fine
        if day == 4:
            lines.append("new;;4")  # empty converted
            lines.append("old;0;4;extra")  # too many cells
    return "﻿" + "\r\n".join(lines) + "\r\n"


def three_variants_error(rng: np.random.Generator) -> str:
    lines = ["variant,converted"]
    for i in range(30):
        lines.append(f"{'ABC'[i % 3]},{int(rng.random() < 0.1)}")
    return "\n".join(lines) + "\n"


GENERATORS = {
    "conversion_per_user.csv": conversion_per_user,
    "continuous_per_user_cuped.csv": continuous_per_user_cuped,
    "aggregated_daily.csv": aggregated_daily,
    "aggregated_continuous.csv": aggregated_continuous,
    "semicolon_crlf_bom.csv": semicolon_crlf_bom,
    "three_variants_error.csv": three_variants_error,
}


def write_csvs(out_dir: Path) -> None:
    """Writes the six CSV files into ``out_dir`` from one seeded generator (file order fixed by ``FILES``)."""
    rng = np.random.default_rng(SEED)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        text = GENERATORS[name](rng)
        (out_dir / name).write_bytes(text.encode("utf-8"))


def write_expected(out_dir: Path) -> None:
    """Analyses every fixture with ``abkit.data`` (default options) and writes ``expected.json``."""
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from abkit.data import analyze, read_csv

    expected: dict[str, object] = {}
    for name in FILES:
        path = out_dir / name
        if name == ERROR_FILE:
            try:
                read_csv(path)
            except ValueError as exc:
                expected[name] = {"error": str(exc)}
            else:  # pragma: no cover - the importer must reject this file
                raise RuntimeError(f"{name} was expected to be rejected")
            continue
        expected[name] = analyze(read_csv(path))
    (out_dir / "expected.json").write_text(json.dumps(expected, indent=1, allow_nan=False) + "\n", encoding="utf-8")


def build(out_dir: Path) -> None:
    write_csvs(out_dir)
    write_expected(out_dir)


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE
    build(target)
    for name in [*FILES, "expected.json"]:
        print(f"{name}: {(target / name).stat().st_size:,} bytes")
