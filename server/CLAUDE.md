# CLAUDE.md — server/

Go HTTP server + job worker. Single static binary. No Docker, no nginx.

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
- CertMagic in-binary. Do not add nginx, certbot, or reverse proxy dependencies

## Build
- `CGO_ENABLED=0 go build -o bin/samizdat ./...`
- Target: linux/amd64, linux/arm64, darwin/arm64 (cross-compile in CI)

## Stack (locked — do not add without discussion)
- `modernc.org/sqlite` — SQLite
- `sqlc` — SQL codegen
- `CertMagic` — TLS
- LLM: plain HTTP client to Anthropic + OpenAI-compat endpoints
