---
created: 2026-06-08
topic: Media assets — image scraping, thumbnails, static serving, frontend display
excerpt: Download content images + hero image as thumbnails into cache dir; serve via /api/v1/media/:id; display in document viewer. Fix missing article summary + hero image for 444-type articles.
status: done
---

# Media Assets

## Problem statement
1. Scraped documents lose all images — markdown has remote `![](https://…)` refs that rot or are blocked.
2. Article hero image (`og:image`) and lead excerpt (`og:description`) not captured at all — trafilatura exposes them via `result.Metadata` but we discard them.
3. Video embeds dropped entirely (deferred — not in this plan).
4. No local serving of media.

## Non-goals (deferred)
- Full-size image archiving (thumbnails only for now)
- Video/audio embed archiving
- Vault promotion of media assets (only when doc is pinned — separate story)

---

## Architecture

### Cache dir
Add `CacheDir` field to `Config` struct. Default: `DataDir + "/cache"`.
Media assets stored at: `<CacheDir>/media/<asset-id>.<ext>`

`config.toml` key: `cache_dir` (optional, defaults to `~/.samizdat/cache`)

### New DB table: `media_assets`
```sql
CREATE TABLE IF NOT EXISTS media_assets (
    id           TEXT PRIMARY KEY,   -- UUID, used as filename base
    document_id  TEXT NOT NULL REFERENCES documents(id),
    original_url TEXT NOT NULL,
    local_path   TEXT NOT NULL,      -- relative to CacheDir: "media/<id>.<ext>"
    kind         TEXT NOT NULL,      -- 'hero' | 'content'
    width        INTEGER,            -- thumbnail pixel width
    height       INTEGER,            -- thumbnail pixel height
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    rev          INTEGER NOT NULL DEFAULT 0,
    deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS media_assets_document_id ON media_assets(document_id);
CREATE UNIQUE INDEX IF NOT EXISTS media_assets_original_url ON media_assets(original_url);
```

### Document table: add `excerpt`, `hero_image_url`, `author`
New columns on `documents`:
- `excerpt TEXT NOT NULL DEFAULT ''` — from `og:description` / `meta[name=description]`
- `hero_image_url TEXT NOT NULL DEFAULT ''` — from `og:image` (original remote URL, normalized)
- `author TEXT NOT NULL DEFAULT ''` — from `result.Metadata.Author` (byline)

Trafilatura already populates `result.Metadata.Description`, `result.Metadata.Image`, and `result.Metadata.Author` — just store them.

---

## Server changes

### 1. Config (`internal/config/config.go`)
- Add `CacheDir string \`toml:"cache_dir"\`` to `Config`
- Default: `filepath.Join(data, "cache")`
- `os.MkdirAll(cfg.CacheDir+"/media", 0755)` at server start

### 2. Schema + queries (`internal/store/`)
- Add `excerpt`, `hero_image_url` to `documents` table
- Add `media_assets` table (see above)
- Add queries:
  - `InsertMediaAsset`
  - `GetMediaAssetByOriginalURL`
  - `ListMediaAssetsByDocument`
  - `UpdateDocumentExcerptHero` — sets excerpt + hero_image_url on existing doc
- Update `InsertDocument` params + `GetDocumentByID` return to include new columns
- Run `sqlc generate`

### 3. Scraper (`internal/worker/scraper.go`)
After `InsertDocument`, extract from `result.Metadata`:
- `excerpt` = `result.Metadata.Description` (trim, max 500 chars)
- `hero_image_url` = `result.Metadata.Image` (raw URL from og:image)
- `author` = `result.Metadata.Author` (trim)

Store all three on document.

Then enqueue a `fetch_assets` job: `{"document_id": "<id>"}` with `run_after = now`.

### 4. Asset fetcher (`internal/worker/assets.go`) — NEW FILE
Job kind: `fetch_assets`

**Flow:**
1. Load document by id → get markdown + hero_image_url
2. Collect image URLs:
   - `hero_image_url` (kind=`hero`)
   - Walk markdown for `![…](https://…)` patterns → content images (kind=`content`)
3. For each URL, run `shouldDownload(url)` filter (see below)
4. Check `GetMediaAssetByOriginalURL` — skip if already cached
5. HTTP GET image → decode → resize to thumbnail → save JPEG to cache
6. `InsertMediaAsset` with local_path

**Thumbnail spec:**
- Max dimension: 800px on longest side, preserve aspect ratio
- Format: JPEG, quality 80
- Library: `golang.org/x/image` (resize) + standard `image/jpeg`, `image/png`, `image/gif` decoders
- Add `github.com/nfnt/resize` or use `golang.org/x/image/draw` (stdlib, no extra dep)

**`shouldDownload(url, altText, htmlContext)` heuristics:**
Skip if URL path matches any of:
- `icon`, `logo`, `avatar`, `sprite`, `pixel`, `tracker`, `badge`, `button`, `banner`
- extension is `.gif` (animated noise, tracker pixels)
- extension is `.svg` (vector icons)

Skip if alt text matches: `""` (empty), `"logo"`, `"icon"`

Skip if image is in `<nav>`, `<header>`, `<footer>` (trafilatura already strips these from ContentNode — so for content images this filter is mostly belt+suspenders; applies mainly to raw HTML walk if ever added)

Keep if: no skip condition matched, URL is absolute http/https.

**Content image walk:**
Use regex on markdown: `!\[([^\]]*)\]\((https?://[^)]+)\)` — capture alt + URL.

### 5. Media serve endpoint (`internal/api/media.go`) — NEW FILE
```
GET /api/v1/media/{id}
```
- Public (no bearer auth) — media is not sensitive; tokens would break `<img>` tags in markdown renderer
- Look up `media_assets` by id
- Serve file from `CacheDir/media/<id>.<ext>`
- Set `Content-Type: image/jpeg` (always JPEG thumbnails)
- Set `Cache-Control: public, max-age=86400`
- 404 if not found in DB or file missing

Wire in `router.go`:
```go
mediaH := &mediaHandler{q: q, cacheDir: cfg.CacheDir}
mux.HandleFunc("GET /api/v1/media/{id}", mediaH.serve)
```

Pass `cfg.CacheDir` into `New(...)` or pass full cfg.

### 6. Document API response
`GetDocumentByID` now returns `excerpt` and `hero_image_url` — update JSON response automatically via sqlc.

Also add: `GET /api/v1/documents/{id}/media` → array of `media_assets` for that document (id, kind, width, height). App uses this to build URL map for markdown image rewriting.

---

## App changes

### 1. `src/api.ts`
- Add `excerpt`, `hero_image_url`, `author` to `Document` type
- Add `fetchDocumentMedia(baseUrl, token, id)` → `MediaAsset[]`

```ts
export interface MediaAsset {
  id: string
  document_id: string
  original_url: string
  kind: 'hero' | 'content'
  width: number | null
  height: number | null
}
```

### 2. `app/document/[id].tsx`
**Hero image + excerpt + author section** — above the divider, below the title/URL/meta:
```
[author if present — "By Jane Doe", muted text, small]
[hero image if present, full width, natural aspect ratio]
[excerpt text if present, styled as lead paragraph / italic]
```

**Markdown image rewriting:**
- After loading doc + media assets, build a map: `{original_url → /api/v1/media/<id>}`
- Pass custom `image` renderer to `react-native-markdown-display`:
  ```tsx
  rules={{
    image: (node) => {
      const src = mediaMap[node.attributes.src] ?? node.attributes.src
      return <Image key={node.key} source={{ uri: `${activeUrl}${src}` }} style={s.image} resizeMode="contain" />
    }
  }}
  ```

**Load sequence:**
```ts
const [doc, progress, media] = await Promise.all([
  fetchDocument(...),
  fetchReadingProgress(...),
  fetchDocumentMedia(...),
])
```

Build `mediaMap` from `media` array before render.

---

## API changes summary

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/v1/media/{id}` | none | Serve thumbnail JPEG |
| GET | `/api/v1/documents/{id}/media` | bearer | List media assets for doc |

---

## Implementation order

- [x] 1. Config: add CacheDir, mkdir on start
- [x] 2. Schema: add excerpt/hero_image_url/author to documents, add media_assets table
- [x] 3. sqlc generate
- [x] 4. Scraper: extract excerpt + hero_image_url + author, enqueue fetch_assets job
- [x] 5. assets.go: fetch_assets job handler (download + thumbnail + insert)
- [x] 6. media.go: serve endpoint (public, no auth)
- [x] 7. router.go: wire new endpoints + pass cacheDir
- [x] 8. App api.ts: new types + fetchDocumentMedia
- [x] 9. App document viewer: hero image, excerpt, author, image rewriting
- [ ] 10. Re-scrape 444 article to test
- [x] 11. `just build` — zero errors
- [ ] 12. agent-browser e2e: open document, verify hero image + content images render

---

## Open questions / decisions made
- **No bearer auth on /api/v1/media/{id}**: simplifies `<img>` src in markdown. Media is not PII.
- **JPEG thumbnails only**: consistent Content-Type, smaller files. PNG decode → JPEG encode is fine.
- **No dedup across documents**: `UNIQUE ON original_url` means same remote image shared across docs reuses one asset record + file.
- **golang.org/x/image/draw** for resize: zero extra deps (already in Go stdlib extended).
- **gif/svg skip**: gifs are almost always noise or trackers; SVGs need rasterization (skip for now).
