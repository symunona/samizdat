#!/usr/bin/env bash
# Preflight for `just install`: the install is GLOBAL (one /usr/local/bin/samizdat
# symlink + one systemd `samizdat` service + one data dir ~/.samizdat). If another
# checkout already owns it, installing here silently takes it over. Warn + confirm.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINK="/usr/local/bin/samizdat"

[[ -L "$LINK" ]] || exit 0  # nothing installed yet → no conflict

current="$(readlink -f "$LINK" 2>/dev/null || true)"
current_repo=""
[[ -n "$current" ]] && current_repo="$(cd "$(dirname "$current")/../.." 2>/dev/null && pwd || true)"

# Same checkout (or unresolvable) → fine, this is a normal update.
[[ -z "$current_repo" || "$current_repo" == "$REPO_ROOT" ]] && exit 0

echo "⚠  Samizdat is already installed from a DIFFERENT checkout:"
echo "     installed: $current_repo"
echo "     this repo: $REPO_ROOT"
echo "   The install is global — one /usr/local/bin/samizdat + one systemd 'samizdat'"
echo "   service + one data dir (~/.samizdat, port 8765). Installing here repoints all"
echo "   of that to THIS checkout."
if systemctl is-active --quiet samizdat 2>/dev/null; then
  echo "   The 'samizdat' service is ACTIVE and will be restarted onto this checkout's binary."
fi
echo "   (For a parallel dev env, use 'just dev' with a distinct port/data_dir instead of 'just install'.)"

if [[ "${FORCE:-}" == "1" ]]; then
  echo "   FORCE=1 set — proceeding."
  exit 0
fi
read -r -p "   Take over the install with THIS checkout? [y/N] " ans
case "$ans" in
  y|Y) ;;
  *) echo "Aborted — install unchanged. (Run from the intended checkout, or FORCE=1 to override.)"; exit 1 ;;
esac
