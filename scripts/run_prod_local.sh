#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/backend"
# Load project-root .env for shell-level checks and provider settings.
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
export CHATE_ENV="${CHATE_ENV:-production}"
if [ "${CHATE_SECRET_KEY:-CHANGE_ME_FOR_PRODUCTION}" = "CHANGE_ME_FOR_PRODUCTION" ]; then
  echo "Set CHATE_SECRET_KEY in .env before production-style run." >&2
  exit 1
fi
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers
