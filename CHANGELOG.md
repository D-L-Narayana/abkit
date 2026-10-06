# Changelog

All notable changes to abkit (Python package and web app) are documented here.

## 1.1.0

### Statistics (Python `abkit` and the TypeScript twin in `webapp/src`)
- Delta-method confidence intervals for the **relative** lift (`relative_lift_proportions`, `relative_lift_means`, `relative_lift_ci`),
  which include the control arm's own sampling error; the results page, the calculators, the CLI and the static calculator now show them
  next to the absolute interval. `ratio_metric_delta` applies the same method to ratio metrics such as revenue per booking.
- Power in both directions: `power_proportion`, `power_mean` and `mde_at_n` invert the sample-size formulas (a bracket + bisection solve for
  the MDE); the wizard shows the power you will reach at your planned number of days, the calculators plot power against n.
- Sufficient statistics: `MeanStats` and `Sums` dataclasses, `welch_ttest_from_stats` and `cuped_from_sums` (an exact twin of the array
  version), so aggregated data and the web app's daily sums can be analysed without raw rows. `two_proportion_ztest` accepts
  `alternative="larger" | "smaller"`.
- New module `abkit.sequential`: mixture sequential probability ratio test (mSPRT) with always-valid p-values
  (`msprt_proportions`, `msprt_means`, `mixture_likelihood_ratio`, `always_valid_p`, `tau_from_mde`). The web app computes the series
  for every experiment and labels a verdict "sequential" when it is based on the always-valid p-value before the planned sample is reached.
- Ranking: `interleaving_test` replaces the old two-proportion z-test on complementary win shares (which overstated significance by a factor
  √2 in the statistic) with the exact two-sided binomial test on decided sessions plus a Wilson interval for the preference 2p̂ − 1;
  `wilson_interval`, `mean_ndcg_at_k`, `build_rankings` and `simulate_interleaving_sessions` added. The Ranking lab uses the exact test.
- The TypeScript twin gained a Cody rational-Chebyshev `erfc`, an Acklam + Halley-step inverse normal and a χ²₁ survival function, and is
  checked against SciPy-generated fixtures shared with the Python tests (`tests/fixtures/*.json`).

### Web app
- Dashboard: search, status / metric-type filters, tag chips and sorting (all in the URL); stop / resume / complete / duplicate / delete with
  undo; export-all / import-all JSON; versioned local-storage store (v2) with automatic migration from v1 and a quarantine for records that
  fail validation (downloadable, never dropped).
- Wizard: scenario presets, notes, allocation skew / novelty decay / pre-period correlation settings, draft persistence across reloads,
  `/new?from=<id>` prefill. The continuous-metric simulation now draws daily sufficient statistics from the exact sampling distribution
  (Cholesky means, Wishart/Bartlett covariance): previously a 400-draw sample was scaled up, so the day-level estimates carried far more
  noise than their confidence intervals claimed and an A/A revenue experiment was "significant" in about 74 % of seeded runs; the
  conversion demos are unchanged bit for bit.
- Results: decision basis, delta-method relative CI, always-valid p-value and the day it crossed α, sequential-monitoring plot, exports
  (lossless CSV, JSON, Markdown summary, print), share links v2 (`"2."` + base64url(deflate-raw(compact JSON)) — a three-week conversion
  experiment is about 860 characters instead of 5,350; v1 links keep decoding), read-only shared view with "save to my experiments".
- Calculators: sample size for conversion and continuous metrics, power at n / MDE at n with a power curve, z-test with both intervals,
  SRM; all inputs in the URL with a copy-link button.
- Upload: per-user and aggregated CSV layouts, RFC-4180 parsing (quotes, embedded newlines, `;`/tab delimiters, CRLF, BOM, decimal comma),
  arm-label rules with an explicit control label override, preview before saving, skipped rows listed by line number; the same formats are
  read by `abkit analyze`.
- Docs page rebuilt from a registry of topic modules (hypothesis tests, planning & power, guardrails & variance, sequential testing,
  ranking evaluation, data & sharing); the sticky table of contents lets long section titles wrap and scrolls when it is taller than
  the viewport.
- Accessibility and robustness: focus moves to the page content on client-side navigation and the new page is announced to screen readers;
  numeric fields are plain text inputs whose validation message is linked through `aria-describedby`; a route-level error boundary shows a
  recoverable card (retry, copy details, back to the list) instead of a blank app.
- Fonts are self-hosted (`@fontsource-variable` Geist and JetBrains Mono); the theme is applied before first paint by an external script.
- Contrast: the light-theme secondary text token (`--ink-3`) was darkened so small text meets 4.5:1 on the tinted surfaces (`--bg-2`,
  `--bg-3`), not only on white cards; filter counts no longer rely on opacity; formula blocks in the docs wrap instead of becoming horizontal
  scroll regions (both were reported by the axe-core audit of the production bundle).

### Data import / export
- `webapp/src/lib/csv.ts` (`parseCsvText`, `toCsv`, `toJson`, `fromJson`), `webapp/src/lib/share.ts` (`encodeShare`, `decodeShare`) and the
  Python twin `abkit.data` (`read_csv`, `parse_csv_text`, `analyze`) share one set of CSV fixtures (`tests/fixtures/csv/`) with a
  Python-generated `expected.json` that the TypeScript tests and the browser tests assert against.

### Command-line interface
- New subcommands `ttest`, `power` (`--solve-mde`), `holm`, `interleave`, `ndcg`, `analyze`; `samplesize --metric mean --std`;
  `simulate --scale F --out PATH --seed N`; `--version`. Every command prints JSON; invalid input prints one line on stderr and exits 2.

### Simulation report
- Two new studies: legal peeking with the always-valid p-value (study 7) and coverage of the relative-lift interval, delta method versus the
  naive "absolute CI ÷ control rate" (study 8). Both draw from `default_rng(seed + 1)` so studies 1–6 consume the random stream exactly
  as in 1.0.
- `reports/simulation.json` was regenerated. The report committed with 1.0 had been produced with other settings for the interleaving study
  (300 runs capped at 4,000 sessions, versus the code's 200 runs capped at 3,000), so its peeking, SRM and interleaving rows did not
  reproduce from the code; the README, the docs page and `web/index.html` (via `scripts/sync_report.py`) now quote the regenerated file.

### Deployment, verification and tooling
- `vercel.json` (repository root) serves `webapp/dist` as a static SPA with a strict Content-Security-Policy (`script-src 'self'`, no inline
  scripts, no third-party origins), `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, HSTS and
  `Cross-Origin-Opener-Policy`; compiled assets are cached as immutable. The stale `webapp/vercel.json` was removed. Vite no longer inlines
  small assets, so no font is embedded as a `data:` URL that `font-src 'self'` would refuse.
- Playwright suite (`npm run e2e`): the production bundle is served by `webapp/e2e/serve-dist.mjs` with the headers and rewrites read from
  `vercel.json`; every application-flow test fails on `securitypolicyviolation` events, console refusals, failed or foreign-origin requests;
  `headers.spec.ts` asserts the exact header values on the shell, scripts, stylesheets and fonts; desktop and phone projects; an axe-core
  audit (WCAG 2.2 AA) runs in a separately named project that bypasses the policy only for the axe instrumentation.
- Vitest suites for every library module, fixture-driven parity with the Python package, `pyproject.toml` with ruff/mypy/pytest settings,
  a CI workflow (Python 3.10 and 3.12 plus the web app), `scripts/check.sh` as the local full gate and `scripts/sync_report.py --check`.
- Package exports every public function from `abkit/__init__.py`; version 1.1.0.
- Packaging: the source distribution now carries `tests/fixtures/**` (`MANIFEST.in`), so the complete test suite runs from the extracted
  sdist — the first 1.1.0 candidate shipped the test modules without their fixtures and failed collection. A packaging regression test
  (`tests/test_packaging.py`) builds both archives and asserts their contents, and `scripts/check_archive.py` (run by `scripts/check.sh`
  and CI) builds a fresh sdist and wheel, lists their members, runs the full suite from the extracted sdist with an assertion that the
  archive's own package is imported, and exercises the extracted wheel's CLI.

## 1.0.0

- Initial release: z-test, Welch t-test, sample size, SRM, CUPED, Holm/Bonferroni, NDCG/MRR/P@k, team-draft interleaving,
  Monte-Carlo validation studies, CLI, static calculator and the React experimentation web app.
