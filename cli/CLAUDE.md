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
- **`config.Save` re-serializes the WHOLE file from the CLI's struct**, so it drops every
  key that struct does not model. That is fine for `sam setup`, which authors the file —
  and destructive anywhere else: the *server's* config.toml has a richer schema
  (`[llm]` provider/base_url/`[[llm.fallback]]`, `[ytdlp]`, `[export]`, the data paths),
  and one `Save` against it wiped all of them (2026-08-05; recovered by hand). **Never
  call `Save` on a config this CLI did not write.** To persist one value, use
  `config.SaveDeviceToken` — it rewrites only its own line (or prepends it, since a root
  key appended at the end would land inside the last `[table]`) and is covered by
  `TestSaveDeviceTokenPreservesForeignKeys`. Write any future single-value setter the
  same way.
- `config.Defaults()` fills missing fields — Load calls Defaults before decode
- Never add default secret values; leave api_key fields empty string
- `DeviceToken string` (`device_token,omitempty`) — cached local-trust bearer token for CLI→server calls; written by `yt` (and future commands) after first successful pair
- Future: keychain integration for secrets; don't store in plaintext beyond config.toml

## CLI → Server auth pattern (local-trust pairing)

**Use `apiClient` (`cmd/api.go`) — do not hand-roll the flow.** `newAPIClient()` resolves
the port, loads config, and mints/reuses the device token; `c.do(method, path, body)`
issues the request against `/api/v1<path>`, re-pairing **once** on a 401 (a revoked token
must not cost the user a manual step); `decode(resp, &out)` turns a non-2xx into the
server's own error line. `yt` and `llm` both go through it.

The underlying flow it implements:
1. Read `cfg.DeviceToken`; if empty or revoked (401), call `pairAndCache()`
2. `pairAndCache()` calls `localDeviceToken()` which: POSTs to `/api/v1/admin/pair/new` (loopback-only admin endpoint) to mint a code, then POSTs to `/api/v1/pair` to claim it → returns `device_token`
3. Token is written back to config (0600) via `config.Save()`
4. On 401 retry: re-pair once, then retry the original request — no infinite loop
- Helper `loadPort()` reads the server port from config. It — and everything else that
  loads config for a server call — must go through **`resolveConfigPath()`**, never
  `config.DefaultPath()`: `sam --config X` that talks to the port named in some OTHER
  config is a silent cross-instance call. (`loadPort`, `newAPIClient` and
  `subscription.go`'s `authedRequest` all had that bug; the last was a third hand-rolled
  copy of the auth flow and is now a two-line wrapper over `apiClient`.)

## llm command — inspect the server's LLM Router
`sam llm check` (`just check-llm`) probes every configured **and discovered** provider
(LAN/local Ollama, Anthropic, OpenRouter) and prints one row each: reachable, auth,
credits, model count, latency. It runs **deep by default** — a 1-token ping (~$0.000001)
is the only way to tell a valid Anthropic key from a valid key on an empty account, and
this is a manual command; `--shallow` skips it. Exit code is gated on the **routing chain
only**: an `available` provider with no key is information, not a failure.

After the probe table, `sam llm check` also prints a **pipeline mismatch table** if any
pipeline step has a pinned provider+model that no longer exists on that provider. This is
the failure mode where a step silently 404s on every call and falls back, rather than
failing loud (see `server/internal/api/llm_status.go checkPipelineModels`). The table is
populated from `pipeline_mismatches` in the `/api/v1/llm/check` response. If any
mismatches exist, the command exits non-zero even if the routing chain is healthy.

Output is a hand-laid table (`renderProbeTable` / `renderMismatchTable`), **not**
`text/tabwriter`, for two reasons: tabwriter counts ANSI escapes toward cell width (every
colored row drifts), and a single-cell line ends its column block (an inline error would
split the table in two).

- **Green = usable, yellow = no key configured, red = unusable.** A keyless provider was
  never contacted, so its REACHABLE cell reads `—`, not `no` — and it is yellow, not red:
  telling the user to fix a box that is probably fine is worse than saying nothing.
- **The error is not a column.** It is a full sentence, so it gets its own red line
  indented under its row (`    ! …`) and DETAIL is left empty. DETAIL only ever carries
  the credit numbers or the endpoint.
- **Padding is measured on the unpainted text** (`cell{text, color}` + `paintIf`), in
  RUNES not bytes — the em dash a missing value renders as is 3 bytes and one column.
- **The mismatch table has no warn/yellow state** — every row is red, because a mismatch
  means the next run of that step will 404. Unlike the probe table there is no "keyless"
  state to soften. The `renderMismatchTable` function shares the same `cell`/`writeRow`
  primitives as `renderProbeTable`.
- `--color auto|always|never`; auto honours `NO_COLOR`, `TERM=dumb`, and whether stdout is
  a terminal, so `just check-llm > out.txt` stays clean. Use `--color=always` to see the
  real thing through a pipe.
- **The exit code needs `stateOK`, not "not red".** A chain provider with no key is not
  broken, but it cannot serve a call either — `chainUsable` is the single place that
  decides, and it is unit-tested.
- **Two independent exit-code gates:** (1) `!chainUsable(out.Results)` — no usable routing
  chain; (2) `len(out.PipelineMismatches) > 0` — a pinned model is gone. Both are checked;
  either alone causes non-zero exit. Chain failure is checked first.

`sam llm models` (`just list-models`) lists what each provider serves — the same catalog
the app's model picker offers. `--provider <id>` filters, `--refresh` busts the server's
5-minute cache.

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
- **Table rendering pattern:** use `cell{text, color}` + `writeRow` + rune-counted widths — never `text/tabwriter`. New tables (like `renderMismatchTable`) must follow the same primitives. The mismatch table demonstrates the minimal case: no warn state, all-red rows, shared header/row rendering with the probe table.

## Stack
- `github.com/spf13/cobra` — CLI dispatch
- `github.com/BurntSushi/toml` — config parse/encode
- `net/http` (stdlib) — CLI→server HTTP calls; uses `http.DefaultClient` with `//nolint:noctx` (context threading deferred)
- No CGO (modernc sqlite will live in server/, not cli/)