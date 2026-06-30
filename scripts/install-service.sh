#!/usr/bin/env bash
# Install/update Samizdat as a PER-INSTANCE systemd service.
#
# Each checkout installs its own service `samizdat-<instance>` that runs THIS
# repo's binary with THIS repo's config.toml (own port + data_dir). So multiple
# checkouts run side-by-side (e.g. sam on :8765, sam2 on :8766) without clashing.
#
# Env:
#   INSTANCE=<name>   override instance name (default: basename of the repo dir)
#   FORCE=1           non-interactive; on conflict, install as a separate service
#   DRY_RUN=1         print the generated unit + chosen mode, touch nothing
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(id -un)"
HOME_DIR="$HOME"
INSTANCE="${INSTANCE:-$(basename "$REPO_ROOT")}"
TMPL="$REPO_ROOT/deploy/samizdat.service.tmpl"
BIN="$REPO_ROOT/server/bin/samizdat"
CFG="$REPO_ROOT/config.toml"
WEBDIR="$REPO_ROOT/app/dist"
EXTZIP_PATH="$REPO_ROOT/clipper/dist/sam-chrome.zip"
LEGACY_UNIT="/etc/systemd/system/samizdat.service"

SERVICE="samizdat-${INSTANCE}"
UNIT_DST="/etc/systemd/system/${SERVICE}.service"

port_of() { grep -E '^\s*port\s*=' "$1" 2>/dev/null | grep -oE '[0-9]+' | head -1; }
PORT="$([[ -f "$CFG" ]] && port_of "$CFG" || true)"; PORT="${PORT:-8765}"

# Which checkout owns the legacy global `samizdat.service` (if any)?
legacy_repo=""
if [[ -f "$LEGACY_UNIT" ]]; then
  binpath="$(systemctl cat samizdat.service 2>/dev/null | sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' | head -1)"
  binpath="$(readlink -f "$binpath" 2>/dev/null || true)"
  [[ -n "$binpath" ]] && legacy_repo="$(cd "$(dirname "$binpath")/../.." 2>/dev/null && pwd || true)"
fi

# Decide mode: takeover (repoint legacy samizdat.service) vs separate (samizdat-<instance>).
MODE="separate"
if [[ -f "$LEGACY_UNIT" && -n "$legacy_repo" && "$legacy_repo" != "$REPO_ROOT" ]]; then
  echo "⚠  The legacy 'samizdat' service is owned by a DIFFERENT checkout:"
  echo "     legacy owner: $legacy_repo"
  echo "     this checkout: $REPO_ROOT  (instance '$INSTANCE', port $PORT)"
  echo "   You can run both at once as separate services."
  if [[ "${FORCE:-}" == "1" ]]; then
    MODE="separate"; echo "   FORCE=1 → installing as a separate service 'samizdat-$INSTANCE'."
  elif [[ "${DRY_RUN:-}" == "1" ]]; then
    MODE="separate"; echo "   DRY_RUN: assuming [s] separate."
  else
    echo "     [t] take over the legacy 'samizdat' service with this checkout"
    echo "     [s] install this checkout as a SEPARATE service 'samizdat-$INSTANCE' (run both)"
    echo "     [a] abort"
    read -r -p "   Choose [t/s/a]: " ch
    case "$ch" in
      t|T) MODE="takeover" ;;
      s|S) MODE="separate" ;;
      *) echo "Aborted — nothing changed."; exit 1 ;;
    esac
  fi
fi
if [[ "$MODE" == "takeover" ]]; then
  SERVICE="samizdat"; UNIT_DST="$LEGACY_UNIT"
fi

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
  -e "s|@USER@|$USER_NAME|g" \
  -e "s|@HOME@|$HOME_DIR|g" \
  -e "s|@REPO@|$REPO_ROOT|g" \
  -e "s|@BIN@|$BIN|g" \
  -e "s|@CFG@|$CFG|g" \
  -e "s|@WEBDIR@|$WEBDIR|g" \
  -e "s|@EXTZIP@|$EXTZIP|g" \
  -e "s|@INSTANCE@|$INSTANCE|g" \
  "$TMPL")"

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "── DRY_RUN: would write $UNIT_DST (service '$SERVICE', port $PORT, mode $MODE) ──"
  echo "$unit"
  echo "── end (no changes made) ──"
  exit 0
fi

echo "→ Installing $UNIT_DST  (service '$SERVICE', port $PORT)"
echo "$unit" | sudo tee "$UNIT_DST" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null 2>&1 || true
sudo systemctl restart "$SERVICE"
sudo systemctl status "$SERVICE" --no-pager -l || true
echo "✓ '$SERVICE' running on port $PORT  (config: $CFG)"
echo "  Logs:    journalctl -u $SERVICE -f"
echo "  Stop:    sudo systemctl stop $SERVICE"
