import type { DocSection } from "./index";

/** Interleaving experiments: the exact binomial test, the preference interval and the Ranking lab's simulation model. */
export const sections: DocSection[] = [
  {
    id: "interleaving-test",
    title: "Interleaving test: exact binomial on decided sessions",
    group: "ranking",
    body: (
      <>
        <p>
          Each interleaved session ends with a winner (the ranker whose picks were clicked more) or a tie. A tie says nothing about which ranker is better, so only the <em>decided</em> sessions are tested. Under the
          null hypothesis that the rankers are equally good, every decided session is a fair coin flip, so the number of B wins among the decided sessions is Binomial(decided, ½):
        </p>
        <pre className="formula">{"H₀: π = ½,   X = winsB ~ Binomial(decided, ½),   decided = winsA + winsB\np = P(|X − decided/2| ≥ |winsB − decided/2|) = 2 · P(X ≤ min(winsA, winsB))     (exact; no normal approximation)"}</pre>
        <p>
          Why not a two-proportion z-test on the shares winsA/decided and winsB/decided? They are complementary shares of <em>one</em> sample, not two independent samples: their difference is 2(π̂ − ½), while
          the pooled two-sample standard error treats them as independent and is too small by √2 — the statistic is inflated by √2. For 100 vs 120 wins that formula reports p ≈ 0.057, almost "significant";
          the exact binomial p is 0.200. The Ranking lab and <code>abkit.ranking.interleaving_test</code> use the exact test, which SciPy computes as <code>binomtest(winsB, decided, 0.5)</code>.
        </p>
        <p>The effect size is the <b>preference</b> for B, (winsB − winsA)/decided = 2p̂ − 1 ∈ [−1, 1], with a Wilson score interval for p̂ mapped through 2p − 1:</p>
        <pre className="formula">{"p̂ = winsB/decided,   z = z₁₋α/₂\ncentre = (p̂ + z²/2n) / (1 + z²/n),   half = z·√( p̂(1−p̂)/n + z²/4n² ) / (1 + z²/n)\nCI(preference) = [ 2·(centre − half) − 1,  2·(centre + half) − 1 ]"}</pre>
        <p>
          100 vs 120 wins: preference +9.1% for B with 95% CI −4.1% to +22.0% — it covers 0, in line with p = 0.200. The Wilson interval never leaves [−1, 1] and keeps its coverage with few sessions or lopsided
          results, where the Wald interval fails. A ranker is declared the winner only when p &lt; α.
        </p>
      </>
    ),
  },
  {
    id: "interleaving-lab",
    title: "What the Ranking lab simulates",
    group: "ranking",
    body: (
      <>
        <p>
          You enter the relevance grade (0–3) of the document at each position for both rankers, up to 20 positions. Both rankers order one shared pool of documents whose grades are the better of the two lists at
          each rank, so each list is reproduced exactly when the two are permutations of each other (otherwise a position gets the nearest available grade). Every simulated session draws a fresh team-draft
          interleaving — a coin decides who picks first in each round — then the document at position p is clicked with probability (grade/3) · 0.7/√p, a simple position bias, and the session goes to the team
          with more clicks.
        </p>
        <p>
          The lab's state (both lists, k, the seed and the number of sessions) lives in the page URL, so a lab can be shared or bookmarked; "Re-roll sessions" advances the seed. The Python package has the same
          simulator, <code>simulate_interleaving_sessions</code>, with the identical model (different random streams).
        </p>
      </>
    ),
  },
];
