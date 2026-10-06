import { Link } from "react-router-dom";
import type { DocSection } from "./index";

/** Effect sizes and planning: the delta-method relative-lift interval, power at a given n and the MDE a sample can detect. */
export const sections: DocSection[] = [
  {
    id: "delta-method",
    title: "Relative lift: delta-method confidence interval",
    group: "planning",
    body: (
      <>
        <p>
          Teams talk in relative terms (“+10% conversion”), but the test is computed on the absolute difference. Dividing the absolute interval by the control
          rate looks like a relative interval, yet it treats the control rate as a known constant. The control estimate has sampling error too, and the ratio
          R = μ̂B / μ̂A inherits it. The delta method (a first-order Taylor expansion of the ratio) propagates both errors:
        </p>
        <pre className="formula">{"R = μ̂B / μ̂A,   lift = R − 1\nVar(R) ≈ seB² / μ̂A²  +  μ̂B² · seA² / μ̂A⁴\nCI = lift ± z₁₋α/₂ · √Var(R)"}</pre>
        <p>
          For conversion rates se² = p̂(1 − p̂)/n per arm; for means se² = s²/n (CUPED-adjusted means and variances for continuous metrics). Example — A 1,000 of
          10,000, B 1,100 of 10,000: lift +10.0%, delta-method 95% CI [1.09%, 18.91%]. Scaling the absolute interval by p̂A gives [1.50%, 18.50%] instead — about 5%
          too narrow here, and increasingly so the smaller the control sample or the larger the lift. Every relative interval in this app (results pages, dashboard, exports and the{" "}
          <Link className="link" to="/calculator">z-test calculator</Link>) uses the delta method; the Python package exposes the same formula as <code>relative_lift_ci</code>,{" "}
          <code>relative_lift_proportions</code> and <code>relative_lift_means</code>.
        </p>
        <p>The interval is undefined when the control mean is zero (nothing to be relative to) and is symmetric on the lift scale, so for very small samples it can extend below −100%; read the absolute interval in those cases.</p>
      </>
    ),
  },
  {
    id: "power-at-n",
    title: "Power at a given sample size and the MDE a sample can detect",
    group: "planning",
    body: (
      <>
        <p>
          The sample-size formula answers “how many users do I need?”. Two inverse questions matter just as often: with the users you can actually get, how
          likely are you to detect the planned effect (power at n), and what is the smallest effect you could detect with the planned power (MDE at n)? Solving the
          two-proportion sample-size equation for power gives
        </p>
        <pre className="formula">{"power(n) = Φ( ( |p₂ − p₁| · √n  −  z₁₋α/₂ · √(2 p̄ q̄) ) / √(p₁q₁ + p₂q₂) ),   p₂ = p₁(1 + MDE)\nmeans:   power(n) = Φ( |δ| · √(n/2) / σ  −  z₁₋α/₂ )"}</pre>
        <p>
          10% baseline, +10% relative, α = 0.05: 14,751 users per arm give 80.0% power (the textbook plan). With 10,000 per arm power is 63.6%; with 7,000 it is
          48.8% — a coin flip; doubling the plan to 29,502 gives 97.7%. With zero true effect the formula returns α/2 = 2.5%, the chance of a “significant” result in the
          planned direction. MDE at n is found by bisection on the same function (the mean-metric version has the closed form δ = (z₁₋α/₂ + z_power)·σ·√(2/n)):
          at 10,000 per arm the smallest relative lift detectable with 80% power is 12.2%; at 5,000 it is 17.4%.
        </p>
        <p>
          Underpowered tests are not just likely to miss real effects: the effects they do flag are biased upwards, because only lucky draws clear the threshold.
          The <Link className="link" to="/calculator">calculator</Link> plots power against n for your plan, and the wizard shows the power your planned duration buys before you launch.
          Python: <code>power_proportion</code>, <code>power_mean</code>, <code>mde_at_n</code>.
        </p>
      </>
    ),
  },
];
