#!/usr/bin/env python3
"""Keep the Monte-Carlo numbers embedded in the static calculator in sync with ``reports/simulation.json``.

``web/index.html`` embeds the report as a JavaScript object literal between the markers ``/*SIM_JSON*/`` and
``/*END_SIM_JSON*/``. Run this after ``abkit simulate`` has regenerated the report::

    python3 scripts/sync_report.py            # rewrite the block (no-op when already in sync)
    python3 scripts/sync_report.py --check    # exit 1 when the page is out of sync (CI gate), 0 when in sync

Exit status: 0 in sync / updated, 1 out of sync (``--check`` only), 2 unreadable input or missing markers.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT = ROOT / "reports" / "simulation.json"
DEFAULT_HTML = ROOT / "web" / "index.html"
START, END = "/*SIM_JSON*/", "/*END_SIM_JSON*/"


def render_block(report: dict[str, Any]) -> str:
    """The marker-delimited literal exactly as the page embeds it (compact ``json.dumps``)."""
    return f"{START}{json.dumps(report)}{END}"


def sync_html(html: str, report: dict[str, Any]) -> str:
    """Return ``html`` with the embedded report replaced by ``report``; raises ``ValueError`` when the markers are missing."""
    start = html.find(START)
    end = html.find(END, start + len(START)) if start >= 0 else -1
    if start < 0 or end < 0:
        raise ValueError(f"markers {START} … {END} not found in the page")
    return html[:start] + render_block(report) + html[end + len(END) :]


def load_report(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return data


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Sync the simulation report embedded in web/index.html with reports/simulation.json.")
    p.add_argument("--report", type=Path, default=DEFAULT_REPORT, help=f"report to embed (default {DEFAULT_REPORT.relative_to(ROOT)})")
    p.add_argument("--html", type=Path, default=DEFAULT_HTML, help=f"page to update (default {DEFAULT_HTML.relative_to(ROOT)})")
    p.add_argument("--check", action="store_true", help="do not write; exit 1 when the page is out of sync")
    a = p.parse_args(argv)
    try:
        report = load_report(a.report)
        html = a.html.read_text(encoding="utf-8")
        updated = sync_html(html, report)
    except (OSError, ValueError) as exc:
        print(f"sync_report: error: {exc}", file=sys.stderr)
        return 2
    if updated == html:
        print(f"{a.html} is in sync with {a.report}")
        return 0
    if a.check:
        print(f"{a.html} is out of sync with {a.report}; run `python3 scripts/sync_report.py` to update it", file=sys.stderr)
        return 1
    a.html.write_text(updated, encoding="utf-8")
    print(f"updated {a.html} from {a.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
