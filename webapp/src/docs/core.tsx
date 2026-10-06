import type { DocSection } from "./index";

/** The original methodology sections: tests, planning, guardrails, ranking, multiple comparisons. */
export const sections: DocSection[] = [
  {
    id: "ztest",
    title: "Two-proportion z-test",
    group: "tests",
    body: (
      <>
        <p>For conversion metrics we compare rates p̂A and p̂B with the pooled standard error for the test statistic and the unpooled (Wald) standard error for the confidence interval.</p>
        <pre className="formula">{"z = (p̂B − p̂A) / √( p̄(1−p̄)(1/nA + 1/nB) ),   p̄ = (xA + xB)/(nA + nB)\nCI = (p̂B − p̂A) ± z₁₋α/₂ · √( p̂A(1−p̂A)/nA + p̂B(1−p̂B)/nB )"}</pre>
        <p>Continuous metrics use Welch's t-test with the Welch–Satterthwaite degrees of freedom.</p>
      </>
    ),
  },
  {
    id: "multiple",
    title: "Multiple comparisons",
    group: "tests",
    body: <p>Testing several metrics or variants inflates the family-wise error rate. Holm's step-down procedure orders p-values and compares p(k) with α/(m − k + 1) — uniformly more powerful than Bonferroni at the same FWER.</p>,
  },
  {
    id: "power",
    title: "Sample size & power",
    group: "planning",
    body: (
      <>
        <p>Fix α, power and the minimum detectable effect <em>before</em> launch. For proportions:</p>
        <pre className="formula">{"n = ( z₁₋α/₂·√(2p̄q̄) + z_power·√(p₁q₁ + p₂q₂) )² / (p₂ − p₁)²"}</pre>
        <p>10% baseline, +10% relative lift, α = 0.05, power 0.8 → 14,751 users per arm. Halving the MDE quadruples the sample.</p>
      </>
    ),
  },
  {
    id: "srm",
    title: "Sample-ratio mismatch",
    group: "guardrails",
    body: (
      <>
        <p>If the split of users between arms differs from the intended ratio more than chance allows, the assignment or logging is broken and every metric is suspect. Chi-square goodness of fit at a strict α = 0.001:</p>
        <pre className="formula">{"χ² = Σ (observed − expected)² / expected,   df = arms − 1"}</pre>
        <p>At 200k users a 49/51 skew is detected 100% of the time with 0.10% false alarms (5,000 simulated splits each).</p>
      </>
    ),
  },
  {
    id: "cuped",
    title: "CUPED variance reduction",
    group: "guardrails",
    body: (
      <>
        <p>Controlled-experiment Using Pre-Experiment Data (Deng et al., 2013): subtract the part of the metric explained by a pre-period covariate X that is independent of treatment.</p>
        <pre className="formula">{"θ = cov(X, Y) / var(X),   Ỹ = Y − θ (X − X̄)\nvar(Ỹ) = var(Y)(1 − ρ²)"}</pre>
        <p>With ρ = 0.6 the variance drops 36.0% — our simulation saw power rise from 69.95% to 88.1% with the lift still unbiased (mean bias −0.0003 on a lift of 0.05).</p>
      </>
    ),
  },
  {
    id: "peeking",
    title: "Why you must not peek (with a fixed-horizon test)",
    group: "sequential",
    body: <p>Checking the p-value after every day and stopping at the first p &lt; 0.05 is a different test with a much higher false-positive rate. In our Monte-Carlo study (A/A data, 10 looks, 4,000 runs) it was <b>19.55%</b> instead of 5%. A Bonferroni α/looks per look brought it to 2.75% (over-conservative). Use the planned sample size, or the always-valid p-value described below.</p>,
  },
  {
    id: "ranking",
    title: "Ranking evaluation",
    group: "ranking",
    body: <p>Offline: NDCG@k = DCG@k / IDCG@k with DCG = Σ (2^rel − 1)/log₂(i + 1); MRR = mean of 1/rank of the first relevant item; P@k. Online: team-draft interleaving shows one merged list built by alternating picks and credits clicks to the ranker that picked the item — every session compares both rankers, so it needs fewer sessions than a traffic-split A/B test.</p>,
  },
];
