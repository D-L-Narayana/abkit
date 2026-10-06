"""Offline and online evaluation of search rankers."""
from __future__ import annotations

import math
from collections.abc import Hashable, Sequence
from dataclasses import asdict, dataclass
from typing import Any, cast

import numpy as np
from scipy import stats

#: Highest relevance grade used by the interleaving simulator (grades are integers 0..MAX_GRADE).
MAX_GRADE = 3


def dcg(relevances: Sequence[float]) -> float:
    """Discounted cumulative gain with the (2^rel - 1) / log2(rank + 1) formulation."""
    return float(sum((2**r - 1) / math.log2(i + 2) for i, r in enumerate(relevances)))


def ndcg_at_k(ranked_relevances: Sequence[float], k: int) -> float:
    """NDCG@k of a ranked list given the relevance grade at each position (0 when nothing is relevant)."""
    if k <= 0:
        raise ValueError("k must be >= 1")
    top = list(ranked_relevances)[:k]
    ideal = sorted(ranked_relevances, reverse=True)[:k]
    idcg = dcg(ideal)
    return dcg(top) / idcg if idcg > 0 else 0.0


def mean_ndcg_at_k(queries: Sequence[Sequence[float]], k: int) -> float:
    """Mean NDCG@k over queries (each query is the relevance grade at each ranked position); 0.0 for no queries."""
    if k <= 0:
        raise ValueError("k must be >= 1")
    if not queries:
        return 0.0
    return float(sum(ndcg_at_k(q, k) for q in queries) / len(queries))


def mrr(ranked_relevant_flags: Sequence[Sequence[bool]]) -> float:
    """Mean reciprocal rank over queries; each query is a list of booleans (relevant at position i)."""
    total = 0.0
    for flags in ranked_relevant_flags:
        for i, f in enumerate(flags):
            if f:
                total += 1 / (i + 1)
                break
    return total / len(ranked_relevant_flags) if ranked_relevant_flags else 0.0


def precision_at_k(ranked_relevant_flags: Sequence[bool], k: int) -> float:
    if k <= 0:
        raise ValueError("k must be >= 1")
    top = list(ranked_relevant_flags)[:k]
    return sum(1 for f in top if f) / k


def team_draft_interleave(rank_a: Sequence[Hashable], rank_b: Sequence[Hashable], rng: np.random.Generator | None = None) -> tuple[list[Hashable], list[str]]:
    """Team-draft interleaving (Radlinski, Kurup & Joachims, 2008).

    Two rankers "pick" alternately, like captains choosing teams: a coin decides who
    picks first in each round, each picks its highest-ranked item not yet in the
    result, and remembers which team it belongs to. Returns the interleaved list and
    the team label ("A"/"B") for each position. Credit clicks to teams to compare
    rankers online with far fewer sessions than an A/B test needs.
    """
    rng = rng or np.random.default_rng()
    result: list[Hashable] = []
    teams: list[str] = []
    seen: set[Hashable] = set()
    ia = ib = 0
    count_a = count_b = 0
    a, b = list(rank_a), list(rank_b)
    while ia < len(a) or ib < len(b):
        while ia < len(a) and a[ia] in seen:
            ia += 1
        while ib < len(b) and b[ib] in seen:
            ib += 1
        a_left, b_left = ia < len(a), ib < len(b)
        if not a_left and not b_left:
            break
        pick_a = a_left and (not b_left or count_a < count_b or (count_a == count_b and rng.random() < 0.5))
        if pick_a:
            item, ia, count_a = a[ia], ia + 1, count_a + 1
            teams.append("A")
        else:
            item, ib, count_b = b[ib], ib + 1, count_b + 1
            teams.append("B")
        result.append(item)
        seen.add(item)
    return result, teams


def interleaving_outcome(clicked_positions: Sequence[int], teams: Sequence[str]) -> str:
    """Winner of one interleaved session: the team with more clicked items ("A", "B" or "tie")."""
    ca = sum(1 for p in clicked_positions if teams[p] == "A")
    cb = sum(1 for p in clicked_positions if teams[p] == "B")
    return "A" if ca > cb else "B" if cb > ca else "tie"


# ----------------------------------------------------------------------------------------------------------------------
# Interleaving experiment: exact binomial test on decided sessions
# ----------------------------------------------------------------------------------------------------------------------


def _check_count(value: Any, name: str) -> int:
    """Non-negative integer (Python or NumPy) or ValueError."""
    if isinstance(value, bool) or not isinstance(value, int | np.integer) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer, got {value!r}")
    return int(value)


def _check_alpha(alpha: float) -> float:
    if not 0 < alpha < 1:
        raise ValueError("alpha must be in (0, 1)")
    return float(alpha)


@dataclass(frozen=True)
class InterleavingResult:
    """Outcome of an interleaving experiment.

    ``p_value`` is the exact two-sided binomial p-value of ``wins_b`` among the decided sessions (ties carry no
    information about which ranker is better and are excluded, but reported). ``preference`` is the share of decided
    sessions won by B minus the share won by A, i.e. (wins_b - wins_a) / decided = 2p̂ - 1, with ``ci_low``/``ci_high``
    the Wilson score interval for p̂ mapped through 2p - 1. ``winner`` is "B" or "A" when ``p_value < alpha``, else "tie".
    """

    wins_a: int
    wins_b: int
    ties: int
    p_value: float
    preference: float
    ci_low: float
    ci_high: float
    winner: str
    alpha: float

    @property
    def decided(self) -> int:
        """Sessions that produced a winner (ties excluded)."""
        return self.wins_a + self.wins_b

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def wilson_interval(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion k/n (Wilson, 1927).

        centre = (p̂ + z²/2n) / (1 + z²/n),   half-width = z·√( p̂(1−p̂)/n + z²/4n² ) / (1 + z²/n),   z = z₁₋α/₂

    Unlike the Wald interval it never leaves [0, 1] and keeps its coverage for small n or p̂ near 0 or 1.
    Returns (0, 1) when n == 0 (no information).
    """
    k, n, alpha = _check_count(k, "k"), _check_count(n, "n"), _check_alpha(alpha)
    if k > n:
        raise ValueError("k must not exceed n")
    if n == 0:
        return (0.0, 1.0)
    z = float(stats.norm.isf(alpha / 2))
    p_hat = k / n
    denom = 1 + z * z / n
    centre = (p_hat + z * z / (2 * n)) / denom
    half = z * math.sqrt(p_hat * (1 - p_hat) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def interleaving_test(wins_a: int, wins_b: int, ties: int = 0, alpha: float = 0.05) -> InterleavingResult:
    """Exact two-sided binomial test for an interleaving experiment.

    Every decided session is one Bernoulli trial "B wins" with unknown probability π; under H₀ (the rankers are
    equally good) π = ½, so the number of B wins among the ``decided = wins_a + wins_b`` sessions is Binomial(decided, ½)
    and the two-sided p-value is P(|X − decided/2| ≥ |wins_b − decided/2|) — computed exactly with
    ``scipy.stats.binomtest(wins_b, decided, 0.5)``, no normal approximation. Ties are excluded from the test.

    Do not test this with a two-proportion z-test on the complementary shares wins_a/decided and wins_b/decided: the two
    "samples" are the same sessions, the difference of complementary shares is 2(π̂ − ½) and the pooled two-sample standard
    error is too small by a factor √2, so that statistic is inflated by √2 (100 vs 120 wins: p ≈ 0.057 instead of the
    exact 0.200).
    """
    wins_a, wins_b, ties, alpha = _check_count(wins_a, "wins_a"), _check_count(wins_b, "wins_b"), _check_count(ties, "ties"), _check_alpha(alpha)
    decided = wins_a + wins_b
    if decided == 0:
        return InterleavingResult(wins_a, wins_b, ties, 1.0, 0.0, -1.0, 1.0, "tie", alpha)
    p_value = float(stats.binomtest(wins_b, decided, 0.5).pvalue)
    lo, hi = wilson_interval(wins_b, decided, alpha)
    preference = (wins_b - wins_a) / decided
    winner = ("B" if wins_b > wins_a else "A") if p_value < alpha else "tie"
    return InterleavingResult(wins_a, wins_b, ties, p_value, preference, 2 * lo - 1, 2 * hi - 1, winner, alpha)


# ----------------------------------------------------------------------------------------------------------------------
# Session simulator (the model behind the web app's Ranking lab)
# ----------------------------------------------------------------------------------------------------------------------


def _grades(rel: Sequence[int], name: str, n: int) -> list[int]:
    out: list[int] = []
    for g in rel:
        if isinstance(g, bool) or not isinstance(g, int | np.integer) or not 0 <= g <= MAX_GRADE:
            raise ValueError(f"{name} grades must be integers in 0..{MAX_GRADE}, got {g!r}")
        out.append(int(g))
    return out + [0] * (n - len(out))


def build_rankings(rel_a: Sequence[int], rel_b: Sequence[int]) -> tuple[list[int], list[int], list[int]]:
    """Turn two "relevance grade by position" lists into one document pool and each ranker's order over it.

    Both rankers rank the same documents. Document i (0-based) of the pool has grade ``grades[i]`` = the larger of the
    i-th best grade in ``rel_a`` and in ``rel_b``, so the pool is sorted by grade and can realise either list exactly when
    the two lists are permutations of each other. ``order_a[p]`` is the document ranker A shows at position p: the unused
    document whose grade is nearest to ``rel_a[p]`` (ties → the better document, i.e. the lowest index). The shorter list
    is padded with grade 0. Returns ``(grades, order_a, order_b)``.
    """
    n = max(len(rel_a), len(rel_b))
    a, b = _grades(rel_a, "rel_a", n), _grades(rel_b, "rel_b", n)
    grades = [max(x, y) for x, y in zip(sorted(a, reverse=True), sorted(b, reverse=True), strict=True)]

    def order(wanted: list[int]) -> list[int]:
        used = [False] * n
        out: list[int] = []
        for w in wanted:
            best = min((i for i in range(n) if not used[i]), key=lambda i: (abs(grades[i] - w), i))
            used[best] = True
            out.append(best)
        return out

    return grades, order(a), order(b)


def simulate_interleaving_sessions(rel_a: Sequence[int], rel_b: Sequence[int], sessions: int, rng: np.random.Generator, click_scale: float = 0.7) -> tuple[int, int, int]:
    """Simulate team-draft interleaving sessions with position-biased clicks; returns ``(wins_a, wins_b, ties)``.

    Model (the web app's Ranking lab uses the same one):

    * ``build_rankings(rel_a, rel_b)`` gives the shared document pool and both rankers' orders;
    * every session draws a fresh team-draft interleaving (coin flips from ``rng``), so no ranker keeps a fixed
      position advantage and two identical rankers stay at the null;
    * the document at 1-based position p is clicked with probability (grade / MAX_GRADE) · click_scale / √p;
    * the session goes to the team with more clicked documents; equal counts (including no clicks) are a tie.
    """
    sessions = _check_count(sessions, "sessions")
    if not 0 <= click_scale <= 1:
        raise ValueError("click_scale must be in [0, 1]")
    grades, order_a, order_b = build_rankings(rel_a, rel_b)
    discount = [click_scale / math.sqrt(p + 1) for p in range(len(grades))]
    wins_a = wins_b = ties = 0
    for _ in range(sessions):
        merged, teams = team_draft_interleave(order_a, order_b, rng)
        clicks_a = clicks_b = 0
        for pos, doc in enumerate(cast("list[int]", merged)):
            if rng.random() < grades[doc] / MAX_GRADE * discount[pos]:
                if teams[pos] == "A":
                    clicks_a += 1
                else:
                    clicks_b += 1
        if clicks_a > clicks_b:
            wins_a += 1
        elif clicks_b > clicks_a:
            wins_b += 1
        else:
            ties += 1
    return wins_a, wins_b, ties
