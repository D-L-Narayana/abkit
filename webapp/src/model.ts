/**
 * Experiment model, deterministic simulation and the demo seeds.
 * Persistence lives in lib/storage.ts, share links in lib/share.ts, CSV/JSON import-export in lib/csv.ts.
 */
import { addSums, binomial, emptySums, mulberry32, randn, type Sums } from "./stats";

export type MetricType = "conversion" | "continuous";
export interface DayData { day: number; nA: number; nB: number; convA: number; convB: number; sumsA: Sums; sumsB: Sums }
export interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  owner: string;
  metric: string;
  metricType: MetricType;
  baseline: number; // conversion rate or mean
  std?: number; // continuous metric std
  mdeRel: number;
  alpha: number;
  power: number;
  dailyTraffic: number;
  split: number; // share of A
  startDate: string;
  status: "draft" | "running" | "completed" | "stopped";
  plannedPerArm: number;
  days: DayData[];
  source: "simulated" | "csv";
  tags: string[];
  stoppedAt?: string; // ISO date when the experiment was stopped or completed by hand
  scenario?: string; // id of the scenario preset this experiment was generated from (see lib/scenarios.ts)
  notes?: string;
}

export const hash = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

export interface SimOptions { trueLiftRel: number; days: number; srmSkew?: number; preCorrelation?: number; noveltyDecay?: boolean }

/**
 * χ² draw with `df` degrees of freedom. df < 30: exact sum of df squared standard normals;
 * df ≥ 30: Wilson–Hilferty normal approximation χ² ≈ df·(1 − 2/(9df) + z·√(2/(9df)))³ (relative error O(1/df)).
 */
function chi2(df: number, rnd: () => number): number {
  if (df <= 0) return 0;
  if (df < 30) {
    let s = 0;
    for (let i = 0; i < df; i++) { const z = randn(rnd); s += z * z; }
    return s;
  }
  const c = 2 / (9 * df);
  const t = 1 - c + Math.sqrt(c) * randn(rnd);
  return df * Math.max(0, t) ** 3;
}

/**
 * Exact sufficient statistics of n i.i.d. draws from a bivariate normal (X = pre-period covariate, Y = metric)
 * with means (meanX, meanY), standard deviations (sdX, sdY) and correlation rho — without drawing the n users.
 *
 * For a multivariate normal sample the mean vector and the sample covariance are independent:
 *   x̄ ~ N(μ, Σ/n)                 drawn as μ + L z / √n with L the Cholesky factor of Σ (L = [[σx, 0], [ρσy, σy√(1−ρ²)]]),
 *   W = (n−1)·S ~ Wishart(n−1, Σ)  drawn by the Bartlett decomposition W = L A Aᵀ Lᵀ, A lower-triangular with
 *                                  A₁₁² ~ χ²_{n−1}, A₂₂² ~ χ²_{n−2}, A₂₁ ~ N(0, 1).
 * Sums = { n, sx = n·x̄, sy = n·ȳ, sxx = Wxx + n·x̄², syy = Wyy + n·ȳ², sxy = Wxy + n·x̄·ȳ } (Σx² = (n−1)Sxx + n·x̄²).
 * n ≤ 0 returns empty sums; n = 1 is a single point (W = 0); n = 2 has a rank-one scatter matrix, as it must.
 * Consumes the PRNG in a fixed order: means (2 normals), then A₁₁, A₂₂, A₂₁.
 */
export function sufficientStatsNormal(n: number, meanX: number, meanY: number, sdX: number, sdY: number, rho: number, rnd: () => number): Sums {
  n = Math.floor(n);
  if (!(n > 0)) return emptySums();
  const sx = Math.max(0, sdX), sy = Math.max(0, sdY);
  const r = Math.max(-1, Math.min(1, rho));
  const l11 = sx, l21 = r * sy, l22 = sy * Math.sqrt(Math.max(0, 1 - r * r));
  const root = Math.sqrt(n);
  const z1 = randn(rnd), z2 = randn(rnd);
  const mx = meanX + (l11 * z1) / root;
  const my = meanY + (l21 * z1 + l22 * z2) / root;
  let wxx = 0, wyy = 0, wxy = 0;
  const df = n - 1;
  if (df > 0) {
    const a11 = Math.sqrt(chi2(df, rnd));
    const a22 = Math.sqrt(chi2(df - 1, rnd));
    const a21 = randn(rnd);
    // B = L·A = [[l11·a11, 0], [l21·a11 + l22·a21, l22·a22]];  W = B·Bᵀ
    const b11 = l11 * a11, b21 = l21 * a11 + l22 * a21, b22 = l22 * a22;
    wxx = b11 * b11;
    wxy = b11 * b21;
    wyy = b21 * b21 + b22 * b22;
  }
  return { n, sx: n * mx, sy: n * my, sxx: wxx + n * mx * mx, syy: wyy + n * my * my, sxy: wxy + n * mx * my };
}

/** Simulate daily aggregates for an experiment definition. */
export function simulate(e: Omit<Experiment, "days">, o: SimOptions): DayData[] {
  const rnd = mulberry32(hash(e.id));
  const out: DayData[] = [];
  const rho = o.preCorrelation ?? 0.6;
  for (let d = 0; d < o.days; d++) {
    const traffic = Math.round(e.dailyTraffic * (0.85 + 0.3 * rnd()) * (d % 7 >= 5 ? 0.75 : 1));
    const shareA = e.split - (o.srmSkew ?? 0);
    const nA = binomial(traffic, shareA, rnd);
    const nB = traffic - nA;
    const lift = o.noveltyDecay ? o.trueLiftRel * Math.max(0.2, 1 - d / o.days) : o.trueLiftRel;
    let convA = 0, convB = 0;
    let sumsA = emptySums(), sumsB = emptySums();
    if (e.metricType === "conversion") {
      convA = binomial(nA, e.baseline, rnd);
      convB = binomial(nB, e.baseline * (1 + lift), rnd);
    } else {
      // continuous metric (e.g. revenue/user) with a pre-period covariate X ~ N(baseline, std²) correlated at rho with the metric:
      // exact sufficient statistics for every user of the arm-day, so the sample means carry σ/√n noise (not that of a small sub-sample)
      const std = e.std ?? e.baseline * 0.8;
      sumsA = sufficientStatsNormal(nA, e.baseline, e.baseline, std, std, rho, rnd);
      sumsB = sufficientStatsNormal(nB, e.baseline, e.baseline * (1 + lift), std, std, rho, rnd);
    }
    out.push({ day: d + 1, nA, nB, convA, convB, sumsA, sumsB });
  }
  return out;
}

export const cumulative = (days: DayData[]): DayData[] => {
  const acc: DayData[] = [];
  let c: DayData | null = null;
  for (const d of days) {
    c = c ? { day: d.day, nA: c.nA + d.nA, nB: c.nB + d.nB, convA: c.convA + d.convA, convB: c.convB + d.convB, sumsA: addSums(c.sumsA, d.sumsA), sumsB: addSums(c.sumsB, d.sumsB) } : { ...d };
    acc.push(c);
  }
  return acc;
};

function base(id: string, name: string, extra: Partial<Experiment>): Omit<Experiment, "days"> {
  return { id, name, hypothesis: "", owner: "Search team", metric: "Booking conversion", metricType: "conversion", baseline: 0.1, mdeRel: 0.05, alpha: 0.05, power: 0.8, dailyTraffic: 40_000, split: 0.5, startDate: "2026-09-01", status: "running", plannedPerArm: 0, source: "simulated", tags: [], ...extra };
}
/**
 * The six demo experiments. Each carries the id of the scenario preset it illustrates (see lib/scenarios.ts);
 * the simulation options are spelled out here, not read from the preset catalogue, so the seeded data never changes.
 */
export function seedExperiments(): Experiment[] {
  const defs: [Omit<Experiment, "days">, SimOptions][] = [
    [base("exp-ranker-v2", "Search ranker v2 (LTR) vs price sort", { hypothesis: "Ranking by the learning-to-rank model instead of price-ascending increases booking conversion on the results page.", metric: "Booking conversion", baseline: 0.082, mdeRel: 0.04, dailyTraffic: 60_000, startDate: "2026-09-08", tags: ["search", "ranking"], status: "completed", scenario: "real-effect" }), { trueLiftRel: 0.055, days: 21 }],
    [base("exp-free-cancel-badge", "Free-cancellation badge on hotel cards", { hypothesis: "A prominent 'Free cancellation' badge reduces hesitation and lifts click-through to the hotel page.", metric: "Card click-through", baseline: 0.31, mdeRel: 0.03, dailyTraffic: 80_000, startDate: "2026-09-15", tags: ["ux", "results page"], scenario: "real-effect" }), { trueLiftRel: 0.012, days: 12 }],
    [base("exp-urgency-copy", "Scarcity copy: 'Only 2 left' on results", { hypothesis: "Scarcity messaging increases bookings without hurting cancellations.", metric: "Booking conversion", baseline: 0.085, mdeRel: 0.05, dailyTraffic: 55_000, startDate: "2026-09-10", tags: ["ux", "copy"], scenario: "novelty-decay" }), { trueLiftRel: 0.06, days: 14, noveltyDecay: true }],
    [base("exp-checkout-2step", "Two-step checkout vs single page", { hypothesis: "Splitting guest and payment details into two steps lowers checkout abandonment.", metric: "Checkout completion", baseline: 0.42, mdeRel: 0.03, dailyTraffic: 18_000, startDate: "2026-09-12", tags: ["checkout"], scenario: "loser" }), { trueLiftRel: -0.02, days: 14 }],
    [base("exp-genius-upsell", "Loyalty upsell module: revenue per visitor", { hypothesis: "Showing member rates lifts revenue per visitor; CUPED with last-month spend as covariate.", metric: "Revenue per visitor (₹)", metricType: "continuous", baseline: 412, std: 640, mdeRel: 0.03, dailyTraffic: 30_000, startDate: "2026-09-05", tags: ["revenue", "cuped"], status: "completed", scenario: "revenue-cuped" }), { trueLiftRel: 0.035, days: 18, preCorrelation: 0.62 }],
    [base("exp-map-default", "Map view as default on mobile", { hypothesis: "Defaulting mobile results to the map raises engagement.", metric: "Hotel page views / session", baseline: 0.27, mdeRel: 0.05, dailyTraffic: 50_000, startDate: "2026-09-18", tags: ["mobile"], scenario: "bucketing-bug" }), { trueLiftRel: 0.0, days: 8, srmSkew: 0.012 }],
  ];
  return defs.map(([d, o]) => {
    const planned = d.metricType === "conversion" ? sampleSizePlanned(d) : Math.ceil(2 * (((1.96 + 0.8416) * (d.std ?? 1)) / (d.baseline * d.mdeRel)) ** 2);
    return { ...d, plannedPerArm: planned, days: simulate(d, o) };
  });
}
function sampleSizePlanned(d: Omit<Experiment, "days">): number {
  const p1 = d.baseline, p2 = d.baseline * (1 + d.mdeRel);
  const za = 1.959964, zb = 0.841621;
  const pbar = (p1 + p2) / 2;
  const num = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((num / (p2 - p1)) ** 2);
}
