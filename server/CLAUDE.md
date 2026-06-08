# CLAUDE.md — server/

Go HTTP server + job worker. Single static binary. No Docker, no nginx.

## Module

`github.com/symunona/samizdat/server` — own `go.mod`. CLI is a separate module; it talks to the server via HTTP (admin endpoints, local trust). No shared `engine/` module for M1; promote later if needed.

## Package layout

```
server/
  main.go                   # parse flags, load config, wire + start
  internal/
    config/
      config.go             # ServerConfig struct; load from TOML (same data dir as cli/)
    store/
      db.go                 # Open(path): WAL pragmas + migrate
      schema.sql            # DDL — embedded, applied at open
      queries.sql           # sqlc source queries
      *.go                  # sqlc-generated (never edit by hand)
    auth/
      passphrase.go         # Argon2id hash + verify (owner passphrase)
      token.go              # crypto/rand token, SHA-256 hash
    pair/
      codes.go              # DB-backed pair codes: mint, claim, expire
    api/
      router.go             # http.NewServeMux() — wire all routes
      health.go             # GET  /api/v1/health          (public)
      pair.go               # POST /api/v1/pair            (public, code→token)
      me.go                 # GET  /api/v1/me              (bearer-authed)
      admin_pair.go         # POST /api/v1/admin/pair/new  (passphrase + loopback only)
      middleware.go         # bearerAuth, localhostOnly guards
```

> `sam qr` (CLI) calls `POST /api/v1/admin/pair/new` authenticated by `Authorization: Passphrase <argon2-hash>`, loopback only. Server returns `{code, qr_data_uri}`. CLI prints the QR. Keeps DB ownership in the server; CLI stays a thin client.

## M1 schema (schema.sql)

```sql
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  token_hash  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS pair_codes (
  code        TEXT PRIMARY KEY,   -- 8-char uppercase alphanum
  expires_at  TEXT NOT NULL,      -- ISO8601, TTL 10 min
  used_at     TEXT
);

CREATE TABLE IF NOT EXISTS server_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
  -- keys: "passphrase_hash" (Argon2id $argon2id$... string)
);
```

`rev` on `devices` is a server monotonic sequence. For now: `SELECT COALESCE(MAX(rev),0)+1 FROM devices` inside a transaction. Promote to a sequence table later.

## sqlc setup

`sqlc.yaml` at `server/` root:
```yaml
version: "2"
sql:
  - engine: sqlite
    queries: internal/store/queries.sql
    schema:  internal/store/schema.sql
    gen:
      go:
        package: store
        out:     internal/store
```

Run `sqlc generate` before `go build`. `just server::gen` wraps this. Generated files are committed.

## Non-negotiables
- **Pure-Go SQLite**: `modernc.org/sqlite` only — no cgo, no mattn/go-sqlite3
- **`sqlc` for all SQL**: write `.sql` query files, generate typed Go. Never hand-write row-scan structs
- **WAL mode**: enable at every connection open (`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`)
- **UUID PKs**: all tables use UUID primary keys (client-minted). No auto-increment IDs
- **Row schema**: every table has `id`, `created_at`, `updated_at`, `rev` (server monotonic int), `deleted_at` (tombstone nullable)
- **Job queue = `jobs` table**: no Redis, no external queue. Worker claims with `BEGIN IMMEDIATE … RETURNING`

## API conventions
- REST JSON, all routes under `/api/v1/`
- Auth: `Authorization: Bearer <token>` (token stored as SHA-256 hash in DB)
- Admin routes: `Authorization: Passphrase <hash>` + loopback-only guard
- Never return stack traces in HTTP responses — log internally, return `{"error":"..."}` with appropriate 4xx/5xx
- Errors: typed sentinels + `fmt.Errorf("context: %w", err)` wrapping

## Domain model naming (exact, no synonyms)
`Document` · `Highlight` · `Annotation` · `Note` · `Feed` · `Subscription` · `Scraper` · `Pipeline` · `PipelineStep` · `Job` · `Schedule` · `Tag` · `UserProfile`
Banned: `Content`, `Memory`, `Source`, `Parsed*`, `Cron`, `Url`

## LLM routing
- Two adapters only: Anthropic Messages API + OpenAI-compatible
- Tier routing: triage→Haiku (`claude-haiku-4-5-20251001`), breakdown→Sonnet (`claude-sonnet-4-6`), digest→Opus (`claude-opus-4-8`)
- Credentialed/paywalled jobs → local provider only, never cloud (enforced in router, not caller)

## TLS
- CertMagic in-binary. `--dev` flag → plain HTTP on localhost (no TLS). Do not add nginx, certbot, or reverse proxy dependencies.

## Build
- `CGO_ENABLED=0 go build -o bin/samizdat .`
- Target: linux/amd64, linux/arm64, darwin/arm64 (cross-compile in CI)

## Stack (locked — do not add without discussion)
- `modernc.org/sqlite` — SQLite
- `sqlc` — SQL codegen
- `github.com/google/uuid` — UUID generation
- `golang.org/x/crypto` — Argon2id
- `CertMagic` — TLS (post-M1)
- LLM: plain HTTP client to Anthropic + OpenAI-compat endpoints (post-M1)
