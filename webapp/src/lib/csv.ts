/**
 * CSV import/export and JSON export for experiments.
 *
 * `parseCsvText` reads two layouts, both RFC 4180 (quoted cells, doubled quotes, line breaks inside quotes, CRLF or LF,
 * optional UTF-8 BOM, delimiter auto-detected among comma, semicolon and tab; with a semicolon delimiter a decimal comma
 * such as "12,5" is accepted):
 *
 *   per-user     variant, converted | value [, pre_value] [, day]                                 one row per user
 *   aggregated   variant, users, conversions | sum, sum_sq [, pre_sum, pre_sum_sq, cross_sum] [, day]   one row per arm and day
 *
 * `converted` accepts 0/1, true/false, yes/no. `day` is a whole number or an ISO date (YYYY-MM-DD, numbered 1, 2, … from
 * the earliest date). Rows that cannot be read are skipped and reported as `Issue { row, reason }` with the 1-based
 * physical line of the file (the header is line 1) — nothing is dropped silently. Variant labels: control ∈ {a, control,
 * ctrl, 0, baseline}, treatment ∈ {b, treatment, variant, test, 1} (case-insensitive); any other pair of exactly two labels
 * takes the first-seen label as control (with a warning); more than two labels is an error that lists them.
 *
 * `toCsv` writes the aggregated layout with every sufficient statistic, so the day table round-trips exactly (lossless);
 * `toJson`/`fromJson` carry the whole experiment under the schema tag "abkit-experiment/1". The Python package applies the
 * same rules (`abkit.data.read_csv`), and `tests/fixtures/csv/` holds files both implementations must agree on.
 */
import type { DayData, Experiment, MetricType } from "../model";
import { addSums, emptySums, meanVar, type Sums } from "../stats";

export type CsvFormat = "per-user" | "aggregated";
export interface Issue { row: number; reason: string }
export interface ParseResult {
  experiment: Experiment;
  format: CsvFormat;
  /** Data rows that were used (header, blank lines and skipped rows are not counted). */
  rows: number;
  skipped: Issue[];
  /** Labels as first written in the file. */
  labels: { control: string; treatment: string };
  /** A CUPED covariate (pre_value, or pre_sum/pre_sum_sq/cross_sum) was present. */
  hasPre: boolean;
  warnings: string[];
}
export interface ParseOptions {
  /** Variant label of the control arm (case-insensitive) when the file does not use a standard label pair. */
  controlLabel?: string;
  id?: string;
  /** ISO date; defaults to the earliest date in a `day` column of dates, else today. */
  startDate?: string;
  alpha?: number;
  /** Intended share of users in the control arm (for the sample-ratio check). */
  split?: number;
  mdeRel?: number;
  /** Planned users per arm; when given, the experiment is created as "running" unless `status` says otherwise. */
  plannedPerArm?: number;
  status?: Experiment["status"];
}

export const JSON_SCHEMA = "abkit-experiment/1";
export const CONTROL_LABELS: readonly string[] = ["a", "control", "ctrl", "0", "baseline"];
export const TREATMENT_LABELS: readonly string[] = ["b", "treatment", "variant", "test", "1"];
export type Delimiter = "," | ";" | "\t";

// ---------------------------------------------------------------- RFC 4180 reader
export interface CsvRecord {
  /** 1-based physical line where the record starts (the header is line 1). */
  line: number;
  cells: string[];
}

/** Delimiter with the most occurrences outside quotes on the first line (ties: comma, then semicolon, then tab). */
export function detectDelimiter(text: string): Delimiter {
  const end = text.search(/[\r\n]/);
  const first = end < 0 ? text : text.slice(0, end);
  const counts: Record<Delimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const c of first) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "," || c === ";" || c === "\t")) counts[c]++;
  }
  let best: Delimiter = ",";
  for (const d of [";", "\t"] as const) if (counts[d] > counts[best]) best = d;
  return best;
}

/**
 * Splits CSV text into records with a small state machine: a cell starting with `"` runs until the closing quote (`""`
 * inside it is one quote; line breaks inside it belong to the cell), everything else is literal. CRLF, LF and lone CR all
 * end a record; records whose cells are all blank (empty lines) are dropped. Never throws.
 */
export function readCsvRecords(text: string, delimiter: Delimiter = detectDelimiter(text)): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  let i = 0;
  const endRecord = (): void => {
    cells.push(field);
    field = "";
    if (cells.some((c) => c.trim() !== "")) records.push({ line: start, cells });
    cells = [];
  };
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; } else { quoted = false; i++; }
        continue;
      }
      if (c === "\n" || (c === "\r" && src[i + 1] !== "\n")) line++;
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field.trim() === "") { quoted = true; field = ""; i++; continue; }
    if (c === delimiter) { cells.push(field); field = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      endRecord();
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
      line++;
      start = line;
      continue;
    }
    field += c;
    i++;
  }
  if (cells.length > 0 || field !== "") endRecord();
  return records;
}

// ---------------------------------------------------------------- cell parsers (mirrored in abkit/data.py)
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER = /^\d+$/; // day numbers: whole, non-negative (negative days would fail storage validation)
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/;
const YES = new Set(["1", "true", "yes"]);
const NO = new Set(["0", "false", "no"]);

/** Strict decimal number ("", "0x1f", "Infinity" and "1_000" are NaN); "12,5" is 12.5 when `decimalComma` is set. */
export function parseNumber(raw: string, decimalComma = false): number {
  let s = raw.trim();
  if (decimalComma && /^[+-]?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  return NUMBER.test(s) ? Number(s) : NaN;
}

function parseConverted(raw: string): 0 | 1 | null {
  const s = raw.trim().toLowerCase();
  return YES.has(s) ? 1 : NO.has(s) ? 0 : null;
}

interface DayKey { kind: "number" | "date"; key: string }
function parseDay(raw: string): DayKey | null {
  const s = raw.trim();
  if (INTEGER.test(s)) return { kind: "number", key: String(Number(s)) };
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { kind: "date", key: `${m[1]}-${m[2]}-${m[3]}` };
}

/** Days between two ISO dates (calendar days, UTC). */
const daysBetween = (fromIso: string, toIso: string): number => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

/** Sanity check for aggregated sums: n·Σy² ≥ (Σy)² (otherwise the variance would be negative); zero users carry zero sums. */
function sumsProblem(nameSum: string, nameSq: string, users: number, sum: number, sumSq: number): string | null {
  if (users === 0) return sum !== 0 || sumSq !== 0 ? `users is 0 but ${nameSum}/${nameSq} are not` : null;
  if (sumSq < 0) return `${nameSq} must be ≥ 0`;
  if (users * sumSq < sum * sum * (1 - 1e-6)) return `${nameSq} is too small for ${nameSum} and users (implies a negative variance)`;
  return null;
}

// ---------------------------------------------------------------- header
const normaliseHeader = (h: string): string => h.trim().toLowerCase().replace(/[\s-]+/g, "_");
const ALIASES = {
  variant: ["variant", "arm", "group"],
  converted: ["converted"],
  value: ["value"],
  pre: ["pre_value", "pre", "covariate"],
  users: ["users", "visitors", "n"],
  conversions: ["conversions"],
  sum: ["sum"],
  sumSq: ["sum_sq"],
  preSum: ["pre_sum"],
  preSumSq: ["pre_sum_sq"],
  cross: ["cross_sum"],
  day: ["day", "date"],
} as const;
type Column = keyof typeof ALIASES;
function columnIndex(header: string[], column: Column): number {
  for (const name of ALIASES[column]) {
    const i = header.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- labels
interface Acc { n: number; conv: number; sums: Sums }
const newAcc = (): Acc => ({ n: 0, conv: 0, sums: emptySums() });
interface LabelInfo { key: string; display: string; days: Map<string, Acc> }
const names = (ls: LabelInfo[]): string => ls.map((l) => l.display).join(", ");

function resolveLabels(labels: LabelInfo[], controlLabel: string | undefined, warnings: string[]): { control: LabelInfo[]; treatment: LabelInfo[] } {
  if (controlLabel !== undefined && controlLabel.trim() !== "") {
    const key = controlLabel.trim().toLowerCase();
    const ctl = labels.find((l) => l.key === key);
    if (!ctl) throw new Error(`The control label "${controlLabel}" does not appear in the file. Variant labels found: ${names(labels)}.`);
    const rest = labels.filter((l) => l !== ctl);
    if (rest.length === 0) throw new Error(`Only one variant label found ("${ctl.display}") — both arms need rows.`);
    if (rest.length > 1) throw new Error(`Found ${labels.length} variant labels (${names(labels)}); an A/B test needs exactly two. With "${ctl.display}" as control the treatment is ambiguous: ${names(rest)}.`);
    return { control: [ctl], treatment: rest };
  }
  if (labels.length === 1) throw new Error(`Only one variant label found ("${labels[0]!.display}") — both arms need rows (e.g. A/B or control/treatment).`);
  const ctl = labels.filter((l) => CONTROL_LABELS.includes(l.key));
  const trt = labels.filter((l) => TREATMENT_LABELS.includes(l.key));
  const other = labels.filter((l) => !ctl.includes(l) && !trt.includes(l));
  if (other.length === 0 && ctl.length > 0 && trt.length > 0) {
    if (ctl.length > 1) warnings.push(`Several spellings were counted as the control arm: ${names(ctl)}.`);
    if (trt.length > 1) warnings.push(`Several spellings were counted as the treatment arm: ${names(trt)}.`);
    return { control: ctl, treatment: trt };
  }
  if (labels.length > 2) throw new Error(`Found ${labels.length} variant labels (${names(labels)}); an A/B test needs exactly two (control and treatment). Remove or relabel the extra arm, or name the control label explicitly.`);
  const first = labels[0]!, second = labels[1]!;
  if (ctl.length === 1 && trt.length === 0) return { control: ctl, treatment: [ctl[0] === first ? second : first] };
  if (trt.length === 1 && ctl.length === 0) return { control: [trt[0] === first ? second : first], treatment: trt };
  warnings.push(`Variant labels "${first.display}" and "${second.display}" are not standard names; "${first.display}" (first in the file) was taken as control and "${second.display}" as treatment. Name the control label to override.`);
  return { control: [first], treatment: [second] };
}

// ---------------------------------------------------------------- import
function checkOptions(o: ParseOptions): void {
  if (o.alpha !== undefined && !(o.alpha > 0 && o.alpha < 1)) throw new Error("alpha must be between 0 and 1 (exclusive).");
  if (o.split !== undefined && !(o.split > 0 && o.split < 1)) throw new Error("The control share must be between 0 and 1 (exclusive).");
  if (o.mdeRel !== undefined && !(Number.isFinite(o.mdeRel) && o.mdeRel !== 0)) throw new Error("The relative MDE must be a non-zero number.");
  if (o.plannedPerArm !== undefined && !(Number.isInteger(o.plannedPerArm) && o.plannedPerArm >= 0)) throw new Error("Planned users per arm must be a whole number ≥ 0.");
}

const newId = (): string => `csv-${Date.now().toString(36)}-${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, "0")}`;

/** Parses CSV text into an experiment (see the module comment for the formats). Throws an Error with an actionable message. */
export function parseCsvText(text: string, name: string, opts: ParseOptions = {}): ParseResult {
  checkOptions(opts);
  const delimiter = detectDelimiter(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const records = readCsvRecords(text, delimiter);
  if (records.length < 2) throw new Error("The file needs a header row and at least one data row.");
  const header = records[0]!.cells.map(normaliseHeader);
  const col = (c: Column): number => columnIndex(header, c);
  const iVariant = col("variant");
  if (iVariant < 0) throw new Error(`CSV needs a 'variant' column (the arm of each row: A/B, control/treatment, …). Columns found: ${header.join(", ")}.`);
  const warnings: string[] = [];
  const iUsers = col("users");
  const format: CsvFormat = iUsers >= 0 ? "aggregated" : "per-user";
  const iDay = col("day");
  let metricType: MetricType;
  let hasPre = false;
  let iConverted = -1, iValue = -1, iPre = -1, iConversions = -1, iSum = -1, iSumSq = -1, iPreSum = -1, iPreSumSq = -1, iCross = -1;
  if (format === "per-user") {
    iConverted = col("converted");
    iValue = col("value");
    iPre = col("pre");
    if (iConverted < 0 && iValue < 0) throw new Error("Per-user CSV needs 'variant' plus either 'converted' (0/1, true/false, yes/no) or 'value' (a number per user). Optional: 'pre_value' (CUPED covariate) and 'day'. Daily aggregates need a 'users' column instead.");
    if (iConverted >= 0 && iValue >= 0) warnings.push("Both 'converted' and 'value' columns are present — the conversion metric ('converted') was analysed; remove that column to analyse 'value'.");
    metricType = iConverted >= 0 ? "conversion" : "continuous";
    if (iPre >= 0) {
      if (metricType === "continuous") hasPre = true;
      else warnings.push("'pre_value' is ignored for a conversion metric (CUPED applies to continuous metrics).");
    }
  } else {
    iConversions = col("conversions");
    iSum = col("sum");
    iSumSq = col("sumSq");
    if (iConversions >= 0) metricType = "conversion";
    else if (iSum >= 0 && iSumSq >= 0) metricType = "continuous";
    else if (iSum >= 0 || iSumSq >= 0) throw new Error("Aggregated continuous rows need both 'sum' (Σ value) and 'sum_sq' (Σ value²) per arm and day.");
    else throw new Error("Aggregated CSV needs 'variant', 'users' and either 'conversions' or 'sum' + 'sum_sq' (optional: 'pre_sum', 'pre_sum_sq', 'cross_sum' for CUPED, and 'day').");
    iPreSum = col("preSum");
    iPreSumSq = col("preSumSq");
    iCross = col("cross");
    const pre = [iPreSum, iPreSumSq, iCross];
    if (pre.some((i) => i >= 0)) {
      if (metricType === "conversion") warnings.push("CUPED columns (pre_sum, pre_sum_sq, cross_sum) are ignored for a conversion metric.");
      else if (pre.some((i) => i < 0)) throw new Error(`CUPED needs all three covariate columns; missing: ${["pre_sum", "pre_sum_sq", "cross_sum"].filter((_, k) => pre[k]! < 0).join(", ")}.`);
      else hasPre = true;
    }
  }

  const width = header.length;
  const decimalComma = delimiter === ";";
  const skipped: Issue[] = [];
  const labels: LabelInfo[] = [];
  const byKey = new Map<string, LabelInfo>();
  let rows = 0;
  let numberDays = 0, dateDays = 0;
  const skip = (row: number, reason: string): void => { skipped.push({ row, reason }); };
  const got = (cell: string): string => `(got "${cell.trim()}")`;

  for (let r = 1; r < records.length; r++) {
    const { line, cells } = records[r]!;
    if (cells.length !== width) { skip(line, `expected ${width} columns, got ${cells.length}`); continue; }
    const label = cells[iVariant]!.trim();
    if (label === "") { skip(line, "variant is empty"); continue; }
    let dayKey = "1";
    if (iDay >= 0) {
      const d = parseDay(cells[iDay]!);
      if (!d) { skip(line, `day must be a whole number or an ISO date ${got(cells[iDay]!)}`); continue; }
      if (d.kind === "date") dateDays++; else numberDays++;
      dayKey = d.key;
    }
    let add: Acc;
    if (format === "per-user") {
      if (metricType === "conversion") {
        const c = parseConverted(cells[iConverted]!);
        if (c === null) { skip(line, `converted must be 0/1, true/false or yes/no ${got(cells[iConverted]!)}`); continue; }
        add = { n: 1, conv: c, sums: emptySums() };
      } else {
        const y = parseNumber(cells[iValue]!, decimalComma);
        if (!Number.isFinite(y)) { skip(line, `value must be a number ${got(cells[iValue]!)}`); continue; }
        let x = 0;
        if (hasPre) {
          x = parseNumber(cells[iPre]!, decimalComma);
          if (!Number.isFinite(x)) { skip(line, `pre_value must be a number ${got(cells[iPre]!)}`); continue; }
        }
        add = { n: 1, conv: 0, sums: { n: 1, sx: x, sy: y, sxx: x * x, syy: y * y, sxy: x * y } };
      }
    } else {
      const users = parseNumber(cells[iUsers]!, decimalComma);
      if (!Number.isInteger(users) || users < 0) { skip(line, `users must be a whole number ≥ 0 ${got(cells[iUsers]!)}`); continue; }
      if (metricType === "conversion") {
        const conv = parseNumber(cells[iConversions]!, decimalComma);
        if (!Number.isInteger(conv) || conv < 0 || conv > users) { skip(line, `conversions must be a whole number between 0 and users ${got(cells[iConversions]!)} for ${users} users`); continue; }
        add = { n: users, conv, sums: emptySums() };
      } else {
        const sy = parseNumber(cells[iSum]!, decimalComma);
        const syy = parseNumber(cells[iSumSq]!, decimalComma);
        if (!Number.isFinite(sy)) { skip(line, `sum must be a number ${got(cells[iSum]!)}`); continue; }
        if (!Number.isFinite(syy)) { skip(line, `sum_sq must be a number ${got(cells[iSumSq]!)}`); continue; }
        const bad = sumsProblem("sum", "sum_sq", users, sy, syy);
        if (bad) { skip(line, bad); continue; }
        let sx = 0, sxx = 0, sxy = 0;
        if (hasPre) {
          sx = parseNumber(cells[iPreSum]!, decimalComma);
          sxx = parseNumber(cells[iPreSumSq]!, decimalComma);
          sxy = parseNumber(cells[iCross]!, decimalComma);
          if (!Number.isFinite(sx)) { skip(line, `pre_sum must be a number ${got(cells[iPreSum]!)}`); continue; }
          if (!Number.isFinite(sxx)) { skip(line, `pre_sum_sq must be a number ${got(cells[iPreSumSq]!)}`); continue; }
          if (!Number.isFinite(sxy)) { skip(line, `cross_sum must be a number ${got(cells[iCross]!)}`); continue; }
          const badPre = sumsProblem("pre_sum", "pre_sum_sq", users, sx, sxx);
          if (badPre) { skip(line, badPre); continue; }
        }
        add = { n: users, conv: 0, sums: { n: users, sx, sy, sxx, syy, sxy } };
      }
    }
    const key = label.toLowerCase();
    let info = byKey.get(key);
    if (!info) {
      info = { key, display: label, days: new Map() };
      byKey.set(key, info);
      labels.push(info);
    }
    const acc = info.days.get(dayKey) ?? newAcc();
    acc.n += add.n;
    acc.conv += add.conv;
    acc.sums = addSums(acc.sums, add.sums);
    info.days.set(dayKey, acc);
    rows++;
  }

  if (rows === 0) {
    const first = skipped[0]!;
    throw new Error(`No usable data rows: all ${skipped.length} rows were skipped (first problem — line ${first.row}: ${first.reason}).`);
  }
  if (numberDays > 0 && dateDays > 0) throw new Error("The 'day' column mixes numbers and dates — use one or the other.");
  const { control, treatment } = resolveLabels(labels, opts.controlLabel, warnings);

  const isDate = dateDays > 0;
  const dayKeys = new Set<string>();
  for (const l of labels) for (const k of l.days.keys()) dayKeys.add(k);
  const ordered = [...dayKeys].sort(isDate ? undefined : (a, b) => Number(a) - Number(b));
  const firstDate = isDate ? ordered[0]! : null;
  const armTotal = (group: LabelInfo[], k: string): Acc => group.reduce<Acc>((acc, l) => {
    const a = l.days.get(k);
    return a ? { n: acc.n + a.n, conv: acc.conv + a.conv, sums: addSums(acc.sums, a.sums) } : acc;
  }, newAcc());
  const days: DayData[] = ordered.map((k) => {
    const a = armTotal(control, k), b = armTotal(treatment, k);
    return { day: firstDate ? daysBetween(firstDate, k) + 1 : Number(k), nA: a.n, nB: b.n, convA: a.conv, convB: b.conv, sumsA: a.sums, sumsB: b.sums };
  });
  const labelsOut = { control: control[0]!.display, treatment: treatment[0]!.display };
  const totalA = days.reduce((s, d) => s + d.nA, 0), totalB = days.reduce((s, d) => s + d.nB, 0);
  if (totalA === 0) throw new Error(`The control arm ("${labelsOut.control}") has no users.`);
  if (totalB === 0) throw new Error(`The treatment arm ("${labelsOut.treatment}") has no users.`);
  const convTotalA = days.reduce((s, d) => s + d.convA, 0);
  const sumsTotalA = days.reduce((s, d) => addSums(s, d.sumsA), emptySums());
  const baseline = metricType === "conversion" ? convTotalA / totalA : sumsTotalA.sy / totalA;
  const std = metricType === "continuous" && sumsTotalA.n > 1 ? Math.sqrt(meanVar(sumsTotalA).var) : undefined;
  const planned = opts.plannedPerArm ?? 0;
  const note = `Imported from a ${format} CSV: ${rows} rows over ${days.length} day${days.length === 1 ? "" : "s"}; control = "${labelsOut.control}", treatment = "${labelsOut.treatment}"${skipped.length ? `; ${skipped.length} row${skipped.length === 1 ? "" : "s"} skipped` : ""}.`;
  const experiment: Experiment = {
    id: opts.id ?? newId(),
    name,
    hypothesis: "",
    owner: "You",
    metric: metricType === "conversion" ? "Conversion rate" : "Mean value per user",
    metricType,
    baseline,
    ...(std !== undefined && Number.isFinite(std) ? { std } : {}),
    mdeRel: opts.mdeRel ?? 0.05,
    alpha: opts.alpha ?? 0.05,
    power: 0.8,
    dailyTraffic: Math.round((totalA + totalB) / Math.max(1, days.length)),
    split: opts.split ?? 0.5,
    startDate: opts.startDate ?? firstDate ?? new Date().toISOString().slice(0, 10),
    status: opts.status ?? (planned > 0 ? "running" : "completed"),
    plannedPerArm: planned,
    days,
    source: "csv",
    tags: hasPre ? ["csv", "cuped"] : ["csv"],
    notes: note,
  };
  return { experiment, format, rows, skipped, labels: labelsOut, hasPre, warnings };
}

// ---------------------------------------------------------------- export
/**
 * Lossless aggregated CSV: `day,variant,users,conversions` for conversion metrics,
 * `day,variant,users,sum,sum_sq,pre_sum,pre_sum_sq,cross_sum` for continuous ones (variants written as A and B;
 * numbers in their shortest round-trip form, so `parseCsvText(toCsv(e))` restores every day exactly).
 */
export function toCsv(e: Experiment): string {
  const conversion = e.metricType === "conversion";
  const lines = [conversion ? "day,variant,users,conversions" : "day,variant,users,sum,sum_sq,pre_sum,pre_sum_sq,cross_sum"];
  const sums = (s: Sums): string => [s.sy, s.syy, s.sx, s.sxx, s.sxy].map(String).join(",");
  for (const d of e.days) {
    if (conversion) {
      lines.push(`${d.day},A,${d.nA},${d.convA}`, `${d.day},B,${d.nB},${d.convB}`);
    } else {
      lines.push(`${d.day},A,${d.nA},${sums(d.sumsA)}`, `${d.day},B,${d.nB},${sums(d.sumsB)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Pretty-printed `{ schema: "abkit-experiment/1", experiment }`. */
export function toJson(e: Experiment): string {
  return JSON.stringify({ schema: JSON_SCHEMA, experiment: e }, null, 2);
}

/** Reads what `toJson` wrote; throws an Error naming the problem (bad JSON, other schema, missing or invalid fields). */
export function fromJson(text: string): Experiment {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`Not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(doc) || typeof doc.schema !== "string") throw new Error(`Expected an abkit experiment file with "schema": "${JSON_SCHEMA}".`);
  if (doc.schema !== JSON_SCHEMA) throw new Error(`Unsupported schema "${doc.schema}" — this version reads "${JSON_SCHEMA}".`);
  const problem = validateExperimentShape(doc.experiment);
  if (problem) throw new Error(`Invalid experiment: ${problem}`);
  return doc.experiment as Experiment;
}

// ---------------------------------------------------------------- structural validation
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isFin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const METRIC_TYPES: ReadonlySet<string> = new Set(["conversion", "continuous"]);
const STATUSES: ReadonlySet<string> = new Set(["draft", "running", "completed", "stopped"]);
const STRING_FIELDS = ["id", "name", "hypothesis", "owner", "metric", "startDate", "source"] as const;
const OPTIONAL_STRINGS = ["stoppedAt", "scenario", "notes"] as const;
const NUMBER_FIELDS = ["baseline", "mdeRel", "alpha", "power", "dailyTraffic", "split", "plannedPerArm"] as const;
const UNIT_FIELDS = ["alpha", "power", "split"] as const;
const COUNT_FIELDS = ["day", "nA", "nB", "convA", "convB"] as const;
const SUM_FIELDS = ["n", "sx", "sy", "sxx", "syy", "sxy"] as const;

/**
 * Checks that `x` has the shape of an `Experiment` (strings, finite numbers, enums, `days` as daily records with finite
 * sufficient statistics). Returns `null` when valid, otherwise the first problem found. Unknown extra keys are allowed.
 */
export function validateExperimentShape(x: unknown): string | null {
  if (!isRecord(x)) return "expected an experiment object";
  for (const k of STRING_FIELDS) if (typeof x[k] !== "string") return `${k} must be a string`;
  if ((x.id as string).trim() === "") return "id must not be empty";
  for (const k of OPTIONAL_STRINGS) if (x[k] !== undefined && typeof x[k] !== "string") return `${k} must be a string`;
  if (typeof x.metricType !== "string" || !METRIC_TYPES.has(x.metricType)) return 'metricType must be "conversion" or "continuous"';
  if (typeof x.status !== "string" || !STATUSES.has(x.status)) return 'status must be "draft", "running", "completed" or "stopped"';
  for (const k of NUMBER_FIELDS) if (!isFin(x[k])) return `${k} must be a finite number`;
  for (const k of UNIT_FIELDS) {
    const v = x[k];
    if (!isFin(v) || v <= 0 || v >= 1) return `${k} must be between 0 and 1`;
  }
  if (x.std !== undefined && !isFin(x.std)) return "std must be a finite number";
  if (!Array.isArray(x.tags) || !x.tags.every((t: unknown) => typeof t === "string")) return "tags must be an array of strings";
  if (!Array.isArray(x.days)) return "days must be an array of daily records";
  for (let i = 0; i < x.days.length; i++) {
    const d: unknown = x.days[i];
    if (!isRecord(d)) return `days[${i}] must be an object`;
    for (const k of COUNT_FIELDS) {
      const v = d[k];
      if (!isFin(v) || v < 0) return `days[${i}].${k} must be a finite number ≥ 0`;
    }
    for (const arm of ["sumsA", "sumsB"] as const) {
      const s = d[arm];
      if (!isRecord(s)) return `days[${i}].${arm} must be an object`;
      for (const k of SUM_FIELDS) if (!isFin(s[k])) return `days[${i}].${arm}.${k} must be a finite number`;
    }
  }
  return null;
}
