#!/usr/bin/env bash
# Install/update Samizdat as a PER-INSTANCE *user* systemd service.
#
# Runs under `systemctl --user` (~/.config/systemd/user/) so restarts need no
# sudo. Lingering keeps it alive across logout/reboot. Each checkout installs its
# own service `samizdat-<instance>` running THIS repo's binary + config.toml
# (own port + data_dir), so multiple checkouts run side-by-side.
#
# Env:
#   INSTANCE=<name>   override instance name (default: basename of the repo dir)
#   DRY_RUN=1         print the generated unit + chosen path, touch nothing
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(id -un)"
INSTANCE="${INSTANCE:-$(basename "$REPO_ROOT")}"
TMPL="$REPO_ROOT/deploy/samizdat.service.tmpl"
BIN="$REPO_ROOT/server/bin/samizdat"
CFG="$REPO_ROOT/config.toml"
WEBDIR="$REPO_ROOT/app/dist"
EXTZIP_PATH="$REPO_ROOT/clipper/dist/sam-chrome.zip"

SERVICE="samizdat-${INSTANCE}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_DST="$UNIT_DIR/${SERVICE}.service"
LEGACY_SYS_UNIT="/etc/systemd/system/${SERVICE}.service"

port_of() { grep -E '^\s*port\s*=' "$1" 2>/dev/null | grep -oE '[0-9]+' | head -1; }
PORT="$([[ -f "$CFG" ]] && port_of "$CFG" || true)"; PORT="${PORT:-8765}"

if [[ ! -d "$WEBDIR" ]]; then
  echo "  (no app/dist — run 'just build-app-web'; service will run API-only until then)"
fi

# Serve the browser extension zip if it's been built (just build-clipper).
EXTZIP=""
if [[ -f "$EXTZIP_PATH" ]]; then
  EXTZIP=" --extension-zip $EXTZIP_PATH"
else
  echo "  (no clipper/dist/sam-chrome.zip — run 'just build-clipper'; extension download disabled)"
fi

# Render the unit from the template.
unit="$(sed \
  -e "s|@REPO@|$REPO_ROOT|g" \
  -e "s|@BIN@|$BIN|g" \
  -e "s|@CFG@|$CFG|g" \
  -e "s|@WEBDIR@|$WEBDIR|g" \
  -e "s|@EXTZIP@|$EXTZIP|g" \
  -e "s|@INSTANCE@|$INSTANCE|g" \
  "$TMPL")"

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "── DRY_RUN: would write $UNIT_DST (user service '$SERVICE', port $PORT) ──"
  echo "$unit"
  echo "── end (no changes made) ──"
  exit 0
fi

# A leftover system unit from the old (sudo) layout would clash on the port.
# Removing it needs root, so we can't do it here — guide the user, then stop.
if [[ -f "$LEGACY_SYS_UNIT" ]]; then
  echo "✗ A system service '$SERVICE' still exists at $LEGACY_SYS_UNIT."
  echo "  Remove it once (root-owned) so the user service can take the port:"
  echo "    sudo systemctl disable --now $SERVICE && sudo rm $LEGACY_SYS_UNIT && sudo systemctl daemon-reload"
  echo "  Then re-run: just install"
  exit 1
fi

# Ensure the user manager survives logout/reboot.
if [[ "$(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "→ Enabling lingering (may prompt once) so the service runs without a login session"
  loginctl enable-linger "$USER_NAME" || sudo loginctl enable-linger "$USER_NAME" || true
fi

mkdir -p "$UNIT_DIR"
echo "→ Installing $UNIT_DST  (user service '$SERVICE', port $PORT)"
echo "$unit" > "$UNIT_DST"
systemctl --user daemon-reload
systemctl --user enable "$SERVICE" >/dev/null 2>&1 || true
systemctl --user restart "$SERVICE"
systemctl --user status "$SERVICE" --no-pager -l || true
echo "✓ '$SERVICE' running on port $PORT  (config: $CFG)"
echo "  Logs:    journalctl --user -u $SERVICE -f"
echo "  Restart: systemctl --user restart $SERVICE   (no sudo)"
echo "  Stop:    systemctl --user stop $SERVICE"
