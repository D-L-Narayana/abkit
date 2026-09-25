import { useEffect, useState, type ReactNode } from "react";
import { Page } from "../components/ui";
import { useTitle } from "../theme";

const DOCS: { id: string; title: string; body: ReactNode }[] = [
  { id: "ztest", title: "Two-proportion z-test", body: <><p>For conversion metrics we compare rates p̂A and p̂B with the pooled standard error for the test statistic and the unpooled (Wald) standard error for the confidence interval.</p><pre className="formula">{"z = (p̂B − p̂A) / √( p̄(1−p̄)(1/nA + 1/nB) ),   p̄ = (xA + xB)/(nA + nB)\nCI = (p̂B − p̂A) ± z₁₋α/₂ · √( p̂A(1−p̂A)/nA + p̂B(1−p̂B)/nB )"}</pre><p>Continuous metrics use Welch's t-test with the Welch–Satterthwaite degrees of freedom.</p></> },
  { id: "power", title: "Sample size & power", body: <><p>Fix α, power and the minimum detectable effect <em>before</em> launch. For proportions:</p><pre className="formula">{"n = ( z₁₋α/₂·√(2p̄q̄) + z_power·√(p₁q₁ + p₂q₂) )² / (p₂ − p₁)²"}</pre><p>10% baseline, +10% relative lift, α = 0.05, power 0.8 → 14,751 users per arm. Halving the MDE quadruples the sample.</p></> },
  { id: "peeking", title: "Why you must not peek", body: <p>Checking the p-value after every day and stopping at the first p &lt; 0.05 is a different test with a much higher false-positive rate. In our Monte-Carlo study (A/A data, 10 looks) it was <b>19.1%</b> instead of 5%. A Bonferroni α/looks per look brought it to 2.6% (over-conservative). Use the planned sample size, or a proper sequential test (mSPRT / always-valid p-values).</p> },
  { id: "srm", title: "Sample-ratio mismatch", body: <><p>If the split of users between arms differs from the intended ratio more than chance allows, the assignment or logging is broken and every metric is suspect. Chi-square goodness of fit at a strict α = 0.001:</p><pre className="formula">{"χ² = Σ (observed − expected)² / expected,   df = arms − 1"}</pre><p>At 200k users a 49/51 skew is detected 100% of the time with 0.06% false alarms.</p></> },
  { id: "cuped", title: "CUPED variance reduction", body: <><p>Controlled-experiment Using Pre-Experiment Data (Deng et al., 2013): subtract the part of the metric explained by a pre-period covariate X that is independent of treatment.</p><pre className="formula">{"θ = cov(X, Y) / var(X),   Ỹ = Y − θ (X − X̄)\nvar(Ỹ) = var(Y)(1 − ρ²)"}</pre><p>With ρ = 0.6 the variance drops 36% — our simulation saw power rise from 70% to 88% with the lift still unbiased (bias 0.0003).</p></> },
  { id: "ranking", title: "Ranking evaluation", body: <p>Offline: NDCG@k = DCG@k / IDCG@k with DCG = Σ (2^rel − 1)/log₂(i + 1); MRR = mean of 1/rank of the first relevant item; P@k. Online: team-draft interleaving shows one merged list built by alternating picks and credits clicks to the ranker that picked the item — every session compares both rankers, so it needs fewer sessions than a traffic-split A/B test.</p> },
  { id: "multiple", title: "Multiple comparisons", body: <p>Testing several metrics or variants inflates the family-wise error rate. Holm's step-down procedure orders p-values and compares p(k) with α/(m − k + 1) — uniformly more powerful than Bonferroni at the same FWER.</p> },
];

export function Docs() {
  useTitle("Docs — abkit");
  const [active, setActive] = useState(DOCS[0]!.id);
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: "-20% 0px -60% 0px" });
    DOCS.forEach((d) => { const el = document.getElementById(d.id); if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, []);
  return (
    <Page eyebrow="Methodology" title="Docs" lede="The formulas behind every number in the app, with the Monte-Carlo evidence for the guardrails.">
      <div className="grid lg:grid-cols-[220px_1fr] gap-6">
        <nav className="hidden lg:grid sticky top-20 self-start text-sm gap-0.5" aria-label="Sections">
          {DOCS.map((d) => (
            <a key={d.id} href={`#${d.id}`} className="nav-link" aria-current={active === d.id ? "page" : undefined}>{d.title}</a>
          ))}
        </nav>
        <div className="grid gap-4">
          {DOCS.map((d, i) => (
            <section key={d.id} id={d.id} className={`card p-5 md:p-6 rise rise-d${Math.min(i, 3)} grid gap-3 leading-relaxed text-[15px] scroll-mt-20`} aria-labelledby={`${d.id}-h`}>
              <h2 id={`${d.id}-h`} className="text-lg">{d.title}</h2>
              {d.body}
            </section>
          ))}
          <p className="text-xs faint">Everything on this page is implemented in the <a className="link" href="https://github.com/D-L-Narayana/abkit" rel="noopener noreferrer" target="_blank">Python package</a> (with pytest checks against SciPy) and mirrored in TypeScript for this app.</p>
        </div>
      </div>
    </Page>
  );
}
