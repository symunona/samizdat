---
created: 2026-08-09
topic: One source of truth for the served APK path
excerpt: The APK's location was spelled out independently in the justfile, the tools, the server flag and the config key — only accidentally in agreement, which left the systemd service serving no /download/samizdat.apk at all. Everything now derives from config.toml [server] apk_path, resolved by one function.
status: done
---

## The bug

`just dev` ran the server with `--apk dist/samizdat.apk`; `deploy/samizdat.service.tmpl`
did not pass the flag and `config.toml` carried no `apk_path`, so under `just restart`
(prod) the server registered NEITHER `GET /download/samizdat.apk` NOR
`GET /api/v1/app/android/version`. The version request fell through to the SPA catch-all
and answered HTML — a fresh APK was undownloadable and the in-app updater blind, silently.

## The rule

`config.toml` `[server] apk_path` is the single source of truth. It is optional: unset
means `dist/samizdat.apk`, and a relative value resolves against the **config file's own
directory**, not the process cwd (a systemd unit has no cwd guarantee the way a `just`
recipe does).

## Seam

- `config.Load` resolves `Server.APKPath` to an absolute path (default included), so
  every consumer reads one already-resolved field.
- `samizdat config apk-path` prints that resolved path — the resolver the shell side
  calls, so there is no second implementation to drift.
- `just _apk-path` wraps it (building the server binary if missing); the build/deploy
  recipes and `tools/verify-apk.sh` take the path from there. `tools/write-apk-sidecar.mjs`
  requires the path as an argument.
- The `--apk` flag is gone: it was the mechanism that let dev and prod diverge.
- The APK routes register unconditionally. A missing artifact answers a clean 404
  ("apk not built") instead of falling through to the SPA catch-all.
