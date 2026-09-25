"""Offline and online evaluation of search rankers."""
from __future__ import annotations

import math
from typing import Hashable, Sequence

import numpy as np


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
