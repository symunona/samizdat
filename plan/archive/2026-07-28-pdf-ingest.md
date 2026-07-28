---
created: 2026-07-28
topic: PDF ingest — scrape PDFs without Chromium (pure-Go text extraction)
excerpt: A PDF URL dies in the scraper ("playwright: Download is starting") and leaves no Document at all. Add a third media_type ('pdf') fetched over plain HTTP and text-extracted in pure Go, alongside the existing article/video paths.
status: done
---

# PDF Ingest

## The bug

Feeding `https://arxiv.org/pdf/2604.21751` produced nothing visible. Job
`5afe722b` (`scrape_url`) in the prod DB:

```
status     = dead
attempts   = 3
last_error = fetch: goto https://arxiv.org/pdf/2604.21751:
             Frame.Goto ...: playwright: Download is starting
```

Chain:

1. `handleScrapeURL` (`server/internal/worker/scraper.go:109`) has exactly two
   branches: the YouTube/yt-dlp special case, and *everything else* → browser
   fetch (`browser.FetchHTML`).
2. Chromium navigating to `application/pdf` starts a **download** instead of
   rendering. `Frame.Goto` returns `Download is starting`.
3. The error is deterministic, so all 3 attempts fail and the job goes `dead`.
4. The failure happens *before* `UpsertDocument`, so **no Document row is ever
   created** → nothing in the Documents list, nothing in the vault. The only
   trace is the Jobs tab.

`grep -ri pdf --include=*.go server/ cli/` → zero hits. There is no PDF support
anywhere; `media_type` is `'article' | 'video'` only.

A PDF needs no browser at all:

```
$ curl -sIL https://arxiv.org/pdf/2604.21751
content-type: application/pdf   content-length: 1428282
```

## Decisions

- **Full pure-Go PDF path**, not an arXiv-only URL rewrite. Every PDF should
  ingest, not just this one.
- **No stub Document on hard scrape failure.** Failures stay in `jobs`. (Keeps
  `documents` = real content only. The Documents view separately surfaces the
  error state of a displayed document's job — parallel work.)
- **No poppler / `pdftotext` shell-out.** Design rule 6 is single static binary,
  no external deps on the happy path. Text-layer PDFs only; a scanned-image PDF
  extracts to ~nothing and is flagged, not OCR'd.

## Design

New `media_type = 'pdf'`, third sibling to `article` / `video`. It reuses the
whole downstream chain unchanged — `UpsertDocument` → `finishDocument` →
`triggerPipelines` — because a PDF Document is just markdown like any other.

### Routing (`handleScrapeURL`)

Insert a PDF branch next to the YouTube one, *before* the browser fetch:

- Cheap check: URL path ends in `.pdf` (case-insensitive).
- Otherwise a plain-HTTP `Content-Type: application/pdf` sniff decides — this
  catches extension-less PDF URLs without paying for a browser launch.

### Fetch + extract (`server/internal/worker/pdf.go`)

- `net/http` GET with a browser-ish UA, redirect-following, size cap (reject
  absurd files rather than OOM the 4 GB box), context deadline.
- Text via `github.com/dslipak/pdf` — pure Go, no cgo, maintained fork of
  `rsc.io/pdf` with a usable `GetPlainText`.
- Metadata: title from the PDF Info dict when present, else the filename from
  the URL. Author likewise.
- Empty/near-empty extraction (scanned image PDF) → `DetectFalseParse`-style
  flag on the Document + permanent job failure, matching the existing
  false-parse contract (no pointless retry of a deterministic failure).

### Canonicalization

`canonicalize` keeps the PDF URL as-is — one PDF URL, one Document, per design
rule 3.

## Test plan (E2E, written before the work)

1. **Unit** — extract from a small fixture PDF, assert real text out; assert an
   image-only PDF is flagged rather than stored as an empty Document.
2. **Live** — enqueue `scrape_url` for the actual arXiv URL that broke; assert
   the job reaches `done`, a Document exists with `media_type='pdf'` and
   non-trivial markdown, and it does **not** touch Chromium.
3. **UI** — `just robot-browser`, open the Documents list, confirm the PDF
   document renders readable text in the reader.
4. `just build` + linter + `just e2e` green.
