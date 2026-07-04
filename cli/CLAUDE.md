# CLAUDE.md — cli/

`sam` binary. Cobra commands. Shares engine with server/ once engine package exists.

## Structure
```
cmd/          one file per command group (root.go, setup.go, yt.go, login.go, …)
config/       Config struct + TOML load/save
setup/        Step interface + Runner (step.go)
setup/steps/  numbered step files: 01_data_dir.go, 02_llm.go, …
```

## Setup wizard pattern
Each onboarding step implements `setup.Step`:
- `Name() string` — short label shown in progress
- `ShouldSkip(*config.Config) bool` — idempotent re-run guard
- `Run(*config.Config) error` — mutates cfg in place; Runner saves after each success

Steps are numbered (01_, 02_, …). Order matters; Runner executes in slice order defined in `cmd/setup.go`.

## Config
- Format: TOML, `~/.samizdat/config.toml`, **0600 perms** (contains API keys)
- `config.Defaults()` fills missing fields — Load calls Defaults before decode
- Never add default secret values; leave api_key fields empty string
- `DeviceToken string` (`device_token,omitempty`) — cached local-trust bearer token for CLI→server calls; written by `yt` (and future commands) after first successful pair
- Future: keychain integration for secrets; don't store in plaintext beyond config.toml

## CLI → Server auth pattern (local-trust pairing)
Commands that talk to the local server use a cached bearer token stored in config:
1. Read `cfg.DeviceToken`; if empty or revoked (401), call `pairAndCache()`
2. `pairAndCache()` calls `localDeviceToken()` which: POSTs to `/api/v1/admin/pair/new` (loopback-only admin endpoint) to mint a code, then POSTs to `/api/v1/pair` to claim it → returns `device_token`
3. Token is written back to config (0600) via `config.Save()`
4. On 401 retry: re-pair once, then retry the original request — no infinite loop
- Helper `loadPort()` reads the server port from config (defined elsewhere in cmd/)
- `enqueueScrape()` / similar per-command HTTP helpers build and fire the actual API request

## login command — credential-passing pattern
`sam login <domain>` authenticates to a paywalled domain so scrapes render full-text:
- Credentials accepted via `--user`/`--pass` flags **or** `SAM_LOGIN_USER`/`SAM_LOGIN_PASS` env vars (env is fallback, flags take priority)
- Credentials are validated present in the CLI before hitting the server — fail fast with a clear error
- POSTs to `/api/v1/admin/scraper/login` (loopback admin endpoint — **not** bearer-token-authed; no pairing step used here)
- Credentials are forwarded to the server but **never stored** by the CLI. By default the server stores them (0600 credentials.toml) for unattended session refresh; `--no-save` keeps the cookie jar only
- Response body decoded for `ok`, `detail`, and `error` fields; non-200 falls back to `resp.Status` if `error` is empty
- `--port` flag overrides `cfg.Server.Port` (same pattern as other commands)
- Note: this command does **not** use the device-token pairing flow — it hits an admin endpoint directly. If pairing is added later, align with the standard auth pattern.

## Conventions
- `CGO_ENABLED=0` always — pure Go, no cgo
- Wrap all external errors: `fmt.Errorf("context: %w", err)` — including open src/dst/copy individually in file helpers
- Steps are non-destructive by default: prompt before creating dirs or writing files
- `readLine()` / `expandHome()` helpers live in steps package (not exported — copy-paste is fine for now)
- URL validation for ingestion commands: validate before hitting the server (see `isYouTubeURL`)
- Print user-facing "server not reachable" hint to stderr before returning the wrapped error
- Credential env-var fallback pattern: check flag first, then `os.Getenv("SAM_LOGIN_*")` — use this for any future commands that accept secrets

## Stack
- `github.com/spf13/cobra` — CLI dispatch
- `github.com/BurntSushi/toml` — config parse/encode
- `net/http` (stdlib) — CLI→server HTTP calls; uses `http.DefaultClient` with `//nolint:noctx` (context threading deferred)
- No CGO (modernc sqlite will live in server/, not cli/)