---
created: 2026-06-08
topic: Job Runner + Scraper (M2 step 1)
excerpt: Minimal job queue in SQLite + worker goroutine + scrape_url handler → Document. No feeds, no pipeline, no LLM.
status: done
---

# Job Runner + Scraper

> Scope: insert a `scrape_url` job → worker picks it up → `Document` lands in DB. Nothing else.

## Schema additions (minimal)

Two new tables only. All existing M1 tables unchanged.

```sql
-- jobs: the queue
CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,           -- 'scrape_url' (only kind for now)
    payload      TEXT NOT NULL,           -- JSON, kind-specific
    status       TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed|dead
    attempts     INTEGER NOT NULL DEFAULT 0,
    run_after    TEXT NOT NULL,           -- ISO-8601; worker skips if now < run_after
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    rev          INTEGER NOT NULL DEFAULT 0,
    deleted_at   TEXT
);

-- documents: one per canonical URL
CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,
    canonical_url TEXT NOT NULL UNIQUE,
    title         TEXT NOT NULL DEFAULT '',
    markdown      TEXT NOT NULL DEFAULT '',
    fetched_at    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    rev           INTEGER NOT NULL DEFAULT 0,
    deleted_at    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS documents_canonical_url ON documents(canonical_url);
```

**Payload shape for `scrape_url`:**
```json
{ "url": "https://example.com/article" }
```

## Worker

Single goroutine inside the server process. Starts with `server.Start()`.

**Claim loop (every 5s poll, or wake on new job insert via channel):**
```sql
BEGIN IMMEDIATE;
UPDATE jobs
  SET status='running', attempts=attempts+1, updated_at=?
  WHERE id=(
    SELECT id FROM jobs
    WHERE status='queued' AND run_after <= ?
    ORDER BY created_at
    LIMIT 1
  )
RETURNING *;
COMMIT;
```

**Dispatch:** `switch job.Kind { case "scrape_url": ... }`

**On success:** `UPDATE jobs SET status='done', updated_at=? WHERE id=?`

**On error (retry):**
- attempts < 3 → `status='queued', run_after = now + 2^attempts * 30s`
- attempts >= 3 → `status='dead'`

## Scraper handler (`scrape_url`)

1. Parse `url` from payload JSON.
2. Check `documents.canonical_url` — if exists, mark job `done` and return (dedup).
3. `net/http` GET with a real `User-Agent`, 30s timeout.
4. Extract main content: **`markusmobius/go-trafilatura`** (pure Go port of Trafilatura, best-in-class accuracy).
5. Convert HTML→Markdown: **`github.com/JohannesKaufmann/html-to-markdown`** (pure Go, MIT).
6. Upsert `Document` row (UUID, canonical_url = input url for now).
7. Mark job `done`.

## API endpoint (trigger for testing)

```
POST /api/v1/jobs
Authorization: Bearer <token>
{"kind":"scrape_url","url":"https://..."}
```

Returns `{"job_id":"..."}`. Worker picks it up async.

Also: `GET /api/v1/documents` (bearer) → list scraped docs (for smoke test).

## Package layout additions

```
server/internal/
  worker/
    worker.go     # Worker struct, Start(ctx), claim loop, dispatch
    scraper.go    # handleScrapeURL(ctx, job) — fetch + extract + upsert
  api/
    jobs.go       # POST /api/v1/jobs
    documents.go  # GET  /api/v1/documents
```

## Self-tests (before implementation)

Write these specs first (`tooling/spec` or plain Go tests):

1. **Happy path:** insert `scrape_url` job for a real URL → worker runs → `documents` row exists with non-empty markdown.
2. **Dedup:** insert same URL twice → only one `documents` row, second job marked `done` immediately.
3. **Bad URL (404):** job retries 3× → status `dead`, no document row.
4. **Claim atomicity:** two workers race to claim → only one wins, no double-processing.
5. **`GET /api/v1/documents`** returns the scraped doc.

## Out of scope

- `feeds`, `subscriptions`, `schedules` — M2 step 2
- `highlights`, pipeline, LLM — M2 step 3+
- `run_pipeline` job kind — not yet
- Canonical URL normalization (query-param stripping) — later
- Auth header scraping / paywalled content — later

## Decisions

- **Extractor:** `markusmobius/go-trafilatura` — pure Go, best accuracy, matches vault intent.
- **Worker poll:** 5s for dev; channel-wake is a later optimisation.
- **Canonical URL:** strip `#fragment` + known UTM params (`utm_*`, `fbclid`, `gclid`) via `url.Parse` before dedup check.
