import { cumulative, type Experiment } from "../model";
import { cuped, meanVar, srm, twoProportionZ, welch } from "../stats";
import type { Tone } from "../components/ui";

export interface SeriesPoint { day: number; lift: number; band: [number, number]; cband?: [number, number]; p: number; pc?: number; pPlot: number; n: number }

const P_FLOOR = 1e-4; // log-scale floor for the sequential p-value plot
const clampP = (p: number): number => (Number.isFinite(p) ? Math.max(P_FLOOR, Math.min(1, p)) : 1);

export function analyse(e: Experiment) {
  const cum = cumulative(e.days);
  const last = cum[cum.length - 1];
  if (!last) return null;
  const srmRes = srm([last.nA, last.nB], [e.split, 1 - e.split]);
  const progress = Math.min(1, Math.min(last.nA, last.nB) / Math.max(1, e.plannedPerArm));
  if (e.metricType === "conversion") {
    const z = twoProportionZ(last.convA, last.nA, last.convB, last.nB, e.alpha);
    const series: SeriesPoint[] = cum.map((d) => {
      const r = twoProportionZ(d.convA, d.nA, d.convB, d.nB, e.alpha);
      const base = Math.max(1e-12, r.rateA);
      return { day: d.day, lift: 100 * r.liftRel, band: [100 * (r.ciLow / base), 100 * (r.ciHigh / base)], p: r.p, pPlot: clampP(r.p), n: d.nA + d.nB };
    });
    const daily = e.days.map((d) => ({ day: d.day, A: 100 * (d.convA / Math.max(1, d.nA)), B: 100 * (d.convB / Math.max(1, d.nB)) }));
    return { kind: "conversion" as const, last, srm: srmRes, z, series, daily, progress };
  }
  const a = meanVar(last.sumsA), b = meanVar(last.sumsB);
  const raw = welch(a, b, e.alpha);
  const c = cuped(last.sumsA, last.sumsB);
  const adj = welch(c.adjA, c.adjB, e.alpha);
  const series: SeriesPoint[] = cum.map((d) => {
    const r = welch(meanVar(d.sumsA), meanVar(d.sumsB), e.alpha);
    const cc = cuped(d.sumsA, d.sumsB);
    const ra = welch(cc.adjA, cc.adjB, e.alpha);
    const base = Math.max(1e-12, d.sumsA.sy / d.sumsA.n);
    return { day: d.day, lift: 100 * ra.liftRel, band: [100 * (r.ciLow / base), 100 * (r.ciHigh / base)], cband: [100 * (ra.ciLow / base), 100 * (ra.ciHigh / base)], p: r.p, pc: ra.p, pPlot: clampP(ra.p), n: d.nA + d.nB };
  });
  const daily = e.days.map((d) => ({ day: d.day, A: d.sumsA.sy / Math.max(1, d.nA), B: d.sumsB.sy / Math.max(1, d.nB) }));
  return { kind: "continuous" as const, last, srm: srmRes, a, b, raw, cuped: c, adj, series, daily, progress };
}
export type Analysis = NonNullable<ReturnType<typeof analyse>>;

export interface Verdict { label: string; tone: Tone; p: number; lift: number; reason: string }
export function verdict(e: Experiment, an: Analysis): Verdict {
  const p = an.kind === "conversion" ? an.z.p : an.adj.p;
  const lift = an.kind === "conversion" ? an.z.liftRel : an.adj.liftRel;
  if (an.srm.mismatch) return { label: "SRM — invalid", tone: "bad", p, lift, reason: "The observed split does not match the intended allocation, so no metric can be trusted." };
  if (an.progress < 1 && e.status === "running") return { label: `Collecting · ${Math.round(an.progress * 100)}%`, tone: "neutral", p, lift, reason: "Planned sample size not reached yet — do not read the p-value as a decision." };
  if (p < e.alpha) return lift > 0 ? { label: "Winner", tone: "ok", p, lift, reason: "Significant positive lift at the planned sample size." } : { label: "Loser", tone: "bad", p, lift, reason: "Significant negative effect at the planned sample size." };
  return { label: "No significant effect", tone: "warn", p, lift, reason: "The confidence interval still includes zero at the planned sample size." };
}
export const P_PLOT_FLOOR = P_FLOOR;
