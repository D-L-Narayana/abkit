#!/usr/bin/env sh
# Full local gate: the same checks as .github/workflows/ci.yml, in one portable POSIX-sh script.
#
#   sh scripts/check.sh                 # Python lint/types/tests/coverage, report sync, CLI smoke, archive check, web app unit tests, build, e2e
#   sh scripts/check.sh --python-only   # stop after the Python gate
#   sh scripts/check.sh --no-e2e        # skip the Playwright suite (needs `npx playwright install chromium` once)
#
# Prerequisites: `pip install -e ".[dev]"` and `npm --prefix webapp ci`.
set -eu
cd "$(dirname "$0")/.."

PYTHON_ONLY=0
RUN_E2E=1
for arg in "$@"; do
  case "$arg" in
    --python-only) PYTHON_ONLY=1 ;;
    --no-e2e) RUN_E2E=0 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "check.sh: unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() {
  printf '\n== %s\n' "$*"
  "$@"
}

quiet_step() {
  printf '\n== %s (stdout suppressed)\n' "$*"
  "$@" >/dev/null
}

step python3 -m ruff check abkit tests scripts
step python3 -m mypy abkit
step python3 -B -m pytest -q --cov=abkit --cov-fail-under=85
step python3 scripts/sync_report.py --check
step python3 -m abkit.cli --version
quiet_step python3 -m abkit.cli analyze tests/fixtures/csv/conversion_per_user.csv
QUICK_REPORT="${TMPDIR:-/tmp}/abkit-simulation-quick.json"
quiet_step python3 -m abkit.cli simulate --quick --out "$QUICK_REPORT"
step python3 scripts/check_archive.py

if [ "$PYTHON_ONLY" -eq 1 ]; then
  printf '\nPython gate passed.\n'
  exit 0
fi

step npm --prefix webapp run test
step npm --prefix webapp run build
if [ "$RUN_E2E" -eq 1 ]; then
  step npm --prefix webapp run e2e
fi
printf '\nAll checks passed.\n'
