---
created: 2026-07-02
topic: Auto-export Obsidian vault (DB → markdown, one-way)
excerpt: Continuously persist Documents + Annotations as Obsidian-flavored markdown to a configured folder. Frontmatter carries IDs; overwrite-by-id only. Stats on UI.
status: done — server engine + config + API + Settings card + e2e green
---

# Auto-export vault

## Goal
Continuously mirror the SQLite index out to a plain-markdown **Obsidian vault** on disk.
One-way (DB → markdown). Own files (by frontmatter `id`) are overwritten; foreign files
are never touched. An index note is (re)built on load. Stats surfaced in the app.

This is a *backup/observation* view, not the design-rule "source of truth" vault — hence a
separate `[export]` config section, distinct from the reserved (still-unused) `vault_dir`.

## Decisions
- **Layout:** one `.md` per `Document`. Annotations embedded in the doc note as Obsidian
  callouts (`> [!quote]`) with block-ref ids (`^ann_<id>`). Fewer files; annotations travel
  with their source; clean overwrite-by-id at file granularity.
- **Config:** new `[export]` section — `dir` (path, repo-relative ok) + `enabled` (bool).
- **Cursor:** incremental by `updated_at` (same cursor the sync endpoint uses). Track last
  exported `updated_at`; re-export any doc whose row OR whose annotation changed since.
- **Filenames:** slug of title; id→path map built by scanning existing frontmatter on load,
  so a retitled doc rewrites its existing file instead of orphaning it. Collisions get `-N`.
- **Overwrite rule:** only files whose frontmatter contains our `id` (and a
  `samizdat: export` marker) are ever written/renamed. Everything else is left untouched.
- **Index:** `_index.md` — a MOC listing all exported docs (wikilinks, grouped by month),
  regenerated on every sweep and on startup.

## Vault file shape
```
---
id: <doc uuid>
samizdat: export
canonical_url: <url>
title: <title>
author: <author>
published: <iso or empty>
fetched: <iso>
media_type: article|video
tags: [foo, bar]
---
# <title>

<document markdown body>

## Annotations
> [!quote] <note body, or "(no note)">
> <exact selection>
> — pos <start>–<end> · <color> ^ann_<id>
```

## Work items
1. **config**: add `ExportSection{Dir, Enabled}` to `config.go` + defaults. Wire into `[export]`.
2. **sqlc**: add `ListTagNamesForDocument` (join document_tags→tags), regen.
3. **export pkg** (`server/internal/export/`):
   - `Exporter{q, dir, log, mu, stats}`.
   - `slug()`, `render(doc, annos, tags) []byte`, frontmatter parse (read id from a file).
   - `loadIndex()` — scan `dir/*.md`, map our `id`→path (skip foreign files).
   - `sweep(ctx)` — docs+annotations since cursor → set of docIDs → rewrite each → advance
     cursor → rebuild `_index.md` → update stats.
   - `Run(ctx)` — initial full sweep, then `time.Ticker` loop (e.g. every 15s).
4. **wire**: start exporter goroutine from `api.New` when `enabled`. Expose stats via handler.
5. **api**: `GET /api/v1/export/stats` → `{enabled, dir, doc_count, annotation_count,
   last_export_at, last_error}`.
6. **app**: show stats in Settings screen (new "Export" card).
7. **dev config + gitignore**: add `[export]` to repo `config.toml`; gitignore `export-vault/`.
8. **e2e**: extend smoke — assert `/api/v1/export/stats` 200 + files land on disk.
9. Lint, `just build`, `just e2e`, `just dev` restart. Squash-merge to main.

## Non-goals
- No import / two-way. No deletes of foreign files. No highlight export (machine data, and
  Highlights already flow server→phone; can add later if wanted).
