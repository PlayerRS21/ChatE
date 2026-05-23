#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export PYTHONPATH="${PYTHONPATH:-}:backend"

echo "[1/8] Python syntax"
python -m compileall -q backend/app

echo "[2/8] Frontend syntax"
node --check frontend/js/app.js
node --check frontend/js/settings.js

echo "[3/8] Backend tests"
if command -v pytest >/dev/null 2>&1; then pytest -q tests; else echo "pytest missing; skipped"; fi

echo "[4/8] Python security lint"
if command -v bandit >/dev/null 2>&1; then bandit -r backend/app; else echo "bandit missing; skipped"; fi

echo "[5/8] Python dependency audit"
if command -v pip-audit >/dev/null 2>&1; then pip-audit -r backend/requirements.txt; else echo "pip-audit missing; skipped"; fi

echo "[6/8] Semgrep rules"
if command -v semgrep >/dev/null 2>&1; then semgrep --config auto backend frontend; else echo "semgrep missing; skipped"; fi

echo "[7/8] npm audit"
if [ -f package-lock.json ]; then npm audit; else echo "package-lock.json missing; skipped"; fi

echo "[8/8] ZIP integrity placeholder"
echo "Run: unzip -tq <release>.zip"
