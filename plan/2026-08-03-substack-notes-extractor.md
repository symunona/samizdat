---
created: 2026-08-03
topic: Generalized Substack Notes extractor
excerpt: substack_notes adapter so `sam sub add https://substack.com/@<handle>/notes` polls a writer's Notes (Substack ships no RSS for Notes, and the rendered profile gates anonymous visitors at 2 items).
status: done
---

# Substack Notes extractor

## Why
Substack publishes RSS for **posts** (`https://<handle>.substack.com/feed`) but **not for
Notes**. Subscribing to a writer's Notes feed fails autodetect: no `<link rel=alternate>`,
and the page is client-rendered (raw HTML holds zero note permalinks).

## What was tried first, and why it lost
`kind: html_links` + a browser render looked like a config-only win — `poll_feed.go` already
browser-fetches for that kind. Measured against a prolific account (`@noahpinion`, 12 notes)
it caps at **2**: the rendered page ends in the literal string `"Log in for more"`, and six
2000px scrolls added nothing (`scrollHeight` 1631, unchanged). `max_urls: 50` would have been
theatre. Restack noise, the other suspected problem, measured at **zero** — every rendered
permalink was own-handle.

## What shipped
`kind: substack_notes` (`server/internal/extractor/substack_notes.go`). Two unauthenticated
GETs, no browser:

1. `/api/v1/user/<handle>/public_profile` → numeric user id
2. `/api/v1/reader/feed/profile/<id>?types[]=note` → full activity, 12/12 for noahpinion

Items are filtered to `context.type == "note"` **and** `comment.handle == <handle>` (the
activity feed carries restacks of other writers), then mapped to
`https://substack.com/@<handle>/note/<entity_key>`. The API **ignores a limit param**, so
`max_urls` is applied client-side.

The registry keys on exact host, so one `extractors/substack.com/feed.yaml` covers every
handle; publication post feeds live on `<handle>.substack.com`, a separate key, so the
existing `natesnewsletter.substack.com` RSS config is untouched.

## Three things the API-only path did NOT fix (found by scraping for real)
Discovery working is not the feature working. The first live poll produced two Documents
whose bodies were Substack's marketing chrome ("Group chats are here", "You made it, you
own it") — HTTP 200, job `done`, content worthless.

1. **`article_selector: '[class*="feedPermalinkUnit"]'`** — a note permalink page is ~95%
   product upsell around a tweet-sized body, and trafilatura reliably picks the upsell.
   Pruning takes 246549 → 37666 bytes. Substack's class suffix is a build hash
   (`feedPermalinkUnit-JBJrHa`), hence prefix matching.
2. **`short_form: true`** — with the right body extracted, every note then died on
   `DetectFalseParse`'s 200-char floor ("could not parse document", job dead). Notes are
   legitimately tweet-sized. New `ExtractorConfig.ShortForm` + `Registry.IsShortForm` +
   `pipeline.DetectFalseParseShortForm` (drops the length floor, **keeps** the bot/login
   markers). Both gates were wired: scraper and `handleRunPipeline` (which needed the
   registry threaded in).
3. **`leadLineTitle`** — Substack's `og:title` is the author's profile name, so both notes
   landed in the list as "Samuel Albanie (@samuelalbanie)". Short-form docs now take their
   title from the first line of body, truncated at 90 runes.

## Verified
- `sam sub add https://substack.com/@samuelalbanie/notes` → feed `94e354b1`, poll discovered
  2/2 notes in 720ms
- Documents scraped with real bodies and distinct titles ("some reflections on 2025",
  "There's an exquisite form of agony…")
- **Visible in the reader** (agent-browser): `/document/c9232eb1…` renders the note text in
  the viewer iframe, not a blank shell
- `just lint`, `just e2e` (exit 0, 26 PASS), server FRESH on HEAD

## Known rough edge (not fixed — user's call)
Notes trigger the **Summarizer** pipeline like any other Document, and an LLM handed 24
characters invents: the summary attached to "some reflections on 2025" is three sentences
about digital connectivity and misinformation that appear nowhere in the note. Either narrow
that pipeline's trigger to exclude `substack.com`, or skip pipelines for short-form docs.
