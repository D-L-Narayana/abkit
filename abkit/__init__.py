"""abkit — A/B-testing and ranking-evaluation toolkit."""
from .stats import (  # noqa: F401
    ZTestResult,
    TTestResult,
    SRMResult,
    CupedResult,
    two_proportion_ztest,
    welch_ttest,
    sample_size_proportion,
    sample_size_mean,
    srm_check,
    cuped,
    bonferroni,
    holm,
)
from .ranking import dcg, ndcg_at_k, mrr, precision_at_k, team_draft_interleave, interleaving_outcome  # noqa: F401

__version__ = "1.0.0"
