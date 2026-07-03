# CLAUDE.md — server/

Go HTTP server + job worker. Single static binary. No Docker, no nginx.

## After changing Go code

Always use `just dev` to rebuild and restart — it rebuilds both server AND app, kills any running instance, and starts in background:
```bash
just dev
```
Never use raw `pkill`/`go build` manually. `just dev` is the canonical restart command for agents and humans alike.

**Rebuilding the binary ≠ restarting the process.** A running server holds its old
code in memory until restarted. `just dev` now kills whatever holds the dev port
first (dev nohup included) and fails loudly if the new process doesn't actually
bind — so it can't "succeed" while a stale process keeps serving.

**Which server is running, and is it fresh? → `just status`.** It reports the mode
(dev nohup vs `samizdat-<instance>` systemd service), PID, and compares the live
server's stamped commit (`GET /api/v1/health` → `commit`, injected via `-ldflags`)
to `git HEAD` → a FRESH/STALE verdict. Don't trust `/api/v1/app/android/version`
for server freshness — it reads the APK sidecar per-request and shows fresh even on
stale server code. Two run modes: **dev nohup** (orphaned to init, from `just dev`)
vs **systemd service** (`just restart`). `just kill` stops dev servers.

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
      admin_test_device.go  # POST /api/v1/admin/test-device (loopback only) — idempotent: one reusable robot device, rotates its token
      media.go              # GET  /api/v1/media/{id}      (asset serving)
                            # GET  /api/v1/documents/{id}/audio (audio streaming)
      ytdlp_status.go       # GET  /api/v1/ytdlp/status    (bearer-authed, proxy health)
      middleware.go         # bearerAuth, localhostOnly guards
    transcript/
      vtt.go                # WebVTT parser → []Segment{StartMs,EndMs,Text}
    worker/
      youtube.go            # yt-dlp ingest: audio + transcript → video Document
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
  --       "ytdlp_proxy_last_ok_at" (RFC3339, persisted across restarts)
);

CREATE TABLE IF NOT EXISTS documents (
  ...
  content_hash    TEXT NOT NULL DEFAULT '',
  media_type      TEXT NOT NULL DEFAULT 'article',  -- 'article' | 'video'
  media_metadata  TEXT NOT NULL DEFAULT '',         -- JSON: {provider, external_id, duration_ms, transcript_status}
  transcript      TEXT NOT NULL DEFAULT '',         -- JSON: [{start_ms,end_ms,text}] (video only)
  ...
);

CREATE TABLE IF NOT EXISTS annotations (
  ...
  pos_end      INTEGER NOT NULL DEFAULT 0,
  media_ts_ms  INTEGER NOT NULL DEFAULT 0,  -- playback timestamp for video annotations (0 = none)
  ...
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

## Highlight vs Annotation (critical distinction)
- **`Highlight`** — LLM-extracted unit from a Document. Machine data. Server→phone **one-way**. Created by `Pipeline`.
- **`Annotation`** — user-created text selection on a `Document` or `Highlight`. Has a text anchor (W3C TextQuoteSelector JSON) + optional note body (markdown). User-authored → **two-way sync** (LWW push). Never machine-generated.
- **Video annotations** additionally carry `media_ts_ms` (playback timestamp in milliseconds; 0 = not a video annotation). This is the only permitted deviation from the text-anchor model.

## Document media types
- **`media_type = 'article'`** — default. HTML scrape via Playwright + Trafilatura.
- **`media_type = 'video'`** — YouTube/podcast ingest via yt-dlp. Fields:
  - `media_metadata`: JSON `{provider, external_id, duration_ms, transcript_status}` where `transcript_status` ∈ `"subs" | "auto" | "none"`.
  - `transcript`: JSON `[{start_ms, end_ms, text}]` segments (empty array `[]` when none).
  - `markdown`: flattened transcript text (one segment per line); falls back to video description when no transcript.

## Scraper paywall auth (per-domain login)
Paywalled domains reuse the owner's subscription via a persisted browser session,
so gated articles render full-text. Config lives in the existing per-domain seam —
`extractors/<domain>/feed.yaml` — under an `auth:` block (`login_url`,
`user_selector`, `pass_selector`, `submit_selector`, `success_text`,
`paywall_text`). No new TOML section.
- **Session jar:** Playwright `storageState` (cookies + localStorage) at
  `<cacheDir>/auth/<domain>.json`, chmod 0600, gitignored (`**/auth/*.json`).
  `extractor.AuthStatePath(cacheDir, domain)` resolves it.
- **Login:** `POST /api/v1/admin/scraper/login` (loopback-only), body
  `{domain, username, password}` → `worker.Login` → `BrowserPool.Login`: headless
  form fill, then the **login success detector** waits for `success_text` to appear
  (SPA-hydration-safe `Locator.WaitFor`, 20s) before saving the jar. Credentials are
  used once and never stored — only the cookie jar persists. CLI: `sam login <domain>`
  (`--user`/`--pass` or `SAM_LOGIN_USER`/`SAM_LOGIN_PASS`).
- **Scrape:** `handleScrapeURL` looks up the domain's `Auth`; when present it loads
  the jar into the fetch context (`BrowserPool.FetchHTML(url, statePath)`). The
  **stale-session detector** warns (`re-run: sam login <domain>`) when `paywall_text`
  is still present in the fetched HTML — session missing/expired.
- SSO note: a domain's login may live on a parent host (444 → magyarjeti.hu); the
  `login_url`'s `?redirect=` sends the session back so the content domain's cookie is
  set. `storageState` captures cookies for all domains touched during login.
- **Follow-up (not built):** credentialed Documents should route to a local LLM only
  (Rule 5). The router guard is documented but unimplemented; single-user server →
  no shared-cache leak today.

## YouTube ingest pipeline
- Triggered by `scrape_url` jobs for any YouTube URL (all forms: watch, youtu.be, shorts, embed, music, m.).
- **Canonical form**: always `https://www.youtube.com/watch?v=<id>` — canonicalization happens before DB dedup.
- **yt-dlp invocation**: one session for audio + metadata + subtitles. Flags: `-f bestaudio -x --audio-format m4a --write-info-json --write-subs --write-auto-subs --sub-langs en.*,en,en-orig --sub-format vtt --convert-subs vtt`.
- **Transcript preference**: manual subs → auto-captions → none.
- **Audio asset**: stored as `media_assets` row with `kind="audio"`, accessible at `GET /api/v1/documents/{id}/audio` (range-request capable via `http.ServeFile`).
- **Intermediate files** (info.json, .vtt) are deleted after processing; only the .m4a is kept.
- **Post-ingest**: calls `finishDocument()` (shared with article scraper) — enqueues `fetch_assets` and triggers matching pipelines.

## yt-dlp config (`[ytdlp]` in TOML)
```toml
[ytdlp]
path    = "yt-dlp"               # binary; default = PATH lookup
proxy   = "socks5h://100.x.y.z:1080"  # residential proxy (required for VPS; Tailscale home node recommended)
cookies = "/path/to/cookies.txt" # optional Netscape cookies.txt (fallback/auth)
```
The VPS datacenter IP is bot-blocked by YouTube. A residential proxy (e.g. home node over Tailscale) is required for the happy path. See `docs/youtube-ingest.md`.

## yt-dlp proxy status endpoint
`GET /api/v1/ytdlp/status` (bearer-authed):
- Background goroutine probes the SOCKS5 proxy every 60 seconds by fetching `https://api.ipify.org` through it.
- GET also triggers an immediate fresh probe (8s timeout) — page refresh = recheck.
- `last_ok_at` (last successful probe time) is persisted in `server_settings` under key `ytdlp_proxy_last_ok_at` so it survives restarts.
- Response: `{configured, proxy, ok, exit_ip, error, checked_at, last_ok_at}`.
- If no proxy is configured, the handler is registered but always returns `{configured: false}` and no background goroutine runs.

## Media serving
- `GET /api/v1/media/{id}` — serves any media asset by asset ID; content-type inferred by extension.
- `GET /api/v1/documents/{id}/audio` — looks up the `audio`-kind asset for a document; streams it via `http.ServeFile` (supports HTTP range requests for seek).
- Content-type is inferred by file extension: `.m4a/.mp4/.aac` → `audio/mp4`, `.mp3` → `audio/mpeg`, `.webm/.opus` → `audio/webm`, `.png` → `image/png`, default → `image/jpeg`.

## Job enqueueing rules
- **Always set `ParentJobID`** when enqueueing a job from inside a pipeline step or worker handler. Use `ParentJobIDFromCtx(ctx)` in pipeline steps; use `&job.ID` or `job.ParentJobID` in worker handlers. Never insert a job with a nil parent when a driving job exists — this is required for job-tree visibility in the UI.
- **Pipeline filter exclusions**: use `exclude_source_feed_ids` in a pipeline's filter JSON to prevent it from running on specific feeds (e.g., a global summarizer pipeline should exclude feed IDs that have their own dedicated pipeline). Never rely on pipeline ordering or naming conventions to avoid double-processing.
- **`skip_new_scrapes` config**: both `extract_links` and `extract_list_items` steps support `{"skip_new_scrapes": true}` — set this on pipelines that should only enrich already-scraped links, never trigger new scrapes.
- **`finishDocument()`** is the shared post-upsert hook for any scraped Document (article or video): enqueues `fetch_assets` and triggers matching pipelines. Failures inside `finishDocument` are logged but not propagated — the Document is already persisted, so re-raising would cause needless re-scrape/re-download on retry.

## LLM routing
- Two adapters only: Anthropic Messages API + OpenAI-compatible
- Tier routing: triage→Haiku (`claude-haiku-4-5-20251001`), breakdown→Sonnet (`claude-sonnet-4-6`), digest→Opus (`claude-opus-4-8`)
- Credentialed/paywalled jobs → local provider only, never cloud (enforced in router, not caller)

## Auto-export vault (`internal/export`)
One-way mirror of Documents + Annotations to a structured plain-markdown Obsidian vault on disk. DB → markdown only; never imports. Config: `[export]` section (`enabled`, `dir`) in TOML — distinct from the reserved (unused) `vault_dir`. Needs `cacheDir` (passed by `api.New`) to source image assets.
- **Layout:** `documents/<slug>.md` (one per Document, marker `samizdat: export`), `annotations/<slug>.md` (one **separate** note per Annotation, marker `samizdat: export-annotation`), `assets/<id>.<ext>` (copied image assets), `_index.md` (MOC, marker `samizdat: export-index`).
- **Ownership marker:** every note carries its marker + `id:` in frontmatter. `loadIndex()` scans `documents/` and `annotations/` at startup and only ever writes/renames files carrying the matching marker — **foreign files are never touched**.
- **Documents:** frontmatter (id, url, title, author, published, fetched, media_type, `hero`, tags); body = markdown with image URLs rewritten to `../assets/…` + a `![hero]` embed; a `## Annotations` section wikilinks its annotation notes. Tombstoned doc → note removed.
- **Annotations:** own note — frontmatter (id, `document: [[doc]]`, color, media_ts, pos, created) + `> [!quote] From [[doc]]` blockquote + note body. Tombstoned annotation → note removed (handled in the sweep from the changed-annotation list, since `exportDoc` only writes live ones).
- **Assets:** every image `MediaAsset` (kind ≠ `audio`) is copied `cacheDir/<LocalPath>` → `assets/<basename>` (skips if same size); its `OriginalUrl` is rewritten to `../assets/…` in doc/annotation bodies. Audio is not exported.
- **Cursor:** incremental by `updated_at` (same cursor `GET /api/v1/sync` uses). A doc re-exports when its row OR any of its annotations changed. `overlap()` steps the cursor back 1s so a same-second commit (RFC3339 is second-resolution) isn't skipped; re-export is idempotent.
- **Sweeps are serialized** (`sweepMu`) so the 15s ticker and on-demand `Refresh` can't write the same file at once. `GET /api/v1/export/stats` triggers a `Refresh` then returns the snapshot (`{enabled, dir, doc_count, annotation_count, last_export_at, last_error}`) — a UI refresh forces an immediate mirror.
- Wired in `api.New` (goroutine started only when `enabled`). e2e coverage: `e2e/smoke.js` `runExportChecks`.

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
- `golang.org/x/net` — SOCKS5 proxy dialer (for yt-dlp proxy health checks)
- `golang.org/x/image` — image processing
- `CertMagic` — TLS (post-M1)
- `github.com/markusmobius/go-trafilatura` — HTML content extraction (direct dep, not indirect)
- `github.com/playwright-community/playwright-go` — headless browser scraping (direct dep, not indirect)
- `github.com/JohannesKaufmann/html-to-markdown/v2` — HTML→Markdown conversion (direct dep, not indirect)
- `github.com/yuin/goldmark` — Markdown processing (direct dep, not indirect)
- `gopkg.in/yaml.v3` — YAML parsing (direct dep, not indirect)
- LLM: plain HTTP client to Anthropic + OpenAI-compat endpoints (post-M1)
- **yt-dlp**: external binary (not a Go library) — invoked via `os/exec`. Must be installed separately on the host.