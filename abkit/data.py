"""Experiment data: CSV import (per-user and aggregated-daily layouts) and the end-to-end analysis.

This module is the Python twin of the web app's importer (``webapp/src/lib/csv.ts``) and analysis hub
(``webapp/src/lib/analysis.ts``): the same two CSV layouts, the same arm-label rules, the same skipped-row reporting
and the same statistics, so a file analysed on the command line and the same file uploaded to the app give the same
numbers (``tests/fixtures/csv/expected.json`` pins that agreement).

CSV layouts (RFC 4180: quoted cells, doubled quotes, line breaks inside quotes, LF/CRLF, optional UTF-8 BOM,
delimiter auto-detected among comma, semicolon and tab; with a semicolon delimiter a decimal comma such as 12,5 is accepted)::

    per-user     variant, converted | value [, pre_value] [, day]                                      one row per user
    aggregated   variant, users, conversions | sum, sum_sq [, pre_sum, pre_sum_sq, cross_sum] [, day]  one row per arm and day

``converted`` accepts 0/1, true/false, yes/no. ``day`` is a whole number or an ISO date (YYYY-MM-DD, numbered 1, 2, …
from the earliest date). Rows that cannot be read are skipped and reported as :class:`Issue` with the 1-based physical
line of the file (the header is line 1) — nothing is dropped silently. Arm labels: control ∈ {a, control, ctrl, 0,
baseline}, treatment ∈ {b, treatment, variant, test, 1} (case-insensitive); any other pair of exactly two labels takes
the first-seen label as control (with a warning) unless ``control_label`` names it; more than two labels is an error.

``analyze`` returns a JSON-serialisable dict: fixed-horizon test (pooled z-test or Welch's t-test from sufficient
statistics), delta-method relative lift, sample-ratio check, CUPED when a covariate is present, the always-valid
(mSPRT) p-value series and a verdict with its basis (``fixed`` or ``sequential``).
"""
from __future__ import annotations

import datetime as dt
import math
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import IO, Any, NamedTuple

from .sequential import always_valid_p, mixture_likelihood_ratio, msprt_proportions, tau_from_mde
from .stats import (
    MeanStats,
    RelativeLiftResult,
    Sums,
    TTestResult,
    ZTestResult,
    cuped_from_sums,
    relative_lift_means,
    relative_lift_proportions,
    srm_check,
    two_proportion_ztest,
    welch_ttest_from_stats,
)

CONTROL_LABELS: tuple[str, ...] = ("a", "control", "ctrl", "0", "baseline")
TREATMENT_LABELS: tuple[str, ...] = ("b", "treatment", "variant", "test", "1")
_DELIMITERS = (",", ";", "\t")
_ALIASES: dict[str, tuple[str, ...]] = {
    "variant": ("variant", "arm", "group"),
    "converted": ("converted",),
    "value": ("value",),
    "pre": ("pre_value", "pre", "covariate"),
    "users": ("users", "visitors", "n"),
    "conversions": ("conversions",),
    "sum": ("sum",),
    "sum_sq": ("sum_sq",),
    "pre_sum": ("pre_sum",),
    "pre_sum_sq": ("pre_sum_sq",),
    "cross": ("cross_sum",),
    "day": ("day", "date"),
}
_NUMBER = re.compile(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")
_DECIMAL_COMMA = re.compile(r"[+-]?[0-9]+,[0-9]+")
_INTEGER = re.compile(r"[0-9]+")
_ISO_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T\s].*)?")
_YES = frozenset({"1", "true", "yes"})
_NO = frozenset({"0", "false", "no"})


# --------------------------------------------------------------------------- data classes
@dataclass(frozen=True)
class Issue:
    """A skipped row: the 1-based physical line in the file (the header is line 1) and why it was skipped."""

    row: int
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class DayAgg:
    """Daily aggregates of both arms: users, conversions and CUPED sums (x = pre-period covariate, y = metric)."""

    day: int
    n_a: int
    n_b: int
    conv_a: int
    conv_b: int
    sums_a: Sums
    sums_b: Sums

    def as_dict(self) -> dict[str, Any]:
        return {"day": self.day, "n_a": self.n_a, "n_b": self.n_b, "conv_a": self.conv_a, "conv_b": self.conv_b, "sums_a": self.sums_a.as_dict(), "sums_b": self.sums_b.as_dict()}


@dataclass(frozen=True)
class ExperimentData:
    """An imported experiment: daily aggregates plus everything the import had to decide or skip."""

    metric_type: str  # "conversion" | "continuous"
    fmt: str  # "per-user" | "aggregated"
    days: tuple[DayAgg, ...]
    control_label: str
    treatment_label: str
    rows: int  # data rows used (header, blank lines and skipped rows not counted)
    issues: tuple[Issue, ...]
    warnings: tuple[str, ...]
    has_pre: bool  # a CUPED covariate was present
    start_date: str | None = None  # earliest date of a `day` column of dates

    @property
    def labels(self) -> dict[str, str]:
        return {"control": self.control_label, "treatment": self.treatment_label}

    @property
    def n_a(self) -> int:
        return sum(d.n_a for d in self.days)

    @property
    def n_b(self) -> int:
        return sum(d.n_b for d in self.days)

    @property
    def conv_a(self) -> int:
        return sum(d.conv_a for d in self.days)

    @property
    def conv_b(self) -> int:
        return sum(d.conv_b for d in self.days)

    def cumulative(self) -> list[DayAgg]:
        """Running totals, one entry per day (the look sequence of the sequential test)."""
        out: list[DayAgg] = []
        prev: DayAgg | None = None
        for d in self.days:
            prev = d if prev is None else DayAgg(d.day, prev.n_a + d.n_a, prev.n_b + d.n_b, prev.conv_a + d.conv_a, prev.conv_b + d.conv_b, prev.sums_a + d.sums_a, prev.sums_b + d.sums_b)
            out.append(prev)
        return out

    def as_dict(self) -> dict[str, Any]:
        return {
            "metric_type": self.metric_type,
            "format": self.fmt,
            "labels": self.labels,
            "rows": self.rows,
            "has_pre": self.has_pre,
            "start_date": self.start_date,
            "days": [d.as_dict() for d in self.days],
            "issues": [i.as_dict() for i in self.issues],
            "warnings": list(self.warnings),
        }


class CsvRecord(NamedTuple):
    """One CSV record: the 1-based physical line where it starts and its cells."""

    line: int
    cells: list[str]


# --------------------------------------------------------------------------- RFC 4180 reader
def detect_delimiter(text: str) -> str:
    """Delimiter with the most occurrences outside quotes on the first line (ties: comma, then semicolon, then tab)."""
    end = re.search(r"[\r\n]", text)
    first = text if end is None else text[: end.start()]
    counts = dict.fromkeys(_DELIMITERS, 0)
    quoted = False
    for c in first:
        if c == '"':
            quoted = not quoted
        elif not quoted and c in counts:
            counts[c] += 1
    best = ","
    for d in (";", "\t"):
        if counts[d] > counts[best]:
            best = d
    return best


def read_records(text: str, delimiter: str | None = None) -> list[CsvRecord]:
    """Splits CSV text into records (RFC 4180).

    A cell starting with ``"`` runs until the closing quote (``""`` inside it is one quote; line breaks inside it belong
    to the cell); everything else is literal. CRLF, LF and a lone CR all end a record; records whose cells are all blank
    (empty lines) are dropped. A leading byte-order mark is ignored. Never raises.
    """
    src = text[1:] if text.startswith("﻿") else text
    delim = detect_delimiter(src) if delimiter is None else delimiter
    if '"' not in src:  # fast path: identical result, no state machine needed
        out: list[CsvRecord] = []
        for i, line in enumerate(re.split(r"\r\n|\n|\r", src), start=1):
            parts = line.split(delim)
            if any(c.strip() for c in parts):
                out.append(CsvRecord(i, parts))
        return out
    records: list[CsvRecord] = []
    cells: list[str] = []
    buf: list[str] = []
    quoted = False
    line_no = 1
    start = 1
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if quoted:
            if c == '"':
                if i + 1 < n and src[i + 1] == '"':
                    buf.append('"')
                    i += 2
                else:
                    quoted = False
                    i += 1
                continue
            if c == "\n" or (c == "\r" and not (i + 1 < n and src[i + 1] == "\n")):
                line_no += 1
            buf.append(c)
            i += 1
            continue
        if c == '"' and "".join(buf).strip() == "":
            quoted = True
            buf = []
            i += 1
            continue
        if c == delim:
            cells.append("".join(buf))
            buf = []
            i += 1
            continue
        if c in "\r\n":
            cells.append("".join(buf))
            buf = []
            if any(x.strip() for x in cells):
                records.append(CsvRecord(start, cells))
            cells = []
            i += 2 if c == "\r" and i + 1 < n and src[i + 1] == "\n" else 1
            line_no += 1
            start = line_no
            continue
        buf.append(c)
        i += 1
    if cells or buf:
        cells.append("".join(buf))
        if any(x.strip() for x in cells):
            records.append(CsvRecord(start, cells))
    return records


# --------------------------------------------------------------------------- cell parsers (mirrored in lib/csv.ts)
def parse_number(raw: str, decimal_comma: bool = False) -> float:
    """Strict decimal number ("", "0x1f", "inf" and "1_000" give NaN); "12,5" is 12.5 when ``decimal_comma`` is set."""
    s = raw.strip()
    if decimal_comma and _DECIMAL_COMMA.fullmatch(s):
        s = s.replace(",", ".", 1)
    return float(s) if _NUMBER.fullmatch(s) else math.nan


def _parse_converted(raw: str) -> int | None:
    s = raw.strip().lower()
    return 1 if s in _YES else 0 if s in _NO else None


def _parse_day(raw: str) -> tuple[str, str] | None:
    """("number", "7") for whole numbers, ("date", "2026-09-01") for ISO dates, None otherwise."""
    s = raw.strip()
    if _INTEGER.fullmatch(s):
        return "number", str(int(s))
    m = _ISO_DATE.fullmatch(s)
    if not m:
        return None
    try:
        dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    return "date", f"{m.group(1)}-{m.group(2)}-{m.group(3)}"


def _sums_problem(name_sum: str, name_sq: str, users: int, total: float, total_sq: float) -> str | None:
    """n·Σy² must be ≥ (Σy)² (else the variance would be negative); zero users must carry zero sums."""
    if users == 0:
        return f"users is 0 but {name_sum}/{name_sq} are not" if total != 0 or total_sq != 0 else None
    if total_sq < 0:
        return f"{name_sq} must be ≥ 0"
    if users * total_sq < total * total * (1 - 1e-6):
        return f"{name_sq} is too small for {name_sum} and users (implies a negative variance)"
    return None


def _normalise_header(h: str) -> str:
    return re.sub(r"[\s-]+", "_", h.strip().lower())


def _column(header: list[str], name: str) -> int:
    for alias in _ALIASES[name]:
        if alias in header:
            return header.index(alias)
    return -1


# --------------------------------------------------------------------------- labels
@dataclass
class _Acc:
    n: int = 0
    conv: int = 0
    sums: Sums = field(default_factory=Sums.empty)


@dataclass
class _Label:
    key: str
    display: str
    days: dict[str, _Acc] = field(default_factory=dict)


def _names(labels: list[_Label]) -> str:
    return ", ".join(x.display for x in labels)


def _resolve_labels(labels: list[_Label], control_label: str | None, warnings: list[str]) -> tuple[list[_Label], list[_Label]]:
    if control_label is not None and control_label.strip() != "":
        key = control_label.strip().lower()
        ctl = next((x for x in labels if x.key == key), None)
        if ctl is None:
            raise ValueError(f'The control label "{control_label}" does not appear in the file. Variant labels found: {_names(labels)}.')
        rest = [x for x in labels if x is not ctl]
        if not rest:
            raise ValueError(f'Only one variant label found ("{ctl.display}") — both arms need rows.')
        if len(rest) > 1:
            raise ValueError(f'Found {len(labels)} variant labels ({_names(labels)}); an A/B test needs exactly two. With "{ctl.display}" as control the treatment is ambiguous: {_names(rest)}.')
        return [ctl], rest
    if len(labels) == 1:
        raise ValueError(f'Only one variant label found ("{labels[0].display}") — both arms need rows (e.g. A/B or control/treatment).')
    ctl_all = [x for x in labels if x.key in CONTROL_LABELS]
    trt_all = [x for x in labels if x.key in TREATMENT_LABELS]
    other = [x for x in labels if x not in ctl_all and x not in trt_all]
    if not other and ctl_all and trt_all:
        if len(ctl_all) > 1:
            warnings.append(f"Several spellings were counted as the control arm: {_names(ctl_all)}.")
        if len(trt_all) > 1:
            warnings.append(f"Several spellings were counted as the treatment arm: {_names(trt_all)}.")
        return ctl_all, trt_all
    if len(labels) > 2:
        raise ValueError(
            f"Found {len(labels)} variant labels ({_names(labels)}); an A/B test needs exactly two (control and treatment). Remove or relabel the extra arm, or name the control label explicitly."
        )
    first, second = labels[0], labels[1]
    if len(ctl_all) == 1 and not trt_all:
        return ctl_all, [second if ctl_all[0] is first else first]
    if len(trt_all) == 1 and not ctl_all:
        return [second if trt_all[0] is first else first], trt_all
    warnings.append(
        f'Variant labels "{first.display}" and "{second.display}" are not standard names; '
        f'"{first.display}" (first in the file) was taken as control and "{second.display}" as treatment. Name the control label to override.'
    )
    return [first], [second]


# --------------------------------------------------------------------------- import
def parse_csv_text(text: str, control_label: str | None = None) -> ExperimentData:
    """Parses CSV text (see the module docstring for the layouts). Raises ``ValueError`` with an actionable message."""
    src = text[1:] if text.startswith("﻿") else text
    delimiter = detect_delimiter(src)
    records = read_records(src, delimiter)
    if len(records) < 2:
        raise ValueError("The file needs a header row and at least one data row.")
    header = [_normalise_header(h) for h in records[0].cells]
    i_variant = _column(header, "variant")
    if i_variant < 0:
        raise ValueError(f"CSV needs a 'variant' column (the arm of each row: A/B, control/treatment, …). Columns found: {', '.join(header)}.")
    warnings: list[str] = []
    i_users = _column(header, "users")
    fmt = "aggregated" if i_users >= 0 else "per-user"
    i_day = _column(header, "day")
    has_pre = False
    i_converted = i_value = i_pre = i_conversions = i_sum = i_sum_sq = i_pre_sum = i_pre_sum_sq = i_cross = -1
    if fmt == "per-user":
        i_converted, i_value, i_pre = _column(header, "converted"), _column(header, "value"), _column(header, "pre")
        if i_converted < 0 and i_value < 0:
            raise ValueError(
                "Per-user CSV needs 'variant' plus either 'converted' (0/1, true/false, yes/no) or 'value' (a number per user). "
                "Optional: 'pre_value' (CUPED covariate) and 'day'. Daily aggregates need a 'users' column instead."
            )
        if i_converted >= 0 and i_value >= 0:
            warnings.append("Both 'converted' and 'value' columns are present — the conversion metric ('converted') was analysed; remove that column to analyse 'value'.")
        metric_type = "conversion" if i_converted >= 0 else "continuous"
        if i_pre >= 0:
            if metric_type == "continuous":
                has_pre = True
            else:
                warnings.append("'pre_value' is ignored for a conversion metric (CUPED applies to continuous metrics).")
    else:
        i_conversions, i_sum, i_sum_sq = _column(header, "conversions"), _column(header, "sum"), _column(header, "sum_sq")
        if i_conversions >= 0:
            metric_type = "conversion"
        elif i_sum >= 0 and i_sum_sq >= 0:
            metric_type = "continuous"
        elif i_sum >= 0 or i_sum_sq >= 0:
            raise ValueError("Aggregated continuous rows need both 'sum' (Σ value) and 'sum_sq' (Σ value²) per arm and day.")
        else:
            raise ValueError("Aggregated CSV needs 'variant', 'users' and either 'conversions' or 'sum' + 'sum_sq' (optional: 'pre_sum', 'pre_sum_sq', 'cross_sum' for CUPED, and 'day').")
        i_pre_sum, i_pre_sum_sq, i_cross = _column(header, "pre_sum"), _column(header, "pre_sum_sq"), _column(header, "cross")
        pre_cols = (i_pre_sum, i_pre_sum_sq, i_cross)
        if any(i >= 0 for i in pre_cols):
            if metric_type == "conversion":
                warnings.append("CUPED columns (pre_sum, pre_sum_sq, cross_sum) are ignored for a conversion metric.")
            elif any(i < 0 for i in pre_cols):
                missing = [name for name, i in zip(("pre_sum", "pre_sum_sq", "cross_sum"), pre_cols, strict=True) if i < 0]
                raise ValueError(f"CUPED needs all three covariate columns; missing: {', '.join(missing)}.")
            else:
                has_pre = True

    width = len(header)
    decimal_comma = delimiter == ";"
    skipped: list[Issue] = []
    labels: list[_Label] = []
    by_key: dict[str, _Label] = {}
    rows = 0
    number_days = date_days = 0

    def got(cell: str) -> str:
        return f'(got "{cell.strip()}")'

    for line_no, cells in records[1:]:
        if len(cells) != width:
            skipped.append(Issue(line_no, f"expected {width} columns, got {len(cells)}"))
            continue
        label = cells[i_variant].strip()
        if label == "":
            skipped.append(Issue(line_no, "variant is empty"))
            continue
        day_key = "1"
        if i_day >= 0:
            parsed_day = _parse_day(cells[i_day])
            if parsed_day is None:
                skipped.append(Issue(line_no, f"day must be a whole number or an ISO date {got(cells[i_day])}"))
                continue
            if parsed_day[0] == "date":
                date_days += 1
            else:
                number_days += 1
            day_key = parsed_day[1]
        add_n, add_conv, add_sums = 0, 0, Sums.empty()
        if fmt == "per-user":
            if metric_type == "conversion":
                conv = _parse_converted(cells[i_converted])
                if conv is None:
                    skipped.append(Issue(line_no, f"converted must be 0/1, true/false or yes/no {got(cells[i_converted])}"))
                    continue
                add_n, add_conv = 1, conv
            else:
                y = parse_number(cells[i_value], decimal_comma)
                if not math.isfinite(y):
                    skipped.append(Issue(line_no, f"value must be a number {got(cells[i_value])}"))
                    continue
                x = 0.0
                if has_pre:
                    x = parse_number(cells[i_pre], decimal_comma)
                    if not math.isfinite(x):
                        skipped.append(Issue(line_no, f"pre_value must be a number {got(cells[i_pre])}"))
                        continue
                add_n, add_sums = 1, Sums(1, x, y, x * x, y * y, x * y)
        else:
            users_f = parse_number(cells[i_users], decimal_comma)
            if not (math.isfinite(users_f) and users_f.is_integer() and users_f >= 0):
                skipped.append(Issue(line_no, f"users must be a whole number ≥ 0 {got(cells[i_users])}"))
                continue
            users = int(users_f)
            if metric_type == "conversion":
                conv_f = parse_number(cells[i_conversions], decimal_comma)
                if not (math.isfinite(conv_f) and conv_f.is_integer() and 0 <= conv_f <= users):
                    skipped.append(Issue(line_no, f"conversions must be a whole number between 0 and users {got(cells[i_conversions])} for {users} users"))
                    continue
                add_n, add_conv = users, int(conv_f)
            else:
                sy = parse_number(cells[i_sum], decimal_comma)
                syy = parse_number(cells[i_sum_sq], decimal_comma)
                if not math.isfinite(sy):
                    skipped.append(Issue(line_no, f"sum must be a number {got(cells[i_sum])}"))
                    continue
                if not math.isfinite(syy):
                    skipped.append(Issue(line_no, f"sum_sq must be a number {got(cells[i_sum_sq])}"))
                    continue
                bad = _sums_problem("sum", "sum_sq", users, sy, syy)
                if bad:
                    skipped.append(Issue(line_no, bad))
                    continue
                sx = sxx = sxy = 0.0
                if has_pre:
                    sx, sxx, sxy = (parse_number(cells[i], decimal_comma) for i in (i_pre_sum, i_pre_sum_sq, i_cross))
                    if not math.isfinite(sx):
                        skipped.append(Issue(line_no, f"pre_sum must be a number {got(cells[i_pre_sum])}"))
                        continue
                    if not math.isfinite(sxx):
                        skipped.append(Issue(line_no, f"pre_sum_sq must be a number {got(cells[i_pre_sum_sq])}"))
                        continue
                    if not math.isfinite(sxy):
                        skipped.append(Issue(line_no, f"cross_sum must be a number {got(cells[i_cross])}"))
                        continue
                    bad_pre = _sums_problem("pre_sum", "pre_sum_sq", users, sx, sxx)
                    if bad_pre:
                        skipped.append(Issue(line_no, bad_pre))
                        continue
                add_n, add_sums = users, Sums(users, sx, sy, sxx, syy, sxy)
        key = label.lower()
        info = by_key.get(key)
        if info is None:
            info = _Label(key, label)
            by_key[key] = info
            labels.append(info)
        acc = info.days.setdefault(day_key, _Acc())
        acc.n += add_n
        acc.conv += add_conv
        acc.sums = acc.sums + add_sums
        rows += 1

    if rows == 0:
        first = skipped[0]
        raise ValueError(f"No usable data rows: all {len(skipped)} rows were skipped (first problem — line {first.row}: {first.reason}).")
    if number_days and date_days:
        raise ValueError("The 'day' column mixes numbers and dates — use one or the other.")
    control, treatment = _resolve_labels(labels, control_label, warnings)

    is_date = date_days > 0
    keys = {k for x in labels for k in x.days}
    ordered = sorted(keys) if is_date else sorted(keys, key=int)
    first_date = ordered[0] if is_date else None

    def arm_total(group: list[_Label], k: str) -> _Acc:
        total = _Acc()
        for x in group:
            a = x.days.get(k)
            if a is not None:
                total.n += a.n
                total.conv += a.conv
                total.sums = total.sums + a.sums
        return total

    days: list[DayAgg] = []
    for k in ordered:
        a, b = arm_total(control, k), arm_total(treatment, k)
        day = (dt.date.fromisoformat(k) - dt.date.fromisoformat(first_date)).days + 1 if first_date is not None else int(k)
        days.append(DayAgg(day, a.n, b.n, a.conv, b.conv, a.sums, b.sums))
    control_name, treatment_name = control[0].display, treatment[0].display
    if sum(d.n_a for d in days) == 0:
        raise ValueError(f'The control arm ("{control_name}") has no users.')
    if sum(d.n_b for d in days) == 0:
        raise ValueError(f'The treatment arm ("{treatment_name}") has no users.')
    return ExperimentData(metric_type, fmt, tuple(days), control_name, treatment_name, rows, tuple(skipped), tuple(warnings), has_pre, first_date)


def read_csv(source: str | Path | IO[str] | IO[bytes], control_label: str | None = None) -> ExperimentData:
    """Reads a CSV file (path, or an open text/binary file) with :func:`parse_csv_text`.

    Bytes are decoded as UTF-8 (a byte-order mark is fine; undecodable bytes become U+FFFD, as in a browser).
    """
    if isinstance(source, str | Path):
        path = Path(source)
        if not path.is_file():
            raise ValueError(f"file not found: {path}")
        raw: str | bytes = path.read_bytes()
    else:
        raw = source.read()
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
    return parse_csv_text(text, control_label=control_label)


# --------------------------------------------------------------------------- analysis
def _z_look(d: DayAgg, alpha: float) -> tuple[ZTestResult | None, RelativeLiftResult | None]:
    """Fixed-horizon z-test and delta-method relative lift at one look; None while an arm has no users (or no control conversions for the lift)."""
    if d.n_a == 0 or d.n_b == 0:
        return None, None
    z = two_proportion_ztest(d.conv_a, d.n_a, d.conv_b, d.n_b, alpha)
    rel = relative_lift_proportions(d.conv_a, d.n_a, d.conv_b, d.n_b, alpha) if d.conv_a > 0 else None
    return z, rel


def _t_look(a: MeanStats | None, b: MeanStats | None, alpha: float) -> tuple[TTestResult | None, RelativeLiftResult | None]:
    """Welch's t-test and delta-method relative lift at one look; None below two users per arm, with no spread, or a zero control mean (lift only)."""
    if a is None or b is None or a.n < 2 or b.n < 2 or not a.var / a.n + b.var / b.n > 0:
        return None, None
    t = welch_ttest_from_stats(a, b, alpha)
    rel = relative_lift_means(a, b, alpha) if a.mean != 0 else None
    return t, rel


def _mean_stats(s: Sums) -> MeanStats | None:
    return s.mean_var() if s.n >= 2 else None


def _z_dict(z: ZTestResult) -> dict[str, Any]:
    return {
        "kind": "two_proportion_z",
        "statistic": z.z,
        "p_value": z.p_value,
        "ci_low": z.ci_low,
        "ci_high": z.ci_high,
        "rate_a": z.rate_a,
        "rate_b": z.rate_b,
        "lift_abs": z.lift_abs,
        "lift_rel": z.lift_rel,
        "significant": z.significant,
    }


def _t_dict(t: TTestResult) -> dict[str, Any]:
    return {
        "kind": "welch_t",
        "statistic": t.t,
        "df": t.df,
        "p_value": t.p_value,
        "ci_low": t.ci_low,
        "ci_high": t.ci_high,
        "mean_a": t.mean_a,
        "mean_b": t.mean_b,
        "diff": t.diff,
        "significant": t.significant,
    }


def _verdict(mismatch: bool, p: float, direction: float, p_av: float | None, decided_day: int | None, progress: float, planned: int | None, alpha: float) -> dict[str, Any]:
    """Decision rules of the web app: SRM → invalid; planned sample reached (or no plan) → fixed-horizon; always-valid p < alpha → sequential; else collecting."""
    pct = round(100 * progress)
    if mismatch:
        return {"decision": "invalid", "basis": "fixed", "reason": "The observed split does not match the intended allocation, so no metric can be trusted."}
    if progress >= 1:
        where = "at the planned sample size" if planned else "on the full data set (no planned sample size given)"
        if p < alpha:
            return {"decision": "winner" if direction > 0 else "loser", "basis": "fixed", "reason": f"Significant {'positive lift' if direction > 0 else 'negative effect'} {where}."}
        return {"decision": "flat", "basis": "fixed", "reason": f"The confidence interval still includes zero {where}."}
    if p_av is not None and p_av < alpha:
        when = f" on day {decided_day}" if decided_day is not None else ""
        tail = "this decision stays valid despite daily monitoring." if direction > 0 else "the treatment is hurting the metric; this decision stays valid despite daily monitoring."
        return {"decision": "winner" if direction > 0 else "loser", "basis": "sequential", "reason": f"The always-valid p-value fell below alpha{when} at {pct}% of the planned sample — {tail}"}
    return {
        "decision": "collecting",
        "basis": "fixed",
        "reason": "Planned sample size not reached and the always-valid p-value has not crossed alpha — keep collecting; the fixed-horizon p-value is for monitoring only.",
    }


def analyze(data: ExperimentData, alpha: float = 0.05, split: float = 0.5, mde_rel: float = 0.05, planned_per_arm: int | None = None) -> dict[str, Any]:
    """Full analysis of an imported experiment as a JSON-serialisable dict (the web app's results page in one object).

    Keys: ``metric_type, format, days, n_a, n_b, conv_a, conv_b, labels, rows, skipped, warnings, has_pre, alpha, split,
    mde_rel, planned_per_arm, progress, srm{chi2, p_value, mismatch, expected}, test{kind, statistic, p_value, ci_low,
    ci_high, …}, relative_lift{lift_rel, ci_low, ci_high, se, alpha, method}, cuped (null, or {theta, var_before,
    var_after, variance_reduction, adjusted_test}), sequential{tau, always_valid_p[], decided_day}, series[{day, n,
    p_value, lift_rel, ci_low, ci_high, always_valid_p}], verdict{decision, basis, reason}``. Continuous metrics add
    ``relative_lift_raw`` and ``p_value_raw / ci_low_raw / ci_high_raw`` per series point (unadjusted); with a CUPED
    covariate ``test`` is the raw Welch test and ``cuped.adjusted_test`` the one the verdict uses.

    ``split`` is the intended control share (sample-ratio check); ``mde_rel`` sets the sequential test's τ =
    |control estimate × mde_rel| (``tau_from_mde``); ``planned_per_arm`` drives ``progress`` and whether the verdict may be
    sequential. Looks where a test is undefined (an arm without users, fewer than two users for a mean) carry ``None``
    values and no sequential evidence. Raises ``ValueError`` for invalid options, a control arm without conversions or
    with a zero mean (relative lift undefined), or fewer than two users per arm for a continuous metric.
    """
    if not 0 < alpha < 1:
        raise ValueError("alpha must be in (0, 1)")
    if not 0 < split < 1:
        raise ValueError("split (the intended control share) must be in (0, 1)")
    if not math.isfinite(mde_rel) or mde_rel == 0:
        raise ValueError("mde_rel must be a non-zero finite number")
    if planned_per_arm is not None and (planned_per_arm < 0 or int(planned_per_arm) != planned_per_arm):
        raise ValueError("planned_per_arm must be a whole number >= 0")
    cum = data.cumulative()
    if not cum:
        raise ValueError("no data")
    last = cum[-1]
    planned = int(planned_per_arm) if planned_per_arm else None
    progress = min(1.0, min(last.n_a, last.n_b) / planned) if planned else 1.0
    srm = srm_check([last.n_a, last.n_b], [split, 1 - split])
    srm_dict = {"chi2": srm.chi2, "p_value": srm.p_value, "mismatch": srm.mismatch, "expected": list(srm.expected)}
    out: dict[str, Any] = {
        "metric_type": data.metric_type,
        "format": data.fmt,
        "days": len(data.days),
        "n_a": last.n_a,
        "n_b": last.n_b,
        "conv_a": last.conv_a,
        "conv_b": last.conv_b,
        "labels": data.labels,
        "rows": data.rows,
        "skipped": [i.as_dict() for i in data.issues],
        "warnings": list(data.warnings),
        "has_pre": data.has_pre,
        "alpha": alpha,
        "split": split,
        "mde_rel": mde_rel,
        "planned_per_arm": planned_per_arm,
        "progress": progress,
        "srm": srm_dict,
    }

    if data.metric_type == "conversion":
        if last.conv_a == 0:
            raise ValueError("the control arm has no conversions, so the relative lift and the sequential test are undefined")
        z = two_proportion_ztest(last.conv_a, last.n_a, last.conv_b, last.n_b, alpha)
        rel = relative_lift_proportions(last.conv_a, last.n_a, last.conv_b, last.n_b, alpha)
        tau = tau_from_mde(z.rate_a * mde_rel)
        seq = msprt_proportions([d.conv_a for d in cum], [d.n_a for d in cum], [d.conv_b for d in cum], [d.n_b for d in cum], tau=tau, alpha=alpha)
        p_av = list(seq.always_valid_p)
        decided_day = cum[seq.decided_at - 1].day if seq.decided_at is not None else None
        series: list[dict[str, Any]] = []
        for d, pk in zip(cum, p_av, strict=True):
            zk, rk = _z_look(d, alpha)
            series.append(
                {
                    "day": d.day,
                    "n": d.n_a + d.n_b,
                    "p_value": zk.p_value if zk else None,
                    "lift_rel": rk.lift_rel if rk else None,
                    "ci_low": rk.ci_low if rk else None,
                    "ci_high": rk.ci_high if rk else None,
                    "always_valid_p": pk,
                }
            )
        out.update(
            test=_z_dict(z),
            relative_lift=rel.as_dict(),
            cuped=None,
            sequential={"tau": tau, "always_valid_p": p_av, "decided_day": decided_day},
            series=series,
            verdict=_verdict(srm.mismatch, z.p_value, z.lift_abs, p_av[-1], decided_day, progress, planned, alpha),
        )
        return out

    if last.n_a < 2 or last.n_b < 2:
        raise ValueError(f"a continuous metric needs at least two users per arm (control has {last.n_a}, treatment has {last.n_b})")
    a, b = last.sums_a.mean_var(), last.sums_b.mean_var()
    if a.mean == 0:
        raise ValueError("the control mean is 0, so a relative lift is undefined")
    raw = welch_ttest_from_stats(a, b, alpha)
    rel_raw = relative_lift_means(a, b, alpha)
    cuped_dict: dict[str, Any] | None = None
    if data.has_pre:
        c = cuped_from_sums(last.sums_a, last.sums_b)
        adj = welch_ttest_from_stats(c.adj_a, c.adj_b, alpha)
        rel = relative_lift_means(c.adj_a, c.adj_b, alpha)
        cuped_dict = {"theta": c.theta, "var_before": c.var_before, "var_after": c.var_after, "variance_reduction": c.variance_reduction, "adjusted_test": _t_dict(adj)}
    else:
        adj, rel = raw, rel_raw
    tau = tau_from_mde(a.mean * mde_rel)
    # mSPRT on the (CUPED-adjusted) difference of means with its Welch variance; looks without two users per arm or without spread carry no evidence (Λ = 0)
    looks: list[tuple[DayAgg, MeanStats | None, MeanStats | None, MeanStats | None, MeanStats | None]] = []
    lrs: list[float] = []
    for d in cum:
        ra, rb = _mean_stats(d.sums_a), _mean_stats(d.sums_b)
        if ra is not None and rb is not None and data.has_pre:
            ck = cuped_from_sums(d.sums_a, d.sums_b)
            aa: MeanStats | None = ck.adj_a
            ab: MeanStats | None = ck.adj_b
        else:
            aa, ab = ra, rb
        looks.append((d, ra, rb, aa, ab))
        if aa is None or ab is None:
            lrs.append(0.0)
            continue
        var_diff = aa.var / aa.n + ab.var / ab.n
        diff = ab.mean - aa.mean
        lrs.append(mixture_likelihood_ratio(diff, var_diff, tau) if math.isfinite(diff) and math.isfinite(var_diff) and var_diff > 0 else 0.0)
    p_av = always_valid_p(lrs)
    decided_idx = next((k for k, pk in enumerate(p_av) if pk < alpha), None)
    decided_day = cum[decided_idx].day if decided_idx is not None else None
    series = []
    for (d, ra, rb, aa, ab), pk in zip(looks, p_av, strict=True):
        tk_raw, rk_raw = _t_look(ra, rb, alpha)
        tk, rk = _t_look(aa, ab, alpha)
        series.append(
            {
                "day": d.day,
                "n": d.n_a + d.n_b,
                "p_value": tk.p_value if tk else None,
                "lift_rel": rk.lift_rel if rk else None,
                "ci_low": rk.ci_low if rk else None,
                "ci_high": rk.ci_high if rk else None,
                "always_valid_p": pk,
                "p_value_raw": tk_raw.p_value if tk_raw else None,
                "ci_low_raw": rk_raw.ci_low if rk_raw else None,
                "ci_high_raw": rk_raw.ci_high if rk_raw else None,
            }
        )
    out.update(
        test=_t_dict(raw),
        relative_lift=rel.as_dict(),
        relative_lift_raw=rel_raw.as_dict(),
        cuped=cuped_dict,
        sequential={"tau": tau, "always_valid_p": p_av, "decided_day": decided_day},
        series=series,
        verdict=_verdict(srm.mismatch, adj.p_value, adj.diff, p_av[-1], decided_day, progress, planned, alpha),
    )
    return out
