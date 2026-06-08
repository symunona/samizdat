#!/usr/bin/env bash
# Install or update the Samizdat systemd service.
# Detects if already installed — if so, updates binary + web assets, then restarts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO_ROOT/deploy/samizdat.service"
UNIT_DST="/etc/systemd/system/samizdat.service"
SERVICE="samizdat"
DATA_DIR="${HOME}/.samizdat"
WEB_DST="$DATA_DIR/web"
WEB_SRC="$REPO_ROOT/app/dist"

# Copy web assets if built
if [[ -d "$WEB_SRC" ]]; then
  echo "→ Copying web assets → $WEB_DST"
  mkdir -p "$WEB_DST"
  cp -r "$WEB_SRC/." "$WEB_DST/"
else
  echo "  (no app/dist found — server will run API-only; run: just build-app-web)"
fi

# Write web_dir to config.toml so the server picks it up
CFG="$DATA_DIR/config.toml"
mkdir -p "$DATA_DIR"
if [[ -f "$CFG" ]]; then
  # Update or append web_dir under [server] section
  if grep -q 'web_dir' "$CFG"; then
    sed -i "s|web_dir.*|web_dir = \"$WEB_DST\"|" "$CFG"
  else
    printf '\n[server]\nweb_dir = "%s"\n' "$WEB_DST" >> "$CFG"
  fi
else
  cat > "$CFG" << EOF
data_dir = "$DATA_DIR"
vault_dir = "$HOME/samizdat"
db_path   = "$DATA_DIR/app.db"

[server]
port    = 8765
web_dir = "$WEB_DST"
EOF
fi

if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  echo "→ Service running — restarting with updated binary + assets"
  sudo systemctl restart "$SERVICE"
elif systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
  echo "→ Service exists but stopped — starting"
  sudo systemctl start "$SERVICE"
else
  echo "→ Installing unit → $UNIT_DST"
  sudo install -m 0644 "$UNIT_SRC" "$UNIT_DST"
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE"
fi

sudo systemctl status "$SERVICE" --no-pager -l || true
echo "✓ Done."
