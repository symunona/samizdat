# CLAUDE.md — server/

Go HTTP server + job worker. One binary. No Docker, no nginx.
Cross-cutting decisions + the bugs behind them: `../docs/decisions.md`.

## Run / restart

`just dev` = rebuild server AND app, kill whatever holds the port, start a nohup. Never raw `go build`/`pkill`.

- **Rebuild ≠ restart.** `just dev` fails loud if the new process does not bind, so it cannot "succeed" while stale code serves.
- **`just status`** = which mode holds the port (dev nohup vs `samizdat-<instance>` systemd), PID, and live `/api/v1/health` `commit` vs `git HEAD` → FRESH/STALE. Don't read `/api/v1/app/android/version` for freshness — it reads the APK sidecar and shows fresh on stale code.
- `just restart` hands the port back to systemd. `just kill` stops dev servers.
- **cgo is REQUIRED** (`just build` sets `CGO_ENABLED=1`) — MuPDF. `CGO_ENABLED=0` still compiles (go-fitz swaps in a purego path that dlopens a `libmupdf.so` this box lacks) and then fails at scrape time. `cli/` stays `CGO_ENABLED=0`.

## Module + layout

`github.com/symunona/samizdat/server`, own `go.mod`. CLI is a separate module talking HTTP.

```
main.go                 flags, config, wire, start
internal/
  config/               ServerConfig from TOML
  store/                db.go (WAL + migrate) · schema.sql · queries.sql · sqlc output (never hand-edit)
  auth/                 Argon2id passphrase · SHA-256 device tokens
  pair/                 DB-backed pair codes
  llm/                  router.go (THE router) · provider.go · discover.go · probe.go · models.go · health.go
  api/                  router.go + one file per route group · middleware.go (bearerAuth, localhostOnly)
  proxypool/            THE yt-dlp egress pool
  pipeline/             catalog.go (Register) · prompt.go · llm_long.go · llmtext.go · chunk.go · step_*.go
  extractor/            per-domain configs + substack_notes.go
  transcript/           vtt.go — WebVTT → sentences
  ctxmenu/              selection context-menu prefs
  export/               vault mirror
  ytdlp/                binary staleness checker
  worker/               youtube.go · pdf.go · pdffig.go · pdfrender.go
```

`sam qr` → `POST /api/v1/admin/pair/new` (`Authorization: Passphrase <argon2-hash>`, loopback only) → `{code, qr_data_uri}`. DB ownership stays in the server; the CLI is a thin client.

## Non-negotiables

- **Pure-Go SQLite** `modernc.org/sqlite` only — never mattn/go-sqlite3.
- **`sqlc` for all SQL.** Write `.sql`, generate typed Go (`just server::gen`, output committed). Never hand-write row scans.
- **WAL** at every open (`journal_mode=WAL`, `synchronous=NORMAL`).
- **UUID PKs, client-minted.** No auto-increment.
- **Every table:** `id`, `created_at`, `updated_at`, `rev` (server monotonic), `deleted_at` tombstone.
- **Queue = the `jobs` table.** No Redis. Claim with `BEGIN IMMEDIATE … RETURNING`.
- snake_case plural tables, `<singular>_id` FKs, ISO-8601 timestamps.

## API conventions

- REST JSON under `/api/v1/`. Bearer token (stored SHA-256 hashed).
- Admin routes: `Authorization: Passphrase <hash>` + loopback guard.
- Never return a stack trace — log internally, answer `{"error":"…"}` with a real status.
- Errors: typed sentinels + `fmt.Errorf("context: %w", err)`.

## Domain names (exact, no synonyms)

`Document` · `Highlight` · `Annotation` · `Note` · `Feed` · `Subscription` · `Scraper` · `Pipeline` · `PipelineStep` · `Job` · `Schedule` · `Tag` · `UserProfile`.
Banned: `Content`, `Memory`, `Source`, `Parsed*`, `Cron`, `Url`.

**`Highlight` vs `Annotation`:**
- `Highlight` — LLM-extracted from a Document. Machine data. Server→phone **one-way**.
- `Annotation` — user-created selection on a Document or Highlight: W3C TextQuoteSelector anchor + optional markdown note. **Two-way LWW.** Never machine-generated.
- Video annotations also carry `media_ts_ms` — the only permitted deviation from the text-anchor model.
- **Standalone note** = an `Annotation` with `document_id = NULL` and no anchor. Created via `POST /api/v1/annotations`; the server force-clears anchor fields. Not a separate entity, so it rides annotation sync + tagging + export unchanged. Exported as its own file with a `> [!note]` callout.

## Migrations (`store/open.go` `migrate()`)

Additive (new table, new column with default) → the `additiveMigrations` slice; duplicate-column errors ignored, so it is idempotent.
Non-additive (relax NOT NULL, change type) → SQLite table rebuild: create `_new`, `INSERT…SELECT`, `DROP`, `RENAME`, re-create indexes, inside a txn, with `PRAGMA foreign_keys=OFF` toggled **outside** it (safe because `MaxOpenConns(1)`), guarded by a `PRAGMA table_info` check. Precedent: `relaxAnnotationDocumentID()` — read it first.

Data migrations needing engine code do NOT go in `migrate()` (import cycle: the catalog lives in `pipeline`, which imports `store`). They run in `main.go` after `store.Open`, guarded by a `server_settings` key — see `pipeline.BackfillStepPrompts`.

`server_settings` keys in use: `passphrase_hash`, `ytdlp_proxy_last_ok`, `llm_provider_health`, `pipeline_step_prompts_backfilled`, `auto_archive_enabled`, `transcripts_reparsed_rollup`, `language_prefs`, `context_menu`.

## Job enqueue is idempotent (`POST /api/v1/jobs`)

`scrape_url` dedups by URL **before** `InsertJob`, via `GetLatestScrapeJobForURL`:
`dead` → `RetryJob` in place (`deduped:true, retried:true`) · `queued/running/paused/done` → return the existing id, no write · no row → insert.

Document dedup by `canonical_url` only stops a duplicate *Document* at run time, not a duplicate *queue row* — this closes extension double-pin, reader re-add and manual retry. **`done` is a deliberate no-op**: re-submitting a scraped URL will not re-scrape. The query reads `json_extract(payload,'$.url')`, so the payload's `url` key must stay stable.

## Sync cursor (`GET /api/v1/sync`)

`updated_at` cursor, `>=` filter, RFC3339 second resolution.

**`server_time` is sampled with `time.Now()` BEFORE any DB read.** That makes it a guaranteed lower bound: a concurrent write in the multi-query read window has `updated_at >= serverTime` and is re-selected next pull. Sampling it after was the bug — a write landing in the read gap sat below the returned cursor and was skipped forever. Re-delivery is idempotent client-side (LWW). **Do not move the sample** without re-reading the race analysis in `sync.go`.

## Auto-archive sweep (`worker.sweepAutoArchive`)

Opt-in (`server_settings.auto_archive_enabled` via `/api/v1/settings`), on the 60s scheduler tick — **not** a Job: nothing to retry, meter or dedup. Stamps `archived_at` on every non-deleted, non-archived, **non-pinned** Highlight older than a month, `rev+1` per row so the phone pulls it. Pinned is the user's explicit keep; a sweep must never undo triage.

## Images: absolutize at ingest, wikilink on export

**`trafilatura.Options.OriginalURL` does NOT rewrite `<img src>`.** A site-relative src survives into `documents.markdown`, and the whole chain then fails silently: `assets.go`'s `markdownImageRe` matches only `http(s)` → no download → no `media_assets` row → the exporter (keyed on `media_assets.original_url`) has nothing to swap → dead link in Obsidian, broken image in the app.

Two absolutization points during scrape:
1. **HTML** — `unwrapFigureImages(rawHTML, base)`, before trafilatura, because `figureContentImages`' http-only filter would drop relative srcs entirely.
2. **Markdown** — `absolutizeImageURLs(md, base)` after html→md, for whatever trafilatura emitted.

Both use `absolutizeURL` (no-op for absolute, `data:`, unparseable). **Anything producing Document markdown must keep image targets absolute or a `/api/v1/media/<id>` route.**

Export (`internal/export`) rewrites **image syntax**, not raw URL substrings, keyed on BOTH `media_assets.original_url` and `/api/v1/media/<id>` — PDF figures and injected heroes have a synthetic `pdf://…` original that appears nowhere in the body. Default embed is `![[file]]` (`[export] image_links = wikilink|relative`): no path, so Obsidian resolves by name and notes survive a move. Alt text becomes the alias; `wikiAlias` strips `|`/brackets and drops a bare number (Obsidian would read it as a width).

### An idle export sweep must touch NOTHING on disk

The exporter ticks every 15s and Syncthing/Obsidian watch the vault, so an identical rewrite is still a sync event. Two load-bearing rules:
- **The cursor sits AT the newest `updated_at`, never before it.** `ListDocumentsSince` filters `>= cursor`, so a same-second row is re-selected anyway; the old one-second rollback re-exported the newest doc forever, one file event per tick.
- **`writeNote`/`writeIndex` skip a byte-identical file.** Backstop — `_index.md` is rewritten on every sweep that does any work.

`GET /api/v1/export/stats` runs a full sweep per request, so the same rules keep the Settings card from churning the vault. Guarded by `TestSweepIsQuietWhenNothingChanged`.

## Document media types

### `article`
Playwright + Trafilatura. Per-domain config in `extractors/<domain>/feed.yaml`.

### `pdf` — never through the browser
Chromium answers a PDF navigation with `playwright: Download is starting` and no page → every PDF scrape died permanently (job `dead`, no Document at all). `handleScrapeURL` branches on `isPDFURL` **before** the browser fetch; extension-less PDF URLs are caught by retrying on that download error and sniffing the content type.

- `media_metadata`: `{pages, bytes}`. `markdown`: one page block per page.
- Extraction reads raw positioned glyphs (`Page.Content().Text`), never `GetPlainText`/`GetTextByRow` — those drop geometry, and typeset PDFs encode word breaks as *positioning*, so the helpers return `WhyareallLLMs`. Word spaces come from inter-glyph gaps; two-column order from a **document-wide** gutter x (one page's evidence is too weak).
- **Figures are rendered, not extracted.** Most academic figures (TikZ, matplotlib, pgfplots) are drawing operators — the ResNet paper yields *zero* image XObjects.
  - *Detect* by walking the content stream (`pdf.Interpret`: `cm` CTM + `Do` on Image/Form XObjects + painted path ops). Clipping paths (`W n`) ignored — a clip is usually the whole page. Boxes within 12pt merge; <60×40pt is furniture; a box repeating at the same spot on >half the pages is a running header. **go-fitz cannot give you these** — MuPDF exposes whole-page output only.
  - *Render* with MuPDF at 150dpi, one page render, cropped per figure (`pixelRect` maps points→pixels off the MediaBox and the bitmap's real size, never nominal DPI). PNG — figures are line art.
  - Assets get synthetic `original_url` `pdf://<doc>/p<page>/fig<n>` so a re-scrape overwrites instead of duplicating. Markdown carries a `sam-figure:N` placeholder until `storePDFFigures` returns URLs; `resolveFigures` deletes any that never got one, so a failed render leaves no broken image.
  - Tables are detected too (ruled drawings) — you get the crop *and* the text. Deliberate: column-flattened table text is often unreadable, the picture is not.
  - **Text drawn inside a figure box is lifted out of the prose stream** (`takeInterior`→`interiorBlock`) and re-attached under the image as a collapsed `<details><pre>`, one row per `<br>`. Without it `reflowParagraphs` glues a whole table into one paragraph of numbers and `splitAtGutter` tears its right columns to another part of the page. The text stays in `documents.markdown` — searchable, exported, visible to `DetectFalseParse` — only visually subordinate. Guards: a box absorbing >60% of a page's fragments is mis-detected (move nothing); <3 interior lines stays in place. The block is ONE line and `reflowParagraphs` skips it by its `<details>` prefix.
  - Open: the caption is duplicated (truncated in `alt`, full inline) — `captionFor` takes one line only, so dropping the inline copy would lose the continuation.
  - **No table parser.** MuPDF's `fz_table_hunt` is in the archive we link but go-fitz doesn't expose it (`opts.flags = 0`); a real `| a | b |` needs a fork. See `plan/2026-07-29-pdf-table-parsing-research.md`.
- Scanned/image-only PDF → no text layer → `DetectFalseParse` flags it, job fails permanently. No OCR.
- Library: `github.com/ledongthuc/pdf` (pure Go). `dslipak/pdf` rejected — `GetPlainText` burned >2min CPU on a 21-page paper.
- MuPDF is AGPL-3.0 → the repo is AGPL.

### `video` — yt-dlp
- `media_metadata`: `{provider, external_id, duration_ms, transcript_status, orig_lang, transcript_langs}`; `transcript_status` ∈ `subs|auto|none`.
- `transcript`: lang-keyed map `{lang: [{start_ms,end_ms,text,new_para?}]}` (`{}` when none). Legacy rows may be a bare array — parsers accept both.
- `markdown`: flattened transcript prose; falls back to the video description.
- **A segment is a SENTENCE, not a caption cue** (`internal/transcript`). Two load-bearing passes:
  - **Roll-up de-dup (`ParseVTT`).** YouTube auto-captions emit each line 3× — a paint-on cue with inline word timings (`<00:00:01.000>`), a ~10ms settle cue, and the same line carried into the next cue. Joined they read A, "A B", B, "B C" … never *equal* to the predecessor, so cue-level dedup dropped nothing and every video body was **~3× its real text** at 3× the LLM tokens. Roll-up is detected by those inline timings; then each LINE is the candidate and one equal to the last emitted is dropped. Window of one — the only false drop is a verbatim back-to-back repeat. Manual tracks keep the per-cue path.
  - **Sentence reflow (`Reflow`).** A cue is a ~35-char display wrap; cues are concatenated and re-cut at sentence boundaries, re-timed by interpolating within the cue each end fell in. `>>` (speaker marker) is stripped and forces a break. `NewPara` marks speaker change / >2.5s gap / ~700 chars. Guards both ways: run-on past 350 chars or 20s splits at a clause; a sentence under 40 chars glues forward.
  - **Never render one block per cue** — thousands of mid-sentence stubs, broken anchors across wraps, shredded prose to the LLM.
- `worker.BackfillTranscripts` repairs pre-reflow rows once (guard `transcripts_reparsed_rollup`) from the cached `.vtt` in `<cache>/media`; a row whose subs are gone falls back to `transcript.DedupRollup`. A row that yields nothing is left alone — never replace a body with nothing.

## Pipeline: catalog + prompts live in config, not Go

`pipeline/catalog.go` is the single registry: `Register(spec KindSpec, h Handler)` binds handler and `[]FieldSpec` in one call, so they cannot drift. New step kind = one `Register` in its `init()`. `GET /api/v1/pipeline-steps` serves `Catalog()` so the app renders an editor it never hardcodes.

- **The prompt is a config value.** Each LLM step's default is its `prompt` FieldSpec `Default`; the handler falls back via `defaultPrompt(kind)` only when the step config has none. Tuning = a DB edit.
- **One renderer for all four LLM steps** (`prompt.go`): `renderPrompt` expands `{{title}}` / `{{content}}` / `{{recently_covered}}` in a **single pass** (document text containing a token is never re-expanded). Every default ends with `promptTemplateTail`; a stored template with no `{{content}}` gets `legacyPromptTail` appended, so a hand-typed one-liner still receives the document. `TestDefaultPromptsComposeLegacyMessage` guards byte-identity with the pre-templating message — don't "tidy" the prompt consts.
- **No step field is a credential.** `model` (type `model` → the app renders a picker) and `provider` (a Router id) are the only routing keys. `TestStepCatalogDeclaresNoCredential` fails the build if `api_key`/`base_url` reappear.

### Credentials never live in a pipeline row

`pipeline.StripCredentials(stepsJSON)` removes every credential-*named* key (`api_key`, `apiKey`, `secret`, `token`, `password`, `passphrase`, any case) from every step config on **every read path**. Keyed on the NAME, not the catalog, so it also covers legacy rows and hand-added keys — the case catalog-driven redaction always missed. There is deliberately **no write-side counterpart**: nothing reads these any more, so a save that drops one loses nothing. The app mirrors the same test (`SECRET_KEY` in `pipelines.tsx`), including in its raw-JSON view. `steps_json.go` keeps it a pure string→string function, rewriting at raw-message level to preserve unknown keys.

**`max_tokens` is exempt** (`notCredentialRe` here, `NOT_SECRET_KEY` in the app). It contains "token", so `StripCredentials` ate it: the field never rendered and the next save dropped it. Keep the two exemptions in step.

## The LLM Router owns every endpoint (`internal/llm/router.go`)

Built ONCE in `api.New`, threaded api → worker → `pipeline.Dispatch` → `Handler`. Steps take a `*llm.Router`, never a `Client` — choosing an endpoint is routing, and routing has one owner.

- **A step names a provider id, nothing else.** `base_url`/`api_key` are gone from every spec; the Router resolves endpoint + key from config.toml + env. Legacy rows are stripped on read and dropped on save.
- **Pinning is pinning.** `CompleteRoute(ctx, Route{Provider: id}, msgs)` does **not** fall back — a step aimed at the local box must fail, never quietly spend cloud money. Empty `Route.Provider` walks the chain (primary → fallbacks) on `ErrTransport` only.
- **Legacy bare transports still resolve** (`"anthropic"`, `"openai_compat"` → first provider on that transport). Keep that path while such rows exist.
- **Provider ids** = brands for cloud (`anthropic`, `openrouter`, `openai`), `host:port` for self-hosted — the only thing telling two Ollama boxes apart. `Provider.HealthKey()` (`transport@base_url`) is a SEPARATE identity: health rows and `llm_usages` were written with it; renaming orphans them.
- **A model name belongs to ONE provider.** Unset resolves to the endpoint's `default_model` (anthropic → `claude-haiku-4-5-20251001`; `openai_compat` errors naming `llm.default_model` — a local box serves only what was pulled). Never re-introduce a provider-specific default in a step. `Usage.Model` reports what actually ran; steps write that (via `pipeline.servedModel`) to `llm_usages` and to Highlight provenance.
- **Params travel with the route and come back as SENT.** `llm.Params` (`model`, `max_tokens`, `temperature`) rides `Route`; each adapter echoes the effective values in `Usage`. Unset stays unset — a local box has Modelfile defaults an invented number would override — except Anthropic's mandatory `max_tokens`, which reports the 4096 it really sends.
- **Provenance lives in `highlights.metadata`, never in `body`.** Body is markdown that syncs, exports and gets edited; provenance there duplicates on regenerate and is lost on edit. `pipeline.llmStepCall` is the ONE path step→LLM: routes, writes the `llm_usages` ledger row, returns provenance JSON (`model`, `provider`, `step`, `max_tokens`, `temperature`, `tokens_in/out`, `prompt_sha` — a fingerprint of the TEMPLATE, so a summary can be dated against a prompt change). Steps differ in how they parse a reply, never in how they call or account. Metadata `provider` prefers the PINNED id; the ledger keeps the transport name, which is what `llm_status` aggregates spend by.
- **Ollama's default context is 4096 and truncates silently.** The OpenAI-compatible endpoint has no `num_ctx` — bake it into a model variant (`FROM qwen3:4b-instruct` + `PARAMETER num_ctx 7168` → `ollama create`) rather than setting `OLLAMA_CONTEXT_LENGTH` on a shared box. Size to what stays on the GPU (`ollama ps` shows the split; the first byte spilling to CPU roughly halves throughput). Then declare the same number in `[llm.summarize.<role>] ctx_tokens` — it is the ONLY thing keeping a prompt inside the window.
- **Name a self-hosted box by DNS, never IP** (`http://xayah.tail7f475e.ts.net:11434/v1`). A provider id is `host:port`, so the address is also the identity every step pins; rebuilding the box moved the IP, taking down the primary AND orphaning every pin at once — and a pin never falls back, so it fails hard rather than degrading. Grep `pipelines.steps` for the old `host:port` whenever `base_url` changes.
- **Ollama binds `127.0.0.1` by default** — a box answering `ollama list` over ssh is still `connection refused` from here. `OLLAMA_HOST=0.0.0.0:11434` in a systemd drop-in makes it a tailnet provider; note it has no auth, so that also exposes it to the box's LAN.

### Discovery (`discover.go`)

Deduped by `HealthKey`, in routing order: `[llm]` → `primary`, each `[[llm.fallback]]` → `fallback`, then anything an env key enables (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`) plus the well-known `http://localhost:11434/v1` → `available`.

**There is no LAN scan** — the LAN Ollama is whatever `base_url` names. Sweeping a subnet would be slow, rude, and would invent endpoints nobody asked to send documents to.

`available` providers feed the model picker and `just check-llm` but nothing routes through them, so they never raise the app's alert dot (only `primary`/`fallback` do).

### Probe (`probe.go`) — the only thing that actively asks

`POST /api/v1/llm/probe` → `just check-llm` + the Settings **Probe** button. Never on a render path; that is why `health.go` stays passive.

| Flavor | Check | Credits |
|---|---|---|
| local / openai_compat | `GET {base}/models` | `n/a` |
| OpenRouter | `GET /api/v1/models` + `/api/v1/key` | real numbers |
| Anthropic | `GET /v1/models` (proves the key) | no endpoint exists |

- **Anthropic has no balance API.** Shallow → credits from the health registry's last `quota` error. `?deep=1` → a `max_tokens:1` completion settles it for ~$0.000001 and, going through the normal client, *updates* the registry, so probe and passive status agree by construction. `just check-llm` is deep by default (`--shallow` opts out); the Settings button is always shallow — it is one tap from a render.
- **Unreachable means nothing is listening.** A 4xx came back over a working connection: `reachable: true, auth: bad_key`. Only `ErrTransport` sets `reachable: false`.
- A provider with **no key is never contacted** — claiming reachability we never established is a guess.
- `anthropicBaseURL` is a `var` so probe tests can point it at an httptest server (same trick as `extractor.substackAPIBase`).

### Ad-hoc completions (`api/llm_ask.go`, `POST /api/v1/llm/ask`)

The one path from a UI to the Router (reader selection menu: translate / ask). Routing rules are a step's: named provider = pinned, empty = chain.
- **There is no system role.** Anthropic takes `system` as a top-level field, not a turn, and both adapters share one `llm.Message` shape — so the request's `system` (the master prompt) is PREPENDED to the user message here, one code path for both providers.
- **Metered like any other call**: one `llm_usages` row, `job_id`/`pipeline_run_id` nil. An ad-hoc ask spends real money and belongs in the ledger Settings reads.
- Bounded: `askMaxRunes` (413 past it), 120s context. `ErrNoProvider` → 503, provider error → 502 with its reason, never a stack trace.

### Context menu is a server setting (`internal/ctxmenu`)

`server_settings.context_menu`, served + patched by `/api/v1/settings` beside `language_prefs`. Holds the master prompt + menu items. `Normalize()` runs on **both** read and write, dropping rows the device cannot execute (no id, unknown kind) and filling per-kind blanks — a row that renders and does nothing is worse than a missing one. Routing is a provider id + model, never an endpoint or key.

### Model catalog (`models.go`)

`GET /api/v1/llm/models` → groups of `{provider_id, provider_label, role, models[]}`, cached 5 min (`?refresh=1` busts). All flavors serve the OpenAI-shaped `{"data":[…]}`. Anthropic **without** a key answers with the named tiers — an empty picker for the provider you are about to configure is worse than a short honest list. An unreachable provider contributes an `error` on its group, never an empty picker for everyone else.

## How much document a step sends (`pipeline/llm_long.go` + `[llm.summarize]`)

Every LLM step goes through `llmStepCallLong`. It replaced four hardcoded `content[:12000]` slices that dropped everything past a few thousand tokens, said nothing, and could cut a rune in half.

Three bands in **estimated** tokens (`EstimateTokens` = runes/3, a third of the window held back as headroom — there is no tokenizer, and being wrong low is invisible while being wrong high is loud):

| Band | Condition | What happens |
|---|---|---|
| small | `< chunk_above` | one call, step's own config — byte-identical to before |
| medium | `< big_above` | `Split` → one call per chunk → fold |
| large | else | one call to the `big` role, clamped, with a visible note |

- **Chunk size is derived, never configured** (`ChunkBudget` = `ctx_tokens*2/3 − max_tokens − prompt`). A knob would be a staler copy of `ctx_tokens`.
- **One chunk per job tick.** `worker.stuckJobAge` requeues a job idle >10 min, and a dozen sequential local calls cross that — the reset would run a second worker on the same run: double spend, duplicate Highlights. Ticking keeps `updated_at` fresh and makes a crash cost one chunk. `StepResult.Continue` skips `stepRetryDelay` for a tick that made progress (delay is backoff; progress is not failure).
- **map→reduce is for LOSSY steps ONLY. Extraction uses `partition`.** The fold never sees the document, only chunk summaries — correct for `llm_summarize`, catastrophic for a "verbatim" step: on a real newsletter it invented a Dolly Parton quote and attributed a Steve Jobs line to Carl Jung, into Highlights that synced and exported. `partition` runs the STEP's own prompt per chunk and unions the results — no map prompt, no fold. `chunkStrategyFor(kind)` **defaults to `partition`**; only `llm_summarize` opts out, so a new kind is safe without remembering to opt in (same polarity as `toleratesTruncatedReply`).
- **`planRun` returns an explicit `band`; nothing re-derives it.** It used to return `nil` for four reasons and `singleCall` guessed — so a document that chunked to exactly ONE chunk landed in the `big` role and went to the cloud with the big cap (a 12067-rune newsletter met a 1024-token cap and truncated). The window scaled with the local model's context, so *raising* it sent MORE to the cloud — and it leaked design rule 5, routing paywalled content to a cloud LLM with no gate and no log line.
- **`CompactForLLM` (`llmtext.go`) runs before the band is chosen.** Link targets stripped from what the LLM sees; the stored Document untouched. **76% of one real newsletter was ConvertKit tracking URLs**, costing twice: they tokenize ~1.7 runes/token against the assumed 3 (under-counting a link-heavy doc up to 1.76×), and their bulk pushed a single-call newsletter into chunking — which caused the fabrication above. That issue: 23238 → 6651 runes, and no chunking at all. **Image syntax stays byte-identical**, targets included — `llm_topics` copies bodies verbatim into exported Highlights.
- **`EstimateTokens` is NOT always conservative.** Holds for prose (3000 runes ≈ 983 tokens), fails for link-heavy markdown (18000 ≈ 10546). Two errors currently cancel: `qwen3-sum:latest` really serves **12288** while `ctx_tokens` declares 7168. **"Correcting" `ctx_tokens` alone would break it** — chunks would reach ~12800 real tokens and the endpoint 400s. Fix the estimator first.
- **Ollama ≥0.32.7 ERRORS on overflow** (`exceed_context_size_error`) rather than dropping the front. The "answers confidently about whatever survived" warning applies to the 4096 default, not to a sized model.
- **Chunk text is never stored.** `Split` is deterministic (test-guarded), so each tick re-derives and takes the one it needs; `pipeline_runs.state` holds only partials and counters. Storing chunks would put a copy of every long document in the runs table.
- **The fold carries the STEP's own prompt** — its output contract is the point. Only the `map` pass has its own, because a chunk is not an article and the summary prompt makes a model write twelve little articles. That map prompt deliberately has **no `__NOT_PARSEABLE__` clause**: the sentinel kills the whole Document, and a nav bar is a normal chunk of a real article.
- **Escalation, not recursion.** A role exhausting `max_tries` retries on `big` (skipped if it resolves to the same endpoint). Oversized partials escalate the same way — no recursive fold.
- **A role naming neither provider nor model keeps the step's routing.** No `[llm.summarize]` block changes how much is sent, never where. Hence `bigCtxTokens` sizes an unconfigured `big` like `map` — the call still lands on the 7k local box.
- **A window too small for the prompt fails the step, loudly.** `ChunkBudget` returning 0 once meant "skip the clamp", sending the whole document to a box that could not hold it.
- Provenance gains `chunks`/`calls`/`truncated`; tokens are run sums and `model` names whoever wrote the final text. Absent `chunks` = one call.

## LLM provider health (`internal/llm/health.go`)

**Nothing here probes.** A health check on a render is a real completion — tokens and money every time Settings paints — so status is the outcome of the LAST real call. Both clients `defer Record(provider, baseURL, err)` on every return path into a package-level registry. That placement is deliberate: steps mint their own clients, so wiring health through `New` would miss them.

- **Identity is provider+base URL** (`ProviderKey`) — two openai_compat boxes are two rows. `llm_usages` records only the provider NAME, so per-endpoint cost is not derivable; the registry's per-endpoint `calls` is the ONLY per-box number, and `routed_share` (calls ÷ all calls, in `llm_status.go`) answers "how much is the local box actually serving?".
- **`classify(err)` → `quota | auth | transport | api`.** Anthropic answers a spent balance with a plain **400**, so only the message separates "out of credits" from "bad request" — that is `quotaRe`. This classification is the whole feature: before it, a dead pipeline was the only symptom.
- **Persisted** to `server_settings.llm_provider_health` after every Record, re-read on every `GET /api/v1/llm/status` (in-memory always wins), so an overnight failure survives a restart and a seeded row lands without one (`just e2e-int`). `restore` runs per request, not just at startup.
- Rows come from `Router.Providers()`. A provider dropped from config still gets a row with `role: "retired"` — its spend and error are history worth keeping, but it must never raise the alert dot. Nor must `available`; only `primary`/`fallback` can break a pipeline.
- `llm.HasKey(cfg)` mirrors `newSingle`'s env fallback — keep them in step or a working provider reads "No API key configured". The API returns `has_key`, never the key.
- **`defer Record(…, err)` needs NAMED return values** (`reply string, u Usage, err error`) so the closure captures the final `err`, not the zero value at defer registration. Any future client follows this.

## yt-dlp egress pool (`internal/proxypool`)

`[ytdlp].proxies` is an ORDERED POOL; `proxypool.Pool` is its single owner — built in `api.New`, threaded into the worker AND read by the status endpoint, so the Settings card can never disagree with what an ingest used. Before it, one string meant one blinking home node killed every ingest.

- **Sticky active.** `Current()` keeps the active entry while healthy, else the first healthy, else `list[0]`. Not "best of the healthy" — re-picking per probe reshuffles which IP YouTube sees mid-session, and an unprobed pool must still be usable.
- **`Attempts()` ends with the UNHEALTHY entries.** A stale probe must never take the pool out of service.
- **Only a bot wall rotates.** `ytdlpRun.exec` retries the next proxy for `isBotBlock(output)`, returns immediately otherwise — a private video would cost one full wait per proxy for the same error.
- **Every yt-dlp invocation goes through `ytdlpRun`** (probe `-J`, audio, video). The three sites used to hand-roll `--proxy`/`--cookies`/exec/classify; a fourth copy would silently never rotate.
- **Distinct exit IPs are the number that matters.** Two nodes in one household share one address, so failing between them buys nothing — `Probe` returns the exit IP and the app tags duplicates.
- Probe transport is chosen by scheme (`socks5*` vs `http(s)`) — probing an `http://` entry with a SOCKS dialer reports a working proxy as dead.

### A stale binary is a SEPARATE failure class (`internal/ytdlp`)

The two ways video ingest dies have the same symptom and opposite fixes. YouTube rotates its player/signature scheme every few weeks; a behind-by-one `yt-dlp` then 403s on the media fetch — on EVERY proxy. Read as an IP ban that costs an afternoon swapping healthy nodes (it did: the reported "proxy broke" was a 2.5-month-old binary, all seven proxies fine).

- **It never rotates.** `exec` checks `isStaleBinaryFailure` BEFORE `isBotBlock`.
- **Its message names the versions and says "not a proxy problem"** — including when the version check says current, because that diagnosis holds either way. What it must NOT do then is assert staleness.
- **`Checker.Get` is cached 6h** against the GitHub release list. Offline it falls back to age (`StaleAfter` 30d): being unable to check must never turn a current binary into a reported problem, but a year-old one still is. Equal-to-latest is current however old — yt-dlp going quiet is not the operator's problem.
- Served in `GET /api/v1/ytdlp/status` as `ytdlp`, beside the proxies; raises the app's alert dot.

## Scraper paywall auth (per-domain login)

Paywalled domains reuse the owner's subscription via a persisted browser session. Config lives in the existing per-domain seam — `extractors/<domain>/feed.yaml` under `auth:` (`login_url`, `user_selector`, `pass_selector`, `submit_selector`, `success_text`, `paywall_text`). No new TOML section.

- **Session jar:** Playwright `storageState` at `<cacheDir>/auth/<domain>.json`, 0600, gitignored. `extractor.AuthStatePath` resolves it.
- **Credential store:** per-domain `{username,password}` in `<data_dir>/credentials.toml` (0600, gitignored, `internal/credstore`) — separate from the hand-edited config.toml. This is what enables unattended refresh; **not** shell rc / env files.
- **Login:** `POST /api/v1/admin/scraper/login` (loopback) → `worker.Login` → `BrowserPool.Login`: headless form fill, then wait for `success_text` (SPA-hydration-safe `Locator.WaitFor`, 20s) before saving the jar. CLI: `sam login <domain>` (`--user`/`--pass` or `SAM_LOGIN_USER`/`SAM_LOGIN_PASS`; `--no-save` = jar only).
- **Scrape + auto-refresh:** `handleScrapeURL` loads the jar into the fetch context. If the HTML still shows `paywall_text` (`isGated`), `refreshSession` re-logins **once** from credentials.toml and re-fetches.

## Short-form feeds (Substack Notes, tweet-sized items)

Some feeds legitimately publish a few sentences. The `DetectFalseParse` length floor reads those as empty stubs and kills the job permanently.

**`short_form: true` in `feed.yaml`:**
- Exempts Documents from the **length floor** in both `handleScrapeURL` and `handleRunPipeline`. Bot/login markers still apply — they matter *more* on short content.
- Enables **`leadLineTitle`**: a profile-scoped feed's og:title is the author's name (every item identical), so the title becomes the first prose line of the body (block markers stripped, 90 runes + `…`).

Two helpers implement the split — `DetectFalseParse` (floor on) and `DetectFalseParseShortForm` (floor off). The caller selects via `reg.IsShortForm(url)`; that lookup is the ONLY branch point, the detection logic is not duplicated.

**`substack_notes` extractor kind.** Substack has RSS for posts, none for Notes, and the rendered profile hard-gates anonymous visitors after two items — so browser-scraping silently truncates an active writer. `SubstackNotesAdapter` uses the reader API instead: `GET /api/v1/user/<handle>/public_profile` → id, then `GET /api/v1/reader/feed/profile/<id>?types[]=note`. Items are filtered to the profile's own handle (restacks appear in the same feed); the API ignores a limit, so `MaxURLs` is applied client-side. Individual permalinks render fine anonymously, so only discovery needs this.

`substackAPIBase` is a `var` so tests can swap in an httptest server. The registry keys on **exact host**, so one `extractors/substack.com/feed.yaml` serves every handle; publication feeds live on `<handle>.substack.com` — a separate key.

A shipped `substack.com` config must set **both**: `article_selector` (else trafilatura keeps ~95% marketing chrome around a tweet-sized body — pruning cuts 246549 → 37666 bytes; the class suffix is a build hash, so match by prefix) and `short_form: true`.

**Still open:** pipelines fire on short-form Documents like any other, and an LLM handed 24 characters invents. Narrow the trigger, or teach pipelines to skip short-form docs.
