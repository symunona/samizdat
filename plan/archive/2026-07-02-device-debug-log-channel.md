---
created: 2026-07-02
topic: Device debug log channel + auto version bump
excerpt: Paired APK streams its JS + WebView logs to the server over an HTTP batch stream; server appends to tmp/device-logs/<device>.ndjson so we can tail -f from this machine. Plus auto PATCH version bump on every build-android.
status: done — squash-merged to main 2026-07-02. server+app+build green, web streaming verified via agent-browser + isolated endpoint test. APK 0.2.3/code6 built+deployed. NOTE: on-device log capture still pending a `just dev` restart of :8765 (was serving a stale binary at merge time).
---

# Device debug log channel + auto version bump

## Why
Native WebView YouTube errors ("152 code 4") are invisible — no console reachable
from this machine. Need a live channel: paired device → server → a file we tail.
Doubles as a general remote-debug channel for the physical Android device.

## Decisions (user-confirmed)
- **Transport:** HTTP batch NDJSON POST (not raw WebSockets). Keeps the single static
  binary dep-free, rides existing TLS + bearer auth, trivial reconnect, RN `fetch`-friendly.
  Flush every ~1s; immediate flush on `error`-level.
- **Scope:** App JS logs (logger.ts + console.* + uncaught JS errors) + the YtPlayer
  WebView (`window.onerror` / unhandledrejection / iframe error event). No native module.
- **Version:** default **PATCH** bump every `just build-android`; `minor`/`major` args
  for the others. `versionCode` always +1.

## Pieces

### Server
- `server/internal/api/debug_logs.go` — `POST /api/v1/debug/logs`, bearerAuth.
  Body = NDJSON (raw). Appends to `tmp/device-logs/<name>-<id8>.ndjson` (CWD-relative,
  gitignored). Device from `deviceFromCtx(r)`. Prepends a session-start marker on first
  write per process is unnecessary — just append. Returns 204.
- Register route in `router.go`.

### App
- `app/src/debugLog.ts` — queue + flusher. `setDebugLogTarget(url, token, deviceId, enabled)`,
  `pushLog(entry)`. Guards against logging its own POST failures (loop). NDJSON body.
- `app/src/logger.ts` — forward every log/warn/error to an optional sink (`setLogSink`).
- `app/_layout.tsx` — `DebugLogBridge` inside ConnectionProvider: reads `useConnection()`,
  wires `setDebugLogTarget`, installs global JS error handler (ErrorUtils / window.onerror).
- `app/src/YtPlayer.tsx` — HTML `window.onerror` + `onunhandledrejection` → `post({t:'jserr'})`;
  richer iframe `onError` (state + code); WebView `onError`/`onHttpError`/`onRenderProcessGone`.
  Route `jserr` → `log.error` so it ships. Mirror the extra iframe error detail into `.web.tsx`.
- Settings toggle "Stream debug logs" (persisted, default ON for this debug build) + storage helper.

### Build / version
- `tools/bump-version.mjs` — bump app.json version (patch|minor|major) + versionCode +1.
- `just build-android level="patch"` — runs bump first (before gen-icons/prebuild).
- `just bump level="patch"` — standalone.
- `just device-logs` — `tail -F tmp/device-logs/*.ndjson`.

### Docs
- Root `CLAUDE.md` — version bump policy under Building.
- `app/CLAUDE.md` — debug log channel + version policy sections.
- `.gitignore` — ensure `tmp/device-logs/` covered (tmp/ already ignored).

## E2E / test
- `just build` (go + tsc) green.
- `just lint` green (knip, parity, go vet).
- `just e2e` green — the bridge POSTs logs on web; endpoint must return 2xx (204), no 4xx/5xx.
- Manual: bump → build-android → install → open a YouTube video → `just device-logs` shows
  the real error behind "152 code 4".

## Self-test checklist
1. `curl -XPOST localhost:8765/api/v1/debug/logs` w/ bearer → 204, file appears.
2. Web app running → logs land in tmp/device-logs/.
3. Version: 0.2.2→0.2.3 on plain build; `minor`→0.3.0; `major`→1.0.0; code +1 each.
</content>
</invoke>
