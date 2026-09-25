/** TypeScript twin of abkit/stats.py + abkit/ranking.py (no dependencies). */

// ---------------- numerics ----------------
export function erf(x: number): number {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const normCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));
export function normPpf(p: number): number {
  if (p <= 0 || p >= 1) return NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}
function gammaln(x: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaln(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
  }
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
}
export const chi2Sf = (x: number, df: number): number => gammaQ(df / 2, x / 2);
/** Regularised incomplete beta I_x(a,b) via continued fraction (Numerical Recipes). */
function betacf(a: number, b: number, x: number): number {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}
export function betainc(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Two-sided p-value for Student t with df degrees of freedom. */
export const tSf2 = (t: number, df: number): number => betainc(df / 2, 0.5, df / (df + t * t));
export function tPpf(p: number, df: number): number {
  // bisection on the two-sided survival function
  let lo = 0, hi = 50;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (tSf2(mid, df) > 2 * (1 - p)) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------- tests ----------------
export interface ZResult { rateA: number; rateB: number; liftAbs: number; liftRel: number; z: number; p: number; ciLow: number; ciHigh: number; significant: boolean; }
export function twoProportionZ(convA: number, nA: number, convB: number, nB: number, alpha = 0.05): ZResult {
  const pa = convA / nA, pb = convB / nB;
  const pooled = (convA + convB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  const z = se > 0 ? (pb - pa) / se : 0;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  const seU = Math.sqrt((pa * (1 - pa)) / nA + (pb * (1 - pb)) / nB);
  const zc = normPpf(1 - alpha / 2);
  const diff = pb - pa;
  return { rateA: pa, rateB: pb, liftAbs: diff, liftRel: pa > 0 ? diff / pa : NaN, z, p, ciLow: diff - zc * seU, ciHigh: diff + zc * seU, significant: p < alpha };
}
export interface MeanStats { n: number; mean: number; var: number; }
export interface TResult { diff: number; liftRel: number; t: number; df: number; p: number; ciLow: number; ciHigh: number; significant: boolean; }
export function welch(a: MeanStats, b: MeanStats, alpha = 0.05): TResult {
  const va = a.var / a.n, vb = b.var / b.n;
  const se = Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1));
  const diff = b.mean - a.mean;
  const t = se > 0 ? diff / se : 0;
  const p = tSf2(Math.abs(t), df);
  const tc = tPpf(1 - alpha / 2, df);
  return { diff, liftRel: a.mean !== 0 ? diff / a.mean : NaN, t, df, p, ciLow: diff - tc * se, ciHigh: diff + tc * se, significant: p < alpha };
}
export function sampleSizeProportion(baseline: number, mdeRel: number, alpha = 0.05, power = 0.8): number {
  const p1 = baseline, p2 = baseline * (1 + mdeRel);
  const za = normPpf(1 - alpha / 2), zb = normPpf(power);
  const pbar = (p1 + p2) / 2;
  const num = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((num / (p2 - p1)) ** 2);
}
export function sampleSizeMean(std: number, mdeAbs: number, alpha = 0.05, power = 0.8): number {
  return Math.ceil(2 * (((normPpf(1 - alpha / 2) + normPpf(power)) * std) / mdeAbs) ** 2);
}
export function srm(observed: number[], ratios?: number[]): { chi2: number; p: number; mismatch: boolean; expected: number[] } {
  const total = observed.reduce((a, b) => a + b, 0);
  const r = ratios ?? observed.map(() => 1 / observed.length);
  const expected = r.map((x) => x * total);
  const chi2 = observed.reduce((s, o, i) => s + (o - expected[i]!) ** 2 / expected[i]!, 0);
  const p = chi2Sf(chi2, observed.length - 1);
  return { chi2, p, mismatch: p < 0.001, expected };
}
export const holm = (ps: number[], alpha = 0.05): boolean[] => {
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const out = ps.map(() => false);
  for (let k = 0; k < order.length; k++) {
    const [p, i] = order[k]!;
    if (p < alpha / (order.length - k)) out[i] = true; else break;
  }
  return out;
};

/** Aggregate sufficient statistics for CUPED at the arm level: sums of x (pre-period), y (metric), x², y², xy. */
export interface Sums { n: number; sx: number; sy: number; sxx: number; syy: number; sxy: number; }
export const emptySums = (): Sums => ({ n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 });
export const addSums = (a: Sums, b: Sums): Sums => ({ n: a.n + b.n, sx: a.sx + b.sx, sy: a.sy + b.sy, sxx: a.sxx + b.sxx, syy: a.syy + b.syy, sxy: a.sxy + b.sxy });
export function meanVar(s: Sums): MeanStats {
  const mean = s.sy / s.n;
  return { n: s.n, mean, var: Math.max(0, (s.syy - s.n * mean * mean) / (s.n - 1)) };
}
export function cuped(a: Sums, b: Sums): { theta: number; varianceReduction: number; adjA: MeanStats; adjB: MeanStats } {
  const all = addSums(a, b);
  const mx = all.sx / all.n, my = all.sy / all.n;
  const varX = (all.sxx - all.n * mx * mx) / (all.n - 1);
  const cov = (all.sxy - all.n * mx * my) / (all.n - 1);
  const theta = varX > 0 ? cov / varX : 0;
  const adj = (s: Sums): MeanStats => {
    const mxs = s.sx / s.n, mys = s.sy / s.n;
    const vy = (s.syy - s.n * mys * mys) / (s.n - 1);
    const vx = (s.sxx - s.n * mxs * mxs) / (s.n - 1);
    const cxy = (s.sxy - s.n * mxs * mys) / (s.n - 1);
    return { n: s.n, mean: mys - theta * (mxs - mx), var: Math.max(1e-12, vy + theta * theta * vx - 2 * theta * cxy) };
  };
  const varY = (all.syy - all.n * my * my) / (all.n - 1);
  const varAdj = varY - theta * theta * varX;
  return { theta, varianceReduction: varY > 0 ? 1 - varAdj / varY : 0, adjA: adj(a), adjB: adj(b) };
}

// ---------------- ranking ----------------
export const dcg = (rels: number[]): number => rels.reduce((s, r, i) => s + (2 ** r - 1) / Math.log2(i + 2), 0);
export function ndcgAtK(rels: number[], k: number): number {
  const ideal = [...rels].sort((a, b) => b - a).slice(0, k);
  const idcg = dcg(ideal);
  return idcg > 0 ? dcg(rels.slice(0, k)) / idcg : 0;
}
export const mrr = (relevantFlags: boolean[][]): number => relevantFlags.reduce((s, f) => { const i = f.indexOf(true); return s + (i >= 0 ? 1 / (i + 1) : 0); }, 0) / Math.max(1, relevantFlags.length);
export const precisionAtK = (flags: boolean[], k: number): number => flags.slice(0, k).filter(Boolean).length / k;
export function teamDraft<T>(a: T[], b: T[], rnd: () => number): { list: T[]; teams: ("A" | "B")[] } {
  const list: T[] = [], teams: ("A" | "B")[] = [], seen = new Set<T>();
  let ia = 0, ib = 0, ca = 0, cb = 0;
  for (;;) {
    while (ia < a.length && seen.has(a[ia]!)) ia++;
    while (ib < b.length && seen.has(b[ib]!)) ib++;
    const aLeft = ia < a.length, bLeft = ib < b.length;
    if (!aLeft && !bLeft) break;
    const pickA = aLeft && (!bLeft || ca < cb || (ca === cb && rnd() < 0.5));
    const item = pickA ? a[ia++]! : b[ib++]!;
    if (pickA) ca++; else cb++;
    list.push(item); teams.push(pickA ? "A" : "B"); seen.add(item);
  }
  return { list, teams };
}

// ---------------- PRNG ----------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function randn(rnd: () => number): number {
  const u = Math.max(1e-12, rnd()), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** Binomial draw via normal approximation for large n, exact for small n. */
export function binomial(n: number, p: number, rnd: () => number): number {
  if (n < 60) { let k = 0; for (let i = 0; i < n; i++) if (rnd() < p) k++; return k; }
  return Math.min(n, Math.max(0, Math.round(n * p + Math.sqrt(n * p * (1 - p)) * randn(rnd))));
}
export const fmtPct = (x: number, d = 2): string => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : "–");
export const fmtP = (p: number): string => (!Number.isFinite(p) ? "–" : p < 1e-4 ? p.toExponential(1) : p.toFixed(4));
export const fmtNum = (x: number, d = 2): string => (Number.isFinite(x) ? x.toLocaleString(undefined, { maximumFractionDigits: d }) : "–");
