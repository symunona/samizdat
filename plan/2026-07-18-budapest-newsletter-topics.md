---
created: 2026-07-18
topic: Budapest newsletter — topic-split pipeline, pre-render fix, visit-on-web fix
excerpt: New llm_topics step (verbatim topic split, no summarizer) + Budapest pipeline; fix plaintext-email <pre> code-fence render; fix broken "Visit on web" for non-http docs.
status: in_progress
---

# Budapest Newsletter — topics pipeline + two bug fixes

The Budapest municipality newsletter ("Fővárosi Önkormányzat Hírlevele", feed
`Budapest` / `email-newsletter:budapest-4b26`) is email-ingested. Three asks:

## 1. Plaintext email renders inside a `<pre>` code block (bug)
`api/newsletter.go extractHTMLBody` wraps `text/plain` bodies (and multipart with no
HTML part) in `<pre>…</pre>`; `emailHTMLToMarkdown` then converts `<pre>` → a ` ``` `
fenced code block → the whole newsletter renders monospace.

**Fix:** replace the `<pre>` wrap with `plaintextToHTML()` — HTML-escape, split on
blank lines into `<p>` paragraphs, single newlines → `<br>`. Renders as prose, keeps
autolinking. Two call sites (text/plain branch, multipart no-html branch).

**Backfill:** the 4 already-stored Budapest issues keep the fence. Unwrap them:
strip a leading ` ``` ` line + trailing ` ``` ` line from stored `markdown` (non-
destructive) via a one-off SQL update, then re-export.

## 2. New pipeline step `llm_topics` — verbatim topic split, no summarizer
None of the existing steps fit: `llm_summarize` = one summary; `llm_ai_newsletter` =
AI/ML kinds; `llm_321_newsletter` = James Clear; `extract_list_items` = list bullets.

`step_llm_topics.go`: one LLM call, JSON `{highlights:[{title, body}]}`. Splits the
newsletter into its distinct sections/topics. `kind="topic"`, `title` = section
headline, `body` = the section's **original text, verbatim** (no summarizing). Preserve
the source language. Defensively unwraps a wrapping code fence from `doc.Markdown`
before sending. Same config shape (model/provider/base_url/api_key) + LLM-usage
insert + fence-strip on reply as the sibling steps.

## 3. Budapest pipeline (DB row)
`scripts/seed-budapest-pipeline.sh` → `POST /api/v1/pipelines`:
```
name: Budapest Newsletter
trigger: on_new_document
filter: {"source_feed_id":"1a67c4b2-fadc-51c7-88d7-f10ab340afd7"}
steps:  [{"kind":"llm_topics","config":{}}]
```
Then run on the existing 4 issues via `POST /api/v1/pipelines/{id}/run`.

## 4. "Visit on web" broken (bug)
- Email docs have `canonical_url = email:<msgid>@domain` — no web page → `Linking.openURL`
  no-ops.
- Generic: `openInWeb` (`document/[id].tsx:491`) + `VideoDocument.tsx:827` call bare
  `Linking.openURL`, missing the web `window.open` branch (present in `LinkActionSheet`)
  and a `.catch`.

**Fix:** shared `src/openExternal.ts` — `Platform.OS==='web' ? window.open(url) :
Linking.openURL(url).catch()`, guarded to http(s). Reuse in `document/[id].tsx`,
`VideoDocument.tsx`, `LinkActionSheet.tsx` (parity). Hide the open-web button when
`canonical_url` isn't http(s).

## Extra: exclude Budapest from the catch-all Summarizer
A separate "Summarizer" pipeline (broad filter, per-newsletter excludes) also matched
the Budapest feed → added a `summary` highlight. User wants no summarizer here, so add
the Budapest feed id to its `exclude_source_feed_ids` (same pattern as thorstenball/
napirajz/latent.space/natesnewsletter) and delete the 3 stale summary highlights.

## Checklist
- [x] newsletter.go: plaintextToHTML + swap both `<pre>` sites (+ test)
- [x] text.go: StripCodeFence helper (+ test)
- [x] step_llm_topics.go: new step + register
- [x] unwrap 4 stored Budapest docs (SQL, rev bump)
- [x] seed-budapest-pipeline.sh + create pipeline + run on 4 docs → 5/6/7 topics
- [x] exclude Budapest from Summarizer + delete its summary highlights
- [x] app: openExternal.ts + wire document viewer / VideoDocument / LinkActionSheet + hide button
- [x] just build + lint (0 issues) + go tests
- [x] agent-browser: prose render ✓, 5 topic highlights ✓, web button hidden on email doc ✓, present+opens on http doc ✓
- [ ] just e2e green
- [ ] commit
