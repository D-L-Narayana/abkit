/**
 * Analysis hub: turns an experiment's daily aggregates into everything the Dashboard, the Results page and the
 * Markdown summary show — the fixed-horizon test, delta-method relative confidence intervals, CUPED for continuous
 * metrics, the sample-ratio guardrail, the always-valid (mSPRT) p-value series and a verdict with an explicit basis.
 *
 * `analyse` never throws: structurally malformed input yields `null`, and a failing sequential computation only
 * degrades the always-valid series to "unavailable" (NaN) while the fixed-horizon results are still returned.
 */
import type { Tone } from "../components/ui";
import { cumulative, type DayData, type Experiment, type MetricType } from "../model";
import { cuped, emptySums, meanVar, relativeLiftMeans, relativeLiftProportions, srm, twoProportionZ, welch, type MeanStats, type RelCI, type Sums, type TResult, type ZResult } from "../stats";
import { msprtSeries, tauFromMde } from "./sequential";

/**
 * One cumulative look (day). `lift`, `band` and `cband` are relative to the control arm, in percent; the bands are
 * delta-method confidence intervals (`cband` = CUPED-adjusted, continuous metrics only). `p`/`pc` are the fixed-horizon
 * p-values recomputed at this look (naive repeated testing — monitoring only); `pAV` is the always-valid p-value, which
 * may be read at every look. The `*Plot` values are clamped to [P_PLOT_FLOOR, 1] for the log-scale chart.
 */
export interface SeriesPoint { day: number; lift: number; band: [number, number]; cband?: [number, number]; p: number; pc?: number; pPlot: number; pAV: number; pAVPlot: number; n: number }
/** Final always-valid p-value, the first day it fell below α (null when it never did) and the mixing scale τ. */
export interface SequentialSummary { pAV: number; decidedDay: number | null; tau: number }
export interface DailyPoint { day: number; A: number; B: number }
export type SrmResult = ReturnType<typeof srm>;
export type CupedResult = ReturnType<typeof cuped>;

interface AnalysisBase {
  last: DayData;
  srm: SrmResult;
  series: SeriesPoint[];
  daily: DailyPoint[];
  /** min(users per arm) / planned users per arm, capped at 1. */
  progress: number;
  /** Final delta-method relative lift CI (CUPED-adjusted for continuous metrics). */
  rel: RelCI;
  sequential: SequentialSummary;
}
export interface ConversionAnalysis extends AnalysisBase { kind: "conversion"; z: ZResult }
export interface ContinuousAnalysis extends AnalysisBase { kind: "continuous"; a: MeanStats; b: MeanStats; raw: TResult; cuped: CupedResult; adj: TResult; /** Delta-method relative CI on the raw (unadjusted) means. */ relRaw: RelCI }
export type Analysis = ConversionAnalysis | ContinuousAnalysis;

const P_FLOOR = 1e-4; // log-scale floor for the sequential p-value plot
const clampP = (p: number): number => (Number.isFinite(p) ? Math.max(P_FLOOR, Math.min(1, p)) : 1);
/** The always-valid line is hidden (NaN) rather than drawn at 1 when the sequential analysis is unavailable. */
const plotAV = (p: number): number => (Number.isFinite(p) ? clampP(p) : NaN);

// ---------------- input validation ----------------
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const SUM_KEYS = ["n", "sx", "sy", "sxx", "syy", "sxy"] as const;
function readSums(x: unknown): Sums | null {
  if (!isObj(x)) return null;
  for (const k of SUM_KEYS) if (!fin(x[k])) return null;
  const s = x as Record<(typeof SUM_KEYS)[number], number>;
  return s.n >= 0 ? { n: s.n, sx: s.sx, sy: s.sy, sxx: s.sxx, syy: s.syy, sxy: s.sxy } : null;
}
interface CleanExperiment { metricType: MetricType; alpha: number; split: number; plannedPerArm: number; mdeRel: number; baseline: number; days: DayData[] }
/** Structural check; returns a sanitised copy with only the fields the analysis needs, or null when the data cannot be analysed. */
function normalise(e: unknown): CleanExperiment | null {
  if (!isObj(e)) return null;
  const metricType = e.metricType;
  if (metricType !== "conversion" && metricType !== "continuous") return null;
  const alpha = e.alpha, split = e.split;
  if (!fin(alpha) || !(alpha > 0 && alpha < 1) || !fin(split) || !(split > 0 && split < 1)) return null;
  if (!Array.isArray(e.days) || e.days.length === 0) return null;
  const days: DayData[] = [];
  for (let i = 0; i < e.days.length; i++) {
    const d: unknown = e.days[i];
    if (!isObj(d) || !fin(d.nA) || !fin(d.nB) || d.nA < 0 || d.nB < 0) return null;
    const day = fin(d.day) ? d.day : i + 1;
    const sumsA = readSums(d.sumsA), sumsB = readSums(d.sumsB);
    if (metricType === "conversion") {
      if (!fin(d.convA) || !fin(d.convB) || d.convA < 0 || d.convB < 0 || d.convA > d.nA || d.convB > d.nB) return null;
      days.push({ day, nA: d.nA, nB: d.nB, convA: d.convA, convB: d.convB, sumsA: sumsA ?? emptySums(), sumsB: sumsB ?? emptySums() });
    } else {
      if (!sumsA || !sumsB) return null;
      days.push({ day, nA: d.nA, nB: d.nB, convA: fin(d.convA) ? d.convA : 0, convB: fin(d.convB) ? d.convB : 0, sumsA, sumsB });
    }
  }
  return {
    metricType,
    alpha,
    split,
    plannedPerArm: fin(e.plannedPerArm) && e.plannedPerArm > 0 ? e.plannedPerArm : 0,
    mdeRel: fin(e.mdeRel) && e.mdeRel !== 0 ? e.mdeRel : 0.05, // same default as the Python twin
    baseline: fin(e.baseline) ? e.baseline : NaN,
    days,
  };
}

// ---------------- sequential (mSPRT) ----------------
interface SeqInput { diff: number; varDiff: number }
const NO_EVIDENCE: SeqInput = { diff: 0, varDiff: 0 };
/** A look carries evidence only when its difference and variance are finite and the variance is positive. */
const seqPoint = (diff: number, varDiff: number): SeqInput => (Number.isFinite(diff) && Number.isFinite(varDiff) && varDiff > 0 ? { diff, varDiff } : NO_EVIDENCE);
/**
 * Always-valid p-values for cumulative looks. τ = |MDE on the absolute scale| (τ heuristic of lib/sequential.ts), taken
 * from the observed final control estimate × relative MDE and falling back to the planned baseline × relative MDE.
 * Unavailable (all NaN) when no usable τ exists or the sequential library rejects the input.
 */
function sequentialSeries(points: SeqInput[], mdeAbs: number, fallbackMdeAbs: number, alpha: number, cum: DayData[]): { pAV: number[]; summary: SequentialSummary } {
  const unavailable = { pAV: points.map(() => NaN), summary: { pAV: NaN, decidedDay: null, tau: NaN } };
  const scale = [mdeAbs, fallbackMdeAbs].map(Math.abs).find((m) => Number.isFinite(m) && m > 0);
  if (scale === undefined) return unavailable;
  try {
    const tau = tauFromMde(scale);
    const out = msprtSeries(points, tau, alpha);
    const pAV = points.map((_, k) => { const p = out.pAV[k]; return fin(p) ? p : NaN; });
    const k = pAV.findIndex((p) => p < alpha);
    return { pAV, summary: { pAV: pAV[pAV.length - 1] ?? NaN, decidedDay: k >= 0 ? cum[k]!.day : null, tau } };
  } catch {
    return unavailable;
  }
}

// ---------------- analysis ----------------
export function analyse(e: Experiment): Analysis | null {
  try {
    const x = normalise(e);
    if (!x) return null;
    const cum = cumulative(x.days);
    const last = cum[cum.length - 1];
    if (!last || !(last.nA + last.nB > 0)) return null;
    const { alpha } = x;
    const srmRes = srm([last.nA, last.nB], [x.split, 1 - x.split]);
    const progress = Math.min(1, Math.min(last.nA, last.nB) / Math.max(1, x.plannedPerArm));

    if (x.metricType === "conversion") {
      const z = twoProportionZ(last.convA, last.nA, last.convB, last.nB, alpha);
      const rel = relativeLiftProportions(last.convA, last.nA, last.convB, last.nB, alpha);
      // mSPRT look k: diff = p̂B − p̂A, V = p̄(1−p̄)(1/nA + 1/nB) with the pooled rate (same as the Python twin)
      const points = cum.map((d) => { const pbar = (d.convA + d.convB) / (d.nA + d.nB); return seqPoint(d.convB / d.nB - d.convA / d.nA, pbar * (1 - pbar) * (1 / d.nA + 1 / d.nB)); });
      const seq = sequentialSeries(points, z.rateA * x.mdeRel, x.baseline * x.mdeRel, alpha, cum);
      const series: SeriesPoint[] = cum.map((d, i) => {
        const r = twoProportionZ(d.convA, d.nA, d.convB, d.nB, alpha);
        const rl = relativeLiftProportions(d.convA, d.nA, d.convB, d.nB, alpha);
        const pAV = seq.pAV[i] ?? NaN;
        return { day: d.day, lift: 100 * rl.lift, band: [100 * rl.lo, 100 * rl.hi], p: r.p, pPlot: clampP(r.p), pAV, pAVPlot: plotAV(pAV), n: d.nA + d.nB };
      });
      const daily: DailyPoint[] = x.days.map((d) => ({ day: d.day, A: 100 * (d.convA / Math.max(1, d.nA)), B: 100 * (d.convB / Math.max(1, d.nB)) }));
      return { kind: "conversion", last, srm: srmRes, z, rel, sequential: seq.summary, series, daily, progress };
    }

    const a = meanVar(last.sumsA), b = meanVar(last.sumsB);
    const raw = welch(a, b, alpha);
    const c = cuped(last.sumsA, last.sumsB);
    const adj = welch(c.adjA, c.adjB, alpha);
    const rel = relativeLiftMeans(c.adjA, c.adjB, alpha);
    const relRaw = relativeLiftMeans(a, b, alpha);
    // mSPRT on the CUPED-adjusted difference with its Welch variance; τ on the metric's own scale
    const looks = cum.map((d) => {
      const ms = { a: meanVar(d.sumsA), b: meanVar(d.sumsB) };
      const cc = cuped(d.sumsA, d.sumsB);
      return { d, ms, cc, r: welch(ms.a, ms.b, alpha), ra: welch(cc.adjA, cc.adjB, alpha) };
    });
    const points = looks.map(({ cc }) => seqPoint(cc.adjB.mean - cc.adjA.mean, cc.adjA.var / cc.adjA.n + cc.adjB.var / cc.adjB.n));
    const seq = sequentialSeries(points, a.mean * x.mdeRel, x.baseline * x.mdeRel, alpha, cum);
    const series: SeriesPoint[] = looks.map(({ d, ms, cc, r, ra }, i) => {
      const rl = relativeLiftMeans(ms.a, ms.b, alpha);
      const rc = relativeLiftMeans(cc.adjA, cc.adjB, alpha);
      const pAV = seq.pAV[i] ?? NaN;
      return { day: d.day, lift: 100 * rc.lift, band: [100 * rl.lo, 100 * rl.hi], cband: [100 * rc.lo, 100 * rc.hi], p: r.p, pc: ra.p, pPlot: clampP(ra.p), pAV, pAVPlot: plotAV(pAV), n: d.nA + d.nB };
    });
    const daily: DailyPoint[] = x.days.map((d) => ({ day: d.day, A: d.sumsA.sy / Math.max(1, d.nA), B: d.sumsB.sy / Math.max(1, d.nB) }));
    return { kind: "continuous", last, srm: srmRes, a, b, raw, cuped: c, adj, rel, relRaw, sequential: seq.summary, series, daily, progress };
  } catch {
    return null;
  }
}

// ---------------- verdict ----------------
export type Decision = "winner" | "loser" | "flat" | "collecting" | "invalid";
export interface Verdict { label: string; tone: Tone; p: number; lift: number; reason: string; decision: Decision; basis: "fixed" | "sequential" }

/**
 * Decision rules, in order:
 *  1. sample-ratio mismatch → "invalid" (no metric can be trusted);
 *  2. planned sample reached, or the experiment is completed/stopped → fixed-horizon decision on the p-value;
 *  3. otherwise, always-valid p < α → winner/loser on a sequential basis (valid despite daily peeking);
 *  4. otherwise → collecting.
 * The direction (winner vs loser) follows the sign of the absolute difference; `lift` reports the delta-method relative lift.
 */
export function verdict(e: Experiment, an: Analysis): Verdict {
  const p = an.kind === "conversion" ? an.z.p : an.adj.p;
  const lift = an.rel.lift;
  const direction = an.kind === "conversion" ? an.z.liftAbs : an.adj.diff;
  const alpha = fin(e.alpha) && e.alpha > 0 && e.alpha < 1 ? e.alpha : 0.05;
  const pct = Math.round(100 * (fin(an.progress) ? Math.max(0, Math.min(1, an.progress)) : 0));
  const base = { p, lift };
  if (an.srm.mismatch) return { ...base, label: "SRM — invalid", tone: "bad", decision: "invalid", basis: "fixed", reason: "The observed split does not match the intended allocation, so no metric can be trusted." };

  const closed = e.status === "completed" || e.status === "stopped";
  if (an.progress >= 1 || closed) {
    const where = an.progress >= 1 ? "at the planned sample size" : `after the experiment was ${e.status === "stopped" ? "stopped" : "marked complete"} at ${pct}% of the planned sample`;
    const caveat = an.progress >= 1 ? "" : " — with fewer users than planned the test had less power than designed.";
    if (p < alpha) {
      return direction > 0
        ? { ...base, label: "Winner", tone: "ok", decision: "winner", basis: "fixed", reason: `Significant positive lift ${where}.${caveat}` }
        : { ...base, label: "Loser", tone: "bad", decision: "loser", basis: "fixed", reason: `Significant negative effect ${where}.${caveat}` };
    }
    return { ...base, label: "No significant effect", tone: "warn", decision: "flat", basis: "fixed", reason: `The confidence interval still includes zero ${where}.${caveat}` };
  }

  const { pAV, decidedDay } = an.sequential;
  if (pAV < alpha) {
    const when = decidedDay !== null ? ` on day ${decidedDay}` : "";
    return direction > 0
      ? { ...base, label: "Winner · sequential", tone: "ok", decision: "winner", basis: "sequential", reason: `The always-valid p-value fell below α${when} at ${pct}% of the planned sample — this decision stays valid despite daily monitoring.` }
      : { ...base, label: "Loser · sequential", tone: "bad", decision: "loser", basis: "sequential", reason: `The always-valid p-value fell below α${when} at ${pct}% of the planned sample — the treatment is hurting the metric; this decision stays valid despite daily monitoring.` };
  }
  return { ...base, label: `Collecting · ${pct}%`, tone: "neutral", decision: "collecting", basis: "fixed", reason: "Planned sample size not reached and the always-valid p-value has not crossed α — keep collecting; the fixed-horizon p-value is for monitoring only." };
}
export const P_PLOT_FLOOR = P_FLOOR;
