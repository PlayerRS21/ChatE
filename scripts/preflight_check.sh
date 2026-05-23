#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "[1/8] Python syntax"
python -m compileall -q backend/app
echo "[2/8] Frontend app syntax"
node --check frontend/js/app.js
echo "[3/8] Frontend settings syntax"
node --check frontend/js/settings.js
echo "[4/8] Backend test syntax"
python -m py_compile tests/test_backend_security.py
echo "[5/8] Playwright test syntax"
node --check tests/frontend-smoke.spec.js
echo "[6/8] Shell scripts"
bash -n scripts/run_tests.sh scripts/security_scan.sh scripts/run_fast_local.sh scripts/run_prod_local.sh scripts/share_cloudflare.sh
echo "[7/8] No changelog files"
if find . -iname '*changelog*' -print -quit | grep -q .; then
  echo "Changelog file found; remove it." >&2
  exit 1
fi
echo "[8/8] ZIP/path sanity"
python - <<'PY'
from pathlib import Path
required = [
    'backend/app/main.py', 'frontend/js/app.js', 'frontend/js/settings.js',
    'frontend/sw.js', 'frontend/manifest.webmanifest', '.env.example'
]
missing = [p for p in required if not Path(p).exists()]
if missing:
    raise SystemExit(f'Missing required files: {missing}')
print('Preflight OK')
PY
