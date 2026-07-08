---
created: 2026-07-08
topic: Detect false parses (bot-protection / login-wall / empty stub) and fail cleanly
excerpt: Two-layer detection (deterministic pre-check + LLM structured signal) that fails the job and flags the Document with an error state instead of polluting the DB with junk highlights.
status: done — server + app + tests + e2e green; dev restarted
---

# Scraper false-parse detection

## Problem
Scraping a URL that hits bot-protection ("Checking your browser…"), a JS challenge, a
paywall, or a login wall yields a Document with no real article body. The LLM pipeline
then extracts garbage Highlights ("checking your browser", "inside the fastest growing
Canadian AI startup…"). We want to DETECT these and FAIL cleanly.

## Detection strategy (two layers)
1. **Deterministic pre-check** — `pipeline.DetectFalseParse(title, markdown)` (new
   `server/internal/pipeline/detect.go`). Runs before any LLM tokens are spent.
   - **Marker match** → reason `bot protection`. Small, concrete phrase list
     (`botMarkers`) of specific multi-word strings unlikely in a real article body
     (e.g. "checking your browser", "verify you are human", "enable javascript and
     cookies", "attention required! | cloudflare", "this content is for subscribers").
     Single common words ("captcha", "cloudflare", "log in") deliberately excluded to
     avoid false positives on articles *about* those topics.
   - **Min length** → reason `could not parse document`. If the plain text (image
     markdown stripped) is `< minContentChars` (200) AND the doc has no image, it's a
     near-empty stub. Docs with images are never length-flagged (extract_images + the
     summarizer's own empty-return handle image-only content).
2. **LLM structured signal** — `llm_summarize` step. The prompt instructs the model to
   emit exactly `__NOT_PARSEABLE__` when the input is a bot page / login wall / empty
   stub. The step detects that token → fails permanently. Catches cases the heuristic
   misses. (Provider routing unchanged — the existing per-step `provider` override is
   the seam for Rule 5 local routing; full credentialed-routing remains the documented
   unbuilt follow-up.)

## Failure model
- New sentinel error `pipeline.FalseParseError{Reason}` (`Error()` == the clean reason).
- `worker.run` treats a `FalseParseError` (via `errors.As`) as **permanent**: the job
  goes straight to `dead` (no 3× retry — re-scraping a bot-blocked / paywalled URL is
  exactly what design rule 3 forbids), and `last_error` is set to the clean reason.
- No Highlights are created (we return before/instead of inserting).

## Document error state
- New additive column `documents.error_reason TEXT NOT NULL DEFAULT ''`.
  Empty = healthy; non-empty = `bot protection` | `could not parse document`.
- `UpsertDocument` clears `error_reason=''` on every successful (re-)scrape; detection
  then re-sets it if the fresh content is still junk.
- `MarkDocumentError` query bumps `rev` so the flag syncs to the phone.
- **Persist-vs-drop decision:** we PERSIST the flagged Document (rather than dropping
  it). Rationale: (a) the user sees *why* a clipped URL produced nothing (flagged in the
  list) instead of it silently vanishing; (b) it preserves the `canonical_url` dedup so a
  known-bad URL isn't blindly re-scraped. Re design rule 1: `error_reason` is a
  rebuildable *index* property, not source-of-truth content — a failed scrape has no
  vault markdown to reconstruct, so on `reindex` the flag is simply re-derived on the
  next scrape attempt. This is acceptable transient state, consistent with jobs.

## Detection call sites (DRY via shared detector; article-only)
- `handleScrapeURL` (article path): after upsert, `DetectFalseParse` → mark doc error +
  fail job; skip `finishDocument` (no pipelines, no asset fetch). Video path returns
  earlier, so it's untouched.
- `handleRunPipeline`: after loading the doc (media_type article only), gate before
  creating the run.
- `handleLLMSummarize`: LLM token signal.

## UI
- **Jobs screen** — already renders `job.last_error`; the clean reason shows on the dead
  job automatically. (No change needed beyond confirming.)
- **Documents list** (`app/(drawer)/documents.tsx`) — red error badge when
  `error_reason` is set.
- **Document viewer** (`app/(drawer)/document/[id].tsx`) — an error banner at the top.
- `api.ts` `Document` gets `error_reason?: string`. Column already flows to the phone via
  `ListDocumentsSince` (`SELECT *`).

## Tests
- `detect_test.go` — table test: positive (each marker, empty stub) → right reason;
  negative (real long article, image-only doc) → nil.
- `step_llm_summarize` test — stub LLM returning `__NOT_PARSEABLE__` → `FalseParseError`,
  doc flagged, zero highlights; normal reply → 1 highlight, no flag.
- e2e (`smoke.js` + harness `seedFalseParseDoc`) — seed a `bot protection` Document,
  load `/documents`, assert the visible badge text.

## Open questions for review
- Marker list is intentionally minimal; add domain-specific paywall phrases as they show
  up rather than pre-building a registry (concrete-over-registry rule).
- `minContentChars = 200` — real articles are far longer; a genuinely tiny text-only post
  would be flagged. Acceptable given the scrape-article use case.
</content>
</invoke>
