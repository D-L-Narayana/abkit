import { describe, expect, it } from "vitest";
import type { Experiment } from "../model";
import { emptySums, fmtP, srm, twoProportionZ } from "../stats";
import { buildSummary, type SummaryAnalysis, type SummaryVerdict } from "./summary";

/** Three days of a conversion experiment: 12,000 vs 12,100 users, 1,200 vs 1,320 conversions (10.00% → 10.91%). */
function conversionExperiment(): Experiment {
  const day = (d: number, nA: number, nB: number, convA: number, convB: number) => ({ day: d, nA, nB, convA, convB, sumsA: emptySums(), sumsB: emptySums() });
  return {
    id: "exp-badge",
    name: "Free-cancellation badge",
    hypothesis: "A visible badge lifts card click-through.",
    owner: "Search team",
    metric: "Card click-through",
    metricType: "conversion",
    baseline: 0.1,
    mdeRel: 0.05,
    alpha: 0.05,
    power: 0.8,
    dailyTraffic: 8_000,
    split: 0.5,
    startDate: "2026-09-01",
    status: "completed",
    plannedPerArm: 12_000,
    days: [day(1, 4_000, 4_100, 400, 450), day(2, 4_000, 4_000, 390, 440), day(3, 4_000, 4_000, 410, 430)],
    source: "simulated",
    tags: ["ux"],
  };
}

function conversionAnalysis(): SummaryAnalysis {
  const last = { day: 3, nA: 12_000, nB: 12_100, convA: 1_200, convB: 1_320 };
  return {
    kind: "conversion",
    last,
    progress: 1,
    srm: srm([last.nA, last.nB], [0.5, 0.5]),
    z: twoProportionZ(last.convA, last.nA, last.convB, last.nB, 0.05),
    rel: { lift: 0.0909, lo: 0.0133, hi: 0.1685, se: 0.0396 },
    sequential: { pAV: 0.031, decidedDay: 3, tau: 0.005 },
  };
}

function winner(an: SummaryAnalysis): SummaryVerdict {
  return { label: "Winner", tone: "ok", p: an.z?.p ?? NaN, lift: 0.0909, reason: "Significant positive lift at the planned sample size.", decision: "winner", basis: "fixed" };
}

describe("buildSummary (Markdown export of a result)", () => {
  const e = conversionExperiment();
  const an = conversionAnalysis();
  const v = winner(an);
  const md = buildSummary(e, an, v);

  it("opens with a heading for the experiment and states the verdict with its reason", () => {
    expect(md.startsWith("# Free-cancellation badge")).toBe(true);
    expect(md).toContain("**Verdict:** Winner");
    expect(md).toContain("Significant positive lift at the planned sample size.");
    expect(md).toContain("> A visible badge lifts card click-through.");
  });

  it("reports the delta-method relative lift with its confidence interval", () => {
    expect(md).toContain("**Relative lift:** +9.09%");
    expect(md).toContain("95% CI [+1.33%, +16.85%]");
    expect(md).toMatch(/delta method/i);
  });

  it("reports the fixed-horizon p-value, the test used and the absolute difference", () => {
    expect(md).toContain(`**p-value:** ${fmtP(v.p)}`);
    expect(md).toMatch(/two-proportion z-test/);
    expect(md).toContain("α = 0.05");
    expect(md).toContain("**Absolute difference:** +0.91 pt");
  });

  it("includes the always-valid p-value and the day the sequential rule fired", () => {
    expect(md).toContain("**Always-valid p (mSPRT):** 0.0310");
    expect(md).toMatch(/crossed α on day 3/);
  });

  it("omits the always-valid line when no sequential result exists", () => {
    const out = buildSummary(e, { ...an, sequential: undefined }, v);
    expect(out).not.toMatch(/always-valid/i);
    expect(out).toContain("**p-value:**");
  });

  it("reports a passing sample-ratio check with the expected and observed split", () => {
    expect(md).toMatch(/\*\*Sample-ratio check:\*\* passed/);
    expect(md).toContain("expected 50% / 50%");
    expect(md).toContain("observed 12,000 / 12,100");
    expect(md).toContain(`p = ${fmtP(an.srm.p)}`);
  });

  it("flags a sample-ratio mismatch as invalidating every metric", () => {
    const bad = buildSummary(
      e,
      { ...an, srm: { chi2: 29.3, p: 6.2e-8, mismatch: true } },
      { ...v, label: "SRM — invalid", tone: "bad", decision: "invalid", reason: "The observed split does not match the intended allocation, so no metric can be trusted." },
    );
    expect(bad).toMatch(/\*\*Sample-ratio check:\*\* MISMATCH/);
    expect(bad).toContain("**Verdict:** SRM — invalid");
    expect(bad).toMatch(/do not act/i);
  });

  it("lists users, conversions and rates per arm and the sample progress", () => {
    expect(md).toContain("| A · control | 12,000 | 1,200 | 10.00% |");
    expect(md).toContain("| B · treatment | 12,100 | 1,320 | 10.91% |");
    expect(md).toContain("12,000 of 12,000 planned per arm (100%)");
  });

  it("includes the start date, the duration and the end date", () => {
    expect(md).toContain("2026-09-01");
    expect(md).toContain("3 days");
    expect(md).toContain("2026-09-03");
  });

  it("mentions when an experiment was stopped early", () => {
    const stoppedExperiment = { ...e, status: "stopped" as const, stoppedAt: "2026-09-02T09:30:00.000Z" };
    const out = buildSummary(stoppedExperiment, { ...an, progress: 0.67 }, v);
    expect(out).toMatch(/stopped on 2026-09-02/);
  });

  it("describes a continuous metric with Welch's t-test, CUPED and an undecided sequential test", () => {
    const ce = { ...e, id: "exp-rev", name: "Loyalty upsell", metric: "Revenue per visitor", metricType: "continuous" as const, baseline: 412, std: 640, status: "running" as const };
    const can: SummaryAnalysis = {
      kind: "continuous",
      last: { day: 3, nA: 9_000, nB: 9_050, convA: 0, convB: 0 },
      progress: 0.6,
      srm: srm([9_000, 9_050], [0.5, 0.5]),
      a: { n: 9_000, mean: 412.3, var: 640 ** 2 },
      b: { n: 9_050, mean: 426.5, var: 650 ** 2 },
      raw: { diff: 14.2, liftRel: 0.0344, p: 0.139, ciLow: -4.6, ciHigh: 33.0 },
      adj: { diff: 13.9, liftRel: 0.0337, p: 0.0574, ciLow: -0.4, ciHigh: 28.2 },
      cuped: { theta: 0.62, varianceReduction: 0.384 },
      rel: { lift: 0.0337, lo: -0.001, hi: 0.0684, se: 0.0177 },
      sequential: { pAV: 0.41, decidedDay: null, tau: 12.4 },
    };
    const cv: SummaryVerdict = { label: "Collecting · 60%", tone: "neutral", p: 0.0574, lift: 0.0337, reason: "Planned sample size not reached yet — do not read the p-value as a decision.", decision: "collecting", basis: "fixed" };
    const out = buildSummary(ce, can, cv);
    expect(out).toContain("| A · control | 9,000 | 412.3 | 640 |");
    expect(out).toContain("| B · treatment | 9,050 | 426.5 | 650 |");
    expect(out).toMatch(/Welch/);
    expect(out).toContain("θ = 0.620");
    expect(out).toContain("38.4% of variance removed");
    expect(out).toContain("**Absolute difference:** +13.9 (95% CI [-0.4, +28.2])");
    expect(out).toMatch(/has not crossed α/);
    expect(out).toContain("**Verdict:** Collecting · 60%");
  });

  it("falls back to the verdict lift when no delta-method interval is available", () => {
    const out = buildSummary(e, { ...an, rel: undefined }, v);
    expect(out).toContain("**Relative lift:** +9.09%");
    expect(out).toMatch(/confidence interval unavailable/i);
    expect(out).not.toMatch(/delta method/i);
  });

  it("explains sequential decisions taken before the planned sample size", () => {
    const running = { ...e, status: "running" as const };
    const out = buildSummary(running, { ...an, progress: 0.7 }, { ...v, label: "Winner · sequential", basis: "sequential", reason: "The always-valid p-value crossed α on day 3." });
    expect(out).toContain("**Verdict:** Winner · sequential");
    expect(out).toMatch(/valid despite daily peeking/i);
  });

  it("is plain Markdown without HTML and never prints NaN", () => {
    expect(md).not.toMatch(/<[a-z!/]/i);
    const out = buildSummary(e, { ...an, rel: { lift: NaN, lo: NaN, hi: NaN }, sequential: { pAV: NaN, decidedDay: null } }, { ...v, p: NaN, lift: NaN });
    expect(out.startsWith("# Free-cancellation badge")).toBe(true);
    expect(out).not.toMatch(/NaN/);
  });
});
