/** Scenario presets: named data-generating stories shared by the demo experiments and the wizard. */
import type { MetricType, SimOptions } from "../model";

export interface Scenario {
  id: string;
  name: string;
  description: string;
  /** Simulation options the preset fills in (true effect, days, bucketing skew, novelty decay, pre-period correlation). */
  options: SimOptions;
  /** Set when the story only makes sense for one metric type (e.g. CUPED needs a continuous metric). */
  metricType?: MetricType;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "real-effect",
    name: "Real effect",
    description: "The change genuinely lifts the metric by 5% relative — a typical minimum detectable effect. Run to the planned sample size and the fixed-horizon test calls a winner about as often as the planned power says.",
    options: { trueLiftRel: 0.05, days: 14 },
  },
  {
    id: "aa-test",
    name: "A/A test",
    description: "Both arms are identical. Any significant result is a false positive — at α = 0.05 about one run in twenty still crosses the line. Use it to check the pipeline and your own peeking habits.",
    options: { trueLiftRel: 0, days: 14 },
  },
  {
    id: "novelty-decay",
    name: "Novelty effect",
    description: "A strong early lift that fades day by day as users get used to the change. Early peeks look great while the cumulative estimate keeps shrinking towards zero.",
    options: { trueLiftRel: 0.06, days: 14, noveltyDecay: true },
  },
  {
    id: "bucketing-bug",
    name: "Bucketing bug (SRM)",
    description: "No true effect, but the allocation leaks 1.2 points of traffic from control to treatment. The sample-ratio-mismatch guardrail must flag the experiment as invalid before anyone reads a lift.",
    options: { trueLiftRel: 0, days: 8, srmSkew: 0.012 },
  },
  {
    id: "revenue-cuped",
    name: "Revenue with CUPED",
    description: "A continuous metric such as revenue per visitor, with a pre-period covariate correlated at ρ ≈ 0.6. CUPED removes that share of the variance and tightens the confidence interval at the same sample size.",
    options: { trueLiftRel: 0.035, days: 18, preCorrelation: 0.62 },
    metricType: "continuous",
  },
  {
    id: "loser",
    name: "Harmful change",
    description: "The change hurts the metric by a couple of percent. A sound process catches a loser as reliably as a winner — and ships neither on a lucky early peek.",
    options: { trueLiftRel: -0.02, days: 14 },
  },
];

export const findScenario = (id: string | undefined | null): Scenario | undefined => (id ? SCENARIOS.find((s) => s.id === id) : undefined);
