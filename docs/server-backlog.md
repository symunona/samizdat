# Server Backlog (post-M1)

> Everything after auth + pairing + health. Grouped by milestone, one line each. Full design: `ARCHITECTURE.md` + planning vault `research/tech/`. Names per `CLAUDE.md` (`009`).

## M2 — Ingest → unit (the core loop)
- `Feed` + `Subscription` + `Schedule`: per-feed email alias + RSS/portal poll.
- `Job` queue in SQLite (`poll_feed` / `scrape_url` / `run_pipeline`): atomic claim, retries, cost metering.
- `Scraper` registry: declarative per-site files (`match` + `extract`); fetch → Defuddle/Trafilatura → md → `Document`.
- Dedup by `canonical_url`; shared **LVL0 summary** field; links → child `Document`s.
- `Pipeline` / `PipelineStep`: per-source prompt → `Highlight`s + `Tag`s; `UserProfile` overlay.
- LLM providers: Anthropic native + OpenAI-compatible adapter; local detect (Ollama/LM Studio/llama.cpp); tiered routing; **paywalled → local only**.

## M3 — Curate + sync
- Sync API: change-cursor pull (`since_rev`) + LWW push; tombstones; client-minted UUID PKs.
- User-authored two-way rows: read-state, position, `Tag`, save-for-digest.
- Vault md↔DB: persist `Document`/`Highlight`/`Note` as markdown; `sam reindex` rebuilds the DB.

## M4 — Publish
- Digest build: walk a `Tag` → assemble draft → **auto-citations** (the promote-gate).
- Static-gen export / publish hook.
- Serve the Expo web build from `embed.FS`.

## M5 — Clipper + authed capture
- `POST /documents` (clip), `POST /highlights`, `POST /jobs` (manual add).
- Per-user encrypted cookie/credential store; per-user-session authed scraping; source health (auth-expiry warnings).

## Cross-cutting (as needed)
- Web cookie/session auth; device-management UI.
- Triggers / watch-conditions → email/notification.
- Settings APIs (providers, `UserProfile`, storage).
- Observability: job logs, token/cost dashboard.
- Sandboxed custom `PipelineStep` code (security) — deferred.
