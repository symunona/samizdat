# server/

The engine: REST API + job worker + cron + storage. One Go binary.

- **Stack:** Go · `modernc.org/sqlite` (pure Go) · `sqlc` · CertMagic (in-binary TLS) · MuPDF via cgo (PDF figures).
- **Runs:** HTTP API, job-queue worker, scheduler. Embeds the Expo web build.
- **Owns:** `app.db` (rebuildable index) + `vault/` (markdown = truth).
- **Does:** ingest (`Feed`/`Subscription`) → `Scraper`→`Document` → `Pipeline`→`Highlight`, jobs + cost metering, sync API, auth, LLM routing.

Dev: `just dev`. Prod: `just build && just restart`. See `CLAUDE.md`.
