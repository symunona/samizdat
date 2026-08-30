---
created: 2026-06-09
topic: Deterministic UUIDs from URL (UUID v5)
excerpt: Replace uuid.NewString() with UUID-v5 from canonical URL so re-scraping the same URL never loses its document ID
status: draft
---

## Problem

Every `scrape_url` run calls `uuid.NewString()` → fresh random UUID → duplicate
`Document` rows if the same URL is scraped twice, and re-scrapes break all FK
references (media_assets, read_states).

## Fix

UUID v5 = SHA-1(namespace, name). `github.com/google/uuid` already in go.mod.

```go
// server/internal/worker/ids.go  (new file)
package worker

import "github.com/google/uuid"

// IDFromURL returns a stable UUID-v5 for any URL string.
// Same input always produces the same output.
func IDFromURL(u string) string {
    return uuid.NewSHA1(uuid.NameSpaceURL, []byte(u)).String()
}
```

## Files to change

### server/internal/worker/scraper.go

```diff
- docID := uuid.NewString()
+ docID := IDFromURL(canonicalURL)
```

Also change the INSERT to upsert so re-scrapes update rather than fail:

```sql
-- queries.sql
INSERT INTO documents (...) VALUES (...)
ON CONFLICT(canonical_url) DO UPDATE SET
  title          = excluded.title,
  markdown       = excluded.markdown,
  fetched_at     = excluded.fetched_at,
  excerpt        = excluded.excerpt,
  hero_image_url = excluded.hero_image_url,
  author         = excluded.author,
  updated_at     = excluded.updated_at,
  rev            = excluded.rev;
```

### server/internal/worker/assets.go

```diff
- assetID := uuid.NewString()
+ assetID := IDFromURL(asset.OriginalURL)
```

Same upsert pattern for `media_assets ON CONFLICT(original_url)`.

## What NOT to change

- `devices`, `jobs`, `pair_codes`, `read_states` — random UUIDs stay; these are
  not keyed by URL and must not collide.

## Verification

1. Scrape the same URL twice → same document ID, no duplicate row, `updated_at` bumped
2. Media asset re-fetch → same asset ID, local_path unchanged
3. `just build` passes
4. Run existing e2e scrape test (or manual: POST scrape_url twice, check DB)
