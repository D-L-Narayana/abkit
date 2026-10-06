import type { DocSection } from "./index";

/** Sequential testing: the mixture SPRT and its always-valid p-value (implemented in abkit/sequential.py and lib/sequential.ts). */
export const sections: DocSection[] = [
  {
    id: "msprt",
    title: "Always-valid p-values (mSPRT) — peeking made legal",
    group: "sequential",
    body: (
      <>
        <p>
          A fixed-horizon test answers one question at one moment: the planned sample size. Dashboards are read every day, so the app also computes a{" "}
          <em>mixture sequential probability ratio test</em> (mSPRT): a test whose false-positive rate stays below α no matter how often, or when, you look. Stopping at the
          first look with p<sub>k</sub> &lt; α is then a legitimate decision rule.
        </p>
        <p>
          At look k the observed difference δ̂<sub>k</sub> (rate B − rate A, or mean B − mean A) is treated as normal with its estimated variance V<sub>k</sub>. The null
          hypothesis is δ = 0. Instead of a single alternative, the alternative is <b>mixed over a normal prior</b> δ ~ N(0, τ²) — a bet on effects of roughly the size the
          experiment was designed for — which has a closed form:
        </p>
        <pre className="formula">{"δ̂ₖ ~ N(δ, Vₖ),   H₀: δ = 0,   H₁: δ ~ N(0, τ²)\n\nΛₖ = √( Vₖ / (Vₖ + τ²) ) · exp( δ̂ₖ² · τ² / ( 2 · Vₖ · (Vₖ + τ²) ) )\n\npₖ = min( 1, 1 / max_{j ≤ k} Λⱼ )"}</pre>
        <p>
          Λ<sub>k</sub> is the likelihood of the data under the mixed alternative divided by its likelihood under the null; it depends on δ̂<sub>k</sub>² only, so the
          test is two-sided. For conversion metrics V<sub>k</sub> = p̄(1 − p̄)(1/n<sub>A</sub> + 1/n<sub>B</sub>) with the pooled rate p̄ (the same null variance as the
          z-test); for continuous metrics V<sub>k</sub> = s²<sub>A</sub>/n<sub>A</sub> + s²<sub>B</sub>/n<sub>B</sub> (Welch), using the CUPED-adjusted statistics when a
          pre-period covariate is available. All inputs are cumulative — the running totals at each look, not the per-day increments.
        </p>
        <p>
          <b>Why it is valid.</b> Under the null, the sequence Λ<sub>1</sub>, Λ<sub>2</sub>, … is a non-negative martingale with expectation 1, so Ville's maximal inequality
          gives P(max<sub>k</sub> Λ<sub>k</sub> ≥ 1/α) ≤ α. Hence P(any p<sub>k</sub> &lt; α) ≤ α <em>for every stopping rule</em>, and p<sub>k</sub> = 1 / max Λ is
          non-increasing: evidence, once observed, is never un-observed. The classic per-look p-value has neither property, which is why peeking at it inflates false
          positives.
        </p>
        <p>
          <b>Choosing τ.</b> The test is most sensitive to effects of size about τ. We use the planned absolute minimum detectable effect, τ = |MDE<sub>abs</sub>| (for a
          conversion metric baseline × relative MDE, e.g. 10% × 10% = 0.01). A larger τ decides faster on big effects and slower on small ones; a smaller τ does the opposite.
          It is a documented heuristic, not an optimum, and you can pass τ explicitly in the Python package.
        </p>
        <p>
          <b>What it is for — and what it is not.</b> The guarantee is conservative: the realised false-positive rate sits below α rather than at it, so at the planned sample
          size the always-valid p has less power than the fixed-horizon test. Use it to <em>stop early</em> while an experiment is still collecting data (the app labels such
          a verdict "sequential"); once the planned sample size is reached, the fixed-horizon p-value and its confidence interval remain the final read. Sample-ratio
          mismatch invalidates both.
        </p>
        <p>
          <b>Evidence.</b> The Python test suite replays thousands of simulated A/A experiments with twenty looks each and checks that the any-look false-positive rate of the
          always-valid p-value stays within sampling error of α while the naive "stop at the first p &lt; 0.05" rule on the same data does not, and that power at an effect equal
          to τ reaches the planned level. For the numbers at scale, see the sequential-testing study in the simulation report (reports/simulation.json). The
          TypeScript twin used by this app is checked against the Python numbers to a relative tolerance of 10⁻¹².
        </p>
      </>
    ),
  },
];
