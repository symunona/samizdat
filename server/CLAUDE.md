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
      ytdlp_status.go       # GET  /api/v1/ytdlp/status    (bearer-authed, proxy health)
      llm_status.go         # GET  /api/v1/llm/status      (bearer-authed, provider health + spend)
      middleware.go         # bearerAuth, localhostOnly guards
      sync.go               # GET  /api/v1/sync            (bearer-authed, incremental pull)
      sync_test.go          # unit tests for cursor correctness
      jobs.go               # POST /api/v1/jobs            (bearer-authed, idempotent enqueue)
      pipeline_steps.go     # GET  /api/v1/pipeline-steps  (bearer-authed, step catalog)
      pipelines.go          # CRUD for pipelines; redacts secrets on every read path
      pipelines_test.go     # integration test: api_key round-trip (preserve + redact)
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
  --       "ytdlp_proxy_last_ok_at" (RFC3339, persisted across restarts)
  --       "llm_provider_health" (JSON []llm.ProviderHealth, see LLM provider health)
  --       "pipeline_step_prompts_backfilled" (RFC3339, guards the one-shot prompt backfill)
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
  - `transcript`: JSON **lang-keyed map** `{lang: [{start_ms, end_ms, text}]}` (empty object `{}` when none). Legacy rows may still hold a bare array `[...]`; the app parsers accept both.
  - `markdown`: flattened transcript text (one segment per line); falls back to video description when no transcript.

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
- **`api_key` is `Secret: true`** — omitted from the catalog response, stripped from every
  pipeline GET (`pipeline.RedactSecrets`), and re-injected on PUT when the incoming step
  omits it (`pipeline.PreserveSecrets`, matched by index + kind). Without that merge the UI,
  which never sees the key, would wipe it on every save.
- **The prompt backfill is NOT in `store.migrate()`** — the catalog lives in `pipeline`,
  which imports `store`, so a migration there would be an import cycle.
  `pipeline.BackfillStepPrompts` runs in `main.go` right after `store.Open`, guarded by
  `server_settings.pipeline_step_prompts_backfilled` and by a per-step "already has a
  prompt" check. Any future data migration needing engine code goes the same way.

### Secret field handling (api_key round-trip)

Secret fields (`Secret: true` in `FieldSpec`) follow a strict contract across all three
call sites — deviation breaks silent key wipe:

1. **`GET /api/v1/pipelines` and `GET /api/v1/pipelines/{id}`**: `pipeline.RedactSecrets`
   removes the key entirely from the steps JSON before the response is written. The key is
   **absent**, not blank — a client can tell "never set" from "was set, now redacted" by
   the presence of the field in the spec (`Secret: true`) rather than by the value.
2. **`GET /api/v1/pipeline-steps`** (catalog): the `Default` value of a secret field is
   cleared to `nil`. The field spec itself is still returned so the client knows which
   keys are credentials.
3. **`PUT /api/v1/pipelines/{id}`**: `pipeline.PreserveSecrets` is called before the DB
   write. It matches by **index + kind** and copies any secret key the incoming steps omit
   from the stored steps. An explicitly sent value wins. A kind change at the same index
   does NOT inherit the old key.

`steps_json.go` owns all three operations as pure string→string functions so they can be
unit-tested without an HTTP stack. The JSON rewrite is raw-message-level to preserve
unknown keys.

## LLM model resolution — a model name belongs to ONE provider

A pipeline step that names no model must NOT get a hardcoded Claude id: point the
primary at a local Ollama box and that id is a **404 → a 4xx → not `ErrTransport` →
no fallback → the pipeline dies hard**. So the resolution lives in the client:

- `newSingle` hands each client its section's `default_model`; the client fills in an
  empty model (anthropic still ends at `claude-haiku-4-5-20251001`, `openai_compat`
  errors naming `llm.default_model` — a local box serves only what was pulled onto it).
- `Usage.Model` reports the model that actually **ran**. Steps write that (via
  `pipeline.servedModel`) to `llm_usages` and to the highlight's `metadata.model`,
  so a call served by a fallback is not logged under the primary's model.
- Steps therefore pass `c.Model` straight through, empty and all. Never re-introduce a
  provider-specific default in a step.
- **Ollama's context defaults to 4096 tokens and truncates silently**; the summarize step
  feeds up to 12k chars. The OpenAI-compatible endpoint has no `num_ctx`, so bake it into
  a model variant (`FROM qwen3:4b-instruct` + `PARAMETER num_ctx 7168` → `ollama create`)
  rather than setting `OLLAMA_CONTEXT_LENGTH` on a box other people share. Size the context
  to what stays on the GPU (`ollama ps` prints the split) — the first byte that spills to
  CPU roughly halves throughput.

## LLM provider health (`internal/llm/health.go`)

**There is no probe.** A health check would be a real completion — tokens and money
on every Settings render — so status is the outcome of the LAST real call. Both
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
- A provider dropped from config still gets a row with `role: "retired"`: its spend
  and its error are history worth keeping, but it must never raise the app's alert dot.
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