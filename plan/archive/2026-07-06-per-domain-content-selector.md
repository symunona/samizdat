---
created: 2026-07-06
topic: Per-domain content-selector preprocess (drop recommended-articles)
excerpt: >
  444.hu (and any configured domain) appends "recommended articles" blocks that
  trafilatura swallows into the Document body. Add an optional per-domain
  `content_selector` in extractors/<domain>/feed.yaml. When set, the scraper
  prunes fetched HTML to keep only the matching content node(s) inside <body>,
  preserving <head> (trafilatura reads title/author/date/image/description from
  head meta tags), before trafilatura extraction.
status: planned
---

# Per-domain content-selector preprocess

## Problem
Scraped 444.hu articles include the trailing "recommended articles" list as
article body — no boundary between real content and recommendations.
Example doc: a8ed9c5a-7823-5232-ab45-f986a312edae.

## Design
Reuse the existing per-domain seam (`extractors/<domain>/feed.yaml`). No new
config file, no generic registry.

1. **config.go** — add `ContentSelector string ` + yaml:"content_selector,omitempty"`
   to `ExtractorConfig`.

2. **scraper.go** — after fetch + gate handling, before `unwrapFigureImages`:
   - Look up the domain cfg (already have `reg` + `canonical`).
   - If `cfg.ContentSelector != ""`, run `pruneToContent(htmlStr, selector)`:
     - Parse with `golang.org/x/net/html`.
     - Find `<head>` (keep verbatim — trafilatura metadata source).
     - Select content node(s) with `cascadia` (already an available dep).
     - Rebuild a minimal doc: `<html>{head}<body>{selected...}</body></html>`.
     - If selector matches nothing → return original HTML unchanged + WARN log
       (never silently emit an empty doc).
   - Feed the pruned HTML into the existing `unwrapFigureImages` → trafilatura path.

3. **444.hu/feed.yaml** — add `content_selector:` with the real 444 article
   content selector (subagent verifies against a live page).

## Why keep <head>
`trafilatura.Extract` pulls `Metadata.Title/Author/Date/Image/Description` from
`<head>` meta/OG tags. Pruning to only the content div would blank all of those.
Keep head, swap body.

## Testing
- Unit: `pruneToContent` — content div kept, sibling "recommended" block dropped,
  head preserved, no-match → passthrough.
- E2E: re-scrape the 444 URL, assert markdown no longer contains the recommended
  headlines that follow the real article end.
- `just build` + `just e2e`.

## Non-goals
- No generic per-domain pipeline framework. One field, applied at one seam.
- Selector stays a plain CSS selector (cascadia), same lib family html_links uses.
