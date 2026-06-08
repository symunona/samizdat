#!/usr/bin/env bash
# Milestone 1 · step 2 — install Samizdat as a systemd service.
# Requires a built binary: run `just build-server` first.
set -euo pipefail

BIN="${BIN:-server/bin/samizdat}"
PREFIX="${PREFIX:-/usr/local/bin}"
UNIT_SRC="deploy/samizdat.service"
UNIT_DST="/etc/systemd/system/samizdat.service"

if [[ ! -x "$BIN" ]]; then
  echo "✗ $BIN not found. The server isn't built yet." >&2
  echo "  Build it first: just build-server   (server/ is not implemented yet — see docs/server-auth-pairing.md)" >&2
  exit 1
fi

echo "→ Installing binary → $PREFIX/samizdat (sudo)"
sudo install -m 0755 "$BIN" "$PREFIX/samizdat"

echo "→ Installing unit → $UNIT_DST (sudo)"
sudo install -m 0644 "$UNIT_SRC" "$UNIT_DST"
sudo systemctl daemon-reload
sudo systemctl enable --now samizdat
sudo systemctl status samizdat --no-pager || true
echo "✓ samizdat service installed and started."
