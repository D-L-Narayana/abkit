import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./lib/scenarios";
import * as model from "./model";
import { cumulative, hash, seedExperiments, simulate, sufficientStatsNormal, type Experiment, type SimOptions } from "./model";
import { meanVar, mulberry32, welch, type Sums } from "./stats";

// ---------------- helpers ----------------
const def = (id: string, extra: Partial<Omit<Experiment, "days">> = {}): Omit<Experiment, "days"> => ({
  id,
  name: "test",
  hypothesis: "",
  owner: "tests",
  metric: "Revenue per visitor",
  metricType: "continuous",
  baseline: 412,
  std: 640,
  mdeRel: 0.03,
  alpha: 0.05,
  power: 0.8,
  dailyTraffic: 30_000,
  split: 0.5,
  startDate: "2026-09-01",
  status: "running",
  plannedPerArm: 0,
  source: "simulated",
  tags: [],
  ...extra,
});

/** Sample moments implied by a Sums record: means, ddof=1 variances/covariance and the Pearson correlation. */
function implied(s: Sums) {
  const n = s.n, mx = s.sx / n, my = s.sy / n;
  const vx = (s.sxx - n * mx * mx) / (n - 1);
  const vy = (s.syy - n * my * my) / (n - 1);
  const cxy = (s.sxy - n * mx * my) / (n - 1);
  return { n, mx, my, vx, vy, cxy, r: cxy / Math.sqrt(vx * vy) };
}
const last = <T>(xs: T[]): T => xs[xs.length - 1]!;

// Captured from the seeded conversion path before the continuous-metric rewrite. These numbers must never move:
// the demo ids, the per-day traffic/allocation draws and the conversion counts are part of the app's contract.
const SEED_IDS = ["exp-ranker-v2", "exp-free-cancel-badge", "exp-urgency-copy", "exp-checkout-2step", "exp-genius-upsell", "exp-map-default"];
const RANKER_DAY1 = { nA: 31808, nB: 31834, convA: 2646, convB: 2688 };
const MAP_DAY1 = { nA: 23408, nB: 24726, convA: 6423, convB: 6680 };
const CONVERSION_TOTALS = [
  { id: "exp-ranker-v2", days: 21, nA: 566738, nB: 568259, convA: 46676, convB: 49131, plannedPerArm: 111832 },
  { id: "exp-free-cancel-badge", days: 12, nA: 467898, nB: 465655, convA: 145213, convB: 145639, plannedPerArm: 39139 },
  { id: "exp-urgency-copy", days: 14, nA: 362532, nB: 361948, convA: 30891, convB: 31933, plannedPerArm: 69121 },
  { id: "exp-checkout-2step", days: 14, nA: 113791, nB: 113863, convA: 47842, convB: 46689, plannedPerArm: 24182 },
  { id: "exp-map-default", days: 8, nA: 179439, nB: 187877, convA: 48604, convB: 50730, plannedPerArm: 17240 },
];
const day1 = (e: Experiment) => {
  const d = e.days[0]!;
  return { nA: d.nA, nB: d.nB, convA: d.convA, convB: d.convB };
};

// ---------------- honest continuous simulation ----------------
describe("continuous simulation is statistically honest", () => {
  it("A/A: Welch on the cumulative sums rejects at α = 0.05 in ≤ 10% of 200 seeded 10-day runs (412 ± 640, 30k users/day)", () => {
    let rejections = 0;
    for (let i = 0; i < 200; i++) {
      const days = simulate(def(`aa-${i}`), { trueLiftRel: 0, days: 10 });
      const cum = last(cumulative(days));
      const t = welch(meanVar(cum.sumsA), meanVar(cum.sumsB), 0.05);
      if (t.p < 0.05) rejections++;
    }
    expect(rejections / 200).toBeLessThanOrEqual(0.1);
  });

  it("daily arm means carry n-scale noise and the implied SD / pre-period correlation match the parameters", () => {
    const days = simulate(def("honest-days"), { trueLiftRel: 0, days: 18, preCorrelation: 0.62 });
    expect(days).toHaveLength(18);
    for (const d of days) {
      const a = implied(d.sumsA), b = implied(d.sumsB);
      expect(a.n).toBe(d.nA);
      expect(b.n).toBe(d.nB);
      // the mean of ~15k users has SE σ/√n ≈ 5.2 — a 400-draw mean (SE 32) would fail this on most days
      expect(Math.abs(a.my - 412)).toBeLessThan((5 * 640) / Math.sqrt(d.nA));
      expect(Math.abs(b.my - 412)).toBeLessThan((5 * 640) / Math.sqrt(d.nB));
      expect(Math.abs(a.mx - 412)).toBeLessThan((5 * 640) / Math.sqrt(d.nA));
      for (const s of [a, b]) {
        expect(Math.sqrt(s.vy) / 640).toBeGreaterThan(0.95);
        expect(Math.sqrt(s.vy) / 640).toBeLessThan(1.05);
        expect(Math.sqrt(s.vx) / 640).toBeGreaterThan(0.95);
        expect(Math.sqrt(s.vx) / 640).toBeLessThan(1.05);
        expect(Math.abs(s.r - 0.62)).toBeLessThan(0.05);
      }
    }
  });
});

// ---------------- conversion path: bit-identical ----------------
describe("conversion path is bit-identical to the captured snapshot", () => {
  it("keeps the six demo ids in order", () => {
    expect(seedExperiments().map((e) => e.id)).toEqual(SEED_IDS);
  });

  it("exp-ranker-v2 day 1 users and conversions are unchanged", () => {
    const e = seedExperiments().find((x) => x.id === "exp-ranker-v2")!;
    expect(day1(e)).toEqual(RANKER_DAY1);
  });

  it("exp-map-default day 1 users and conversions are unchanged", () => {
    const e = seedExperiments().find((x) => x.id === "exp-map-default")!;
    expect(day1(e)).toEqual(MAP_DAY1);
  });

  it("cumulative totals and planned sample sizes of every conversion demo are unchanged", () => {
    const seeds = seedExperiments();
    for (const t of CONVERSION_TOTALS) {
      const e = seeds.find((x) => x.id === t.id)!;
      const l = last(cumulative(e.days));
      expect({ id: e.id, days: e.days.length, nA: l.nA, nB: l.nB, convA: l.convA, convB: l.convB, plannedPerArm: e.plannedPerArm }).toEqual(t);
      expect(e.metricType).toBe("conversion");
    }
  });

  it("traffic and allocation are drawn before the metric: the continuous demo's day-1 users and plan are unchanged", () => {
    const e = seedExperiments().find((x) => x.id === "exp-genius-upsell")!;
    expect(e.metricType).toBe("continuous");
    expect(e.days).toHaveLength(18);
    expect({ nA: e.days[0]!.nA, nB: e.days[0]!.nB }).toEqual({ nA: 15142, nB: 15108 });
    expect(e.plannedPerArm).toBe(42089);
  });
});

// ---------------- sufficientStatsNormal ----------------
describe("sufficientStatsNormal", () => {
  it("large n (Wilson–Hilferty χ² branch): means, variances, correlation and the variance of the mean match the model", () => {
    const rnd = mulberry32(20261006);
    const n = 15_000, mx = 400, my = 412, sdx = 600, sdy = 640, rho = 0.62, draws = 3000;
    let sMx = 0, sMy = 0, sMx2 = 0, sMy2 = 0, sVx = 0, sVy = 0, sR = 0;
    for (let i = 0; i < draws; i++) {
      const s = sufficientStatsNormal(n, mx, my, sdx, sdy, rho, rnd);
      expect(s.n).toBe(n);
      const m = implied(s);
      sMx += m.mx; sMy += m.my; sMx2 += m.mx * m.mx; sMy2 += m.my * m.my; sVx += m.vx; sVy += m.vy; sR += m.r;
    }
    const meanX = sMx / draws, meanY = sMy / draws;
    // SE of the average of 3000 sample means is σ/√n/√draws ≈ 0.09 — allow 0.5
    expect(Math.abs(meanX - mx)).toBeLessThan(0.5);
    expect(Math.abs(meanY - my)).toBeLessThan(0.5);
    // Var(x̄) must be σ²/n (24 for x, 27.3 for y), not σ²/400
    const varXbar = sMx2 / draws - meanX * meanX, varYbar = sMy2 / draws - meanY * meanY;
    expect(varXbar / ((sdx * sdx) / n)).toBeGreaterThan(0.85);
    expect(varXbar / ((sdx * sdx) / n)).toBeLessThan(1.15);
    expect(varYbar / ((sdy * sdy) / n)).toBeGreaterThan(0.85);
    expect(varYbar / ((sdy * sdy) / n)).toBeLessThan(1.15);
    // E[S²] = σ² and E[r] ≈ ρ
    expect(Math.abs(sVx / draws / (sdx * sdx) - 1)).toBeLessThan(0.01);
    expect(Math.abs(sVy / draws / (sdy * sdy) - 1)).toBeLessThan(0.01);
    expect(Math.abs(sR / draws - rho)).toBeLessThan(0.01);
  });

  it("small n (sum-of-squared-normals χ² branch) matches too, with a negative correlation", () => {
    const rnd = mulberry32(777);
    const n = 12, mx = 10, my = -3, sdx = 2, sdy = 5, rho = -0.5, draws = 20_000;
    let sMx = 0, sMy = 0, sMx2 = 0, sVx = 0, sVy = 0, sR = 0, sC = 0;
    for (let i = 0; i < draws; i++) {
      const s = sufficientStatsNormal(n, mx, my, sdx, sdy, rho, rnd);
      const m = implied(s);
      expect(m.vx).toBeGreaterThanOrEqual(0);
      expect(m.vy).toBeGreaterThanOrEqual(0);
      expect(m.cxy * m.cxy).toBeLessThanOrEqual(m.vx * m.vy * (1 + 1e-9));
      sMx += m.mx; sMy += m.my; sMx2 += m.mx * m.mx; sVx += m.vx; sVy += m.vy; sR += m.r; sC += m.cxy;
    }
    const meanX = sMx / draws;
    expect(Math.abs(meanX - mx)).toBeLessThan(0.02);
    expect(Math.abs(sMy / draws - my)).toBeLessThan(0.05);
    const varXbar = sMx2 / draws - meanX * meanX;
    expect(varXbar / ((sdx * sdx) / n)).toBeGreaterThan(0.9);
    expect(varXbar / ((sdx * sdx) / n)).toBeLessThan(1.1);
    expect(Math.abs(sVx / draws / (sdx * sdx) - 1)).toBeLessThan(0.03);
    expect(Math.abs(sVy / draws / (sdy * sdy) - 1)).toBeLessThan(0.03);
    expect(Math.abs(sC / draws / (rho * sdx * sdy) - 1)).toBeLessThan(0.05); // sample covariance is unbiased
    expect(Math.abs(sR / draws - rho)).toBeLessThan(0.04); // sample correlation has a small O(1/n) bias
  });

  it("edge cases: n = 0 is empty, n = 1 is a single point, n = 2 has a singular sample covariance; deterministic in the PRNG", () => {
    expect(sufficientStatsNormal(0, 1, 2, 3, 4, 0.5, mulberry32(1))).toEqual({ n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 });
    const one = sufficientStatsNormal(1, 100, 50, 10, 20, 0.3, mulberry32(2));
    expect(one.n).toBe(1);
    expect(one.sxx).toBeCloseTo(one.sx * one.sx, 9);
    expect(one.syy).toBeCloseTo(one.sy * one.sy, 9);
    expect(one.sxy).toBeCloseTo(one.sx * one.sy, 9);
    expect(Math.abs(one.sx - 100)).toBeLessThan(60);
    for (let seed = 1; seed <= 20; seed++) {
      const two = sufficientStatsNormal(2, 0, 0, 1, 1, 0.4, mulberry32(seed));
      const m = implied(two);
      expect(two.n).toBe(2);
      // two points span a line: det of the 2×2 scatter matrix is zero (up to rounding of the sums round-trip)
      expect(Math.abs(m.vx * m.vy - m.cxy * m.cxy)).toBeLessThanOrEqual(1e-9 * Math.max(1, m.vx * m.vy));
    }
    const a = sufficientStatsNormal(500, 1, 2, 3, 4, 0.5, mulberry32(42));
    const b = sufficientStatsNormal(500, 1, 2, 3, 4, 0.5, mulberry32(42));
    expect(a).toEqual(b);
    expect(sufficientStatsNormal(500, 1, 2, 3, 4, 0.5, mulberry32(43))).not.toEqual(a);
  });
});

// ---------------- scenarios ----------------
describe("scenario presets", () => {
  const ids = ["real-effect", "aa-test", "novelty-decay", "bucketing-bug", "revenue-cuped", "loser"];

  it("catalogue lists the six presets with descriptions and coherent options", () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(ids);
    for (const s of SCENARIOS) {
      expect(s.name.length).toBeGreaterThan(2);
      expect(s.description.length).toBeGreaterThan(20);
      expect(Number.isInteger(s.options.days) && s.options.days >= 1 && s.options.days <= 60).toBe(true);
      expect(Number.isFinite(s.options.trueLiftRel)).toBe(true);
    }
    const by = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
    expect(by["aa-test"]!.options.trueLiftRel).toBe(0);
    expect(by["real-effect"]!.options.trueLiftRel).toBeGreaterThan(0);
    expect(by["loser"]!.options.trueLiftRel).toBeLessThan(0);
    expect(by["novelty-decay"]!.options.noveltyDecay).toBe(true);
    expect(by["bucketing-bug"]!.options.srmSkew ?? 0).toBeGreaterThan(0);
    expect(by["bucketing-bug"]!.options.trueLiftRel).toBe(0);
    expect(by["revenue-cuped"]!.metricType).toBe("continuous");
    expect(by["revenue-cuped"]!.options.preCorrelation ?? 0).toBeGreaterThan(0);
    expect(by["revenue-cuped"]!.options.preCorrelation ?? 1).toBeLessThan(1);
    expect(SCENARIOS.filter((s) => s.id !== "revenue-cuped").every((s) => s.metricType === undefined)).toBe(true);
  });

  it("every demo experiment carries the scenario id it was generated from", () => {
    const expected: Record<string, string> = {
      "exp-ranker-v2": "real-effect",
      "exp-free-cancel-badge": "real-effect",
      "exp-urgency-copy": "novelty-decay",
      "exp-checkout-2step": "loser",
      "exp-genius-upsell": "revenue-cuped",
      "exp-map-default": "bucketing-bug",
    };
    const seeds = seedExperiments();
    expect(seeds).toHaveLength(6);
    for (const e of seeds) {
      expect(e.scenario).toBe(expected[e.id]);
      expect(SCENARIOS.some((s) => s.id === e.scenario)).toBe(true);
    }
    const cuped = seeds.find((e) => e.scenario === "revenue-cuped")!;
    expect(cuped.metricType).toBe("continuous");
  });
});

// ---------------- module surface ----------------
describe("model module surface", () => {
  it("exposes only the model, simulation and seeds — storage, share links and CSV live in lib/", () => {
    const removed = ["loadExperiments", "saveExperiments", "upsert", "remove", "encodeShare", "decodeShare", "parseCsv"];
    for (const name of removed) expect(name in model, `${name} should no longer be exported from model.ts`).toBe(false);
    expect(Object.keys(model).sort()).toEqual(["cumulative", "hash", "seedExperiments", "simulate", "sufficientStatsNormal"]);
  });
});

// ---------------- model helpers ----------------
describe("model helpers", () => {
  it("cumulative() sums users, conversions and sufficient statistics day by day", () => {
    const e = seedExperiments().find((x) => x.id === "exp-genius-upsell")!;
    const cum = cumulative(e.days);
    expect(cum).toHaveLength(e.days.length);
    expect(cum[0]).toEqual(e.days[0]);
    const l = last(cum);
    expect(l.nA).toBe(e.days.reduce((s, d) => s + d.nA, 0));
    expect(l.nB).toBe(e.days.reduce((s, d) => s + d.nB, 0));
    expect(l.sumsA.n).toBe(l.nA);
    expect(l.sumsB.n).toBe(l.nB);
    expect(l.sumsB.sy).toBeCloseTo(e.days.reduce((s, d) => s + d.sumsB.sy, 0), 6);
    expect(l.sumsA.sxy).toBeCloseTo(e.days.reduce((s, d) => s + d.sumsA.sxy, 0), 3);
    const c = seedExperiments().find((x) => x.id === "exp-ranker-v2")!;
    const lc = last(cumulative(c.days));
    expect(lc.convA).toBe(c.days.reduce((s, d) => s + d.convA, 0));
  });

  it("simulate() is deterministic per id and differs across ids; hash() is a stable 32-bit value", () => {
    const o: SimOptions = { trueLiftRel: 0.02, days: 5, preCorrelation: 0.5 };
    expect(simulate(def("same"), o)).toEqual(simulate(def("same"), o));
    expect(simulate(def("other"), o)).not.toEqual(simulate(def("same"), o));
    expect(hash("abkit")).toBe(hash("abkit"));
    expect(hash("a")).not.toBe(hash("b"));
    expect(hash("exp-ranker-v2")).toBeGreaterThanOrEqual(0);
    expect(hash("exp-ranker-v2")).toBeLessThan(2 ** 32);
    const conv = simulate(def("conv", { metricType: "conversion", baseline: 0.1, std: undefined }), { trueLiftRel: 0.05, days: 3 });
    for (const d of conv) {
      expect(d.convA).toBeLessThanOrEqual(d.nA);
      expect(d.convB).toBeLessThanOrEqual(d.nB);
      expect(d.sumsA).toEqual({ n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 });
    }
  });
});
