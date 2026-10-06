import { describe, expect, it } from "vitest";
import { cumulative, seedExperiments, type DayData, type Experiment } from "../model";
import { addSums, cuped, emptySums, mulberry32, randn, relativeLiftMeans, relativeLiftProportions, twoProportionZ, type Sums } from "../stats";
import { P_PLOT_FLOOR, analyse, verdict } from "./analysis";

/** |actual − expected| ≤ max(abs, rel·|expected|); NaN never passes. */
function close(actual: number, expected: number, rel: number, abs = 0): void {
  const tol = Math.max(abs, rel * Math.abs(expected));
  expect(Math.abs(actual - expected), `got ${actual}, want ${expected} (tol ${tol})`).toBeLessThanOrEqual(tol);
}

const BASE: Omit<Experiment, "days"> = { id: "exp-test", name: "Test", hypothesis: "", owner: "QA", metric: "Conversion", metricType: "conversion", baseline: 0.1, mdeRel: 0.1, alpha: 0.05, power: 0.8, dailyTraffic: 6000, split: 0.5, startDate: "2026-01-01", status: "running", plannedPerArm: 100_000, source: "csv", tags: [] };
type Row = [nA: number, nB: number, convA: number, convB: number];
const repeat = (n: number, row: Row): Row[] => Array.from({ length: n }, () => row);
function conv(rows: Row[], over: Partial<Experiment> = {}): Experiment {
  return { ...BASE, days: rows.map(([nA, nB, convA, convB], i) => ({ day: i + 1, nA, nB, convA, convB, sumsA: emptySums(), sumsB: emptySums() })), ...over };
}
// 10 days × 3,000 users per arm per day. Planned 100,000 per arm → progress 30% (sequential territory).
const LIFT = conv(repeat(10, [3000, 3000, 300, 330])); // 10% → 11%
const FLAT = conv(repeat(10, [3000, 3000, 300, 300])); // A/A
const LOSER = conv(repeat(10, [3000, 3000, 300, 270])); // 10% → 9%
const SKEW = conv(repeat(10, [3000, 3200, 300, 320])); // 30,000 vs 32,000 users: sample-ratio mismatch

/** Deterministic per-user draws aggregated to sufficient statistics (X = pre-period covariate, Y = metric). */
function contDays(days: number, perDay: number, meanA: number, meanB: number, sd: number, rho: number, seed: number): DayData[] {
  const rnd = mulberry32(seed);
  const arm = (n: number, mean: number): Sums => {
    let s = emptySums();
    for (let i = 0; i < n; i++) {
      const zx = randn(rnd);
      const zy = rho * zx + Math.sqrt(1 - rho * rho) * randn(rnd);
      const x = 100 + 30 * zx, y = mean + sd * zy;
      s = addSums(s, { n: 1, sx: x, sy: y, sxx: x * x, syy: y * y, sxy: x * y });
    }
    return s;
  };
  return Array.from({ length: days }, (_, i) => ({ day: i + 1, nA: perDay, nB: perDay, convA: 0, convB: 0, sumsA: arm(perDay, meanA), sumsB: arm(perDay, meanB) }));
}
const CONT: Experiment = { ...BASE, id: "exp-cont", metric: "Revenue per visitor", metricType: "continuous", baseline: 100, std: 30, mdeRel: 0.03, plannedPerArm: 50_000, days: contDays(8, 400, 100, 103, 30, 0.6, 11) };

/** Reference mSPRT (PLAN §3.2): Λ = √(V/(V+τ²))·exp(d²τ²/(2V(V+τ²))), p_k = min(1, 1/max_{j≤k} Λ_j); looks without variance carry no evidence. */
function refSequential(points: { diff: number; varDiff: number }[], tau: number, alpha: number): { pAV: number[]; decidedAt: number | null } {
  let running = 0;
  let decidedAt: number | null = null;
  const pAV = points.map(({ diff, varDiff }, k) => {
    const lr = varDiff > 0 ? Math.sqrt(varDiff / (varDiff + tau * tau)) * Math.exp((diff * diff * tau * tau) / (2 * varDiff * (varDiff + tau * tau))) : 0;
    running = Math.max(running, lr);
    const p = running > 0 ? Math.min(1, 1 / running) : 1;
    if (decidedAt === null && p < alpha) decidedAt = k + 1;
    return p;
  });
  return { pAV, decidedAt };
}
/** Cumulative looks of a conversion experiment with the pooled null variance V_k = p̄(1−p̄)(1/nA + 1/nB). */
const propPoints = (e: Experiment) => cumulative(e.days).map((d) => { const pbar = (d.convA + d.convB) / (d.nA + d.nB); return { diff: d.convB / d.nB - d.convA / d.nA, varDiff: pbar * (1 - pbar) * (1 / d.nA + 1 / d.nB) }; });

describe("analyse — conversion metric", () => {
  it("returns the fixed-horizon z-test and the final delta-method relative CI", () => {
    const an = analyse(LIFT);
    expect(an).not.toBeNull();
    if (!an || an.kind !== "conversion") throw new Error("expected a conversion analysis");
    expect(an.z).toEqual(twoProportionZ(3000, 30_000, 3300, 30_000, 0.05));
    expect(an.rel).toBeDefined();
    expect(an.rel).toEqual(relativeLiftProportions(3000, 30_000, 3300, 30_000, 0.05));
    close(an.rel.lift, 0.1, 0, 1e-12);
    expect(an.progress).toBeCloseTo(0.3, 12);
    expect(an.last.nA + an.last.nB).toBe(60_000);
    expect(an.series.map((s) => s.n)).toEqual(Array.from({ length: 10 }, (_, i) => 6000 * (i + 1)));
  });

  it("series bands are delta-method relative CIs in percent, not the absolute CI divided by the control rate", () => {
    const an = analyse(LIFT);
    if (!an || an.kind !== "conversion") throw new Error("expected a conversion analysis");
    cumulative(LIFT.days).forEach((d, i) => {
      const rl = relativeLiftProportions(d.convA, d.nA, d.convB, d.nB, 0.05);
      const s = an.series[i]!;
      expect(s.day).toBe(d.day);
      close(s.lift, 100 * rl.lift, 1e-12);
      close(s.band[0], 100 * rl.lo, 1e-12);
      close(s.band[1], 100 * rl.hi, 1e-12);
      expect(s.cband).toBeUndefined();
    });
    const last = an.series[an.series.length - 1]!;
    const naive: [number, number] = [(100 * an.z.ciLow) / an.z.rateA, (100 * an.z.ciHigh) / an.z.rateA];
    expect(last.band[0]).toBeLessThan(naive[0]); // for a positive lift the delta-method band is wider on both sides
    expect(last.band[1]).toBeGreaterThan(naive[1]);
  });

  it("exposes the always-valid p series of the mSPRT twin with τ = p̂A(final) · relative MDE", () => {
    const an = analyse(LIFT);
    if (!an) throw new Error("expected an analysis");
    const ref = refSequential(propPoints(LIFT), 0.1 * 0.1, 0.05);
    close(an.sequential.tau, 0.01, 1e-12);
    an.series.forEach((s, i) => close(s.pAV, ref.pAV[i]!, 1e-12));
    expect(an.sequential.pAV).toBe(an.series[an.series.length - 1]!.pAV);
    expect(an.sequential.pAV).toBeLessThan(0.05);
    expect(ref.decidedAt).not.toBeNull();
    expect(an.sequential.decidedDay).toBe(ref.decidedAt); // days are numbered 1..10, so look index = day
    expect(an.sequential.decidedDay).toBeLessThanOrEqual(10);
  });

  it("always-valid p is non-increasing and both plotted p series are clamped to [P_PLOT_FLOOR, 1]", () => {
    const an = analyse(LIFT);
    if (!an) throw new Error("expected an analysis");
    expect(P_PLOT_FLOOR).toBe(1e-4);
    an.series.forEach((s, i) => {
      if (i > 0) expect(s.pAV).toBeLessThanOrEqual(an.series[i - 1]!.pAV);
      expect(s.pAV).toBeGreaterThan(0);
      expect(s.pAV).toBeLessThanOrEqual(1);
      expect(s.pPlot).toBe(Math.max(P_PLOT_FLOOR, Math.min(1, s.p)));
      expect(s.pAVPlot).toBe(Math.max(P_PLOT_FLOOR, Math.min(1, s.pAV)));
    });
    const last = an.series[an.series.length - 1]!;
    expect(last.p).toBeLessThan(P_PLOT_FLOOR); // z ≈ 4 → the floor is actually exercised
    expect(last.pPlot).toBe(P_PLOT_FLOOR);
  });

  it("A/A data: lift 0, p ≈ 1, always-valid p stays at 1 and no decision day", () => {
    const an = analyse(FLAT);
    if (!an || an.kind !== "conversion") throw new Error("expected a conversion analysis");
    expect(an.rel.lift).toBe(0);
    close(an.z.p, 1, 1e-15);
    an.series.forEach((s) => { expect(s.pAV).toBe(1); expect(s.pAVPlot).toBe(1); });
    expect(an.sequential.decidedDay).toBeNull();
    expect(an.sequential.pAV).toBe(1);
  });
});

describe("analyse — continuous metric (CUPED)", () => {
  it("rel is the delta-method CI on CUPED-adjusted means; relRaw on raw means; the adjusted band is narrower", () => {
    const an = analyse(CONT);
    expect(an).not.toBeNull();
    if (!an || an.kind !== "continuous") throw new Error("expected a continuous analysis");
    expect(an.rel).toEqual(relativeLiftMeans(an.cuped.adjA, an.cuped.adjB, 0.05));
    expect(an.relRaw).toEqual(relativeLiftMeans(an.a, an.b, 0.05));
    expect(an.rel.hi - an.rel.lo).toBeLessThan(an.relRaw.hi - an.relRaw.lo);
    expect(an.cuped.varianceReduction).toBeGreaterThan(0.2); // ρ = 0.6 → ≈ 36% of the variance removed
    const last = an.series[an.series.length - 1]!;
    close(last.lift, 100 * an.rel.lift, 1e-12);
    close(last.cband![0], 100 * an.rel.lo, 1e-12);
    close(last.cband![1], 100 * an.rel.hi, 1e-12);
    close(last.band[0], 100 * an.relRaw.lo, 1e-12);
    close(last.band[1], 100 * an.relRaw.hi, 1e-12);
    expect(last.p).toBe(an.raw.p);
    expect(last.pc).toBe(an.adj.p);
    expect(last.pPlot).toBe(Math.max(P_PLOT_FLOOR, Math.min(1, an.adj.p)));
  });

  it("always-valid p uses the CUPED-adjusted difference and its Welch variance, τ = mean_A(final) · relative MDE", () => {
    const an = analyse(CONT);
    if (!an || an.kind !== "continuous") throw new Error("expected a continuous analysis");
    const points = cumulative(CONT.days).map((d) => { const c = cuped(d.sumsA, d.sumsB); return { diff: c.adjB.mean - c.adjA.mean, varDiff: c.adjA.var / c.adjA.n + c.adjB.var / c.adjB.n }; });
    const tau = Math.abs(an.a.mean * 0.03);
    const ref = refSequential(points, tau, 0.05);
    close(an.sequential.tau, tau, 1e-12);
    an.series.forEach((s, i) => close(s.pAV, ref.pAV[i]!, 1e-12));
    expect(an.sequential.decidedDay).toBe(ref.decidedAt);
    expect(an.sequential.pAV).toBe(an.series[an.series.length - 1]!.pAV);
  });

  it("tolerates a first look with a single user per arm (no evidence, nothing thrown)", () => {
    const tiny = contDays(1, 1, 100, 103, 30, 0.6, 5)[0]!;
    const e: Experiment = { ...CONT, days: [tiny, ...CONT.days.map((d) => ({ ...d, day: d.day + 1 }))] };
    const an = analyse(e);
    expect(an).not.toBeNull();
    if (!an) throw new Error("expected an analysis");
    expect(an.series[0]!.pAV).toBe(1);
    expect(Number.isFinite(an.series[an.series.length - 1]!.pAV)).toBe(true);
    expect(Number.isFinite(an.rel.lift)).toBe(true);
  });
});

describe("verdict — decision rules", () => {
  it("sample-ratio mismatch → invalid, whatever the metric says", () => {
    const an = analyse(SKEW);
    if (!an) throw new Error("expected an analysis");
    expect(an.srm.mismatch).toBe(true);
    const v = verdict(SKEW, an);
    expect(v.decision).toBe("invalid");
    expect(v.label).toBe("SRM — invalid");
    expect(v.tone).toBe("bad");
    expect(v.basis).toBe("fixed");
  });

  it("running below the planned sample: always-valid p < α → winner / loser with basis sequential", () => {
    const anW = analyse(LIFT);
    const anL = analyse(LOSER);
    if (!anW || !anL) throw new Error("expected analyses");
    expect(anW.progress).toBeLessThan(1);
    const w = verdict(LIFT, anW);
    expect(w.decision).toBe("winner");
    expect(w.basis).toBe("sequential");
    expect(w.label).toBe("Winner · sequential");
    expect(w.tone).toBe("ok");
    expect(w.lift).toBeGreaterThan(0);
    const l = verdict(LOSER, anL);
    expect(l.decision).toBe("loser");
    expect(l.basis).toBe("sequential");
    expect(l.label).toBe("Loser · sequential");
    expect(l.tone).toBe("bad");
    expect(l.lift).toBeLessThan(0);
  });

  it("running below the planned sample without a sequential signal → collecting", () => {
    const an = analyse(FLAT);
    if (!an) throw new Error("expected an analysis");
    const v = verdict(FLAT, an);
    expect(v.decision).toBe("collecting");
    expect(v.basis).toBe("fixed");
    expect(v.label).toBe("Collecting · 30%");
    expect(v.tone).toBe("neutral");
  });

  it("planned sample reached → fixed-horizon decision on p (no sequential suffix)", () => {
    const e = { ...LIFT, plannedPerArm: 30_000 };
    const an = analyse(e);
    if (!an) throw new Error("expected an analysis");
    expect(an.progress).toBe(1);
    const v = verdict(e, an);
    expect(v.decision).toBe("winner");
    expect(v.basis).toBe("fixed");
    expect(v.label).toBe("Winner");
    expect(v.tone).toBe("ok");
  });

  it("completed or stopped experiments are judged by the fixed-horizon p even below the planned sample", () => {
    const done = { ...FLAT, status: "completed" as const };
    const anD = analyse(done);
    if (!anD) throw new Error("expected an analysis");
    const vd = verdict(done, anD);
    expect(vd.decision).toBe("flat");
    expect(vd.basis).toBe("fixed");
    expect(vd.label).toBe("No significant effect");
    expect(vd.tone).toBe("warn");
    const stopped = { ...LOSER, status: "stopped" as const };
    const anS = analyse(stopped);
    if (!anS) throw new Error("expected an analysis");
    const vs = verdict(stopped, anS);
    expect(vs.decision).toBe("loser");
    expect(vs.basis).toBe("fixed");
    expect(vs.label).toBe("Loser");
    expect(vs.reason).toMatch(/stopped/i);
  });

  it("carries the fixed-horizon p and the delta-method lift of the analysis", () => {
    const anC = analyse(LIFT);
    const anK = analyse(CONT);
    if (!anC || anC.kind !== "conversion" || !anK || anK.kind !== "continuous") throw new Error("expected analyses");
    const vc = verdict(LIFT, anC);
    expect(vc.p).toBe(anC.z.p);
    expect(vc.lift).toBe(anC.rel.lift);
    const vk = verdict(CONT, anK);
    expect(vk.p).toBe(anK.adj.p); // CUPED-adjusted Welch p
    expect(vk.lift).toBe(anK.rel.lift);
  });
});

describe("analyse never throws", () => {
  const strip = (d: DayData): Omit<DayData, "sumsA" | "sumsB"> => ({ day: d.day, nA: d.nA, nB: d.nB, convA: d.convA, convB: d.convB });
  const malformed: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "experiment"],
    ["an empty object", {}],
    ["no days", { ...BASE, days: [] }],
    ["days is not an array", { ...BASE, days: "nope" }],
    ["a null day", { ...BASE, days: [null] }],
    ["no users at all", conv([[0, 0, 0, 0], [0, 0, 0, 0]])],
    ["conversions above users", conv([[100, 100, 150, 10]])],
    ["NaN users", conv([[NaN, 100, 10, 10]])],
    ["negative users", conv([[100, -5, 10, 0]])],
    ["non-numeric counts", { ...BASE, days: [{ day: 1, nA: "100", nB: 100, convA: 10, convB: 10, sumsA: emptySums(), sumsB: emptySums() }] }],
    ["unknown metric type", { ...LIFT, metricType: "bogus" }],
    ["alpha = 0", { ...LIFT, alpha: 0 }],
    ["alpha = 1", { ...LIFT, alpha: 1 }],
    ["alpha NaN", { ...LIFT, alpha: NaN }],
    ["split = 0", { ...LIFT, split: 0 }],
    ["split > 1", { ...LIFT, split: 1.2 }],
    ["continuous without sufficient statistics", { ...CONT, days: CONT.days.map(strip) }],
    ["continuous with NaN sums", { ...CONT, days: CONT.days.map((d) => ({ ...d, sumsA: { ...d.sumsA, syy: NaN } })) }],
    ["continuous with a non-object sums field", { ...CONT, days: CONT.days.map((d) => ({ ...d, sumsB: 7 })) }],
  ];
  it.each(malformed)("returns null for %s", (_label, input) => {
    let out: unknown = "unset";
    expect(() => { out = analyse(input as Experiment); }).not.toThrow();
    expect(out).toBeNull();
  });

  it("is lenient where it can be: conversion data without sums still analyses", () => {
    const e = { ...LIFT, days: LIFT.days.map(strip) } as unknown as Experiment;
    const an = analyse(e);
    expect(an).not.toBeNull();
    if (!an || an.kind !== "conversion") throw new Error("expected a conversion analysis");
    expect(an.z.p).toBe(twoProportionZ(3000, 30_000, 3300, 30_000, 0.05).p);
  });

  it("verdict never throws for any valid analysis", () => {
    for (const e of [LIFT, FLAT, LOSER, SKEW, CONT, { ...LIFT, status: "draft" as const }]) {
      const an = analyse(e);
      expect(an).not.toBeNull();
      expect(() => verdict(e, an!)).not.toThrow();
    }
  });
});

describe("the six seeded demo experiments", () => {
  const seeds = seedExperiments();
  it("all analyse with finite always-valid p-values, consistent series and verdicts that follow the rules", () => {
    expect(seeds.length).toBe(6);
    for (const e of seeds) {
      const an = analyse(e);
      expect(an, e.id).not.toBeNull();
      if (!an) continue;
      expect(an.series.length).toBe(e.days.length);
      an.series.forEach((s, i) => {
        expect(Number.isFinite(s.pAV), `${e.id} day ${s.day} pAV`).toBe(true);
        expect(Number.isFinite(s.lift), `${e.id} day ${s.day} lift`).toBe(true);
        expect(s.band[0]).toBeLessThanOrEqual(s.lift);
        expect(s.band[1]).toBeGreaterThanOrEqual(s.lift);
        if (i > 0) expect(s.pAV).toBeLessThanOrEqual(an.series[i - 1]!.pAV);
      });
      expect(Number.isFinite(an.rel.lift), `${e.id} rel`).toBe(true);
      expect(Number.isFinite(an.sequential.tau)).toBe(true);
      const v = verdict(e, an);
      if (v.basis === "sequential") {
        expect(v.label.endsWith(" · sequential")).toBe(true);
        expect(an.progress).toBeLessThan(1);
        expect(an.sequential.pAV).toBeLessThan(e.alpha);
        expect(["winner", "loser"]).toContain(v.decision);
      }
      if (v.decision === "collecting") expect(an.sequential.pAV).toBeGreaterThanOrEqual(e.alpha);
      if (v.decision === "invalid") expect(an.srm.mismatch).toBe(true);
    }
  });
  it("the bucketing-bug demo is invalid and the completed ranker demo is a fixed-horizon winner", () => {
    const map = seeds.find((e) => e.id === "exp-map-default")!;
    const ranker = seeds.find((e) => e.id === "exp-ranker-v2")!;
    const vMap = verdict(map, analyse(map)!);
    expect(vMap.decision).toBe("invalid");
    expect(vMap.label).toBe("SRM — invalid");
    const vRanker = verdict(ranker, analyse(ranker)!);
    expect(ranker.status).toBe("completed");
    expect(vRanker.decision).toBe("winner");
    expect(vRanker.basis).toBe("fixed");
    expect(vRanker.label).toBe("Winner");
  });
});
