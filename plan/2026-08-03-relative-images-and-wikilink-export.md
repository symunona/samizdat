---
created: 2026-08-03
topic: Relative image srcs never ingested + vault export image link style
excerpt: Site-relative <img src> survive scrape verbatim, so no MediaAsset row is created and the vault export cannot rewrite them. Fix ingest absolutization; switch export image embeds to Obsidian ![[name]] wikilinks.
status: done — awaiting user check (old docs not yet re-scraped/re-exported)
---

# Relative images + wikilink export

## Diagnosis (ingest bug, not exporter)

`/home/symunona/dropx/org/99-samizdat/documents/2026-W12/do-androids-dream-of-eclectic-sheep.md`
carries `![Google I'm Feeling Lucky](/images/ggfeelinglucky.png)` — a site-relative path.
DB: `media_assets` for that document = **0 rows**.

Chain:
1. `worker/scraper.go` keeps the `src` verbatim; trafilatura's `OriginalURL` does not
   absolutize image srcs in the converted markdown.
2. `worker/assets.go` `markdownImageRe` = `!\[…\]\((https?://…)\)` → a relative src is
   never a candidate → never downloaded → no `media_assets` row.
3. `export/export.go` builds `urlRewrite` from `media_assets.original_url` → nothing to
   rewrite → the relative path is written to the vault → Obsidian shows nothing.
4. `unwrapFigureImages`/`figureContentImages` also drop `<figure>` images whose src is
   relative (`strings.HasPrefix(src, "http")`), so those vanish outright.

Blast radius today: 18 documents / 41 images (ossama.is 39, anjalishriva.com 2) of 129
documents that carry images.

## Work

1. **Ingest** — absolutize relative image URLs against the canonical URL:
   - `unwrapFigureImages(raw, base)` resolves `src`/`data-src` before the http filter.
   - after html→md: `absolutizeImageURLs(md, base)` rewrites `![alt](rel)`.
   Unit tests for both.
2. **Export** — Obsidian embed style. New `[export] image_links = "wikilink" | "relative"`,
   default **wikilink**: `![[<uuid>.jpg]]` (no path, Obsidian resolves by name), hero
   frontmatter likewise. `relative` keeps today's `![alt](../assets/<uuid>.jpg)`.
   Rewriting moves from blind `strings.ReplaceAll` to an image-syntax regex.
3. Old documents keep their broken links until re-scraped — re-scrape is a separate,
   user-approved step.

## No image-name DB

`media_assets` has no original-filename column: `id` (UUIDv5 of the URL), `original_url`,
`local_path` (`media/<id>.jpg`), `kind`, `width`, `height`. The original basename is only
derivable from `original_url`; it is not stored and is not unique across documents.

## Test

- `go test ./internal/worker/... ./internal/export/...`
- `just build`
- re-export one document to a scratch dir and eyeball the emitted embeds
- `just e2e`
