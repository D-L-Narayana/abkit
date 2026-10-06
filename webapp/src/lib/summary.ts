/**
 * Markdown summary of an experiment result — the text you paste into a ticket or a launch review.
 *
 * Sections: heading + hypothesis, verdict with reason, metric/period/sample facts, the effect (delta-method relative
 * lift ± CI, absolute difference, fixed-horizon p-value, always-valid p-value when a sequential result exists, CUPED
 * details for continuous metrics), the sample-ratio guardrail, a per-arm table and the decision basis.
 *
 * Numbers are formatted deterministically (fixed decimals, comma grouping, no locale lookups) so the same result
 * produces byte-identical text in every browser and in Node. Non-finite values print as "–", never "NaN".
 */
import type { Experiment } from "../model";
import { fmtP } from "../stats";

/** Delta-method relative confidence interval (`RelCI`): lift and bounds are fractions, e.g. 0.05 = +5%. */
export interface RelCILike { lift: number; lo: number; hi: number; se?: number }
/** Always-valid (mSPRT) summary: `pAV` is the final always-valid p-value, `decidedDay` the first day it fell below α. */
export interface SequentialLike { pAV: number; decidedDay: number | null; tau?: number }
interface Interval { ciLow: number; ciHigh: number; p: number }
/** Structural subset of `Analysis` (lib/analysis.ts) the summary reads — keeps the builder independent of the full union type. */
export interface SummaryAnalysis {
  kind: "conversion" | "continuous";
  /** Cumulative totals at the last look (`DayData` shape; sums are not needed here). */
  last: { day?: number; nA: number; nB: number; convA: number; convB: number };
  srm: { chi2: number; p: number; mismatch: boolean };
  progress: number;
  rel?: RelCILike;
  sequential?: SequentialLike;
  z?: Interval & { rateA: number; rateB: number; liftAbs: number; z: number };
  a?: { n: number; mean: number; var: number };
  b?: { n: number; mean: number; var: number };
  raw?: Interval & { diff: number; liftRel: number };
  adj?: Interval & { diff: number; liftRel: number };
  cuped?: { theta: number; varianceReduction: number };
}
/** Structural subset of `Verdict` (lib/analysis.ts). */
export interface SummaryVerdict { label: string; p: number; lift: number; reason: string; tone?: string; decision?: string; basis?: "fixed" | "sequential" }

const DASH = "–";
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** At most `d` decimals, trailing zeros trimmed, thousands grouped with commas: num(13.9) = "13.9", num(12000, 0) = "12,000". */
export function num(x: number, d = 2): string {
  if (!fin(x)) return DASH;
  let s = Math.abs(x).toFixed(d);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  const [intPart = "0", frac] = s.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const negative = x < 0 && Number(s) !== 0;
  return `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}
/** Percent with fixed decimals: pct(0.1) = "10.00%", pct(0.5, 0) = "50%". */
export const pct = (x: number, d = 2): string => (fin(x) ? `${(100 * x).toFixed(d)}%` : DASH);
/** Prefix "+" for positive values so lifts and differences read as deltas. */
const signed = (text: string, x: number): string => (fin(x) && x > 0 ? `+${text}` : text);

/** ISO date `days` after `iso` (YYYY-MM-DD or any Date.parse-able string); null when the start date is unusable. */
function addDays(iso: string, days: number): string | null {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(t) ? new Date(t + days * 86_400_000).toISOString().slice(0, 10) : null;
}

export function buildSummary(e: Experiment, an: SummaryAnalysis, v: SummaryVerdict): string {
  const conv = an.kind === "conversion";
  const ci = `${Math.round((1 - e.alpha) * 100)}% CI`;
  const { nA, nB } = an.last;
  const nDays = e.days.length;
  const lastDay = e.days[e.days.length - 1]?.day ?? nDays;
  const endDate = addDays(e.startDate, Math.max(0, lastDay - 1));
  // Optional lifecycle fields (added by the versioned store); read defensively so older records still summarise.
  const { stoppedAt, notes } = e as Experiment & { stoppedAt?: string; notes?: string };
  const progress = fin(an.progress) ? Math.round(100 * Math.max(0, Math.min(1, an.progress))) : 0;

  const out: string[] = [`# ${e.name}`, ""];
  if (e.hypothesis.trim()) out.push(...e.hypothesis.trim().split(/\r?\n/).map((l) => `> ${l}`), "");
  out.push(`**Verdict:** ${v.label}. ${v.reason}`, "");

  // ---- facts
  out.push(`- **Metric:** ${e.metric} (${conv ? "conversion rate" : "continuous metric, CUPED-adjusted"})`);
  out.push(`- **Owner:** ${e.owner}${e.tags.length ? ` · **Tags:** ${e.tags.join(", ")}` : ""}`);
  const stopped = e.status === "stopped" ? (stoppedAt && addDays(stoppedAt, 0) ? ` · stopped on ${addDays(stoppedAt, 0)}` : " · stopped early") : "";
  out.push(`- **Period:** ${e.startDate}${endDate ? ` → ${endDate}` : ""} · ${nDays} day${nDays === 1 ? "" : "s"} · ${e.status}${stopped}`);
  const planned = e.plannedPerArm > 0 ? `${num(Math.min(nA, nB), 0)} of ${num(e.plannedPerArm, 0)} planned per arm (${progress}%)` : "no planned sample size recorded";
  out.push(`- **Sample:** ${num(nA + nB, 0)} users · ${planned}`, "");

  // ---- effect
  out.push("## Effect", "");
  const rel = an.rel && fin(an.rel.lift) ? an.rel : null;
  const liftText = signed(pct(rel ? rel.lift : v.lift), rel ? rel.lift : v.lift);
  if (rel && fin(rel.lo) && fin(rel.hi)) {
    out.push(`- **Relative lift:** ${liftText} (${ci} [${signed(pct(rel.lo), rel.lo)}, ${signed(pct(rel.hi), rel.hi)}], delta method${conv ? "" : " on CUPED-adjusted means"})`);
  } else {
    out.push(`- **Relative lift:** ${liftText} (confidence interval unavailable)`);
  }
  if (conv && an.z) {
    const pt = (x: number) => `${signed(num(100 * x, 2), x)} pt`;
    out.push(`- **Absolute difference:** ${pt(an.z.liftAbs)} (${ci} [${pt(an.z.ciLow)}, ${pt(an.z.ciHigh)}])`);
    out.push(`- **p-value:** ${fmtP(v.p)} (two-proportion z-test, z = ${num(an.z.z, 2)}, two-sided, α = ${e.alpha})`);
  } else if (!conv && an.adj) {
    const abs = (r: Interval & { diff: number }) => `${signed(num(r.diff), r.diff)} (${ci} [${signed(num(r.ciLow), r.ciLow)}, ${signed(num(r.ciHigh), r.ciHigh)}])`;
    out.push(`- **Absolute difference:** ${abs(an.adj)} — CUPED-adjusted${an.raw ? `; raw ${abs(an.raw)}` : ""}`);
    out.push(`- **p-value:** ${fmtP(v.p)} (Welch's t-test on CUPED-adjusted values, two-sided, α = ${e.alpha}${an.raw ? `; raw p = ${fmtP(an.raw.p)}` : ""})`);
    if (an.cuped) out.push(`- **CUPED:** θ = ${fin(an.cuped.theta) ? an.cuped.theta.toFixed(3) : DASH} · ${pct(an.cuped.varianceReduction, 1)} of variance removed`);
  } else {
    out.push(`- **p-value:** ${fmtP(v.p)} (two-sided, α = ${e.alpha})`);
  }
  const seq = an.sequential;
  if (seq && fin(seq.pAV)) {
    const tau = fin(seq.tau) ? ` (τ = ${num(seq.tau, 4)})` : "";
    const when = seq.decidedDay !== null && fin(seq.decidedDay) ? `crossed α on day ${seq.decidedDay}` : "has not crossed α";
    out.push(`- **Always-valid p (mSPRT):** ${fmtP(seq.pAV)} — ${when}${tau}`);
  }
  out.push("");

  // ---- guardrails
  out.push("## Guardrails", "");
  const srmFacts = `expected ${pct(e.split, 0)} / ${pct(1 - e.split, 0)}, observed ${num(nA, 0)} / ${num(nB, 0)} (χ² = ${num(an.srm.chi2, 2)}, p = ${fmtP(an.srm.p)})`;
  out.push(
    an.srm.mismatch
      ? `- **Sample-ratio check:** MISMATCH — ${srmFacts}. Assignment or logging is broken — do not act on any metric in this summary until it is fixed.`
      : `- **Sample-ratio check:** passed — ${srmFacts}`,
  );
  out.push("");

  // ---- arms
  out.push("## Arms", "");
  if (conv) {
    const rateA = an.z ? an.z.rateA : an.last.convA / Math.max(1, nA);
    const rateB = an.z ? an.z.rateB : an.last.convB / Math.max(1, nB);
    out.push("| Arm | Users | Conversions | Rate |", "| --- | ---: | ---: | ---: |");
    out.push(`| A · control | ${num(nA, 0)} | ${num(an.last.convA, 0)} | ${pct(rateA)} |`);
    out.push(`| B · treatment | ${num(nB, 0)} | ${num(an.last.convB, 0)} | ${pct(rateB)} |`);
  } else {
    const row = (label: string, n: number, s?: { mean: number; var: number }) => `| ${label} | ${num(n, 0)} | ${s ? num(s.mean) : DASH} | ${s ? num(Math.sqrt(Math.max(0, s.var))) : DASH} |`;
    out.push("| Arm | Users | Mean | Std |", "| --- | ---: | ---: | ---: |", row("A · control", nA, an.a), row("B · treatment", nB, an.b));
  }
  out.push("");

  if (notes && notes.trim()) out.push("## Notes", "", ...notes.trim().split(/\r?\n/), "");

  // ---- decision basis
  out.push("---", "");
  if (an.srm.mismatch || v.decision === "invalid") out.push("Decision basis: none — the sample-ratio check failed, so the metrics above cannot be trusted.");
  else if (v.basis === "sequential") out.push("Decision basis: always-valid p-value (mSPRT), which stays valid despite daily peeking; the fixed-horizon p-value is shown for reference only.");
  else if (v.decision === "collecting") out.push("Decision basis: none yet — the planned sample size has not been reached; p-values are shown for monitoring only.");
  else out.push(`Decision basis: fixed-horizon test at the planned sample size (α = ${e.alpha}, two-sided).`);
  out.push("", "_Generated with abkit — statistics computed locally in the browser; nothing was uploaded._", "");
  return out.join("\n");
}
