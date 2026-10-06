/**
 * TypeScript twin of abkit/sequential.py — mixture sequential probability ratio test (mSPRT) with always-valid p-values.
 *
 * A fixed-horizon test is only valid when the data are analysed once, at the planned sample size; "check every day,
 * stop at the first p < 0.05" inflates the false-positive rate several-fold. The mSPRT keeps the type-I error below α
 * no matter how often or when you look ("legal peeking").
 *
 * At look k the observed difference δ̂_k (rate B − rate A, or mean B − mean A) is treated as N(δ, V_k) with V_k its
 * estimated variance; H0 is δ = 0 and the alternative is mixed over the prior δ ~ N(0, τ²), which gives the closed form
 *
 *     Λ_k = sqrt( V_k / (V_k + τ²) ) · exp( δ̂_k² · τ² / (2 · V_k · (V_k + τ²)) )
 *
 * Under H0 (Λ_k) is a non-negative martingale with mean 1, so by Ville's inequality P(max_k Λ_k ≥ 1/α) ≤ α and
 *
 *     p_k = min(1, 1 / max_{j ≤ k} Λ_j)
 *
 * is an always-valid p-value: P(∃k: p_k < α) ≤ α for any stopping rule, and the sequence never increases. τ is the
 * planned absolute minimum detectable effect (`tauFromMde`). The guarantee is conservative, so the fixed-horizon
 * p-value stays the final read when the planned sample size is reached. Every formula mirrors the Python module
 * operation for operation so both languages agree to ~1e-15 relative (fixture: tests/fixtures/sequential.json).
 */

/** One look: observed difference (B − A) and its estimated variance. Build with `proportionPoint` / `meanPoint`. */
export interface SeqPoint { diff: number; varDiff: number }
/** Per-look mixture likelihood ratios, always-valid p-values and the 1-based first look with p < α (null = none). */
export interface SeqSeries { lr: number[]; pAV: number[]; decidedAt: number | null }
/** Per-arm summary of a continuous metric: sample size, mean and sample variance (ddof = 1); same shape as `MeanStats` in stats.ts. */
export interface MeanStatsLike { n: number; mean: number; var: number }

/**
 * Mixture likelihood ratio Λ = sqrt(V/(V+τ²)) · exp(diff²·τ²/(2·V·(V+τ²))) of an observed difference with variance V = varDiff
 * under the N(0, τ²) prior. Depends on diff² only (two-sided). V = 0 returns the limit: 0 when diff = 0, +Infinity otherwise;
 * overwhelming evidence overflows exp() to +Infinity (p = 0), never NaN. Throws on non-finite input, V < 0 or τ ≤ 0.
 */
export function mixtureLR(diff: number, varDiff: number, tau: number): number {
  if (!Number.isFinite(diff) || !Number.isFinite(varDiff) || !Number.isFinite(tau)) throw new Error("diff, varDiff and tau must be finite numbers");
  if (varDiff < 0) throw new Error("varDiff must be >= 0");
  if (tau <= 0) throw new Error("tau must be > 0");
  if (varDiff === 0) return diff === 0 ? 0 : Infinity;
  const tau2 = tau * tau;
  const total = varDiff + tau2;
  const exponent = (diff * diff * tau2) / (2 * varDiff * total);
  return Math.sqrt(varDiff / total) * Math.exp(exponent);
}

/** Always-valid p-values p_k = min(1, 1 / max_{j ≤ k} Λ_j): non-increasing; a running maximum ≤ 1 gives 1, Λ = +Infinity gives 0. */
export function alwaysValidP(lrs: number[]): number[] {
  const out: number[] = [];
  let running = 0;
  for (const lr of lrs) {
    if (Number.isNaN(lr) || lr < 0) throw new Error("likelihood ratios must be >= 0");
    running = Math.max(running, lr);
    out.push(running <= 1 ? 1 : 1 / running);
  }
  return out;
}

/**
 * Scale τ of the mixing prior from the planned absolute minimum detectable effect: τ = |mdeAbs| (documented heuristic —
 * the prior puts its mass on effects of the size the experiment was designed to detect, where decisions arrive fastest).
 * For a conversion metric the absolute MDE is baseline × relative MDE, e.g. 10% × 10% = 0.01.
 */
export function tauFromMde(mdeAbs: number): number {
  if (!Number.isFinite(mdeAbs) || mdeAbs === 0) throw new Error("mdeAbs must be a non-zero finite number");
  return Math.abs(mdeAbs);
}

/**
 * Look for a conversion metric from CUMULATIVE counts: diff = p̂B − p̂A, varDiff = p̄(1 − p̄)(1/nA + 1/nB) with the pooled rate p̄
 * (the null variance of the pooled z-test). An arm without users yet yields { diff: 0, varDiff: 0 } — no evidence (Λ = 0).
 */
export function proportionPoint(convA: number, nA: number, convB: number, nB: number): SeqPoint {
  for (const [conv, n] of [[convA, nA], [convB, nB]] as const) {
    if (!Number.isFinite(conv) || !Number.isFinite(n) || conv < 0 || n < 0 || conv > n) throw new Error("need 0 <= conversions <= visitors in each arm");
  }
  if (nA === 0 || nB === 0) return { diff: 0, varDiff: 0 };
  const pa = convA / nA, pb = convB / nB;
  const pooled = (convA + convB) / (nA + nB);
  return { diff: pb - pa, varDiff: pooled * (1 - pooled) * (1 / nA + 1 / nB) };
}

/** Look for a continuous metric: diff = meanB − meanA, varDiff = varA/nA + varB/nB (Welch). Pass CUPED-adjusted statistics for CUPED. Needs n ≥ 2 per arm. */
export function meanPoint(a: MeanStatsLike, b: MeanStatsLike): SeqPoint {
  for (const s of [a, b]) {
    if (!(s.n >= 2) || !Number.isFinite(s.mean) || !Number.isFinite(s.var) || s.var < 0) throw new Error("each arm needs n >= 2, a finite mean and a finite variance >= 0");
  }
  return { diff: b.mean - a.mean, varDiff: a.var / a.n + b.var / b.n };
}

/**
 * mSPRT over a sequence of CUMULATIVE looks: Λ_k per look, always-valid p-values and the 1-based first look with p_k < alpha
 * (null when no look crossed alpha). Points must be cumulative (running totals), not per-look increments.
 */
export function msprtSeries(points: SeqPoint[], tau: number, alpha = 0.05): SeqSeries {
  if (!(Number.isFinite(tau) && tau > 0)) throw new Error("tau must be a positive finite number");
  if (!(alpha > 0 && alpha < 1)) throw new Error("alpha must be in (0, 1)");
  const lr = points.map((pt) => mixtureLR(pt.diff, pt.varDiff, tau));
  const pAV = alwaysValidP(lr);
  const idx = pAV.findIndex((p) => p < alpha);
  return { lr, pAV, decidedAt: idx >= 0 ? idx + 1 : null };
}
