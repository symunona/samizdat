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
    llm/
      router.go             # THE router: NewRouter(cfg) → discovery + fallback chain; Complete / CompleteRoute
      provider.go           # Provider: id, transport, flavor, base URL, key resolution (env fallback)
      discover.go           # config + [[llm.fallback]] + env keys + well-known localhost:11434, deduped
      probe.go              # ACTIVE checks: reachable / auth / credits (the only path that asks)
      models.go             # per-provider model catalog (5-min cache) for the app's model picker
      health.go             # package-level provider-health registry: Record, Snapshot, Restore, SetPersist
      health_test.go        # unit tests for classify, Record, Restore
    api/
      router.go             # http.NewServeMux() — wire all routes
      health.go             # GET  /api/v1/health          (public)
      pair.go               # POST /api/v1/pair            (public, code→token)
      me.go                 # GET  /api/v1/me              (bearer-authed)
      admin_pair.go         # POST /api/v1/admin/pair/new  (passphrase + loopback only)
      admin_test_device.go  # POST /api/v1/admin/test-device (loopback only) — idempotent: one reusable robot device, rotates its token
      media.go              # GET  /api/v1/media/{id}      (asset serving)
                            # GET  /api/v1/documents/{id}/audio (audio streaming)
      ytdlp_status.go       # GET  /api/v1/ytdlp/status    (bearer-authed, proxy POOL health)
      llm_status.go         # GET  /api/v1/llm/status      (bearer-authed, provider health + spend)
                            # GET  /api/v1/llm/models      (bearer-authed, model catalog per provider)
                            # POST /api/v1/llm/probe       (bearer-authed, ACTIVE probe; ?deep=1 spends 1 token)
      middleware.go         # bearerAuth, localhostOnly guards
      sync.go               # GET  /api/v1/sync            (bearer-authed, incremental pull)
      sync_test.go          # unit tests for cursor correctness
      jobs.go               # POST /api/v1/jobs            (bearer-authed, idempotent enqueue)
      pipeline_steps.go     # GET  /api/v1/pipeline-steps  (bearer-authed, step catalog)
      pipelines.go          # CRUD for pipelines; redacts secrets on every read path
      pipelines_test.go     # integration test: api_key round-trip (preserve + redact)
    proxypool/
      pool.go               # THE residential egress pool for yt-dlp: ordered list, health, rotation
      pool_test.go
    extractor/
      substack_notes.go     # SubstackNotesAdapter: discovers Notes via Substack reader API
                            # (no auth, no headless browser — profile page gates anon after 2 items)
    transcript/
      vtt.go                # WebVTT parser → []Segment{StartMs,EndMs,Text}
    pipeline/
      catalog.go            # Register(KindSpec, Handler) — single registry for all step kinds
      prompt.go             # renderPrompt(tmpl, vars): single-pass {{token}} expansion
      steps_json.go         # RedactSecrets / PreserveSecrets — JSON rewrite helpers
      backfill.go           # BackfillStepPrompts: one-shot migration to write default prompts
      backfill_test.go
      prompt_test.go
      steps_json_test.go
      step_*.go             # one file per step kind; each calls Register in init()
    worker/
      youtube.go            # yt-dlp ingest: audio + transcript → video Document
      pdf.go                # PDF text extraction, figure splicing, layout reconstruction
      pdffig.go             # figure detection (content-stream walk), box geometry, captions
      pdfrender.go          # MuPDF rendering via go-fitz: page→bitmap, crop→PNG, asset store
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
  --       "ytdlp_proxy_last_ok" (JSON {proxy: RFC3339}, persisted across restarts)
  --       "ytdlp_proxy_last_ok_at" (pre-pool scalar; read once to seed the above)
  --       "llm_provider_health" (JSON []llm.ProviderHealth, see LLM provider health)
  --       "pipeline_step_prompts_backfilled" (RFC3339, guards the one-shot prompt backfill)
  --       "auto_archive_enabled" ("true"/"false", opt-in; drives worker.sweepAutoArchive)
);

CREATE TABLE IF NOT EXISTS documents (
  ...
  content_hash    TEXT NOT NULL DEFAULT '',
  media_type      TEXT NOT NULL DEFAULT 'article',  -- 'article' | 'video'
  media_metadata  TEXT NOT NULL DEFAULT '',         -- JSON: {provider, external_id, duration_ms, transcript_status, orig_lang, transcript_langs}
  transcript      TEXT NOT NULL DEFAULT '',         -- JSON: {lang: [{start_ms,end_ms,text}]} (video only; legacy rows may be a bare array)
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

## Auto-archive sweep (`worker.sweepAutoArchive`)

Opt-in (`server_settings.auto_archive_enabled`, served + patched by `/api/v1/settings`),
run on the existing 60s scheduler tick — **not** a Job: there is nothing to retry, meter
or dedup, and a queue row per sweep would be noise. `ArchiveOldHighlights` stamps
`archived_at` on every non-deleted, non-archived, **non-pinned** Highlight older than one
month, `rev + 1` per row so the phone pulls the change through the normal sync feed.
Pinned is the user's explicit keep — a sweep must never undo triage.

## Job enqueue idempotency (`POST /api/v1/jobs`)

`scrape_url` jobs are deduplicated by URL at enqueue time. The logic in `jobs.go` (`create`) applies **before** `InsertJob`:

1. `GetLatestScrapeJobForURL` — queries the latest non-deleted `scrape_url` job for the canonical URL (ordered by `updated_at DESC`).
2. **`dead`** → retry in place: `RetryJob` resets `run_after` and `updated_at` on the existing row (no new row). Response: `{job_id, deduped:true, retried:true}`.
3. **`queued`/`running`/`paused`/`done`** → reuse: return the existing `job_id` with no write. Response: `{job_id, deduped:true, status:<existing>}`.
4. **`sql.ErrNoRows`** (no prior job) → normal insert. Response: `{job_id, deduped:false}`.
5. Any other DB error → 500.

**Rationale:** Document dedup by `canonical_url` only prevents a duplicate *Document* at run time — it does not prevent a duplicate *queue row*. This closes the gap for extension double-pin, reader re-add, and manual retry scenarios.

**`done` is a no-op**: a URL that was already successfully scraped will not be re-scraped via this endpoint, even if the user re-submits it. Intentional — use a dedicated re-scrape flow if needed.

**JSON field `json_extract(payload, '$.url')`** is used in the SQL query — the URL is embedded in the job payload JSON, not a dedicated column. This means the `url` key in the payload must remain stable.

## Sync endpoint (`GET /api/v1/sync`)

Incremental pull for phone clients. Uses an `updated_at`-based cursor with `>=` filter (RFC3339 second resolution).

**Cursor contract (critical):** `server_time` in the response is sampled with `time.Now()` **before** any DB reads, not after. This makes it a guaranteed lower bound: any write that occurs concurrently during the multi-query read window has `updated_at >= serverTime`, so the next pull with that cursor re-selects it. Sampling server_time after the reads (the old bug) allowed a concurrent write to land in the read gap yet sit below the returned cursor — the client would advance past it and skip it forever.

- Re-delivered rows are idempotent client-side (LWW).
- The `>=` filter means same-second updates (doc's `updated_at` equals the cursor) are always included, never skipped.
- **Do not move the `serverTime` sample** to after the DB reads without carefully re-reading the race analysis in `sync.go`.

## Domain model naming (exact, no synonyms)
`Document` · `Highlight` · `Annotation` · `Note` · `Feed` · `Subscription` · `Scraper` · `Pipeline` · `PipelineStep` · `Job` · `Schedule` · `Tag` · `UserProfile`
Banned: `Content`, `Memory`, `Source`, `Parsed*`, `Cron`, `Url`

## Highlight vs Annotation (critical distinction)
- **`Highlight`** — LLM-extracted unit from a Document. Machine data. Server→phone **one-way**. Created by `Pipeline`.
- **`Annotation`** — user-created text selection on a `Document` or `Highlight`. Has a text anchor (W3C TextQuoteSelector JSON) + optional note body (markdown). User-authored → **two-way sync** (LWW push). Never machine-generated.
- **Video annotations** additionally carry `media_ts_ms` (playback timestamp in milliseconds; 0 = not a video annotation). This is the only permitted deviation from the text-anchor model.
- **Standalone note** — an `Annotation` with `document_id = NULL` and no anchor (`exact`/`prefix`/`suffix`/`pos_*` empty/zero). Created via `POST /api/v1/annotations` (no `{id}` segment; `note` required, server force-clears anchor fields). NOT a separate entity — the nullable `document_id` is the only structural difference, so it rides the annotation sync feed + tagging + export unchanged. Export writes it as its own note file with a `> [!note]` callout (no `document:` backlink). Client `Annotation.document_id` is `string | null`.

## Schema migrations (`store/open.go` `migrate()`)
Additive changes (new table / new column with default) go in the `additiveMigrations` slice (`ALTER TABLE … ADD COLUMN`, idempotent — duplicate-column errors ignored). **Non-additive** changes (relax NOT NULL, change type) need a SQLite table rebuild: create `_new`, `INSERT … SELECT`, `DROP`, `RENAME`, re-create indexes — inside a txn, with `PRAGMA foreign_keys=OFF` toggled *outside* the txn (safe because `MaxOpenConns(1)`), and guarded by a `PRAGMA table_info` check so it's idempotent. Precedent: `relaxAnnotationDocumentID()` (document_id NOT NULL → nullable) — read it before writing another.

## Image URLs: absolutize at ingest, embed as wikilinks on export

**`trafilatura.Options.OriginalURL` does NOT rewrite `<img src>`** — a site-relative
src (`/images/x.png`) survives into `documents.markdown` verbatim, and from there the
whole image chain fails silently: `assets.go`'s `markdownImageRe` only matches
`http(s)` targets → no download → no `media_assets` row → the vault exporter (which
keys its rewrite on `media_assets.original_url`) has nothing to swap → a dead link in
Obsidian, and a broken image in the app. Absolutization therefore happens at **two
points** during scrape:

1. **HTML level** (`unwrapFigureImages(rawHTML, base)`): site-relative `src` on
   `<figure><img>` elements are resolved before trafilatura sees the HTML, because
   the http-only filter in `figureContentImages` would otherwise drop them entirely.
2. **Markdown level** (`absolutizeImageURLs(md, base)`): called after html→md
   conversion, catches any remaining relative targets that trafilatura emitted
   (non-figure images). Both passes use `absolutizeURL(raw, base)` which is a no-op
   for absolute, `data:`, and unparseable values.

Anything that produces markdown for a Document must keep image targets absolute or
a `/api/v1/media/<id>` route.

Export (`internal/export`) rewrites **image syntax**, not raw URL substrings, and keys
on BOTH `media_assets.original_url` and `/api/v1/media/<id>` — PDF figures and
pipeline-injected heroes are written as the media route, whose `original_url` is a
synthetic `pdf://…` that appears nowhere in the body. Default embed style is
`![[<file>]]` (`[export] image_links`, `wikilink|relative`): no path, so Obsidian
resolves by name and notes survive being moved. Alt text rides as the wikilink alias
(`![[f.png|caption]]`) — `wikiAlias` strips `|`/brackets and drops a bare number,
which Obsidian would read as a width.

### An idle export sweep must touch NOTHING on disk

The exporter ticks every 15s and something *watches* the vault — Syncthing on this box,
Obsidian on the phone — so a rewrite is a sync event even when the bytes are identical.
Two rules keep an idle sweep silent, and both are load-bearing:

- **The cursor sits AT the newest `updated_at`, never before it.** `ListDocumentsSince`
  filters `updated_at >= cursor`, so a row committed in that same (second-resolution)
  timestamp is re-selected anyway — the old `overlap()` that rolled the cursor back one
  second only guaranteed the newest doc was re-selected and re-exported *forever*, one
  file-change event per tick on a DB nobody had touched in weeks.
- **`writeNote` / `writeIndex` skip a byte-identical file** (`unchanged`). This is the
  backstop: any future re-export of an unchanged row costs an mtime bump otherwise, and
  `_index.md` is rewritten on every sweep that does any work at all.

`GET /api/v1/export/stats` calls `Refresh` (a full sweep) on every request, so the same
rules are what keep the Settings card from churning the vault each time it paints.
Guarded by `TestSweepIsQuietWhenNothingChanged`.

## Document media types
- **`media_type = 'article'`** — default. HTML scrape via Playwright + Trafilatura.
- **`media_type = 'pdf'`** — PDF ingest via plain HTTP + pure-Go text extraction
  (`worker/pdf.go`). **Never route a PDF through the browser**: Chromium answers a
  PDF navigation with `playwright: Download is starting` and no page, which failed
  every PDF scrape permanently (job `dead` after 3 attempts, no Document row at
  all). `handleScrapeURL` branches on `isPDFURL` *before* the browser fetch;
  extension-less PDF URLs are caught by retrying on that same download error and
  sniffing the content type.
  - `media_metadata`: JSON `{pages, bytes}`.
  - `markdown`: extracted text, one page block per page.
  - Extraction works from the raw positioned glyphs (`Page.Content().Text`), not
    the pdf library's `GetPlainText`/`GetTextByRow` helpers — those concatenate
    glyphs and drop the geometry, and typeset PDFs encode word breaks as
    positioning rather than space glyphs, so the helpers return `WhyareallLLMs`.
    Word spaces come back from the inter-glyph gaps; the two-column reading order
    comes from a document-wide gutter x (measured across all pages, because one
    page's evidence is too weak) used to cut lines that carry both columns.
  - **Figures** (`worker/pdffig.go` + `worker/pdfrender.go`). Two problems hide
    behind "extract the images": raster figures are image XObjects, but most
    academic figures (TikZ, matplotlib, pgfplots) are *drawing operators* with
    nothing to extract — the ResNet paper yields **zero** image XObjects. So
    figures are **rendered, not extracted**:
    - **Detection** walks the content stream with `pdf.Interpret` (`cm` CTM +
      `Do` on Image/Form XObjects + painted path ops). Clipping paths (`W n`)
      are ignored — a clip is usually the whole page and would swallow it.
      Boxes within 12pt merge; < 60×40pt is furniture; a box repeating at the
      same spot on >half the pages is a running header. **Do not** try to get
      these boxes from go-fitz — MuPDF exposes whole-page output only
      (`Image`/`ImageDPI`/`SVG`/`Text`/`HTML`), no page-object enumeration.
    - **Rendering** is MuPDF at 150dpi, one render per page, cropped per figure
      (`pixelRect` maps points→pixels off the MediaBox and the bitmap's own
      size, never the nominal DPI). PNG, not JPEG — figures are line art.
    - Assets get a synthetic `original_url` (`pdf://<doc>/p<page>/fig<n>`) so
      re-scraping overwrites instead of duplicating. Markdown carries a
      `sam-figure:N` placeholder until `storePDFFigures` returns real URLs;
      `resolveFigures` deletes any placeholder that never got one, so a failed
      render can never leave a broken image.
    - Tables are detected too (they are ruled drawings) — you get both the crop
      and the table text. Deliberate: the column-flattened text of a table is
      often unreadable, the picture is not.
    - **Text drawn INSIDE a figure box is lifted out of the prose stream**
      (`takeInterior` → `interiorBlock` in `pdf.go`) and re-attached under the
      image as a collapsed `<details><pre>` block, one printed row per `<br>`.
      Without this, `reflowParagraphs` reads every full-width table row as a
      wrapped line and glues the whole table into one paragraph of numbers, and
      `splitAtGutter` tears a wide table's right-hand columns off to a different
      part of the page. The text stays in `documents.markdown` — searchable,
      exported, visible to `DetectFalseParse` — only visually subordinate.
      Two guards: a box absorbing > 60% of a page's fragments is treated as
      mis-detected and nothing is moved; fewer than 3 interior lines (a lone axis
      label) are left in place. The block is ONE line and `reflowParagraphs`
      skips it by its `<details>` prefix, the same way it skips `![`.
    - Still open: the caption is duplicated — once (truncated to its first line)
      in the image `alt`, once inline as prose. `captionFor` only ever takes one
      line, so dropping the inline copy would lose the continuation.
    - There is **no table parser**. MuPDF's `fz_table_hunt` is inside the static
      archive we already link, but go-fitz doesn't expose it (`opts.flags = 0`);
      a real `| a | b |` needs a go-fitz fork. See
      `plan/2026-07-29-pdf-table-parsing-research.md`.
  - A scanned/image-only PDF has no text layer → `DetectFalseParse` flags the
    Document and the job fails permanently. No OCR.
  - **cgo is REQUIRED for the server** because of MuPDF (`just build` sets
    `CGO_ENABLED=1`). `CGO_ENABLED=0` still *compiles* — go-fitz silently swaps
    in a purego path that dlopens a `libmupdf.so` this box does not have — and
    then fails at scrape time. go-fitz vendors static `.a` archives per platform,
    so there is no system package to install; the binary just links glibc
    dynamically (~29MB → ~42MB). `cli/` stays `CGO_ENABLED=0`.
  - MuPDF is **AGPL-3.0**, which is why the repo now carries an AGPL `LICENSE`.
  - Library: `github.com/ledongthuc/pdf` (pure Go, no cgo). `dslipak/pdf` was
    tried and rejected — its `GetPlainText` burned >2min of CPU on a 21-page paper.
- **`media_type = 'video'`** — YouTube/podcast ingest via yt-dlp. Fields:
  - `media_metadata`: JSON `{provider, external_id, duration_ms, transcript_status, orig_lang, transcript_langs}` where `transcript_status` ∈ `"subs" | "auto" | "none"` (of the original track), `orig_lang` is the original language code, and `transcript_langs` lists all languages present.
  - `transcript`: JSON **lang-keyed map** `{lang: [{start_ms, end_ms, text, new_para?}]}` (empty object `{}` when none). Legacy rows may still hold a bare array `[...]`; the app parsers accept both.
  - `markdown`: flattened transcript prose — sentences run together, paragraphs separated by a blank line; falls back to video description when no transcript.
  - **A segment is a SENTENCE, not a caption cue** (`internal/transcript`). Two things
    happen between the `.vtt` and the row, and both are load-bearing:
    - **Roll-up de-dup** (`ParseVTT`). YouTube auto-captions emit every spoken line
      three times — a paint-on cue carrying inline word timings (`<00:00:01.000>`),
      a ~10ms "settle" cue holding the finished line, and the same line again as the
      carried-over first line of the next cue. The joined cue texts run A, "A B", B,
      "B C" …, which is never *equal* to its predecessor, so the original cue-level
      dedup dropped nothing and every video body was **~3x its real text** (and every
      LLM step paid 3x tokens). Roll-up is detected by those inline timings; in that
      mode each LINE is a candidate and a line equal to the last emitted one is
      dropped. Window of one — the only false drop is a line repeated verbatim
      back-to-back. Manual subtitle tracks have no inline timings and keep the
      per-cue path.
    - **Sentence reflow** (`Reflow`). A cue is a ~35-char display wrap cut
      mid-sentence, so cues are concatenated and re-cut at sentence boundaries, with
      each segment re-timed by interpolating within the cue its first/last character
      fell in. `>>` is YouTube's speaker marker: it is stripped and forces a break.
      `NewPara` marks a paragraph opening (speaker change, silence gap > 2.5s, or a
      paragraph past ~700 chars). Guards both ways: a run-on past 350 chars / 20s is
      split at a clause boundary, a sentence under 40 chars is glued to the next.
    - **Never render one block per cue.** That was thousands of mid-sentence stubs,
      it broke TextQuoteSelector anchors across the wraps, and it fed the LLM
      shredded prose. The app renders `.seg` spans grouped into `.para` blocks.
  - `worker.BackfillTranscripts` repairs rows written before that, one-shot, guarded by
    `server_settings.transcripts_reparsed_rollup`. It re-parses the cached `.vtt`
    (kept in `<cache>/media` exactly so this needs no yt-dlp and no network); a row
    whose subtitles are gone falls back to `transcript.DedupRollup`, which recovers
    each line from the stored segments by stripping the leading copy of the one before
    it. A row that yields nothing is left untouched — never replace a body with nothing.

## Step catalog + prompts live in config, not in Go

`internal/pipeline/catalog.go` is the single registry: `Register(spec KindSpec, h Handler)`
binds a step's handler and its `[]FieldSpec` in one call, so the two cannot drift. Adding a
step kind = one `Register` in the step's `init()`. `GET /api/v1/pipeline-steps` serves
`Catalog()` so the app renders a config editor it never hardcodes.

- **The prompt is a config value, not a const.** Each LLM step's default prompt is the
  `prompt` FieldSpec's `Default`; the handler falls back to it (`defaultPrompt(kind)`) only
  when the step config carries none. Tuning a prompt is a DB edit, not a redeploy.
- **One renderer for all four LLM steps** (`prompt.go`): `renderPrompt(tmpl, vars)` expands
  `{{title}}` / `{{content}}` / `{{recently_covered}}` in a single pass (document text that
  contains a token is never re-expanded). Every catalog default ends with the shared
  `promptTemplateTail`; a stored template with no `{{content}}` gets `legacyPromptTail`
  appended, so a hand-typed one-line prompt still receives the document.
  `TestDefaultPromptsComposeLegacyMessage` is the guard that a default-config pipeline sends
  a byte-identical message to the pre-templating one — don't "tidy" the prompt consts.
- **No step field is a credential.** `model` (type `model` — the app renders a picker off
  that) and `provider` (a Router provider id) are the only routing keys; the endpoint and
  the key belong to the Router. `TestStepCatalogDeclaresNoCredential` fails the build if
  `api_key`/`base_url` ever reappear in a kind spec.
- **The prompt backfill is NOT in `store.migrate()`** — the catalog lives in `pipeline`,
  which imports `store`, so a migration there would be an import cycle.
  `pipeline.BackfillStepPrompts` runs in `main.go` right after `store.Open`, guarded by
  `server_settings.pipeline_step_prompts_backfilled` and by a per-step "already has a
  prompt" check. Any future data migration needing engine code goes the same way.

### Credentials never live in a pipeline row

Design rule 5 used to be defended with a redact-on-read / re-inject-on-write pair around a
`Secret: true` field. That whole machinery is gone with the key it protected: a step names
a provider id, and the Router resolves the endpoint and its key from config.toml + env.

What remains is one function. `pipeline.StripCredentials(stepsJSON)` removes every
credential-*named* key (`api_key`, `secret`, `token`, `password`, `passphrase`, any case,
`apiKey` too) from every step config on **every read path** (`GET /api/v1/pipelines`,
`GET /api/v1/pipelines/{id}`, and the PUT response). Keyed on the NAME, not on the
catalog, so it also covers a legacy row and a hand-added key no kind declares — the case a
catalog-driven redaction always missed.

There is deliberately **no write-side counterpart**: nothing reads these keys any more, so
a save that drops one loses nothing the server would have used. The app mirrors the same
name test (`SECRET_KEY` in `pipelines.tsx`) as a second lock, including in its raw-JSON
view.

`steps_json.go` keeps the operation as a pure string→string function so it is unit-testable
without an HTTP stack, and the JSON rewrite stays raw-message-level to preserve unknown keys.

## The LLM Router owns every endpoint (`internal/llm/router.go`)

`llm.NewRouter(cfg.LLM)` is built ONCE in `api.New` and threaded api → worker →
`pipeline.Dispatch` → `Handler`. Steps take a `*llm.Router`, never a `Client`: choosing
an endpoint is routing, and routing has one owner. Before it, all four `step_llm_*.go`
carried their own `provider`/`base_url`/`api_key`/`model` keys and their own
`llm.New(config.LLMSection{…})` block — four copies of the router, and a credential in a
DB row.

- **A step names a provider id, nothing else.** `provider` + `model` are the only routing
  keys in a step config. `base_url` and `api_key` are gone from every step spec: the
  Router resolves the endpoint and the key from config.toml + env. A legacy row that
  still carries one is stripped on read (`pipeline.StripCredentials`) and dropped on the
  next save.
- **Pinning is pinning.** `CompleteRoute(ctx, Route{Provider: id}, msgs)` uses that
  provider and does **not** fall back. A step aimed at the local box must fail when the
  box is down, never quietly spend cloud money. An empty `Route.Provider` uses the chain
  (primary → each fallback, on `ErrTransport` only).
- **Legacy provider names still resolve.** Rows written before the Router stored a bare
  transport (`"anthropic"`, `"openai_compat"`); `Router.resolve` falls back to the first
  provider on that transport. Don't remove that path while such rows exist.
- **Provider ids** are brands for cloud endpoints (`anthropic`, `openrouter`, `openai`)
  and `host:port` for anything self-hosted — the only thing that tells two Ollama boxes
  apart. `Provider.HealthKey()` is a SEPARATE identity (`transport@base_url`): the health
  rows and `llm_usages` were written with it, and renaming it would orphan them.
- **A model name belongs to ONE provider.** An unset model still resolves inside the
  client to that endpoint's `default_model` (anthropic ends at
  `claude-haiku-4-5-20251001`; `openai_compat` errors naming `llm.default_model` — a local
  box serves only what was pulled onto it). Never re-introduce a provider-specific default
  in a step. `Usage.Model` reports what actually ran, and steps write that (via
  `pipeline.servedModel`) to `llm_usages` and to the Highlight's provenance.
- **Params travel with the route and come back as what was SENT.** `llm.Params`
  (`model`, `max_tokens`, `temperature`) rides `Route` into the client; each adapter
  echoes the *effective* values in `Usage`. Unset stays unset — a local box has its own
  Modelfile defaults and an invented number would silently override them — except
  Anthropic's mandatory `max_tokens`, which reports the 4096 it really sends.
- **How a Highlight was made lives in `highlights.metadata`, never in `body`.** Body is
  markdown that syncs, exports to the vault and the user edits; provenance appended there
  duplicates on regenerate and is lost on edit. `pipeline.llmStepCall` is the ONE path
  from a step to the LLM: it routes, writes the `llm_usages` ledger row and returns the
  provenance JSON (`model`, `provider`, `step`, `max_tokens`, `temperature`,
  `tokens_in/out`, `prompt_sha` — a fingerprint of the prompt TEMPLATE, so a summary can
  be dated against a prompt change). Steps differ in how they parse a reply, never in how
  they call or account for it. The metadata's `provider` prefers the step's PINNED
  provider id (a pin never falls back, and `localhost:11434` says which box where
  `openai_compat` says only which protocol); the ledger keeps the transport name, which
  is what `llm_status` aggregates spend by.
- **`max_tokens` is exempt from the credential name test** (`notCredentialRe` in
  `steps_json.go`, mirrored by `NOT_SECRET_KEY` in the app's `pipelines.tsx`). It contains
  "token", so `StripCredentials` ate it: the field never rendered in the step editor and
  the next save dropped it. Keep the two exemptions in step.
- **Ollama's context defaults to 4096 tokens and truncates silently.** The OpenAI-compatible
  endpoint has no `num_ctx`, so bake it into a model variant (`FROM qwen3:4b-instruct` +
  `PARAMETER num_ctx 7168` → `ollama create`) rather than setting `OLLAMA_CONTEXT_LENGTH` on
  a box other people share. Size the context to what stays on the GPU (`ollama ps` prints the
  split) — the first byte that spills to CPU roughly halves throughput. Then tell the server
  the same number in `[llm.summarize.<role>] ctx_tokens`: it is the ONLY thing keeping a
  prompt inside the window, because an oversized one comes back as a confident answer about
  whatever survived, not as an error.
- **Name a self-hosted box by DNS, never by IP** (`http://xayah.tail7f475e.ts.net:11434/v1`).
  A `providerID` is `host:port`, so the address in `base_url` is also the identity every
  pipeline step pins — and an IP is not stable: rebuilding the tailnet box moved it, which
  took the routing primary down AND orphaned the pinned step in one go. Because a pin never
  falls back, the failure is silent in the worst way: `[llm]` alone would have fallen through
  to the cloud fallback, but re-addressing the endpoint without updating the pins turns
  every affected step into a hard error. Grep `pipelines.steps` for the old `host:port`
  whenever `base_url` changes.
- **Ollama binds `127.0.0.1` by default**, so a box that answers `ollama list` over ssh can
  still be `connection refused` from here. `OLLAMA_HOST=0.0.0.0:11434` in a systemd drop-in
  is what makes it a tailnet provider — and it has no auth, so that also exposes it to
  whatever LAN the box sits on.

### Discovery (`discover.go`)

Deduped by `HealthKey`, in routing order: `[llm]` → `primary`, each `[[llm.fallback]]` →
`fallback`, then anything an env key makes usable (`ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`, `OPENAI_API_KEY`) and the well-known `http://localhost:11434/v1` →
`available`. **There is no LAN scan** — the LAN Ollama box is whatever `base_url` names;
sweeping a subnet would be slow, rude, and would invent endpoints nobody asked to send
documents to.

`available` providers populate the model picker and `just check-llm`, but nothing routes
through them, so they never raise the app's alert dot (only `primary`/`fallback` do).

### Probe (`probe.go`) — the only thing that actively asks

`POST /api/v1/llm/probe` (→ `just check-llm`, → the Settings **Probe** button). Never on a
render path; that is exactly why `health.go` stays passive. Cheapest honest check per
flavor:

| Flavor | Check | Credits |
|---|---|---|
| local / openai_compat | `GET {base}/models` | `n/a` — no balance to run out of |
| OpenRouter | `GET /api/v1/models` + `GET /api/v1/key` | real numbers (`$6.30 used of $10`) |
| Anthropic | `GET /v1/models` (proves the key) | **no endpoint exists** — see below |

- **Anthropic has no balance API.** Shallow: credits come from the health registry's last
  recorded `quota` error. `?deep=1`: a `max_tokens`-1 completion settles it for
  ~$0.000001, and because it goes through the normal client it also *updates* the health
  registry — probe and passive status agree by construction. `just check-llm` runs deep by
  default (it is a manual command); `--shallow` opts out. The Settings button is always
  shallow — it is one tap away from a render.
- **Unreachable means nothing is listening.** A 4xx came back over a working connection:
  the box is up and refused the request (`reachable: true`, `auth: bad_key`). Only
  `ErrTransport` sets `reachable: false`.
- A provider with **no key is never contacted** — claiming reachability we never
  established would be a guess.
- `anthropicBaseURL` is a `var`, not a const, so probe tests can point it at an httptest
  server (same trick as `extractor.substackAPIBase`). One real value.

### Ad-hoc completions (`api/llm_ask.go`, `POST /api/v1/llm/ask`)

The one path from a UI to the Router — the reader's selection context menu
(translate / ask a question). Routing rules are a pipeline step's: a named
`provider` is **pinned** (no fallback), an empty one uses the chain.

- **There is no system role.** The Anthropic Messages API takes `system` as a
  top-level field, not a turn, and both adapters share one `llm.Message` shape —
  so the request's `system` (the user's master prompt) is PREPENDED to the user
  message here, on one code path for both providers.
- **Metered like any other call**: one `llm_usages` row per ask, with `job_id` and
  `pipeline_run_id` nil (it belongs to neither). An ad-hoc ask spends real money,
  so it belongs in the ledger the Settings spend summary reads.
- Bounded: `askMaxRunes` (413 past it) and a 120s context — an unbounded paste must
  not become an unbounded bill, and a box that stopped answering must fail the
  popout rather than hold the request open. `ErrNoProvider` → 503, a provider error
  → 502 with its reason (never a stack trace).

### The context menu is a server setting (`internal/ctxmenu`)

`server_settings.context_menu`, served + patched by `/api/v1/settings` beside
`language_prefs`. It holds the master prompt and the menu items; `Normalize()` runs
on **both** read and write, dropping rows the device could not execute (no id,
unknown kind) and filling the per-kind blanks — a row that renders in the sheet and
does nothing is worse than a missing one. Routing is a `provider` id + a `model`,
never an endpoint or a key (same rule as a pipeline step).

### Model catalog (`models.go`)

`GET /api/v1/llm/models` → groups of `{provider_id, provider_label, role, models[]}`,
cached 5 minutes (`?refresh=1` busts it). All four flavors serve the OpenAI-shaped
`{"data":[…]}` list. Anthropic **without** a key answers with the tiers `CLAUDE.md` names
(Haiku/Sonnet/Opus) — an empty picker for the provider you are about to configure is worse
than a short honest list. An unreachable provider contributes an `error` on its group,
never an empty picker for everyone else.

## How much document a step sends (`pipeline/llm_long.go` + `[llm.summarize]`)

Every LLM step goes through `llmStepCallLong`. It replaced four hardcoded
`content[:12000]`/`[:16000]` byte slices — which dropped everything past the first few
thousand tokens, said nothing about it, and could cut a multi-byte rune in half.

Three bands, sized from config, in **estimated** tokens (`EstimateTokens` = runes/3, with
another third of the window held back as headroom; there is no tokenizer, and being wrong
low is invisible while being wrong high is loud):

| Band | Condition | What happens |
|---|---|---|
| small | `< chunk_above` | one call, the step's own config — byte-identical to before |
| medium | `< big_above` | `Split` → one call per chunk (`map` role) → one fold (`reduce` role) |
| large | else | one call to the `big` role, clamped to its window, with a visible note |

- **Chunk size is derived, never configured** (`ChunkBudget`): `ctx_tokens*2/3 − max_tokens −
  prompt`. A knob for it would be a second, staler copy of `ctx_tokens`.
- **One chunk per job tick.** `worker.stuckJobAge` requeues a job whose `updated_at` is over
  10 minutes old, and a dozen sequential calls to a local model cross that — the reset would
  run a second worker on the same run: double spend, duplicate Highlights. Ticking keeps
  `updated_at` fresh and makes a crash cost one chunk instead of all of them.
  `StepResult.Continue` skips `stepRetryDelay` for a tick that made progress (that delay is
  backoff, and progress is not a failure).
- **map→reduce is for LOSSY steps ONLY. Extraction uses `partition`.** The fold never sees
  the document — it sees five-bullet chunk summaries. That is correct for `llm_summarize`,
  whose output is lossy prose by definition, and **catastrophic** for a step whose prompt
  says "verbatim": the source text is gone by the fold, so the model invents plausible
  replacements. On a real James Clear 3-2-1 issue it produced a Dolly Parton quote she never
  said and attributed a Steve Jobs line to Carl Jung — both real, named people, written to
  Highlights that sync to the phone and export to the vault. `partition` is the lossless
  strategy: run the STEP's own prompt on each chunk and union the results. No map prompt, no
  fold. `chunkStrategyFor(kind)` **defaults to `partition`** and only `llm_summarize` opts
  out, so a new step kind is safe without remembering to opt in — same polarity as
  `toleratesTruncatedReply`. Never route an extraction step through map→reduce.
- **`planRun` returns an explicit `band`; nothing re-derives it.** It used to return `nil`
  for four different reasons and `singleCall` guessed which from `EstimateTokens(content) >=
  ChunkAbove` — a test that cannot tell "too small to chunk" from "chunked, but it came out
  as ONE chunk". The second landed in the `big` role: a document that fits the local box in
  one call was sent to the cloud with the big cap, which is how a 12067-rune newsletter met a
  1024-token cap and truncated. The window was `[chunk_above*3, ChunkBudget(map) - overlap]`
  runes, so **raising the local model's context made it bigger** and sent MORE work to the
  cloud — and it is a design-rule-5 leak, routing paywalled content to a cloud LLM with no
  gate and no log line.
- **`CompactForLLM` (`llmtext.go`) runs before the band is chosen.** Link targets are
  stripped from what the LLM sees; the stored Document is untouched. **76% of a real
  newsletter was ConvertKit tracking URLs**, which cost twice: they tokenize ~1.7 runes/token
  against `EstimateTokens`'s assumed 3 (so the estimate under-counts a link-heavy document by
  up to 1.76x), and their bulk pushed a single-call newsletter into the chunking band — which
  is what caused the fabrication above. That issue goes 23238 → 6651 runes, 7746 → 2217
  estimated tokens, and stops chunking entirely. **Image syntax is left byte-identical**,
  targets included: `llm_topics` copies bodies verbatim into Highlights the vault exports,
  and the exporter keys its rewrite on `media_assets.original_url` / `/api/v1/media/<id>`.
- **`EstimateTokens` (runes/3) is NOT always conservative.** `chunk.go` calls it "wrong in the
  safe direction"; measured against the real qwen3 tokenizer that holds for prose (3000 runes
  = 983 tokens) and fails for link-heavy markdown (18000 runes = 10546). Two errors currently
  cancel: `qwen3-sum:latest` really serves **12288** tokens while `ctx_tokens` declares 7168,
  and chunks sized off the under-declared window land inside the real one. **"Correcting"
  `ctx_tokens` to 12288 alone would break it** — chunks would reach ~12800 real tokens and
  the endpoint 400s. Fix the estimator before the declared window.
- **Ollama 0.32.7 ERRORS on context overflow** — `exceed_context_size_error ... request
  (13594 tokens) exceeds the available context size (12288 tokens)` — rather than silently
  dropping the front of the prompt. The older "answers confidently about whatever survived"
  warning still applies to the 4096 `num_ctx` default, not to overflow on a sized model.
- **Chunk text is never stored.** `Split` is deterministic (guarded by a test), so each tick
  re-derives the chunks and takes the one it needs; `pipeline_runs.state` holds only the
  partials and the counters. Storing the chunks would put a copy of every long document in
  the runs table.
- **The fold carries the STEP's own prompt**, not a generic one — the step's output contract
  (caveman bullets, a JSON topic list) is the whole point of the step. Only the `map` pass
  has its own prompt, because a chunk is not an article and the summary prompt makes a model
  write twelve little articles. That map prompt deliberately has **no `__NOT_PARSEABLE__`
  clause**: the sentinel kills the whole Document, and a nav bar is a normal chunk of a real
  article.
- **Escalation, not recursion.** A role that exhausts `max_tries` retries on the `big` role
  (skipped when that resolves to the same endpoint). Partials too large for the `reduce`
  window escalate the same way — there is no recursive fold.
- **A role naming neither provider nor model keeps the step's own routing.** An instance with
  no `[llm.summarize]` block changes how much it sends, never where. That is also why
  `bigCtxTokens` sizes an unconfigured `big` role like the `map` role: the call would still
  land on a 7k local box.
- **A window too small for the prompt fails the step**, loudly. `ChunkBudget` returning 0 once
  meant "skip the clamp", which sent the whole document to a box that could not hold it.
- Provenance gains `chunks`/`calls`/`truncated`; token counts are sums over the run and
  `model` names whoever wrote the final text. Absent `chunks` = one call, and the app card
  renders exactly as before.

## LLM provider health (`internal/llm/health.go`)

**Nothing here probes.** A health check on a render would be a real completion — tokens
and money every time Settings paints — so status is the outcome of the LAST real call.
(The *active* answer lives in `probe.go` above, behind an explicit tap or CLI run.) Both
clients (`anthropic.go`, `openai_compat.go`) `defer Record(provider, baseURL, err)`
on every return path, into a package-level registry. That placement is deliberate:
pipeline steps mint their own clients (`llm.New` per step), so wiring health through
`New` would miss them.

- **Identity is provider+base URL** (`ProviderKey`) — two openai_compat boxes are two
  rows; usage in `llm_usages` only records the provider NAME, so per-endpoint cost is
  not derivable and the API reports spend per provider name instead. The registry's
  per-endpoint `calls` is therefore the ONLY per-box number, and `routed_share`
  (calls ÷ all calls, computed in `llm_status.go`) is what answers "how much is the
  local box actually serving?" on the Settings card.
- **`classify(err)` → `quota | auth | transport | api`.** Anthropic answers a spent
  balance with a plain **400**, so only the message distinguishes "out of credits"
  from "bad request" — that's what `quotaRe` is for. This classification is the whole
  point of the feature: before it, a dead pipeline was the only symptom.
- **Persisted** to `server_settings.llm_provider_health` after every Record, and
  re-read on every `GET /api/v1/llm/status` (in-memory always wins) — so an overnight
  failure survives a restart and a seeded row lands without one (used by `just e2e-int`).
- Rows come from `Router.Providers()` — the API no longer re-derives the client's
  defaulting rules (the old `describeProvider`/`configuredSections` pair is gone). A
  provider dropped from config still gets a row with `role: "retired"`: its spend and its
  error are history worth keeping, but it must never raise the app's alert dot. Neither
  must an `available` one — only `primary`/`fallback` can break a pipeline.
- `llm.HasKey(cfg)` mirrors `newSingle`'s env fallback (`ANTHROPIC_API_KEY`) — keep the
  two in step, or a working provider reads as "No API key configured". The API never
  returns the key itself, only `has_key`.
- **`defer Record(…, err)` uses named return values** — both `anthropic.go` and
  `openai_compat.go` declare `Complete` with named returns (`reply string, u Usage, err error`)
  so the deferred closure captures the final `err` value, not the zero value at defer
  registration. Any future LLM client must follow this same pattern.
- **`restore` is called on every `GET /api/v1/llm/status` request** (not just at startup),
  so a row seeded by another process (or an integration test) becomes visible without a
  restart. In-memory rows always win over persisted ones — `Restore` skips any key already
  present in the registry.

## The yt-dlp egress pool (`internal/proxypool`)

`[ytdlp].proxies` is an ORDERED POOL, and `proxypool.Pool` is its single owner —
built once in `api.New`, threaded into the worker AND read by the status endpoint, so
the Settings card can never disagree with what an ingest actually used. Before it,
`[ytdlp].proxy` was one string: when that one home node blinked, every ingest died
with the bot-block error.

- **Sticky active.** `Current()` keeps the active entry while it is healthy, else the
  first healthy one, else `list[0]`. Not "best of the healthy": re-picking on every
  probe would reshuffle which IP YouTube sees mid-session, and an unprobed pool must
  still be usable — a probe failure is not proof yt-dlp fails.
- **`Attempts()` ends with the UNHEALTHY entries**, deliberately. A stale probe must
  never take the whole pool out of service.
- **Only a bot wall rotates.** `ytdlpRun.exec` retries on the next proxy for
  `isBotBlock(output)` and returns immediately for everything else — a private video
  would otherwise cost one full wait per proxy for the same error.
- **Every yt-dlp invocation goes through `ytdlpRun`** (probe `-J`, audio, video). The
  three sites used to hand-roll `--proxy`/`--cookies`/exec/classify; a fourth would
  have been a fourth copy that silently never rotates.
- **Distinct exit IPs are the number that matters**, not the entry count. Two nodes in
  one household come out of one address, so failing over between them buys nothing —
  `Probe` returns the exit IP for exactly this reason and the app tags duplicates.
- The pool probes with a transport chosen by scheme (`socks5*` vs `http(s)`); yt-dlp
  accepts both, so probing an `http://` entry with a SOCKS dialer would report a
  working proxy as dead.

### A stale binary is a SEPARATE failure class (`internal/ytdlp`)

`isStaleBinaryFailure` and `internal/ytdlp.Checker` exist because the two ways video
ingest dies have the same symptom and opposite fixes. YouTube rotates its
player/signature scheme every few weeks; a behind-by-one-release `yt-dlp` then 403s on
the media fetch — on EVERY proxy. Read as an IP ban, that costs an afternoon of swapping
nodes that were never broken. (It is exactly what happened: the reported "residential
proxy broke" was a 2.5-month-old binary; all seven proxies were healthy.)

- **It never rotates.** `exec` checks `isStaleBinaryFailure` BEFORE `isBotBlock` in its
  continue condition — retrying a signature failure across seven nodes costs seven waits
  for one answer.
- **Its error message names the versions and says "not a proxy problem"** — including
  when the version check says the binary is current, because the diagnosis (swapping
  proxies won't help) holds either way. What it must NOT do then is assert staleness.
- **`Checker.Get` is cached 6h** and compares against the GitHub release list. Offline it
  falls back to age (`StaleAfter` = 30d): being unable to check must never turn a current
  binary into a reported problem, but a year-old one still is. Equal-to-latest is current
  however old the release — yt-dlp going quiet for months is not the operator's problem.
- Served in `GET /api/v1/ytdlp/status` as `ytdlp`, beside the proxies, and it raises the
  app's alert dot (`useServiceAlert`): a broken service, just not a broken proxy.

## Scraper paywall auth (per-domain login)
Paywalled domains reuse the owner's subscription via a persisted browser session,
so gated articles render full-text. Config lives in the existing per-domain seam —
`extractors/<domain>/feed.yaml` — under an `auth:` block (`login_url`,
`user_selector`, `pass_selector`, `submit_selector`, `success_text`,
`paywall_text`). No new TOML section.
- **Session jar:** Playwright `storageState` (cookies + localStorage) at
  `<cacheDir>/auth/<domain>.json`, chmod 0600, gitignored (`**/auth/*.json`).
  `extractor.AuthStatePath(cacheDir, domain)` resolves it.
- **Credential store:** per-domain `{username, password}` in
  `<data_dir>/credentials.toml` (0600, gitignored, `internal/credstore`) — separate
  from the hand-edited config.toml, written programmatically. Keyed by domain
  (`["444.hu"]` table). This is what enables unattended session refresh; it is the
  answer to "where do the creds live" — **not** shell rc / env files.
- **Login:** `POST /api/v1/admin/scraper/login` (loopback-only), body
  `{domain, username, password, save}` → `worker.Login` → `BrowserPool.Login`:
  headless form fill, then the **login success detector** waits for `success_text`
  to appear (SPA-hydration-safe `Locator.WaitFor`, 20s) before saving the jar. When
  `save` is true (default) the credentials are also written to credentials.toml. CLI:
  `sam login <domain>` (`--user`/`--pass` or `SAM_LOGIN_USER`/`SAM_LOGIN_PASS`;
  `--no-save` = jar only, no auto-refresh).
- **Scrape + auto-refresh:** `handleScrapeURL` loads the domain's jar into the fetch
  context (`BrowserPool.FetchHTML(url, statePath)`). If the fetched HTML still shows
  `paywall_text` (`isGated`), the session expired → `refreshSession` re-logins **once**
  from credentials.toml, rewrites the jar, and re-fetches.

## Short-form feeds (Substack Notes, tweet-sized items)

Some feeds publish items that are legitimately a few sentences long. The normal
`DetectFalseParse` length floor reads these as empty stubs and kills the job
permanently — so they need an opt-out.

### `short_form: true` in `feed.yaml`
Mark a feed's extractor config with `short_form: true`. This:
- Exempts Documents from the **length floor** check in both `handleScrapeURL` and
  `handleRunPipeline` (bot/login markers still apply — they matter more on short
  content, not less).
- Enables **`leadLineTitle`**: since the og:title for a profile-scoped feed is the
  author's name (every item would share it), `handleScrapeURL` replaces it with the
  first prose line of the body (stripped of block markers, capped at 90 runes + `…`).

Two pipeline helpers implement the split:
- `pipeline.DetectFalseParse` — normal article path (length floor on).
- `pipeline.DetectFalseParseShortForm` — short-form path (length floor off).

The caller (`handleScrapeURL`, `handleRunPipeline`) selects between them via
`reg.IsShortForm(url)` — the registry lookup is the only branch point; the
detection logic itself is not duplicated.

### `substack_notes` extractor kind
Substack publishes RSS for posts but **not** for Notes. The rendered profile page
hard-gates anonymous visitors after two items ("Log in for more"), so
browser-scraping it silently truncates an active writer's feed.

`SubstackNotesAdapter` (`extractor/substack_notes.go`) uses the **Substack reader
API** instead:
1. `GET /api/v1/user/<handle>/public_profile` → numeric user id
2. `GET /api/v1/reader/feed/profile/<id>?types[]=note` → activity feed

Items are filtered to the profile's own handle (restacks of other writers appear in
the same feed). The API ignores a limit parameter, so `MaxURLs` is applied
client-side. Individual note permalinks render fine anonymously, so only discovery
needs this detour.

`substackAPIBase` is a package-level `var` (not a constant) so tests can swap it
for a local `httptest.Server` without any dependency injection.

The registry keys on **exact host**, so one `extractors/substack.com/feed.yaml` serves
every handle; publication post feeds live on `<handle>.substack.com` — a separate key,
so the existing `natesnewsletter.substack.com` RSS config is untouched.

A shipped extractor config for `substack.com` must set **both**:
- `article_selector` — otherwise trafilatura keeps Substack's marketing chrome
  instead of the note body (a permalink page is ~95% product upsell around a
  tweet-sized body; pruning cuts 246549 → 37666 bytes). Substack's class suffix is a
  build hash (`feedPermalinkUnit-JBJrHa`) — match by prefix, never in full.
- `short_form: true` — otherwise every note trips the false-parse length floor.

**Still open:** pipelines fire on short-form Documents like any other, and an LLM handed
24 characters invents. Narrow the trigger, or teach pipelines to skip short-form docs.