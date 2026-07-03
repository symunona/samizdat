---
created: 2026-07-03
topic: Pipeline tuning (dedup titles, per-feed skips, AI-news cross-issue dedup, James Clear titles) + per-platform clipboard
excerpt: Six asks — kill summary double-title, skip summary on napirajz + Latent Space (highlights only), dedup AI news across issues via recent-headline context injection, James Clear titles = first sentence ≤10 words, and a per-platform copy wrapper (mobile copy is broken).
status: done
---

# Pipeline tuning + clipboard

## System facts (mapped)
- Pipelines are **DB rows** (`pipelines`: `filter` JSON + `steps` JSON), created via API, not seeded.
- `PipelineFilter`: `feed_url_contains`, `source_feed_id`, `exclude_feed_url_contains[]`, `exclude_source_feed_ids[]`. `MatchesDocument` (pipeline.go:120) gates per feed at trigger time.
- Step handlers (Go, registered): `llm_summarize`, `llm_ai_newsletter`, `llm_321_newsletter`, `extract_list_items`, `extract_links`, `extract_images`.
- Highlight = {kind,title,body}; summary steps set `Title = doc.Title`.

### Current pipelines (dev DB)
| name | filter | steps |
|---|---|---|
| Summarizer (global) | exclude thorstenball + James Clear feed | `llm_summarize` |
| Latent Space – AI newsletter | `feed_url_contains: latent.space` | `llm_ai_newsletter` |
| James Clear 3-2-1 | `source_feed_id: aa1e318b` | `llm_321_newsletter` |
| Napirajz Highlight | `source_feed_id: 1501bce2` (telex) | `extract_images` |
| Thorsten Newsletter | `feed_url_contains: thorstenball` | `extract_list_items` |

### Feeds
- Latent Space: `8312b9a9` — `latent.space/feed` — **also hosts the `[AINews]` docs** (12 of them).
- napirajz.hu RSS: `38ca9b9e`; Telex napirajz: `1501bce2` (both URLs contain "napirajz").
- James Clear: `aa1e318b`.

## Tasks

### 1. Kill summary double-title  (`step_llm_summarize.go`, `step_llm_ai_newsletter.go`)
Card shows `title = doc.Title` AND the LLM body often leads with its own heading (fed `# {doc.Title}` → echoes a title line). Fix:
- Prompt: "no heading/title line; never repeat the article title."
- Post-strip: drop a leading markdown heading (`# …`) / a first line that ≈ doc.Title from the reply. Shared helper `stripLeadingTitle(body, docTitle)`.

### 2. No summary on napirajz  (data: Summarizer filter)
Add `"napirajz"` to Summarizer `exclude_feed_url_contains` → catches both napirajz feeds. (napirajz keeps its `extract_images` pipeline.)

### 3. Latent Space → highlights only, no summary
- Exclude `latent.space` from the global Summarizer (`exclude_feed_url_contains`) — today it double-processes (global summary + ai_newsletter summary).
- Add `{"skip_summary": true}` config to `llm_ai_newsletter`; set it on the Latent Space pipeline so it emits topic highlights only.

### 4. AI-news cross-issue dedup  — DESIGN (see below)

### 5. James Clear titles = first sentence, ≤10 words  (`step_llm_321_newsletter.go`)
Idea titles are "first 8 words" today. Change to first **sentence** capped at 10 words. Prompt + deterministic `firstSentenceTitle(body, 10)` fallback so it can't drift. (Quotes keep attribution; question keeps "Question".)

### 6. Per-platform clipboard  (`app/`)
`subscriptions.tsx` copyText uses `navigator.clipboard` → undefined on native → "Copy address" silently fails on mobile. `expo-clipboard` NOT installed.
- Add `expo-clipboard`; new `src/clipboard.ts` `copyToClipboard(text): Promise<boolean>` — native: `expo-clipboard`; web: `navigator.clipboard` + legacy `execCommand` fallback.
- Replace the local copyText; use the wrapper everywhere. Native rebuild (new native module).

## #4 design — recent-headline context injection (elegant)
`llm_ai_newsletter` runs per issue with **no cross-issue memory** → same tool/model recurs (52 `tool` highlights, many dupes).

**Approach:** before the LLM call, fetch the **titles + first body line** of recent topic highlights from the SAME feed (kinds: frontier_model/tool/local_model/opus_equivalent) within a lookback window, inject as an "ALREADY COVERED — do not re-extract" block, and instruct the model to emit only genuinely-new items.

Why this over alternatives:
- **LLM does fuzzy match** ("GPT-5.6 Sol" == "GPT-5.6") — content-hash/exact dedup can't.
- **Zero schema change** — reuses `highlights`.
- **Cheap** — titles + 1 line, capped (~40 items).
- **Self-decaying** — lookback window; config `{"dedup_lookback_days": N}` or `{"dedup_recent_issues": M}`.
- Rejected: DB content-hash (brittle to renames), post-hoc dedup job (expensive + still needs semantic match), embeddings (overkill infra).

New query: recent highlights by feed+kinds+since (join highlights→pipeline_runs→documents on source_feed_id). Return title + first line of body.

Open questions for user:
- Lookback: **days (7)** vs **issues (5)**? (recommend last 7 days)
- Dedup scope: per-feed only (covers Latent Space + [AINews] since same feed) — OK?
- On a recurring item with a *material update*, allow a fresh highlight, or always skip? (recommend: skip unless clearly new info)

## Test plan
- `just dev` restart after Go changes.
- Re-run a Latent Space issue + a James Clear issue + a napirajz doc; assert: no summary double-title, no summary highlight on napirajz/Latent Space, James Clear idea titles ≤10 words / first sentence, and a 2nd AI-news issue skips already-seen tools.
- agent-browser: copy-address on web works; native covered by build (can't drive native clipboard headless — note it).
- `just build` + lint.
