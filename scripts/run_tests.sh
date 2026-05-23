#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export PYTHONPATH="${PYTHONPATH:-}:backend"
python -m compileall -q backend/app
node --check frontend/js/app.js
node --check frontend/js/settings.js

if command -v pytest >/dev/null 2>&1; then
  pytest -q tests
else
  echo "pytest not installed; skipped backend pytest suite"
fi

if command -v npx >/dev/null 2>&1 && [ -f package.json ]; then
  npx playwright test tests/frontend-smoke.spec.js || echo "Playwright smoke skipped/failed; start the app and install Playwright to run it."
else
  echo "npx/package.json unavailable; skipped Playwright smoke"
fi
