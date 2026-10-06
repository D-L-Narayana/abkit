import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { seedExperiments, type DayData } from "../model";
import { emptySums } from "../stats";
import { analyse, verdict } from "./analysis";
import { fromJson, parseCsvText, toCsv, toJson, type CsvFormat, type Issue, type ParseOptions } from "./csv";

const FIXTURE_DIR = new URL("../../../tests/fixtures/csv/", import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), "utf8");

const P = (text: string, opts?: ParseOptions) => parseCsvText(text, "t", opts);
const totals = (days: DayData[]) => days.reduce((a, d) => ({ nA: a.nA + d.nA, nB: a.nB + d.nB, convA: a.convA + d.convA, convB: a.convB + d.convB }), { nA: 0, nB: 0, convA: 0, convB: 0 });
/** Every finite-or-NaN number inside a value, depth first, in key order (structure-agnostic comparison of two analyses). */
function nums(x: unknown, out: number[] = []): number[] {
  if (typeof x === "number") out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => nums(v, out));
  else if (x && typeof x === "object") Object.values(x as Record<string, unknown>).forEach((v) => nums(v, out));
  return out;
}
function expectSameNumbers(a: unknown, b: unknown, rel = 1e-9): void {
  const na = nums(a), nb = nums(b);
  expect(na.length).toBeGreaterThan(10);
  expect(nb.length).toBe(na.length);
  for (let i = 0; i < na.length; i++) {
    const x = na[i]!, y = nb[i]!;
    if (Number.isNaN(x) || Number.isNaN(y)) { expect(Number.isNaN(x)).toBe(Number.isNaN(y)); continue; }
    expect(Math.abs(x - y)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(x), Math.abs(y)));
  }
}

describe("parseCsvText — RFC 4180", () => {
  it("keeps a quoted field containing the delimiter as one cell", () => {
    const r = P('variant,converted\nA,1\n"Variant, B",1\n"Variant, B",0\nA,0\n');
    expect(r.format).toBe("per-user");
    expect(r.labels).toEqual({ control: "A", treatment: "Variant, B" });
    expect(totals(r.experiment.days)).toEqual({ nA: 2, nB: 2, convA: 1, convB: 1 });
    expect(r.skipped).toEqual([]);
    expect(r.rows).toBe(4);
    expect(r.experiment.metricType).toBe("conversion");
    expect(r.experiment.source).toBe("csv");
  });

  it("unescapes doubled quotes and allows newlines inside quoted cells; issue rows count physical lines", () => {
    const r = P('variant,converted\n"Ranker ""v2""",1\nA,0\n"Ranker ""v2""",0\n"A",1\n');
    expect(r.labels.treatment).toBe('Ranker "v2"');
    expect(totals(r.experiment.days)).toEqual({ nA: 2, nB: 2, convA: 1, convB: 1 });
    const q = P('variant,converted\nA,1\n"Variant\nB",1\nA,oops\n"Variant\nB",0\n');
    expect(q.labels.treatment).toBe("Variant\nB");
    expect(q.skipped).toEqual([{ row: 5, reason: expect.stringMatching(/converted/) }]);
    expect(totals(q.experiment.days)).toEqual({ nA: 1, nB: 2, convA: 1, convB: 1 });
  });

  it("autodetects ; with CRLF and a BOM, and tab delimiters", () => {
    const r = P("﻿variant;converted;day\r\nA;1;1\r\nB;0;1\r\nA;0;2\r\nB;1;2\r\n");
    expect(r.skipped).toEqual([]);
    expect(r.experiment.days.map((d) => d.day)).toEqual([1, 2]);
    expect(totals(r.experiment.days)).toEqual({ nA: 2, nB: 2, convA: 1, convB: 1 });
    const t = P("variant\tvalue\nA\t1.5\nB\t2.5\nA\t2.5\nB\t3.5\n");
    expect(t.experiment.metricType).toBe("continuous");
    expect(t.experiment.days[0]!.sumsA.sy).toBe(4);
    expect(t.experiment.days[0]!.sumsB.sy).toBe(6);
    expect(t.hasPre).toBe(false);
  });

  it("ignores blank lines and skips rows with the wrong number of cells", () => {
    const r = P("variant,converted,day\nA,1,1\n\nB,1\nA,0,1\nB,0,1\n\n");
    expect(r.skipped).toEqual([{ row: 4, reason: expect.stringMatching(/3 columns/) }]);
    expect(r.rows).toBe(3);
    expect(totals(r.experiment.days)).toEqual({ nA: 2, nB: 1, convA: 1, convB: 0 });
  });
});

describe("parseCsvText — per-user format", () => {
  it("accepts converted as 0/1, true/false and yes/no (any case) and reports other values as issues", () => {
    const r = P("variant,converted\nA,true\nA,FALSE\nA,Yes\nA,no\nA,1\nA,0\nB,TRUE\nB,yes\nB,0\nA,maybe\n");
    expect(totals(r.experiment.days)).toEqual({ nA: 6, nB: 3, convA: 3, convB: 2 });
    expect(r.skipped).toEqual([{ row: 11, reason: expect.stringMatching(/converted.*maybe/) }]);
    expect(r.rows).toBe(9);
  });

  it("reports bad numeric cells with their line number and keeps the good rows (value + pre_value + day)", () => {
    const r = P("variant,value,pre_value,day\nA,10,9,1\nB,abc,9,1\nA,12,,1\nB,14,13,1\nB,11,10,x\nA,9,8,1\n");
    expect(r.skipped.map((i) => i.row)).toEqual([3, 4, 6]);
    expect(r.skipped[0]!.reason).toMatch(/value/);
    expect(r.skipped[1]!.reason).toMatch(/pre_value/);
    expect(r.skipped[2]!.reason).toMatch(/day/);
    expect(r.rows).toBe(3);
    expect(r.hasPre).toBe(true);
    expect(r.experiment.metricType).toBe("continuous");
    const d = r.experiment.days[0]!;
    expect(d.sumsA).toEqual({ n: 2, sx: 17, sy: 19, sxx: 145, syy: 181, sxy: 162 });
    expect(d.sumsB).toEqual({ n: 1, sx: 13, sy: 14, sxx: 169, syy: 196, sxy: 182 });
    expect(d.nA).toBe(2);
    expect(d.nB).toBe(1);
    expect(r.experiment.baseline).toBeCloseTo(9.5, 12);
  });

  it("sorts days ascending and maps ISO dates to day indices from the earliest date", () => {
    const r = P("variant,converted,day\nA,1,3\nB,0,1\nA,0,2\nB,1,3\nA,1,1\nB,0,2\n");
    expect(r.experiment.days.map((d) => d.day)).toEqual([1, 2, 3]);
    const d = P("variant,converted,day\nA,1,2026-09-03\nB,0,2026-09-01\nA,0,2026-09-02\nB,1,2026-09-03\n");
    expect(d.experiment.days.map((x) => x.day)).toEqual([1, 2, 3]);
    expect(d.experiment.startDate).toBe("2026-09-01");
    expect(d.experiment.days[2]!.nA + d.experiment.days[2]!.nB).toBe(2);
  });
});

describe("parseCsvText — aggregated format", () => {
  it("reads variant,users,conversions[,day] into daily counts", () => {
    const r = P("variant,users,conversions,day\nA,1000,100,1\nB,1000,120,1\nA,900,80,2\nB,950,99,2\n");
    expect(r.format).toBe("aggregated");
    expect(r.rows).toBe(4);
    expect(r.hasPre).toBe(false);
    expect(r.experiment.metricType).toBe("conversion");
    expect(r.experiment.days).toEqual([
      { day: 1, nA: 1000, nB: 1000, convA: 100, convB: 120, sumsA: emptySums(), sumsB: emptySums() },
      { day: 2, nA: 900, nB: 950, convA: 80, convB: 99, sumsA: emptySums(), sumsB: emptySums() },
    ]);
    expect(r.experiment.baseline).toBeCloseTo(180 / 1900, 12);
    expect(r.experiment.dailyTraffic).toBe(Math.round(3850 / 2));
  });

  it("sums several aggregated rows for the same arm and day and validates counts", () => {
    const r = P("variant,users,conversions\nA,1000,100\nA,500,40\nB,1500,160\nB,10,12\nA,-5,0\n");
    expect(r.experiment.days).toHaveLength(1);
    expect(r.experiment.days[0]).toMatchObject({ nA: 1500, nB: 1500, convA: 140, convB: 160 });
    expect(r.skipped).toEqual([
      { row: 5, reason: expect.stringMatching(/conversions/) },
      { row: 6, reason: expect.stringMatching(/users/) },
    ]);
  });

  it("reads variant,users,sum,sum_sq[,pre_sum,pre_sum_sq,cross_sum][,day] into Sums", () => {
    const r = P("variant,users,sum,sum_sq,pre_sum,pre_sum_sq,cross_sum,day\nA,3,30,320,27,251,275,1\nB,3,36,450,30,310,370,1\n");
    expect(r.format).toBe("aggregated");
    expect(r.hasPre).toBe(true);
    expect(r.experiment.metricType).toBe("continuous");
    expect(r.experiment.days[0]!.sumsA).toEqual({ n: 3, sx: 27, sy: 30, sxx: 251, syy: 320, sxy: 275 });
    expect(r.experiment.days[0]!.sumsB).toEqual({ n: 3, sx: 30, sy: 36, sxx: 310, syy: 450, sxy: 370 });
    expect(r.experiment.days[0]).toMatchObject({ nA: 3, nB: 3, convA: 0, convB: 0 });
    expect(r.experiment.baseline).toBeCloseTo(10, 12);
    const plain = P("variant,users,sum,sum_sq\nA,4,40,420\nB,4,44,500\nB,2,20,150\n");
    expect(plain.hasPre).toBe(false);
    expect(plain.experiment.days[0]!.sumsA).toEqual({ n: 4, sx: 0, sy: 40, sxx: 0, syy: 420, sxy: 0 });
    expect(plain.skipped).toEqual([{ row: 4, reason: expect.stringMatching(/sum_sq/) }]);
  });
});

describe("parseCsvText — variant labels", () => {
  it("recognises the standard control/treatment labels regardless of case and notes mixed spellings", () => {
    const r = P("variant,converted\ncontrol,1\nTreatment,0\nCTRL,0\nTEST,1\nbaseline,1\n1,1\n0,0\nvariant,1\n");
    expect(r.labels).toEqual({ control: "control", treatment: "Treatment" });
    expect(totals(r.experiment.days)).toEqual({ nA: 4, nB: 4, convA: 2, convB: 3 });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/control, CTRL, baseline, 0/);
    expect(r.warnings[1]).toMatch(/Treatment, TEST, 1, variant/);
    const plain = P("variant,converted\nA,1\nb,0\na,0\nB,1\n");
    expect(plain.labels).toEqual({ control: "A", treatment: "b" });
    expect(plain.warnings).toEqual([]);
  });

  it("uses the first-seen label as control with a warning when the pair is unknown; controlLabel overrides", () => {
    const text = "variant,converted\nnew,1\nold,0\nold,1\nnew,0\n";
    const r = P(text);
    expect(r.labels).toEqual({ control: "new", treatment: "old" });
    expect(r.warnings.some((w) => /"new".*control/.test(w))).toBe(true);
    const o = P(text, { controlLabel: "OLD" });
    expect(o.labels).toEqual({ control: "old", treatment: "new" });
    expect(o.warnings).toEqual([]);
    expect(totals(o.experiment.days)).toEqual({ nA: 2, nB: 2, convA: 1, convB: 1 });
    expect(() => P(text, { controlLabel: "zzz" })).toThrow(/zzz.*new.*old/s);
    const same = P("variant,converted\na,1\ncontrol,0\n");
    expect(same.labels).toEqual({ control: "a", treatment: "control" });
    expect(same.warnings).toHaveLength(1);
  });

  it("throws listing the labels when there are more than two, or only one", () => {
    expect(() => P("variant,converted\nA,1\nB,0\nC,1\n")).toThrow(/A, B, C/);
    expect(() => P("variant,converted\nA,1\nA,0\n")).toThrow(/both arms/i);
  });

  it("throws an actionable error for missing columns, header-only and empty input", () => {
    expect(() => P("foo,bar\n1,2\n")).toThrow(/variant/);
    expect(() => P("variant,users\nA,10\nB,10\n")).toThrow(/conversions|sum/);
    expect(() => P("variant,converted\n")).toThrow(/data row/);
    expect(() => P("")).toThrow(/data row/);
    expect(() => P("variant,value\nA,x\nB,y\n")).toThrow(/usable/i);
  });
});

describe("export round trips", () => {
  it("toCsv writes the lossless aggregated format and parseCsvText restores every day exactly (conversion)", () => {
    const e = seedExperiments().find((x) => x.id === "exp-ranker-v2")!;
    const csv = toCsv(e);
    expect(csv.split("\n")[0]).toBe("day,variant,users,conversions");
    const r = parseCsvText(csv, e.name, { alpha: e.alpha, split: e.split, mdeRel: e.mdeRel, plannedPerArm: e.plannedPerArm, status: e.status });
    expect(r.format).toBe("aggregated");
    expect(r.labels).toEqual({ control: "A", treatment: "B" });
    expect(r.experiment.days).toEqual(e.days);
    expect(r.experiment).toMatchObject({ alpha: e.alpha, split: e.split, plannedPerArm: e.plannedPerArm, status: e.status, name: e.name });
    expectSameNumbers(analyse(e), analyse({ ...e, days: r.experiment.days }));
  });

  it("toCsv/parseCsvText round-trips continuous sufficient statistics bit for bit", () => {
    const e = seedExperiments().find((x) => x.id === "exp-genius-upsell")!;
    const csv = toCsv(e);
    expect(csv.split("\n")[0]).toBe("day,variant,users,sum,sum_sq,pre_sum,pre_sum_sq,cross_sum");
    const r = parseCsvText(csv, e.name);
    expect(r.hasPre).toBe(true);
    expect(r.experiment.metricType).toBe("continuous");
    expect(r.experiment.days).toEqual(e.days);
    expectSameNumbers(analyse(e), analyse({ ...e, days: r.experiment.days }));
  });

  it("toJson/fromJson round-trips the whole experiment under schema abkit-experiment/1 and rejects bad input", () => {
    for (const e of seedExperiments().slice(0, 6)) {
      const text = toJson(e);
      expect(JSON.parse(text)).toMatchObject({ schema: "abkit-experiment/1" });
      expect(fromJson(text)).toEqual(e);
    }
    const e = seedExperiments()[0]!;
    expect(() => fromJson(JSON.stringify({ schema: "abkit-experiment/99", experiment: e }))).toThrow(/schema/);
    expect(() => fromJson(JSON.stringify({ schema: "abkit-experiment/1", experiment: { ...e, days: undefined } }))).toThrow(/days/);
    expect(() => fromJson(JSON.stringify({ schema: "abkit-experiment/1", experiment: { ...e, days: [{ ...e.days[0], nA: "12" }] } }))).toThrow(/nA/);
    expect(() => fromJson("not json")).toThrow(/JSON/);
  });
});

// ---------------------------------------------------------------- cross-language parity (tests/fixtures/csv, generated by make_fixtures.py)
interface RefLift { lift_rel: number; ci_low: number; ci_high: number; se: number }
interface RefTest { kind: string; statistic: number; p_value: number; ci_low: number; ci_high: number; df?: number }
interface RefPoint { day: number; n: number; p_value: number | null; lift_rel: number | null; ci_low: number | null; ci_high: number | null; always_valid_p: number; p_value_raw?: number | null; ci_low_raw?: number | null; ci_high_raw?: number | null }
interface Ref {
  metric_type: "conversion" | "continuous";
  format: CsvFormat;
  days: number;
  n_a: number;
  n_b: number;
  conv_a: number;
  conv_b: number;
  labels: { control: string; treatment: string };
  rows: number;
  skipped: Issue[];
  warnings: string[];
  has_pre: boolean;
  srm: { chi2: number; p_value: number; mismatch: boolean };
  test: RefTest;
  relative_lift: RefLift;
  relative_lift_raw?: RefLift;
  cuped: { theta: number; variance_reduction: number; adjusted_test: RefTest } | null;
  sequential: { tau: number; always_valid_p: number[]; decided_day: number | null };
  series: RefPoint[];
  verdict: { decision: string; basis: string };
}
type RefFile = Ref | { error: string };
const PARITY_FILES = ["conversion_per_user.csv", "continuous_per_user_cuped.csv", "aggregated_daily.csv", "aggregated_continuous.csv", "semicolon_crlf_bom.csv"];
const STAT_REL = 1e-9, P_REL = 1e-8;
/** |got − want| ≤ rel·|want| (floor 1e-12); a null reference means the TS value must be non-finite. */
function near(got: number, want: number | null, rel: number, what: string): void {
  if (want === null) { expect(Number.isFinite(got), `${what}: expected no value, got ${got}`).toBe(false); return; }
  expect(Number.isFinite(got), `${what}: got ${got}, want ${want}`).toBe(true);
  expect(Math.abs(got - want), `${what}: got ${got}, want ${want}`).toBeLessThanOrEqual(Math.max(1e-12, rel * Math.abs(want)));
}
const pct = (x: number): number => x / 100;

describe("parity with the Python reference (expected.json)", () => {
  const expected = JSON.parse(fixture("expected.json")) as Record<string, RefFile>;

  it("expected.json covers every fixture and the three-label file is rejected with the same message", () => {
    expect(Object.keys(expected).sort()).toEqual([...PARITY_FILES, "three_variants_error.csv"].sort());
    const ref = expected["three_variants_error.csv"]!;
    if (!("error" in ref)) throw new Error("expected an error entry");
    expect(ref.error).toMatch(/A, B, C/);
    expect(() => parseCsvText(fixture("three_variants_error.csv"), "x")).toThrow(ref.error);
  });

  for (const name of PARITY_FILES) {
    it(`${name}: parseCsvText → analyse reproduces the Python analysis`, () => {
      const ref = expected[name]!;
      if ("error" in ref) throw new Error(`${name}: reference is an error`);
      const r = parseCsvText(fixture(name), name);
      expect(r.format).toBe(ref.format);
      expect(r.experiment.metricType).toBe(ref.metric_type);
      expect(r.labels).toEqual(ref.labels);
      expect(r.rows).toBe(ref.rows);
      expect(r.skipped).toEqual(ref.skipped);
      expect(r.warnings).toEqual(ref.warnings);
      expect(r.hasPre).toBe(ref.has_pre);
      expect(r.experiment.days).toHaveLength(ref.days);
      const an = analyse(r.experiment);
      expect(an).not.toBeNull();
      if (!an) return;
      expect([an.last.nA, an.last.nB, an.last.convA, an.last.convB]).toEqual([ref.n_a, ref.n_b, ref.conv_a, ref.conv_b]);
      near(an.srm.chi2, ref.srm.chi2, STAT_REL, "srm.chi2");
      near(an.srm.p, ref.srm.p_value, P_REL, "srm.p");
      expect(an.srm.mismatch).toBe(ref.srm.mismatch);
      const test: { stat: number; p: number; lo: number; hi: number; df?: number } = an.kind === "conversion" ? { stat: an.z.z, p: an.z.p, lo: an.z.ciLow, hi: an.z.ciHigh } : { stat: an.raw.t, p: an.raw.p, lo: an.raw.ciLow, hi: an.raw.ciHigh, df: an.raw.df };
      near(test.stat, ref.test.statistic, STAT_REL, "test.statistic");
      near(test.p, ref.test.p_value, P_REL, "test.p_value");
      near(test.lo, ref.test.ci_low, STAT_REL, "test.ci_low");
      near(test.hi, ref.test.ci_high, STAT_REL, "test.ci_high");
      expect(test.df === undefined).toBe(ref.test.df === undefined); // Welch reports df, the z-test does not — both languages agree on the test kind
      if (ref.test.df !== undefined && test.df !== undefined) near(test.df, ref.test.df, STAT_REL, "test.df");
      near(an.rel.lift, ref.relative_lift.lift_rel, STAT_REL, "relative_lift.lift_rel");
      near(an.rel.lo, ref.relative_lift.ci_low, STAT_REL, "relative_lift.ci_low");
      near(an.rel.hi, ref.relative_lift.ci_high, STAT_REL, "relative_lift.ci_high");
      near(an.rel.se, ref.relative_lift.se, STAT_REL, "relative_lift.se");
      if (an.kind === "continuous") {
        expect(ref.relative_lift_raw).toBeDefined();
        near(an.relRaw.lift, ref.relative_lift_raw!.lift_rel, STAT_REL, "relative_lift_raw.lift_rel");
        near(an.relRaw.lo, ref.relative_lift_raw!.ci_low, STAT_REL, "relative_lift_raw.ci_low");
        near(an.relRaw.hi, ref.relative_lift_raw!.ci_high, STAT_REL, "relative_lift_raw.ci_high");
        if (ref.cuped) {
          near(an.cuped.theta, ref.cuped.theta, STAT_REL, "cuped.theta");
          near(an.cuped.varianceReduction, ref.cuped.variance_reduction, STAT_REL, "cuped.variance_reduction");
          near(an.adj.t, ref.cuped.adjusted_test.statistic, STAT_REL, "cuped.adjusted_test.statistic");
          near(an.adj.p, ref.cuped.adjusted_test.p_value, P_REL, "cuped.adjusted_test.p_value");
          near(an.adj.ciLow, ref.cuped.adjusted_test.ci_low, STAT_REL, "cuped.adjusted_test.ci_low");
          near(an.adj.ciHigh, ref.cuped.adjusted_test.ci_high, STAT_REL, "cuped.adjusted_test.ci_high");
        } else {
          near(an.adj.p, ref.test.p_value, P_REL, "adj.p without covariate");
        }
      } else {
        expect(ref.cuped).toBeNull();
      }
      near(an.sequential.tau, ref.sequential.tau, STAT_REL, "sequential.tau");
      expect(an.sequential.decidedDay).toBe(ref.sequential.decided_day);
      expect(an.series).toHaveLength(ref.series.length);
      ref.series.forEach((pt, i) => {
        const s = an.series[i]!;
        expect(s.day).toBe(pt.day);
        expect(s.n).toBe(pt.n);
        near(s.pAV, pt.always_valid_p, P_REL, `series[${i}].always_valid_p`);
        near(s.pAV, ref.sequential.always_valid_p[i]!, P_REL, `sequential.always_valid_p[${i}]`);
        near(pct(s.lift), pt.lift_rel, STAT_REL, `series[${i}].lift_rel`);
        if (an.kind === "conversion") {
          near(s.p, pt.p_value, P_REL, `series[${i}].p_value`);
          near(pct(s.band[0]), pt.ci_low, STAT_REL, `series[${i}].ci_low`);
          near(pct(s.band[1]), pt.ci_high, STAT_REL, `series[${i}].ci_high`);
        } else {
          near(s.pc ?? NaN, pt.p_value, P_REL, `series[${i}].p_value`);
          near(s.p, pt.p_value_raw ?? null, P_REL, `series[${i}].p_value_raw`);
          near(pct(s.cband![0]), pt.ci_low, STAT_REL, `series[${i}].ci_low`);
          near(pct(s.cband![1]), pt.ci_high, STAT_REL, `series[${i}].ci_high`);
          near(pct(s.band[0]), pt.ci_low_raw ?? null, STAT_REL, `series[${i}].ci_low_raw`);
          near(pct(s.band[1]), pt.ci_high_raw ?? null, STAT_REL, `series[${i}].ci_high_raw`);
        }
      });
      const v = verdict(r.experiment, an);
      expect([v.decision, v.basis]).toEqual([ref.verdict.decision, ref.verdict.basis]);
    });
  }
});
