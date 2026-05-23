#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/backend"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. On Arch Linux run:" >&2
  echo "  sudo pacman -S --needed cloudflared" >&2
  exit 1
fi

if [ ! -d env ]; then
  python -m venv env
fi
source env/bin/activate

REQ_HASH="$(python - <<'PY'
from pathlib import Path
import hashlib
print(hashlib.sha256(Path('requirements.txt').read_bytes()).hexdigest())
PY
)"
STAMP="env/.requirements.sha256"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$REQ_HASH" ]; then
  python -m pip install -r requirements.txt
  printf '%s' "$REQ_HASH" > "$STAMP"
fi

python share.py "$@"
