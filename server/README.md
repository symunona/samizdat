# server/

The Samizdat engine: REST API + cron worker + storage, as one Go static binary.

- **Stack:** Go · pure-Go SQLite (`modernc.org/sqlite`, no CGO) · CertMagic (in-binary TLS) · `sqlc` (portable SQL).
- **Runs:** the HTTP API, the job-queue worker, the cron scheduler; embeds the Expo web build.
- **Owns:** `app.db` (rebuildable index) + `vault/` (markdown = source of truth).

Responsibilities: ingest (`Feed`/`Subscription`), `Scraper`→`Document` (dedup, LVL0), `Pipeline`→`Highlight`, jobs/metering, sync API, auth (passphrase + device tokens), provider routing (Anthropic + OpenAI-compatible/local).

Not initialized yet. Bootstrap: `go mod init` → wire HTTP + worker + SQLite. See `../ARCHITECTURE.md` and `../CLAUDE.md`.
