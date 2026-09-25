/** Experiment model, deterministic simulation, storage and share links. */
import { addSums, binomial, emptySums, randn, type Sums } from "./stats";

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
}

export const rnd32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
export const hash = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

export interface SimOptions { trueLiftRel: number; days: number; srmSkew?: number; preCorrelation?: number; noveltyDecay?: boolean }

/** Simulate daily aggregates for an experiment definition. */
export function simulate(e: Omit<Experiment, "days">, o: SimOptions): DayData[] {
  const rnd = rnd32(hash(e.id));
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
      // continuous metric (e.g. revenue/user) with a correlated pre-period covariate, aggregated to sufficient statistics
      const std = e.std ?? e.baseline * 0.8;
      const gen = (n: number, mean: number): Sums => {
        // Aggregate moments analytically with sampling noise on the means for speed at scale.
        const draws = Math.min(n, 400);
        let s = emptySums();
        for (let i = 0; i < draws; i++) {
          const x = e.baseline + std * randn(rnd);
          const y = mean + std * (rho * ((x - e.baseline) / std) + Math.sqrt(1 - rho * rho) * randn(rnd));
          s = addSums(s, { n: 1, sx: x, sy: y, sxx: x * x, syy: y * y, sxy: x * y });
        }
        const k = n / draws;
        return { n, sx: s.sx * k, sy: s.sy * k, sxx: s.sxx * k, syy: s.syy * k, sxy: s.sxy * k };
      };
      sumsA = gen(nA, e.baseline);
      sumsB = gen(nB, e.baseline * (1 + lift));
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

const KEY = "abkit-experiments-v1";
export function loadExperiments(): Experiment[] {
  try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw) as Experiment[]; } catch { /* ignore */ }
  const seeded = seedExperiments();
  try { localStorage.setItem(KEY, JSON.stringify(seeded)); } catch { /* ignore */ }
  return seeded;
}
export function saveExperiments(list: Experiment[]): void { localStorage.setItem(KEY, JSON.stringify(list)); }
export function upsert(e: Experiment): Experiment[] { const list = loadExperiments().filter((x) => x.id !== e.id); list.unshift(e); saveExperiments(list); return list; }
export function remove(id: string): Experiment[] { const list = loadExperiments().filter((x) => x.id !== id); saveExperiments(list); return list; }

function base(id: string, name: string, extra: Partial<Experiment>): Omit<Experiment, "days"> {
  return { id, name, hypothesis: "", owner: "Search team", metric: "Booking conversion", metricType: "conversion", baseline: 0.1, mdeRel: 0.05, alpha: 0.05, power: 0.8, dailyTraffic: 40_000, split: 0.5, startDate: "2026-09-01", status: "running", plannedPerArm: 0, source: "simulated", tags: [], ...extra };
}
export function seedExperiments(): Experiment[] {
  const defs: [Omit<Experiment, "days">, SimOptions][] = [
    [base("exp-ranker-v2", "Search ranker v2 (LTR) vs price sort", { hypothesis: "Ranking by the learning-to-rank model instead of price-ascending increases booking conversion on the results page.", metric: "Booking conversion", baseline: 0.082, mdeRel: 0.04, dailyTraffic: 60_000, startDate: "2026-09-08", tags: ["search", "ranking"], status: "completed" }), { trueLiftRel: 0.055, days: 21 }],
    [base("exp-free-cancel-badge", "Free-cancellation badge on hotel cards", { hypothesis: "A prominent 'Free cancellation' badge reduces hesitation and lifts click-through to the hotel page.", metric: "Card click-through", baseline: 0.31, mdeRel: 0.03, dailyTraffic: 80_000, startDate: "2026-09-15", tags: ["ux", "results page"] }), { trueLiftRel: 0.012, days: 12 }],
    [base("exp-urgency-copy", "Scarcity copy: 'Only 2 left' on results", { hypothesis: "Scarcity messaging increases bookings without hurting cancellations.", metric: "Booking conversion", baseline: 0.085, mdeRel: 0.05, dailyTraffic: 55_000, startDate: "2026-09-10", tags: ["ux", "copy"] }), { trueLiftRel: 0.06, days: 14, noveltyDecay: true }],
    [base("exp-checkout-2step", "Two-step checkout vs single page", { hypothesis: "Splitting guest and payment details into two steps lowers checkout abandonment.", metric: "Checkout completion", baseline: 0.42, mdeRel: 0.03, dailyTraffic: 18_000, startDate: "2026-09-12", tags: ["checkout"] }), { trueLiftRel: -0.02, days: 14 }],
    [base("exp-genius-upsell", "Loyalty upsell module: revenue per visitor", { hypothesis: "Showing member rates lifts revenue per visitor; CUPED with last-month spend as covariate.", metric: "Revenue per visitor (₹)", metricType: "continuous", baseline: 412, std: 640, mdeRel: 0.03, dailyTraffic: 30_000, startDate: "2026-09-05", tags: ["revenue", "cuped"], status: "completed" }), { trueLiftRel: 0.035, days: 18, preCorrelation: 0.62 }],
    [base("exp-map-default", "Map view as default on mobile", { hypothesis: "Defaulting mobile results to the map raises engagement.", metric: "Hotel page views / session", baseline: 0.27, mdeRel: 0.05, dailyTraffic: 50_000, startDate: "2026-09-18", tags: ["mobile"] }), { trueLiftRel: 0.0, days: 8, srmSkew: 0.012 }],
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

/** Share links: the whole experiment (aggregates only) encoded in the URL hash. */
export function encodeShare(e: Experiment): string {
  const json = JSON.stringify(e);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeShare(s: string): Experiment | null {
  try {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Experiment;
  } catch { return null; }
}

/** CSV: columns variant (A/B or control/treatment), converted (0/1) or value, optional pre_value, optional day. */
export function parseCsv(text: string, name: string): Experiment {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const col = (n: string) => header.indexOf(n);
  const iv = col("variant"), ic = col("converted"), ival = col("value"), ipre = col("pre_value"), iday = col("day");
  if (iv < 0 || (ic < 0 && ival < 0)) throw new Error("CSV needs a 'variant' column and either 'converted' (0/1) or 'value' (number). Optional: pre_value, day.");
  const continuous = ic < 0;
  const byDay = new Map<number, DayData>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(",");
    const v = (cells[iv] ?? "").trim().toLowerCase();
    const isB = ["b", "treatment", "variant", "test", "1"].includes(v);
    const day = iday >= 0 ? Number(cells[iday]) || 1 : 1;
    const d = byDay.get(day) ?? { day, nA: 0, nB: 0, convA: 0, convB: 0, sumsA: emptySums(), sumsB: emptySums() };
    if (continuous) {
      const y = Number(cells[ival]);
      const x = ipre >= 0 ? Number(cells[ipre]) : 0;
      const s = { n: 1, sx: x, sy: y, sxx: x * x, syy: y * y, sxy: x * y };
      if (isB) { d.nB++; d.sumsB = addSums(d.sumsB, s); } else { d.nA++; d.sumsA = addSums(d.sumsA, s); }
    } else {
      const c = Number(cells[ic]) ? 1 : 0;
      if (isB) { d.nB++; d.convB += c; } else { d.nA++; d.convA += c; }
    }
    byDay.set(day, d);
  }
  const days = [...byDay.values()].sort((a, b) => a.day - b.day);
  const total = days.reduce((s, d) => s + d.nA + d.nB, 0);
  const convTotal = days.reduce((s, d) => s + d.convA, 0);
  const nA = days.reduce((s, d) => s + d.nA, 0);
  const id = `csv-${Date.now().toString(36)}`;
  const baseline = continuous ? days.reduce((s, d) => s + d.sumsA.sy, 0) / Math.max(1, nA) : convTotal / Math.max(1, nA);
  return { id, name, hypothesis: "Uploaded from CSV", owner: "You", metric: continuous ? "value" : "conversion", metricType: continuous ? "continuous" : "conversion", baseline, mdeRel: 0.05, alpha: 0.05, power: 0.8, dailyTraffic: Math.round(total / Math.max(1, days.length)), split: 0.5, startDate: new Date().toISOString().slice(0, 10), status: "completed", plannedPerArm: 0, days, source: "csv", tags: ["csv"] };
}
