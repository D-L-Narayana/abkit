/** TypeScript twin of abkit/stats.py + abkit/ranking.py (no dependencies). */

// ---------------- numerics ----------------
/*
 * erf / erfc — W. J. Cody's rational Chebyshev approximations ("Rational Chebyshev approximations for the error
 * function", Math. Comp. 23, 1969; coefficient arrangement of the 1990 CALERF routine). Three regions:
 *   |x| ≤ 0.46875          erf(x)  = x · P₄(x²)/Q₄(x²)
 *   0.46875 < |x| ≤ 4      erfc(x) = e^{−x²} · P₈(x)/Q₈(x)
 *   |x| > 4                erfc(x) = e^{−x²}/x · (1/√π − P₅(1/x²)/Q₅(1/x²)/x²)
 * e^{−x²} is split as e^{−t²}·e^{−(x−t)(x+t)} with t = ⌊16x⌋/16 so the argument of the first factor is exact.
 * Relative error ≲ 5e-15 for |x| ≤ 6 and ≲ 6e-14 up to the underflow point x ≈ 26.54 (checked against SciPy).
 */
const ERF_A = [3.1611237438705656, 113.864154151050156, 377.485237685302021, 3209.37758913846947, 0.185777706184603153];
const ERF_B = [23.6012909523441209, 244.024637934444173, 1282.61652607737228, 2844.23683343917062];
const ERFC_C = [0.564188496988670089, 8.88314979438837594, 66.1191906371416295, 298.635138197400131, 881.95222124176909, 1712.04761263407058, 2051.07837782607147, 1230.33935479799725, 2.15311535474403846e-8];
const ERFC_D = [15.7449261107098347, 117.693950891312499, 537.181101862009858, 1621.38957456669019, 3290.79923573345963, 4362.61909014324716, 3439.36767414372164, 1230.33935480374942];
const ERFC_P = [0.305326634961232344, 0.360344899949804439, 0.125781726111229246, 0.0160837851487422766, 6.58749161529837803e-4, 0.0163153871373020978];
const ERFC_Q = [2.56852019228982242, 1.87295284992346725, 0.527905102951428412, 0.0605183413124413191, 2.33520497626869185e-3];
const ONE_OVER_SQRT_PI = 0.5641895835477562869;
const ERF_THRESH = 0.46875;
const ERFC_XBIG = 26.543; // erfc underflows below the smallest normal double

/** erf(x) for 0 ≤ x ≤ 0.46875. */
function erfSmall(x: number): number {
  const ysq = x > 1.11e-16 ? x * x : 0;
  let xnum = ERF_A[4]! * ysq;
  let xden = ysq;
  for (let i = 0; i < 3; i++) {
    xnum = (xnum + ERF_A[i]!) * ysq;
    xden = (xden + ERF_B[i]!) * ysq;
  }
  return (x * (xnum + ERF_A[3]!)) / (xden + ERF_B[3]!);
}
/** e^{−y²} with the argument split so rounding in y² does not leak into the result. */
function expNegSquare(y: number): number {
  const t = Math.trunc(y * 16) / 16;
  return Math.exp(-t * t) * Math.exp(-(y - t) * (y + t));
}
/** erfc(y) for y > 0.46875. */
function erfcLarge(y: number): number {
  if (y <= 4) {
    let xnum = ERFC_C[8]! * y;
    let xden = y;
    for (let i = 0; i < 7; i++) {
      xnum = (xnum + ERFC_C[i]!) * y;
      xden = (xden + ERFC_D[i]!) * y;
    }
    return (expNegSquare(y) * (xnum + ERFC_C[7]!)) / (xden + ERFC_D[7]!);
  }
  if (y >= ERFC_XBIG) return 0;
  const ysq = 1 / (y * y);
  let xnum = ERFC_P[5]! * ysq;
  let xden = ysq;
  for (let i = 0; i < 4; i++) {
    xnum = (xnum + ERFC_P[i]!) * ysq;
    xden = (xden + ERFC_Q[i]!) * ysq;
  }
  const r = (ysq * (xnum + ERFC_P[4]!)) / (xden + ERFC_Q[4]!);
  return (expNegSquare(y) * (ONE_OVER_SQRT_PI - r)) / y;
}
/** Complementary error function, relative error ≲ 5e-15 for |x| ≤ 6 (Cody). erfc(−x) = 2 − erfc(x). */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const y = Math.abs(x);
  const r = y <= ERF_THRESH ? 1 - erfSmall(y) : erfcLarge(y);
  return x < 0 ? 2 - r : r;
}
/** Error function on the same approximation (erf(x) = 1 − erfc(x) away from zero, direct series near zero). */
export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const y = Math.abs(x);
  const r = y <= ERF_THRESH ? erfSmall(y) : 1 - erfcLarge(y);
  return x < 0 ? -r : r;
}
/** Standard normal survival function P(Z > z) = ½·erfc(z/√2); keeps full relative precision in the far tail. */
export function normSf(z: number): number {
  return 0.5 * erfc(z / Math.SQRT2);
}
/** Standard normal CDF, computed through the survival function on the side that does not cancel. */
export const normCdf = (z: number): number => (z < 0 ? normSf(-z) : 1 - normSf(z));

const ACKLAM_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const ACKLAM_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const ACKLAM_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const ACKLAM_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
/** P. J. Acklam's rational approximation of the inverse normal CDF (relative error ≈ 1.15e-9) for 0 < p ≤ 0.5. */
function acklam(p: number): number {
  const a = ACKLAM_A, b = ACKLAM_B, c = ACKLAM_C, d = ACKLAM_D;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}
/**
 * Inverse of the standard normal CDF. Acklam's approximation followed by one Halley step on f(x) = Φ(x) − p
 * (f′ = φ, f″/f′ = −x), with the residual evaluated through erfc so the step is accurate in the tails.
 * Relative error < 1e-13 against SciPy's ndtri; exactly 0 at p = 0.5; NaN outside (0, 1).
 */
export function normPpf(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  if (p === 0.5) return 0;
  if (p > 0.5) return -normPpf(1 - p);
  const x = acklam(p);
  // Φ(x) − p without cancellation: near the centre via erf (p − ½ is exact there), otherwise via the lower tail.
  const e = x > -0.66 ? 0.5 * erf(x / Math.SQRT2) - (p - 0.5) : normSf(-x) - p;
  if (e === 0) return x;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2); // f / f′
  if (!Number.isFinite(u)) return x;
  return x - u / (1 + (x * u) / 2);
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
/** Chi-square survival function; df = 1 is erfc(√(x/2)) exactly, other df use the regularised incomplete gamma. */
export const chi2Sf = (x: number, df: number): number => (df === 1 ? erfc(Math.sqrt(Math.max(0, x) / 2)) : gammaQ(df / 2, x / 2));
/** Regularised incomplete beta I_x(a,b) via continued fraction (Numerical Recipes). */
function betacf(a: number, b: number, x: number): number {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  // converges in O(√max(a, b)) steps; the cap only matters for df in the millions (Welch with huge arms)
  for (let m = 1; m <= 20_000; m++) {
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
  const p = 2 * normSf(Math.abs(z));
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

/** Relative lift (B/A − 1) with a delta-method confidence interval. All fields NaN when the control mean is 0. */
export interface RelCI { lift: number; lo: number; hi: number; se: number }
const NAN_REL: RelCI = { lift: NaN, lo: NaN, hi: NaN, se: NaN };
/**
 * Delta-method CI for the ratio R = meanB / meanA of two independent estimates:
 *   Var(R) = seB²/meanA² + meanB²·seA²/meanA⁴,   lift = R − 1,   CI = lift ± z₁₋α/₂·√Var(R).
 * Unlike dividing the absolute CI by the control mean, this accounts for the uncertainty of the control estimate.
 */
export function relativeLiftCI(meanA: number, seA: number, meanB: number, seB: number, alpha = 0.05): RelCI {
  if (meanA === 0 || ![meanA, seA, meanB, seB].every(Number.isFinite) || !(alpha > 0 && alpha < 1)) return NAN_REL;
  const ratio = meanB / meanA;
  const variance = (seB * seB) / (meanA * meanA) + (meanB * meanB * seA * seA) / meanA ** 4;
  const se = Math.sqrt(variance);
  const lift = ratio - 1;
  const z = normPpf(1 - alpha / 2);
  return { lift, lo: lift - z * se, hi: lift + z * se, se };
}
/** Delta-method relative lift for two conversion rates (se = √(p(1−p)/n) per arm). */
export function relativeLiftProportions(convA: number, nA: number, convB: number, nB: number, alpha = 0.05): RelCI {
  if (!(nA > 0 && nB > 0 && convA >= 0 && convB >= 0 && convA <= nA && convB <= nB)) return NAN_REL;
  const pa = convA / nA, pb = convB / nB;
  return relativeLiftCI(pa, Math.sqrt((pa * (1 - pa)) / nA), pb, Math.sqrt((pb * (1 - pb)) / nB), alpha);
}
/** Delta-method relative lift for two means from sufficient statistics (se = √(var/n) per arm). */
export function relativeLiftMeans(a: MeanStats, b: MeanStats, alpha = 0.05): RelCI {
  if (!(a.n > 0 && b.n > 0 && a.var >= 0 && b.var >= 0)) return NAN_REL;
  return relativeLiftCI(a.mean, Math.sqrt(a.var / a.n), b.mean, Math.sqrt(b.var / b.n), alpha);
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
/**
 * Power of the two-sided two-proportion z-test at `nPerArm` users per arm (inverse of sampleSizeProportion):
 *   Φ( (|p₂−p₁|·√n − z₁₋α/₂·√(2p̄q̄)) / √(p₁q₁ + p₂q₂) ),  p₂ = p₁(1 + mdeRel).  NaN for impossible inputs.
 */
export function powerProportion(baseline: number, mdeRel: number, nPerArm: number, alpha = 0.05): number {
  const p1 = baseline, p2 = baseline * (1 + mdeRel);
  if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1 && nPerArm > 0 && alpha > 0 && alpha < 1) || !Number.isFinite(nPerArm)) return NaN;
  const za = normPpf(1 - alpha / 2);
  const pbar = (p1 + p2) / 2;
  return normCdf((Math.abs(p2 - p1) * Math.sqrt(nPerArm) - za * Math.sqrt(2 * pbar * (1 - pbar))) / Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)));
}
/** Power of the two-sided two-sample z/t-test for a mean difference `mdeAbs` with known std: Φ(|δ|·√(n/2)/σ − z₁₋α/₂). */
export function powerMean(std: number, mdeAbs: number, nPerArm: number, alpha = 0.05): number {
  if (!(std > 0 && nPerArm > 0 && alpha > 0 && alpha < 1) || !Number.isFinite(nPerArm) || !Number.isFinite(mdeAbs)) return NaN;
  return normCdf((Math.abs(mdeAbs) * Math.sqrt(nPerArm / 2)) / std - normPpf(1 - alpha / 2));
}
/**
 * Smallest relative lift detectable with the given power at `nPerArm` users per arm (bisection on powerProportion,
 * which rises from α/2 at MDE → 0 towards 1 as the treatment rate approaches 1). NaN for impossible inputs.
 */
export function mdeAtN(baseline: number, nPerArm: number, alpha = 0.05, power = 0.8): number {
  if (!(baseline > 0 && baseline < 1 && nPerArm > 0 && alpha > 0 && alpha < 1 && power > alpha / 2 && power < 1) || !Number.isFinite(nPerArm)) return NaN;
  let lo = 0, hi = (1 - baseline) / baseline;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const pw = powerProportion(baseline, mid, nPerArm, alpha);
    if (Number.isNaN(pw) || pw >= power) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}
/** Smallest absolute mean difference detectable at `nPerArm` per arm (closed-form inverse of sampleSizeMean): (z₁₋α/₂ + z_power)·σ·√(2/n). */
export function mdeAtNMean(std: number, nPerArm: number, alpha = 0.05, power = 0.8): number {
  if (!(std > 0 && nPerArm > 0 && alpha > 0 && alpha < 1 && power > 0 && power < 1) || !Number.isFinite(nPerArm)) return NaN;
  return (normPpf(1 - alpha / 2) + normPpf(power)) * std * Math.sqrt(2 / nPerArm);
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
