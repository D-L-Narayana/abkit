import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chi2Sf,
  cuped,
  erf,
  erfc,
  holm,
  mdeAtN,
  mdeAtNMean,
  normCdf,
  normPpf,
  normSf,
  powerMean,
  powerProportion,
  relativeLiftCI,
  relativeLiftMeans,
  relativeLiftProportions,
  sampleSizeMean,
  sampleSizeProportion,
  srm,
  tPpf,
  tSf2,
  twoProportionZ,
  welch,
  type MeanStats,
  type RelCI,
  type Sums,
} from "./stats";

/** |actual − expected| ≤ max(abs, rel·|expected|). A NaN actual always fails. */
function close(actual: number, expected: number, rel: number, abs = 0): void {
  const tol = Math.max(abs, rel * Math.abs(expected));
  expect(Math.abs(actual - expected), `got ${actual}, want ${expected} (tol ${tol})`).toBeLessThanOrEqual(tol);
}

// Reference values: SciPy 1.18 (float64), printed with repr().
const ERFC: [number, number][] = [
  [0, 1],
  [0.1, 0.8875370839817152],
  [0.25, 0.7236736098317631],
  [0.46875, 0.507386526782062],
  [0.5, 0.4795001221869535],
  [0.75, 0.2888443663464849],
  [1, 0.15729920705028516],
  [1.5, 0.03389485352468927],
  [2, 0.004677734981047266],
  [2.5, 0.00040695201744495886],
  [3, 2.2090496998585445e-5],
  [3.5, 7.430983723414129e-7],
  [4, 1.541725790028002e-8],
  [4.5, 1.9661604415428878e-10],
  [5, 1.5374597944280347e-12],
  [5.5, 7.357847917974398e-15],
  [6, 2.1519736712498913e-17],
];
const ERFC_FAR: [number, number][] = [
  [7, 4.183825607779414e-23],
  [10, 2.0884875837625446e-45],
  [26, 5.663192408856145e-296],
];
const ERFC_NEG: [number, number][] = [
  [-0.3, 1.3286267594591274],
  [-1, 1.8427007929497148],
  [-2.5, 1.999593047982555],
  [-4, 1.999999984582742],
];
const NORM_SF: [number, number][] = [
  [0, 0.5],
  [0.5, 0.3085375387259869],
  [1, 0.15865525393145707],
  [1.96, 0.024997895148220435],
  [2.5758, 0.00500042373777868],
  [3, 0.0013498980316300933],
  [4, 3.167124183311986e-5],
  [5, 2.866515718791933e-7],
  [6, 9.865876450376946e-10],
  [8, 6.22096057427174e-16],
];
const NORM_SF_FAR: [number, number][] = [
  [10, 7.61985302416047e-24],
  [20, 2.7536241186061556e-89],
  [30, 4.906713927147908e-198],
  [37, 5.7255712225239266e-300],
];
const NORM_PPF: [number, number][] = [
  [1e-300, -37.0470962993612],
  [1e-15, -7.941345326170998],
  [1e-10, -6.361340902404056],
  [1e-6, -4.753424308822899],
  [0.001, -3.090232306167813],
  [0.02425, -1.972961051311885],
  [0.025, -1.9599639845400545],
  [0.05, -1.6448536269514729],
  [0.2, -0.8416212335729142],
  [0.3, -0.5244005127080409],
  [0.7, 0.5244005127080407],
  [0.8, 0.8416212335729143],
  [0.9, 1.2815515655446004],
  [0.975, 1.959963984540054],
  [0.97575, 1.972961051311885],
  [0.999, 3.090232306167813],
  [0.9999999999, 6.361340889697422],
];
const CHI2_SF: [number, number, number][] = [
  [0.5, 1, 0.47950012218695337],
  [3.841, 1, 0.050013683763956804],
  [10.83, 1, 0.0009986863791802592],
  [25, 1, 5.733031437583875e-7],
  [0.001, 1, 0.9747728793699604],
  [5.99, 2, 0.05003662708658629],
];
const T_SF2: [number, number, number][] = [
  [1.5, 10, 0.16450732644544014],
  [2.0, 30, 0.054625044962983094],
  [2.5, 100.7, 0.014034226596581231],
  [4.0, 5, 0.01032341548083145],
];

describe("erfc (Cody-class accuracy)", () => {
  it.each(ERFC)("erfc(%s) matches SciPy to 1e-14", (x, want) => close(erfc(x), want, 1e-14));
  it.each(ERFC_FAR)("erfc(%s) stays accurate far in the tail", (x, want) => close(erfc(x), want, 1e-13));
  it.each(ERFC_NEG)("erfc(%s) = 2 − erfc(|x|)", (x, want) => close(erfc(x), want, 1e-14));
  it("handles the limits", () => {
    expect(erfc(Infinity)).toBe(0);
    expect(erfc(-Infinity)).toBe(2);
    expect(erfc(27)).toBe(0); // underflows below the smallest normal double
    expect(Number.isNaN(erfc(NaN))).toBe(true);
  });
  it("erf stays exported and consistent with erfc", () => {
    expect(erf(0)).toBe(0);
    close(erf(0.5), 0.5204998778130465, 1e-15);
    close(erf(3), 0.9999779095030014, 1e-15);
    for (const x of [0.05, 0.25, 0.46875, 0.6, 1.2]) {
      close(erf(x), 1 - erfc(x), 0, 1e-15);
      expect(erf(-x)).toBe(-erf(x));
    }
  });
});

describe("normal distribution", () => {
  it.each(NORM_SF)("normSf(%s) matches SciPy norm.sf to 1e-10", (z, want) => close(normSf(z), want, 1e-10));
  it.each(NORM_SF_FAR)("normSf(%s) keeps relative accuracy far out", (z, want) => close(normSf(z), want, 1e-12));
  it("normSf is symmetric and bounded", () => {
    close(normSf(-1), 1 - 0.15865525393145707, 1e-15);
    expect(normSf(Infinity)).toBe(0);
    expect(normSf(-Infinity)).toBe(1);
    expect(normSf(40)).toBe(0);
  });
  it("normCdf is branch-safe in both tails", () => {
    close(normCdf(-1), 0.15865525393145707, 1e-12);
    close(normCdf(-3), 0.0013498980316300933, 1e-12);
    close(normCdf(-6), 9.865876450376946e-10, 1e-12);
    close(normCdf(-8), 6.22096057427174e-16, 1e-12);
    close(normCdf(1.96), 1 - 0.024997895148220435, 1e-15);
    expect(normCdf(-5)).toBe(normSf(5));
    for (const z of [-3, -1, 0, 1, 3]) close(normCdf(z) + normSf(z), 1, 0, 1e-15);
  });
  it.each(NORM_PPF)("normPpf(%s) matches SciPy norm.ppf to 1e-12", (p, want) => close(normPpf(p), want, 1e-12));
  it("normPpf(0.5) is exactly zero and out-of-range inputs give NaN", () => {
    expect(normPpf(0.5)).toBe(0);
    expect(Number.isNaN(normPpf(0))).toBe(true);
    expect(Number.isNaN(normPpf(1))).toBe(true);
    expect(Number.isNaN(normPpf(-0.1))).toBe(true);
    expect(Number.isNaN(normPpf(NaN))).toBe(true);
  });
  it("normPpf round-trips through normSf / normCdf", () => {
    for (const p of [1e-10, 1e-6, 0.001, 0.025, 0.2, 0.45]) close(normSf(-normPpf(p)), p, 1e-12);
    for (const p of [0.3, 0.7, 0.975, 0.999]) close(normCdf(normPpf(p)), p, 1e-12);
  });
});

describe("chi-square and Student t survival functions", () => {
  it.each(CHI2_SF)("chi2Sf(%s, df=%s) matches SciPy to 1e-9", (x, df, want) => close(chi2Sf(x, df), want, 1e-9));
  it.each(T_SF2)("tSf2(%s, df=%s) matches 2·t.sf to 1e-9", (t, df, want) => close(tSf2(t, df), want, 1e-9));
});

describe("existing tests keep their semantics with better precision", () => {
  it("two-proportion z-test matches the hand calculation", () => {
    const r = twoProportionZ(1000, 10_000, 1100, 10_000);
    close(r.z, 2.3066347738170117, 1e-12);
    close(r.p, 0.021075189273797743, 1e-12);
    close(r.liftRel, 0.1, 0, 1e-12);
    expect(r.ciLow).toBeLessThan(0.01);
    expect(r.ciHigh).toBeGreaterThan(0.01);
    expect(r.significant).toBe(true);
    const flat = twoProportionZ(500, 5000, 500, 5000);
    expect(flat.z).toBe(0);
    close(flat.p, 1, 1e-15);
    expect(flat.significant).toBe(false);
  });
  it("Welch t-test from sufficient statistics matches SciPy", () => {
    const r = welch({ n: 1000, mean: 10, var: 4 }, { n: 1200, mean: 10.5, var: 4.5 });
    close(r.t, 5.679618342470649, 1e-12);
    close(r.df, 2164.840378094445, 1e-12);
    close(r.p, 1.5316770758272064e-8, 1e-9);
    expect(r.ciLow).toBeLessThan(0.5);
    expect(r.ciHigh).toBeGreaterThan(0.5);
    expect(r.significant).toBe(true);
  });
  it("sample sizes reproduce the textbook examples", () => {
    expect(sampleSizeProportion(0.1, 0.1)).toBe(14_751);
    expect(sampleSizeProportion(0.1, 0.2)).toBeLessThan(14_751);
    expect(sampleSizeProportion(0.1, 0.1, 0.05, 0.9)).toBeGreaterThan(14_751);
    expect(sampleSizeMean(1, 0.1)).toBe(1570);
  });
  it("SRM and Holm behave as in the Python package", () => {
    const fair = srm([100_000, 100_200]);
    expect(fair.mismatch).toBe(false);
    expect(fair.p).toBeGreaterThan(0.1);
    const skewed = srm([98_000, 102_000]);
    expect(skewed.mismatch).toBe(true);
    expect(skewed.p).toBeLessThan(1e-6);
    const three = srm([500, 250, 250], [0.5, 0.25, 0.25]);
    expect(three.chi2).toBe(0);
    expect(three.mismatch).toBe(false);
    expect(holm([0.01, 0.04, 0.03, 0.2])).toEqual([true, false, false, false]);
    expect(holm([0.001, 0.01, 0.02])).toEqual([true, true, true]);
  });
});

describe("delta-method relative lift", () => {
  it("relativeLiftProportions(1000/10000 vs 1100/10000) matches the reference", () => {
    const r = relativeLiftProportions(1000, 10_000, 1100, 10_000);
    close(r.lift, 0.1, 0, 1e-12);
    close(r.se, 0.045475268003608287, 1e-12);
    close(r.lo, 0.010870112525620937, 1e-12);
    close(r.hi, 0.1891298874743788, 1e-12);
  });
  it("is wider than the naive band that scales the absolute CI by the control rate", () => {
    const r = relativeLiftProportions(1000, 10_000, 1100, 10_000);
    const naive = [0.015040591315121192, 0.1849594086848788];
    expect(r.lo).toBeLessThan(naive[0]!);
    expect(r.hi).toBeGreaterThan(naive[1]!);
  });
  it("honours alpha", () => {
    const r = relativeLiftProportions(500, 20_000, 540, 21_000, 0.1);
    close(r.lift, 0.02857142857142847, 1e-12);
    close(r.se, 0.06302241722503428, 1e-12);
    close(r.lo, -0.07509122298041811, 1e-12);
    close(r.hi, 0.13223408012327503, 1e-12);
    const r95 = relativeLiftProportions(500, 20_000, 540, 21_000);
    expect(r95.hi - r95.lo).toBeGreaterThan(r.hi - r.lo);
  });
  it("relativeLiftMeans uses se = sqrt(var/n)", () => {
    const r = relativeLiftMeans({ n: 1000, mean: 10, var: 4 }, { n: 1200, mean: 10.5, var: 4.5 });
    close(r.lift, 0.05, 0, 1e-12);
    close(r.se, 0.00903327183250897, 1e-12);
    close(r.lo, 0.03229511254572233, 1e-12);
    close(r.hi, 0.06770488745427776, 1e-12);
  });
  it("relativeLiftCI is the shared kernel", () => {
    const pa = 0.1, pb = 0.11;
    const k = relativeLiftCI(pa, Math.sqrt((pa * (1 - pa)) / 10_000), pb, Math.sqrt((pb * (1 - pb)) / 10_000));
    const r = relativeLiftProportions(1000, 10_000, 1100, 10_000);
    close(k.lift, r.lift, 1e-14);
    close(k.se, r.se, 1e-14);
    close(k.lo, r.lo, 1e-14);
    close(k.hi, r.hi, 1e-14);
    expect(k.lo).toBeLessThan(k.lift);
    expect(k.hi).toBeGreaterThan(k.lift);
  });
  it("is undefined (NaN) when the control mean is zero", () => {
    const r = relativeLiftCI(0, 0.01, 0.1, 0.01);
    expect(Number.isNaN(r.lift)).toBe(true);
    expect(Number.isNaN(r.lo)).toBe(true);
    expect(Number.isNaN(r.hi)).toBe(true);
    expect(Number.isNaN(r.se)).toBe(true);
  });
});

describe("power at n and MDE at n", () => {
  it("powerProportion(0.1, 0.1, 14751) ≈ 0.8000055710998799", () => {
    close(powerProportion(0.1, 0.1, 14_751), 0.8000055710998799, 1e-12);
    close(powerProportion(0.1, 0.1, 5000), 0.3710889343229119, 1e-12);
    expect(powerProportion(0.1, 0.1, 20_000)).toBeGreaterThan(powerProportion(0.1, 0.1, 14_751));
  });
  it("powerProportion is the inverse of sampleSizeProportion (ceil boundary)", () => {
    for (const [b, m] of [[0.1, 0.1], [0.082, 0.04], [0.31, 0.03], [0.42, -0.03]] as const) {
      const n = sampleSizeProportion(b, m);
      expect(powerProportion(b, m, n)).toBeGreaterThanOrEqual(0.8);
      expect(powerProportion(b, m, n - 1)).toBeLessThan(0.8);
    }
  });
  it("powerMean is the inverse of sampleSizeMean", () => {
    close(powerMean(1, 0.1, 1570), 0.80005596726894, 1e-12);
    close(powerMean(640, 12.36, 30_000), 0.6573805178520801, 1e-12);
    expect(powerMean(1, 0.1, 1570)).toBeGreaterThanOrEqual(0.8);
    expect(powerMean(1, 0.1, 1569)).toBeLessThan(0.8);
  });
  it("mdeAtN(0.1, 14751) ≈ 0.10 and solves powerProportion = power", () => {
    const m = mdeAtN(0.1, 14_751);
    close(m, 0.1, 0, 1e-3);
    close(powerProportion(0.1, m, 14_751), 0.8, 0, 1e-9);
    for (const [b, mde] of [[0.082, 0.04], [0.31, 0.03]] as const) close(mdeAtN(b, sampleSizeProportion(b, mde)), mde, 0, 1e-3);
    expect(mdeAtN(0.1, 14_751, 0.05, 0.9)).toBeGreaterThan(m);
    expect(mdeAtN(0.1, 30_000)).toBeLessThan(m);
  });
  it("mdeAtNMean inverts sampleSizeMean and powerMean", () => {
    const m = mdeAtNMean(1, 1570);
    close(m, 0.1, 0, 1e-3);
    close(powerMean(1, m, 1570), 0.8, 0, 1e-12);
    expect(sampleSizeMean(1, m)).toBe(1570);
    close(mdeAtNMean(640, 30_000, 0.05, 0.8), (1.959963984540054 + 0.8416212335729143) * 640 * Math.sqrt(2 / 30_000), 1e-12);
    expect(mdeAtNMean(640, 60_000)).toBeLessThan(mdeAtNMean(640, 30_000));
  });
  it("returns NaN for impossible inputs", () => {
    expect(Number.isNaN(mdeAtN(0.1, 0))).toBe(true);
    expect(Number.isNaN(mdeAtN(1.5, 100))).toBe(true);
    expect(Number.isNaN(powerProportion(0.1, 0.1, 0))).toBe(true);
    expect(Number.isNaN(powerMean(0, 0.1, 100))).toBe(true);
    expect(Number.isNaN(mdeAtNMean(0, 100))).toBe(true);
    expect(Number.isNaN(mdeAtNMean(1, 0))).toBe(true);
  });
});

// ---------------- parity with the Python package (tests/fixtures/stats.json, generated by the Python side) ----------------
interface FixtureCase { fn: string; args: Record<string, unknown>; expected: Record<string, unknown> }
interface StatsFixture {
  tolerances: Record<string, number>;
  norm_sf: { z: number; sf: number }[];
  norm_ppf: { p: number; ppf: number }[];
  t_sf2: { t: number; df: number; p: number }[];
  t_ppf: { p: number; df: number; ppf: number }[];
  chi2_sf: { x: number; df: number; sf: number }[];
  cases: FixtureCase[];
}
const fixture = JSON.parse(readFileSync(new URL("../../tests/fixtures/stats.json", import.meta.url), "utf8")) as StatsFixture;
/** Relative tolerance for a function (and its p-value fields) as declared in the fixture's `tolerances` block. */
const tolOf = (fn: string, field?: string): number => (field === "p_value" ? fixture.tolerances.p_value : fixture.tolerances[fn]) ?? fixture.tolerances.default ?? 1e-9;

/** Numbers: |actual − expected| ≤ rel·|expected|, exact zeros must come back as |x| ≤ 1e-15; booleans must be identical. */
function expectFixture(actual: unknown, expected: unknown, rel: number, what: string): void {
  if (typeof expected === "boolean") {
    expect(actual, what).toBe(expected);
    return;
  }
  if (typeof expected !== "number") throw new Error(`${what}: unsupported expected value ${String(expected)}`);
  expect(typeof actual, `${what}: got ${String(actual)}`).toBe("number");
  const a = actual as number;
  if (expected === 0) expect(Math.abs(a), `${what}: got ${a}, want an exact zero`).toBeLessThanOrEqual(1e-15);
  else expect(Math.abs(a - expected), `${what}: got ${a}, want ${expected} (rel ${rel})`).toBeLessThanOrEqual(rel * Math.abs(expected));
}

type Flat = Record<string, number | boolean>;
const asNum = (x: unknown): number => { if (typeof x !== "number") throw new Error(`fixture: expected a number, got ${String(x)}`); return x; };
const asMeanStats = (x: unknown): MeanStats => { const o = x as Record<string, unknown>; return { n: asNum(o.n), mean: asNum(o.mean), var: asNum(o.var) }; };
const asSums = (x: unknown): Sums => { const o = x as Record<string, unknown>; return { n: asNum(o.n), sx: asNum(o.sx), sy: asNum(o.sy), sxx: asNum(o.sxx), syy: asNum(o.syy), sxy: asNum(o.sxy) }; };
const relFields = (r: RelCI): Flat => ({ lift_rel: r.lift, ci_low: r.lo, ci_high: r.hi, se: r.se });
/** Python result fields with no TypeScript counterpart: echoed inputs and values the TS API does not expose. */
const NOT_MIRRORED: Record<string, string[]> = {
  two_proportion_ztest: ["alpha"],
  welch_ttest_from_stats: ["mean_a", "mean_b", "alpha"],
  srm_check: ["observed"],
  cuped_from_sums: ["var_before", "var_after"],
  relative_lift_ci: ["alpha", "method"],
  relative_lift_proportions: ["alpha", "method"],
  relative_lift_means: ["alpha", "method"],
};
const FIXTURE_FUNCTIONS = Object.keys(NOT_MIRRORED).concat(["sample_size_proportion", "sample_size_mean", "power_proportion", "power_mean", "mde_at_n"]);

/** Calls the TypeScript twin of a Python function and returns its result under the Python field names. */
function runCase(c: FixtureCase): Flat {
  const a = c.args;
  switch (c.fn) {
    case "two_proportion_ztest": {
      const r = twoProportionZ(asNum(a.conv_a), asNum(a.n_a), asNum(a.conv_b), asNum(a.n_b), asNum(a.alpha));
      return { rate_a: r.rateA, rate_b: r.rateB, lift_abs: r.liftAbs, lift_rel: r.liftRel, z: r.z, p_value: r.p, ci_low: r.ciLow, ci_high: r.ciHigh, significant: r.significant };
    }
    case "welch_ttest_from_stats": {
      const r = welch(asMeanStats(a.a), asMeanStats(a.b), asNum(a.alpha));
      return { diff: r.diff, t: r.t, df: r.df, p_value: r.p, ci_low: r.ciLow, ci_high: r.ciHigh, significant: r.significant };
    }
    case "sample_size_proportion": return { value: sampleSizeProportion(asNum(a.baseline), asNum(a.mde_rel), asNum(a.alpha), asNum(a.power)) };
    case "sample_size_mean": return { value: sampleSizeMean(asNum(a.std), asNum(a.mde_abs), asNum(a.alpha), asNum(a.power)) };
    case "power_proportion": return { value: powerProportion(asNum(a.baseline), asNum(a.mde_rel), asNum(a.n_per_arm), asNum(a.alpha)) };
    case "power_mean": return { value: powerMean(asNum(a.std), asNum(a.mde_abs), asNum(a.n_per_arm), asNum(a.alpha)) };
    case "mde_at_n": return { value: mdeAtN(asNum(a.baseline), asNum(a.n_per_arm), asNum(a.alpha), asNum(a.power)) };
    case "srm_check": {
      const observed = (a.observed as unknown[]).map(asNum);
      const ratios = a.expected_ratios == null ? undefined : (a.expected_ratios as unknown[]).map(asNum);
      const r = srm(observed, ratios);
      const out: Flat = { chi2: r.chi2, p_value: r.p, mismatch: r.p < asNum(a.alpha) };
      r.expected.forEach((v, i) => { out[`expected[${i}]`] = v; });
      return out;
    }
    case "cuped_from_sums": {
      const r = cuped(asSums(a.a), asSums(a.b));
      return { theta: r.theta, variance_reduction: r.varianceReduction, "adj_a.n": r.adjA.n, "adj_a.mean": r.adjA.mean, "adj_a.var": r.adjA.var, "adj_b.n": r.adjB.n, "adj_b.mean": r.adjB.mean, "adj_b.var": r.adjB.var };
    }
    case "relative_lift_ci": return relFields(relativeLiftCI(asNum(a.mean_a), asNum(a.se_a), asNum(a.mean_b), asNum(a.se_b), asNum(a.alpha)));
    case "relative_lift_proportions": return relFields(relativeLiftProportions(asNum(a.conv_a), asNum(a.n_a), asNum(a.conv_b), asNum(a.n_b), asNum(a.alpha)));
    case "relative_lift_means": return relFields(relativeLiftMeans(asMeanStats(a.a), asMeanStats(a.b), asNum(a.alpha)));
    default: throw new Error(`no TypeScript twin for fixture function ${c.fn}`);
  }
}
/** Flattens nested expected values to "adj_a.mean" / "expected[0]" keys. */
function flatten(x: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) v.forEach((item, i) => { out[`${key}[${i}]`] = item; });
    else if (typeof v === "object" && v !== null) Object.assign(out, flatten(v as Record<string, unknown>, key));
    else out[key] = v;
  }
  return out;
}

describe("parity with the Python fixture (tests/fixtures/stats.json)", () => {
  it("the fixture covers every function family the TypeScript twin mirrors", () => {
    const fns = new Set(fixture.cases.map((c) => c.fn));
    for (const f of FIXTURE_FUNCTIONS) expect(fns.has(f), `fixture has cases for ${f}`).toBe(true);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(30);
    expect(fixture.norm_sf.length).toBeGreaterThanOrEqual(10);
    expect(fixture.norm_ppf.length).toBeGreaterThanOrEqual(10);
  });
  it.each(fixture.norm_sf.map((r): [number, number] => [r.z, r.sf]))("norm.sf(%s)", (z, sf) => expectFixture(normSf(z), sf, tolOf("norm_sf"), `norm_sf(${z})`));
  it.each(fixture.norm_ppf.map((r): [number, number] => [r.p, r.ppf]))("norm.ppf(%s)", (p, ppf) => expectFixture(normPpf(p), ppf, tolOf("norm_ppf"), `norm_ppf(${p})`));
  it.each(fixture.t_sf2.map((r): [number, number, number] => [r.t, r.df, r.p]))("2·t.sf(%s, df=%s)", (t, df, p) => expectFixture(tSf2(t, df), p, tolOf("t_sf2"), `t_sf2(${t}, ${df})`));
  it.each(fixture.t_ppf.map((r): [number, number, number] => [r.p, r.df, r.ppf]))("t.ppf(%s, df=%s)", (p, df, ppf) => expectFixture(tPpf(p, df), ppf, tolOf("t_ppf"), `t_ppf(${p}, ${df})`));
  it.each(fixture.chi2_sf.map((r): [number, number, number] => [r.x, r.df, r.sf]))("chi2.sf(%s, df=%s)", (x, df, sf) => expectFixture(chi2Sf(x, df), sf, tolOf("chi2_sf"), `chi2_sf(${x}, ${df})`));
  it.each(fixture.cases.map((c, i): [string, FixtureCase] => [`${c.fn} #${i + 1}`, c]))("%s", (_name, c) => {
    const got = runCase(c);
    const want = flatten(c.expected);
    const skip = new Set(NOT_MIRRORED[c.fn] ?? []);
    let compared = 0;
    for (const [key, value] of Object.entries(want)) {
      const top = key.split(/[.[]/)[0]!;
      if (skip.has(top)) continue;
      expect(key in got, `${c.fn}: field ${key} is not produced by the TypeScript twin`).toBe(true);
      expectFixture(got[key], value, tolOf(c.fn, top), `${c.fn}(${JSON.stringify(c.args)}).${key}`);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
    // srm(): the TS guardrail uses the fixed α = 0.001 of the Python default
    if (c.fn === "srm_check" && c.args.alpha === 0.001) expect(srm((c.args.observed as number[]), (c.args.expected_ratios as number[] | null) ?? undefined).mismatch).toBe(c.expected.mismatch);
  });
});
