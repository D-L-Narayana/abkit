/**
 * Interleaving experiments: exact binomial test, preference interval and the Ranking lab's session simulator.
 * TypeScript twin of the interleaving part of abkit/ranking.py; parity fixture tests/fixtures/ranking.json is generated
 * by `python3 tests/test_ranking.py` and checked by interleaving.test.ts.
 *
 * Why an exact binomial test: every decided session is one Bernoulli trial "B wins". Under H₀ (the rankers are equally
 * good) the number of B wins among the decided sessions is Binomial(decided, ½), so the two-sided p-value is
 * P(|X − decided/2| ≥ |winsB − decided/2|) — no normal approximation. A two-proportion z-test on the complementary shares
 * winsA/decided and winsB/decided treats one sample as two and inflates the statistic by √2 (100 vs 120 wins: p ≈ 0.057
 * instead of the exact 0.200).
 */
import { ndcgAtK, teamDraft } from "../stats";

/** Highest relevance grade used by the simulator (grades are integers 0..MAX_GRADE). */
export const MAX_GRADE = 3;
/** Largest n for which the two-sided p-value is computed in exact integer arithmetic (one rounding at the end). */
const EXACT_MAX_N = 4096;
const LN_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
const LN_2PI = Math.log(2 * Math.PI);

export interface InterleavingResult {
  winsA: number;
  winsB: number;
  ties: number;
  /** Sessions with a winner (ties excluded). */
  decided: number;
  /** Exact two-sided binomial p-value of winsB among the decided sessions. */
  pValue: number;
  /** (winsB − winsA) / decided = 2p̂ − 1 ∈ [−1, 1]; positive favours B. */
  preference: number;
  /** Wilson score interval for p̂ = winsB/decided, mapped through 2p − 1. */
  ciLow: number;
  ciHigh: number;
  /** "A" or "B" when pValue < alpha, else "tie". */
  winner: "A" | "B" | "tie";
  alpha: number;
}

function checkCount(x: number, name: string): void {
  if (!Number.isInteger(x) || x < 0) throw new RangeError(`${name} must be a non-negative integer, got ${x}`);
}
function checkAlpha(alpha: number): void {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha must be in (0, 1), got ${alpha}`);
}

/** x · 2^e without intermediate overflow or underflow (exact unless the result is subnormal). */
function ldexp(x: number, e: number): number {
  while (e > 1000) { x *= 2 ** 1000; e -= 1000; }
  while (e < -1000) { x *= 2 ** -1000; e += 1000; }
  return x * 2 ** e;
}

/** ln x! for integer x ≥ 0: direct sum below 16, Stirling's formula with the stirlerr correction above. */
function lnFactorial(x: number): number {
  if (x < 16) {
    let s = 0;
    for (let j = 2; j <= x; j++) s += Math.log(j);
    return s;
  }
  return (x + 0.5) * Math.log(x) - x + LN_SQRT_2PI + stirlerr(x);
}

/** stirlerr(x) = ln x! − [(x + ½) ln x − x + ½ ln 2π] (Loader, 2000); the series below is exact to < 2e-16 for x ≥ 16. */
function stirlerr(x: number): number {
  if (x < 16) return lnFactorial(x) - ((x + 0.5) * Math.log(x) - x + LN_SQRT_2PI);
  const x2 = x * x;
  return (1 / 12 - (1 / 360 - (1 / 1260 - (1 / 1680 - 1 / 1188 / x2) / x2) / x2) / x2) / x;
}

/** Deviance term x·ln(x/np) + np − x, by series when x ≈ np to avoid cancellation (Loader, 2000). */
function bd0(x: number, np: number): number {
  if (Math.abs(x - np) < 0.1 * (x + np)) {
    const v = (x - np) / (x + np);
    const v2 = v * v;
    let s = (x - np) * v;
    let ej = 2 * x * v;
    for (let j = 1; j < 1000; j++) {
      ej *= v2;
      const s1 = s + ej / (2 * j + 1);
      if (s1 === s) return s1;
      s = s1;
    }
    return s;
  }
  return x * Math.log(x / np) + np - x;
}

/** ln P(X = x) for X ~ Binomial(n, ½) and 0 < x < n, saddle-point form (relative error ~1e-15 for every n). */
function logPmfHalf(x: number, n: number): number {
  const np = n / 2;
  const lc = stirlerr(n) - stirlerr(x) - stirlerr(n - x) - bd0(x, np) - bd0(n - x, np);
  return lc - 0.5 * (LN_2PI + Math.log(x) + Math.log1p(-x / n));
}

/** ln C(n, k) = ln Γ(n+1) − ln Γ(k+1) − ln Γ(n−k+1), accurate to ~1e-14 relative for all 0 ≤ k ≤ n. */
export function logChoose(n: number, k: number): number {
  checkCount(n, "n");
  checkCount(k, "k");
  if (k > n) throw new RangeError(`k must not exceed n, got k=${k} n=${n}`);
  const m = Math.min(k, n - k);
  if (m === 0) return 0;
  if (m <= 64) {
    let s = 0;
    for (let j = 1; j <= m; j++) s += Math.log((n - m + j) / j);
    return s;
  }
  return lnFactorial(n) - lnFactorial(m) - lnFactorial(n - m);
}

/** 2 · Σ_{i≤m} C(n, i) / 2^n in exact integer arithmetic, correctly rounded to double (n ≤ EXACT_MAX_N). */
function exactTwoSided(m: number, n: number): number {
  let c = 1n;
  let sum = 1n;
  for (let i = 0; i < m; i++) {
    c = (c * BigInt(n - i)) / BigInt(i + 1); // C(n, i+1) from C(n, i), exact
    sum += c;
  }
  const num = 2n * sum;
  const bits = num.toString(2).length;
  if (bits <= 64) return Math.min(1, ldexp(Number(num), -n));
  const shift = BigInt(bits - 64);
  let top = num >> shift;
  if (top << shift !== num) top |= 1n; // sticky bit: discarded non-zero bits break rounding ties correctly
  return Math.min(1, ldexp(Number(top), bits - 64 - n));
}

/**
 * Exact two-sided p-value of k successes in n Bernoulli(½) trials: P(|X − n/2| ≥ |k − n/2|) = 2·P(X ≤ min(k, n−k)),
 * i.e. scipy.stats.binomtest(k, n, 0.5).pvalue. Exact integer arithmetic up to n = 4096; beyond that the largest term is
 * anchored by the log-binomial (log-gamma) saddle-point formula and the rest follow by the exact ratio recurrence.
 * Returns 1 when n = 0 (no trials).
 */
export function binomialTwoSidedP(k: number, n: number): number {
  checkCount(k, "k");
  checkCount(n, "n");
  if (k > n) throw new RangeError(`k must not exceed n, got k=${k} n=${n}`);
  if (n === 0) return 1;
  const m = Math.min(k, n - k);
  if (2 * m === n) return 1;
  if (n <= EXACT_MAX_N) return exactTwoSided(m, n);
  if (m === 0) return ldexp(2, -n);
  let term = 1;
  let sum = 1;
  for (let i = m - 1; i >= 0; i--) {
    term *= (i + 1) / (n - i); // C(n, i) / C(n, i+1)
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return Math.min(1, 2 * Math.exp(logPmfHalf(m, n)) * sum);
}

/** Standard normal quantile Φ⁻¹(p) by Wichura's algorithm AS 241 (PPND16, about 1e-16 relative accuracy); NaN outside (0, 1). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (
      (q * (((((((2509.0809287301226727 * r + 33430.575583588128105) * r + 67265.770927008700853) * r + 45921.953931549871457) * r + 13731.693765509461125) * r + 1971.5909503065514427) * r + 133.14166789178437745) * r + 3.387132872796366608)) /
      (((((((5226.495278852545925 * r + 28729.085735721942674) * r + 39307.89580009271061) * r + 21213.794301586595867) * r + 5394.1960214247511077) * r + 687.1870074920579083) * r + 42.313330701600911252) * r + 1)
    );
  }
  let r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  let val: number;
  if (r <= 5) {
    r -= 1.6;
    val =
      (((((((7.7454501427834140764e-4 * r + 0.0227238449892691845833) * r + 0.24178072517745061177) * r + 1.27045825245236838258) * r + 3.64784832476320460504) * r + 5.7694972214606914055) * r + 4.6303378461565452959) * r + 1.42343711074968357734) /
      (((((((1.05075007164441684324e-9 * r + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r + 0.14810397642748007459) * r + 0.68976733498510000455) * r + 1.6763848301838038494) * r + 2.05319162663775882187) * r + 1);
  } else {
    r -= 5;
    val =
      (((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r + 0.026532189526576123093) * r + 0.29656057182850489123) * r + 1.7848265399172913358) * r + 5.4637849111641143699) * r + 6.6579046435011037772) /
      (((((((2.04426310338993978564e-15 * r + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r + 7.868691311456132591e-4) * r + 0.0148753612908506148525) * r + 0.13692988092273580531) * r + 0.59983220655588793769) * r + 1);
  }
  return q < 0 ? -val : val;
}

/**
 * Wilson score interval for a binomial proportion k/n (Wilson, 1927):
 *   centre = (p̂ + z²/2n) / (1 + z²/n),   half-width = z·√( p̂(1−p̂)/n + z²/4n² ) / (1 + z²/n),   z = z₁₋α/₂.
 * Unlike the Wald interval it never leaves [0, 1] and keeps its coverage for small n or p̂ near 0 or 1. [0, 1] when n = 0.
 */
export function wilson(k: number, n: number, alpha = 0.05): [number, number] {
  checkCount(k, "k");
  checkCount(n, "n");
  checkAlpha(alpha);
  if (k > n) throw new RangeError(`k must not exceed n, got k=${k} n=${n}`);
  if (n === 0) return [0, 1];
  const z = -normalQuantile(alpha / 2);
  const pHat = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (pHat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Exact two-sided binomial test for an interleaving experiment (twin of abkit.ranking.interleaving_test). Ties carry no
 * information about which ranker is better: they are excluded from the test but reported. With no decided sessions the
 * result is p = 1, preference 0 with the uninformative interval [−1, 1] and winner "tie".
 */
export function interleavingTest(winsA: number, winsB: number, ties = 0, alpha = 0.05): InterleavingResult {
  checkCount(winsA, "winsA");
  checkCount(winsB, "winsB");
  checkCount(ties, "ties");
  checkAlpha(alpha);
  const decided = winsA + winsB;
  if (decided === 0) return { winsA, winsB, ties, decided, pValue: 1, preference: 0, ciLow: -1, ciHigh: 1, winner: "tie", alpha };
  const pValue = binomialTwoSidedP(winsB, decided);
  const [lo, hi] = wilson(winsB, decided, alpha);
  const winner: InterleavingResult["winner"] = pValue < alpha ? (winsB > winsA ? "B" : "A") : "tie";
  return { winsA, winsB, ties, decided, pValue, preference: (winsB - winsA) / decided, ciLow: 2 * lo - 1, ciHigh: 2 * hi - 1, winner, alpha };
}

/** Mean NDCG@k over queries (each query is the relevance grade at each ranked position); 0 for no queries. */
export function meanNdcgAtK(queries: number[][], k: number): number {
  if (!Number.isInteger(k) || k <= 0) throw new RangeError(`k must be >= 1, got ${k}`);
  if (queries.length === 0) return 0;
  return queries.reduce((s, q) => s + ndcgAtK(q, k), 0) / queries.length;
}

function gradesOf(rel: number[], name: string, n: number): number[] {
  for (const g of rel) if (!Number.isInteger(g) || g < 0 || g > MAX_GRADE) throw new RangeError(`${name} grades must be integers in 0..${MAX_GRADE}, got ${g}`);
  return Array.from({ length: n }, (_, i) => rel[i] ?? 0);
}

/**
 * Turn two "relevance grade by position" lists into one document pool and each ranker's order over it (twin of
 * abkit.ranking.build_rankings). Both rankers rank the same documents: document i of the pool has grade
 * `grades[i]` = the larger of the i-th best grade in relA and in relB, so the pool is sorted by grade and realises either
 * list exactly when the two are permutations of each other. `orderA[p]` is the document ranker A shows at position p:
 * the unused document whose grade is nearest to relA[p] (ties → the better document). The shorter list is padded with 0.
 */
export function buildRankings(relA: number[], relB: number[]): { grades: number[]; orderA: number[]; orderB: number[] } {
  const n = Math.max(relA.length, relB.length);
  const a = gradesOf(relA, "relA", n);
  const b = gradesOf(relB, "relB", n);
  const sa = [...a].sort((x, y) => y - x);
  const sb = [...b].sort((x, y) => y - x);
  const grades = sa.map((g, i) => Math.max(g, sb[i]!));
  const order = (wanted: number[]): number[] => {
    const used = new Array<boolean>(n).fill(false);
    return wanted.map((w) => {
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(grades[i]! - w);
        if (!used[i] && d < bestDist) { best = i; bestDist = d; }
      }
      used[best] = true;
      return best;
    });
  };
  return { grades, orderA: order(a), orderB: order(b) };
}

/**
 * Simulate team-draft interleaving sessions with position-biased clicks (twin of
 * abkit.ranking.simulate_interleaving_sessions; same model, different random streams). Every session draws a fresh
 * team draft (coin flips from `rnd`), the document at 1-based position p is clicked with probability
 * (grade / MAX_GRADE) · clickScale / √p, and the session goes to the team with more clicked documents (equal → tie).
 */
export function simulateSessions(relA: number[], relB: number[], sessions: number, rnd: () => number, clickScale = 0.7): { winsA: number; winsB: number; ties: number } {
  checkCount(sessions, "sessions");
  if (!(clickScale >= 0 && clickScale <= 1)) throw new RangeError(`clickScale must be in [0, 1], got ${clickScale}`);
  const { grades, orderA, orderB } = buildRankings(relA, relB);
  const discount = grades.map((_, p) => clickScale / Math.sqrt(p + 1));
  let winsA = 0;
  let winsB = 0;
  let ties = 0;
  for (let s = 0; s < sessions; s++) {
    const { list, teams } = teamDraft(orderA, orderB, rnd);
    let ca = 0;
    let cb = 0;
    for (let pos = 0; pos < list.length; pos++) {
      if (rnd() < (grades[list[pos]!]! / MAX_GRADE) * discount[pos]!) {
        if (teams[pos] === "A") ca++;
        else cb++;
      }
    }
    if (ca > cb) winsA++;
    else if (cb > ca) winsB++;
    else ties++;
  }
  return { winsA, winsB, ties };
}

/** Parse a comma/whitespace-separated list of grades: non-numbers dropped, values rounded and clamped to 0..MAX_GRADE, at most `maxPositions` kept. */
export function parseGrades(text: string, maxPositions = 20): number[] {
  return text
    .split(/[,\s]+/)
    .filter((t) => t !== "")
    .map(Number)
    .filter((x) => Number.isFinite(x))
    .map((x) => Math.max(0, Math.min(MAX_GRADE, Math.round(x))))
    .slice(0, maxPositions);
}
