# abkit — experimentation & ranking-evaluation toolkit

[![CI](https://github.com/D-L-Narayana/abkit/actions/workflows/ci.yml/badge.svg)](https://github.com/D-L-Narayana/abkit/actions/workflows/ci.yml)
[![Calculator](https://img.shields.io/badge/live%20calculator-abkit.vercel.app-134e4a)](https://abkit.vercel.app)
![python](https://img.shields.io/badge/python-3.10%2B-3776ab?logo=python&logoColor=white)
![tests](https://img.shields.io/badge/pytest-9%20passing-blue)
[![MIT](https://img.shields.io/badge/license-MIT-black)](LICENSE)

Small, explicit, unit-tested implementations of the statistics an online-travel experimentation platform runs every day,
plus Monte-Carlo studies that check they behave as advertised. Python package + CLI; the core calculators are also
available as a dependency-free web page at **[abkit.vercel.app](https://abkit.vercel.app)**.

> Most product changes at large travel marketplaces ship behind an A/B test, and search changes are judged with offline
> ranking metrics and online interleaving. abkit is my working notebook for those tools — every formula is readable,
> checked against SciPy/textbook values and stress-tested by simulation.

## What's inside

| Module | Functions | Notes |
| --- | --- | --- |
| `abkit.stats` | `two_proportion_ztest`, `welch_ttest` | pooled-SE z statistic + Wald CI; Welch–Satterthwaite df |
| | `sample_size_proportion`, `sample_size_mean` | classic power formulas (10 % baseline, +10 % rel, α 0.05, power 0.8 → **14,751 / arm**) |
| | `srm_check` | sample-ratio-mismatch chi-square guardrail at α = 0.001 |
| | `cuped` | CUPED variance reduction (Deng et al., 2013) with a shared θ so the lift stays unbiased |
| | `bonferroni`, `holm` | family-wise error control for multi-metric / multi-variant tests |
| `abkit.ranking` | `dcg`, `ndcg_at_k`, `mrr`, `precision_at_k` | offline ranking metrics |
| | `team_draft_interleave`, `interleaving_outcome` | team-draft interleaving (Radlinski, Kurup & Joachims, 2008) for online ranker comparison |
| `abkit.simulate` | six Monte-Carlo studies | writes `reports/simulation.json` |
| `abkit.cli` | `abkit ztest \| samplesize \| samplesize-mean \| srm \| simulate` | |
| `web/index.html` | z-test, sample size, SRM in vanilla JS | Acklam inverse-normal, regularised incomplete gamma for χ² |

## Install & use

```bash
git clone https://github.com/D-L-Narayana/abkit.git && cd abkit
pip install -e ".[dev]"        # numpy, scipy, pytest
pytest -q                      # 9 tests

abkit ztest 1000 10000 1100 10000      # control: 1000/10000, treatment: 1100/10000
abkit samplesize 0.10 0.05             # visitors per arm for a +5 % relative lift on a 10 % baseline
abkit srm 100000 101200                # is a 100,000 / 101,200 split suspicious?  (yes: p ≈ 0.008 — borderline, watch it)
abkit simulate --quick                 # Monte-Carlo studies (full run: `abkit simulate`, ~10 min)
```

```python
from abkit import two_proportion_ztest, sample_size_proportion, cuped, ndcg_at_k

r = two_proportion_ztest(conv_a=1000, n_a=10_000, conv_b=1100, n_b=10_000)
r.lift_rel, r.p_value, (r.ci_low, r.ci_high)      # (0.10, 0.021, (0.0015, 0.0185))
sample_size_proportion(baseline=0.10, mde_rel=0.10)   # 14751
ndcg_at_k([3, 2, 0, 1], k=3)                          # 1.0 = ideal order
```

## Methodology, validated by simulation

`abkit simulate` (seed 2026) answers six questions an experimentation team argues about. Numbers from
[`reports/simulation.json`](reports/simulation.json):

| Question | Result | Reading |
| --- | --- | --- |
| **A/A tests** — does the z-test reject 5 % of the time when nothing changed? (20k sims, 20k users/arm) | **5.02 %** false positives | Calibrated to the nominal α. |
| **Power** — does `sample_size_proportion` deliver 80 % power at +10 % rel. lift on a 10 % baseline? | 14,751/arm → **80.3 %** power | The planning formula keeps its promise. |
| **Peeking** — look after each of 10 equal chunks, stop at the first p < 0.05 (A/A data) | **19.1 %** false positives; 2.6 % with α/looks per look | Optional stopping ~4× the error rate; per-look Bonferroni over-corrects — fix the sample size up front or use a sequential test. |
| **CUPED** — variance removed by a pre-period covariate with ρ = 0.6; is the lift still unbiased? | **36.0 %** less variance (theory ρ² = 36 %); power **70 % → 88 %**; bias 0.0003 | Free power from data you already have. |
| **SRM** — does the guardrail catch a 49/51 bucketing bug at 200k users? | **100 %** detected, 0.06 % false alarms (α = 0.001) | Cheap and reliable; run it on every experiment. |
| **Interleaving vs A/B** — sessions to identify the better of two rankers at p < 0.05 | median **1,173** (interleaving) vs **1,370** (A/B) | Interleaving decides faster because every user sees both rankers; the gain depends on the click model. |

All data is synthetic; the studies validate the *statistics*, not any product.

## Tests

`pytest -q` — z-test against a hand calculation, Welch against `scipy.stats.ttest_ind`, the 14.7k textbook sample size,
SRM on fair vs skewed splits, CUPED θ ≈ ρ and variance reduction ≈ ρ² with an unbiased lift, Holm/Bonferroni, NDCG/MRR/P@k
edge cases, and interleaving fairness (every item exactly once, teams balanced, coin-flip first pick).

## Layout

```
abkit/stats.py      tests, planning, guardrails, CUPED, corrections
abkit/ranking.py    NDCG, MRR, P@k, team-draft interleaving
abkit/simulate.py   Monte-Carlo studies -> reports/simulation.json
abkit/cli.py        command-line interface
tests/              pytest
web/index.html      static calculator (deployed to Vercel)
```

## Roadmap

- Sequential testing (mSPRT / always-valid p-values) so peeking becomes legal
- Bootstrap CIs for ratio metrics (revenue per booking) and delta-method variance
- Stratified sampling and variance-reduced interleaving credit

## License

MIT © D L Narayana
