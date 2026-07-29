#!/usr/bin/env bash
# Post-build gate for an Android APK, run by `just build-android*` (local + remote).
#
# The check that matters most is the SIGNER CERT: `app/android` is gitignored, so
# `debug.keystore` never travels with the source. If a build host mints its own,
# the APK installs fine on a clean phone but Android silently REFUSES the
# install-over on a phone carrying the other host's build. Comparing the signer
# against the previous APK is the only cheap way to catch that before the phone does.
#
# Usage: tools/verify-apk.sh <apk> [--against <old-apk>] [--sidecar <json>] [--served <url>]
set -euo pipefail

APK=""; AGAINST=""; SIDECAR=""; SERVED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --against) AGAINST="$2"; shift 2 ;;
    --sidecar) SIDECAR="$2"; shift 2 ;;
    --served)  SERVED="$2";  shift 2 ;;
    -h|--help) sed -n '1,12p' "$0"; exit 0 ;;
    *) APK="$1"; shift ;;
  esac
done
[ -n "$APK" ] && [ -f "$APK" ] || { echo "usage: $0 <apk> [--against <old-apk>] [--sidecar <json>] [--served <url>]"; exit 2; }
: "${SIDECAR:=${APK}.json}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"

# Newest build-tools that actually carries both tools we need.
BT=""
for d in $(ls -1 "$ANDROID_HOME/build-tools" 2>/dev/null | sort -Vr); do
  if [ -x "$ANDROID_HOME/build-tools/$d/apksigner" ] && [ -x "$ANDROID_HOME/build-tools/$d/aapt2" ]; then
    BT="$ANDROID_HOME/build-tools/$d"; break
  fi
done
[ -n "$BT" ] || { echo "✗ no build-tools with apksigner+aapt2 under $ANDROID_HOME/build-tools"; exit 2; }

FAIL=0
ok()   { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; FAIL=1; }
warn() { printf '  ⚠ %s\n' "$1"; }

# JSON field reader (node is a hard dep of this repo; jq is not).
jsonf() { node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>(o??{})[k],j);process.stdout.write(v===undefined||v===null?"":String(v))' "$1" "$2"; }
signer() { "$BT/apksigner" verify --print-certs "$1" 2>/dev/null | sed -n 's/^Signer #1 certificate SHA-256 digest: //p'; }

echo "── verify $(basename "$APK") ──"

WANT_VERSION="$(jsonf "$REPO/app/app.json" expo.version)"
WANT_CODE="$(jsonf "$REPO/app/app.json" expo.android.versionCode)"
WANT_EPOCH="$(jsonf "$REPO/app/app.json" expo.extra.buildEpoch)"

# 1 — signer identity vs the previous APK (the install-over guard).
NEW_SIGNER="$(signer "$APK")"
[ -n "$NEW_SIGNER" ] || bad "apksigner could not read a signer cert"
if [ -n "$AGAINST" ] && [ -f "$AGAINST" ]; then
  OLD_SIGNER="$(signer "$AGAINST")"
  if [ "$NEW_SIGNER" = "$OLD_SIGNER" ]; then
    ok "signer cert unchanged (${NEW_SIGNER:0:16}…) — installs over $(basename "$AGAINST")"
  else
    bad "SIGNER CERT CHANGED — ${OLD_SIGNER:0:16}… → ${NEW_SIGNER:0:16}…"
    echo "      the phone will REFUSE this update (uninstall-first required)."
    echo "      cause: this build used a different debug.keystore. Ship secrets/debug.keystore"
    echo "      to the build host (just setup-build-node) instead of letting prebuild mint one."
  fi
else
  warn "no --against baseline — signer ${NEW_SIGNER:0:16}… unchecked"
fi

# 2 — manifest version matches app.json.
# sed -n 1p, not head -1: head closes the pipe early → aapt2 dies on SIGPIPE → pipefail aborts.
BADGING="$("$BT/aapt2" dump badging "$APK" 2>/dev/null | sed -n '1p')"
GOT_CODE="$(printf '%s' "$BADGING" | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")"
GOT_NAME="$(printf '%s' "$BADGING" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
if [ "$GOT_CODE" = "$WANT_CODE" ] && [ "$GOT_NAME" = "$WANT_VERSION" ]; then
  ok "manifest ${GOT_NAME} / code ${GOT_CODE} matches app.json"
else
  bad "manifest ${GOT_NAME:-?} / code ${GOT_CODE:-?} ≠ app.json ${WANT_VERSION} / ${WANT_CODE}"
fi

# 3 — versionCode strictly greater than the APK we're replacing.
if [ -n "$AGAINST" ] && [ -f "${AGAINST}.json" ]; then
  PREV_CODE="$(jsonf "${AGAINST}.json" version_code)"
  if [ -n "$PREV_CODE" ] && [ "$GOT_CODE" -gt "$PREV_CODE" ] 2>/dev/null; then
    ok "versionCode ${PREV_CODE} → ${GOT_CODE} (strictly greater)"
  else
    bad "versionCode ${GOT_CODE} not greater than previous ${PREV_CODE:-?} — Android won't downgrade"
  fi
fi

# 4 — bundle freshness. assets/app.config is written by the JS-bundle phase, so if it
# still carries the OLD version/epoch the Hermes bundle is stale too: the in-app
# APP_VERSION_CODE would sit behind the manifest and the updater would offer the
# installed build to itself. (This is what `--rerun-tasks` on the bundle phase defends.)
CFG="$(mktemp)"; trap 'rm -f "$CFG"' EXIT
if unzip -p "$APK" assets/app.config > "$CFG" 2>/dev/null && [ -s "$CFG" ]; then
  B_CODE="$(jsonf "$CFG" android.versionCode)"; B_VER="$(jsonf "$CFG" version)"; B_EPOCH="$(jsonf "$CFG" extra.buildEpoch)"
  if [ "$B_CODE" = "$WANT_CODE" ] && [ "$B_VER" = "$WANT_VERSION" ] && [ "$B_EPOCH" = "$WANT_EPOCH" ]; then
    ok "bundled app.config is fresh (${B_VER} / ${B_CODE} / epoch ${B_EPOCH})"
  else
    bad "STALE JS bundle — bundled ${B_VER}/${B_CODE}/epoch ${B_EPOCH} ≠ app.json ${WANT_VERSION}/${WANT_CODE}/epoch ${WANT_EPOCH}"
  fi
else
  bad "assets/app.config missing from the APK — cannot prove the bundle is fresh"
fi

# 5 — exactly one ABI (arm64-v8a). Four ABIs = ~55MB of emulator-only dead weight.
ABIS="$(unzip -l "$APK" | sed -n 's#.*lib/\([^/]*\)/.*#\1#p' | sort -u | tr '\n' ' ' | sed 's/ $//')"
if [ "$ABIS" = "arm64-v8a" ]; then ok "single ABI: arm64-v8a"; else bad "ABIs = '${ABIS:-none}', expected 'arm64-v8a'"; fi

# 6 — sidecar agrees with the artifact, and built_at is derived from buildEpoch (NOT
# `new Date()`): isUpdateAvailable compares built_at > APP_BUILD_EPOCH at equal
# versionCode, so a later timestamp makes the app report an update against itself.
if [ -f "$SIDECAR" ]; then
  S_SIZE="$(jsonf "$SIDECAR" size)"; S_CODE="$(jsonf "$SIDECAR" version_code)"
  S_VER="$(jsonf "$SIDECAR" version)"; S_AT="$(jsonf "$SIDECAR" built_at)"
  A_SIZE="$(stat -c %s "$APK")"
  S_AT_MS="$(node -e 'process.stdout.write(String(Date.parse(process.argv[1])||0))' "$S_AT")"
  [ "$S_SIZE" = "$A_SIZE" ] && ok "sidecar size matches ($A_SIZE)" || bad "sidecar size ${S_SIZE:-?} ≠ apk ${A_SIZE}"
  [ "$S_CODE" = "$WANT_CODE" ] && [ "$S_VER" = "$WANT_VERSION" ] && ok "sidecar version ${S_VER} / ${S_CODE}" \
    || bad "sidecar ${S_VER:-?}/${S_CODE:-?} ≠ app.json ${WANT_VERSION}/${WANT_CODE}"
  [ "$S_AT_MS" = "$WANT_EPOCH" ] && ok "sidecar built_at == extra.buildEpoch" \
    || bad "sidecar built_at ${S_AT} (${S_AT_MS}) ≠ extra.buildEpoch ${WANT_EPOCH} — the app will report an update against its own build"
else
  bad "no sidecar at $SIDECAR — the server serves version metadata from it"
fi

# 7 — what the live server actually hands out.
if [ -n "$SERVED" ]; then
  RESP="$(curl -fsS "$SERVED" 2>/dev/null || true)"
  if [ -z "$RESP" ]; then
    warn "$SERVED unreachable — served version unchecked"
  else
    SV="$(printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.version+"/"+j.version_code)}catch{process.stdout.write("?")}})')"
    [ "$SV" = "${WANT_VERSION}/${WANT_CODE}" ] && ok "server serves ${SV}" || bad "server serves ${SV}, expected ${WANT_VERSION}/${WANT_CODE}"
  fi
fi

[ "$FAIL" = 0 ] && echo "── APK verified ──" || echo "── APK VERIFICATION FAILED ──"
exit "$FAIL"
