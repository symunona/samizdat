# Server Stub Spec — Auth & Pairing (Milestone 1)

> The first Go build target. Scope = **health + owner auth + device pairing + TLS**. Everything else → `server-backlog.md`. Names per `CLAUDE.md` (vault `009`). This is a spec, not code.

## Goal
A running, reachable, pairable server with a health endpoint. **No domain logic yet** (no scrape/pipeline/feed).

## Package layout (`server/`)
- `go.mod` — module `github.com/symunona/samizdat/server`.
- `cmd/samizdat/main.go` — entry; load config; start HTTP (+CertMagic) or `--dev`.
- `internal/config` — merge `config.toml` + env + flags; resolve data dir.
- `internal/store` — SQLite (`modernc.org/sqlite`), migrations, queries (sqlc later); WAL.
- `internal/auth` — passphrase (Argon2id), device tokens, pairing codes, Bearer middleware.
- `internal/httpapi` — router, handlers, JSON helpers.
- `internal/tlsx` — CertMagic setup + `--dev` plain-HTTP path.
- The `cli/` module shares the same `config.toml` + DB file (M1: CLI reads/writes the store directly; promote shared `internal` to a common module later).

## Data (SQLite)
- `owner(id, passphrase_hash, created_at)` — single row.
- `pairing_codes(code, created_at, expires_at, used_at)` — short-lived, single-use.
- `device_tokens(id TEXT, name, token_hash, created_at, last_seen_at, revoked_at)`.
- `config_kv(key, value)` — or keep host/dev in `config.toml`.
- Conventions: TEXT UUID PKs, ISO-8601 timestamps, snake_case plural tables (`CLAUDE.md`).

## Auth model
- **Owner passphrase** set at `sam init` → **Argon2id** hash in `owner`.
- **Device token** = 32-byte random, returned **once**, stored as **SHA-256** hash (tokens are high-entropy → no Argon2). Sent as `Authorization: Bearer <token>`. Constant-time compare. Revocable via `revoked_at`.
- **Middleware:** protected routes require a valid, non-revoked token; bump `last_seen_at`.
- Web cookie/session = later (not M1).

## Pairing flow
1. **`sam qr`** (local trust, server side): insert a `pairing_code` (random, TTL ~5 min, single-use); print the code + a **terminal QR** encoding `https://<host>/pair?code=<code>`.
2. **App:** scan/paste → `POST /pair {code}` over TLS.
3. **Server:** validate (exists, unexpired, unused) → mark used → create `device_tokens` row → return `{device_token, device_id}`. (Code is short-lived + TLS-protected, so code-only is acceptable for M1; optionally also require the passphrase for extra safety.)
4. **App:** store token; all future calls Bearer.

## Endpoints (M1)
- `GET /health` — public → `{status:"ok", version, time}`.
- `POST /pair` — `{code}` → `{device_token, device_id}` | 401.
- `GET /me` — authed → `{device_id, name, server_version}` (drives the "we're online" check).

## TLS / serving
- **CertMagic:** HTTP-01 / TLS-ALPN-01; `HostPolicy` = configured host; cert cache in data dir.
- **`--dev`:** plain HTTP on localhost, no cert.
- Bind `:443` (prod) / `:8787` (dev).

## Config (`config.toml`)
`host`, `data_dir`, `dev` (LLM keys come later). Secrets `0600`. `config.example.toml` committed.

## Acceptance (= M1 steps 3–4)
Server reachable on HTTPS; `sam qr` → app pairs → authed `/health`/`/me` returns ok → app shows **"Yaaay, we're online."**

## Explicitly NOT here
Ingest, `Feed`/`Subscription`, `Scraper`, `Pipeline`, `Job` queue, sync, providers, vault, clipper, digest → `server-backlog.md`.
