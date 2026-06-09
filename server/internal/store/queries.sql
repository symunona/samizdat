-- name: InsertDevice :one
INSERT INTO devices (id, name, token_hash, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: GetDeviceByTokenHash :one
SELECT * FROM devices
WHERE token_hash = ? AND deleted_at IS NULL
LIMIT 1;

-- name: GetDevice :one
SELECT id, name, token_hash, created_at, updated_at, rev, deleted_at FROM devices
WHERE id = ? AND deleted_at IS NULL;

-- name: ListDevices :many
SELECT * FROM devices WHERE deleted_at IS NULL ORDER BY created_at;

-- name: UpdateDeviceLastSeen :exec
UPDATE devices SET last_seen_at = ? WHERE id = ?;

-- name: SoftDeleteDevice :exec
UPDATE devices SET deleted_at = ?, updated_at = ?, rev = ?
WHERE id = ?;

-- name: MaxDeviceRev :one
SELECT COALESCE(MAX(rev), 0) AS rev FROM devices;

-- name: InsertPairCode :exec
INSERT INTO pair_codes (code, expires_at) VALUES (?, ?);

-- name: GetPairCode :one
SELECT * FROM pair_codes WHERE code = ?;

-- name: MarkPairCodeUsed :exec
UPDATE pair_codes SET used_at = ? WHERE code = ?;

-- name: GetSetting :one
SELECT value FROM server_settings WHERE key = ? LIMIT 1;

-- name: UpsertSetting :exec
INSERT INTO server_settings (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- name: InsertJob :one
INSERT INTO jobs (id, kind, payload, status, attempts, run_after, created_at, updated_at, rev)
VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, 0)
RETURNING *;

-- name: ClaimNextJob :one
UPDATE jobs
SET status = 'running', attempts = attempts + 1, updated_at = ?
WHERE id = (
    SELECT j2.id FROM jobs j2
    WHERE j2.status = 'queued' AND j2.run_after <= ?
    ORDER BY j2.created_at
    LIMIT 1
)
RETURNING *;

-- name: MarkJobDone :exec
UPDATE jobs SET status = 'done', result = ?, updated_at = ? WHERE id = ?;

-- name: MarkJobFailed :exec
UPDATE jobs SET status = ?, attempts = ?, run_after = ?, updated_at = ? WHERE id = ?;

-- name: GetDocumentByCanonicalURL :one
SELECT * FROM documents WHERE canonical_url = ? AND deleted_at IS NULL LIMIT 1;

-- name: UpsertDocument :one
INSERT INTO documents (id, canonical_url, title, markdown, fetched_at, excerpt, hero_image_url, author, source_feed_id, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(canonical_url) DO UPDATE SET
  title          = excluded.title,
  markdown       = excluded.markdown,
  fetched_at     = excluded.fetched_at,
  excerpt        = excluded.excerpt,
  hero_image_url = excluded.hero_image_url,
  author         = excluded.author,
  source_feed_id = COALESCE(excluded.source_feed_id, documents.source_feed_id),
  updated_at     = excluded.updated_at,
  rev            = documents.rev + 1
RETURNING *;

-- name: UpdateDocumentExcerptHero :exec
UPDATE documents SET excerpt = ?, hero_image_url = ?, author = ?, updated_at = ? WHERE id = ?;

-- name: ListDocuments :many
SELECT * FROM documents WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50;

-- name: GetDocumentByID :one
SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL LIMIT 1;

-- name: UpsertReadState :one
INSERT INTO read_states (id, device_id, document_id, scroll_y, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(device_id, document_id) DO UPDATE SET
    scroll_y   = excluded.scroll_y,
    updated_at = excluded.updated_at,
    rev        = read_states.rev + 1
RETURNING *;

-- name: GetReadState :one
SELECT * FROM read_states
WHERE device_id = ? AND document_id = ? AND deleted_at IS NULL LIMIT 1;

-- name: UpsertMediaAsset :one
INSERT INTO media_assets (id, document_id, original_url, local_path, kind, width, height, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(original_url) DO UPDATE SET
  document_id = excluded.document_id,
  local_path  = excluded.local_path,
  kind        = excluded.kind,
  width       = excluded.width,
  height      = excluded.height,
  updated_at  = excluded.updated_at,
  rev         = media_assets.rev + 1
RETURNING *;

-- name: GetMediaAssetByOriginalURL :one
SELECT * FROM media_assets WHERE original_url = ? AND deleted_at IS NULL LIMIT 1;

-- name: GetMediaAssetByID :one
SELECT * FROM media_assets WHERE id = ? AND deleted_at IS NULL LIMIT 1;

-- name: ListMediaAssetsByDocument :many
SELECT * FROM media_assets WHERE document_id = ? AND deleted_at IS NULL ORDER BY created_at;

-- name: UpsertFeed :one
INSERT INTO feeds (id, url, kind, title, config, last_polled_at, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(url) DO UPDATE SET
  kind           = excluded.kind,
  title          = excluded.title,
  config         = excluded.config,
  updated_at     = excluded.updated_at,
  rev            = feeds.rev + 1
RETURNING *;

-- name: GetFeed :one
SELECT * FROM feeds WHERE id = ? AND deleted_at IS NULL LIMIT 1;

-- name: GetFeedByURL :one
SELECT * FROM feeds WHERE url = ? AND deleted_at IS NULL LIMIT 1;

-- name: ListFeeds :many
SELECT * FROM feeds WHERE deleted_at IS NULL ORDER BY created_at DESC;

-- name: MarkFeedPolled :exec
UPDATE feeds SET last_polled_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: InsertSubscription :one
INSERT INTO subscriptions (id, feed_id, interval_h, next_run_at, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, 0)
RETURNING *;

-- name: GetSubscription :one
SELECT * FROM subscriptions WHERE id = ? AND deleted_at IS NULL LIMIT 1;

-- name: ListSubscriptions :many
SELECT * FROM subscriptions WHERE deleted_at IS NULL ORDER BY created_at DESC;

-- name: ListDueSubscriptions :many
SELECT * FROM subscriptions WHERE next_run_at <= ? AND deleted_at IS NULL;

-- name: BumpSubscriptionNextRun :exec
UPDATE subscriptions SET next_run_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: DeleteSubscription :exec
UPDATE subscriptions SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: UpsertFeedItem :one
INSERT INTO feed_items (id, feed_id, url, status, seen_at, created_at, updated_at, rev)
VALUES (?, ?, ?, 'pending', ?, ?, ?, 0)
ON CONFLICT(feed_id, url) DO UPDATE SET
  seen_at    = excluded.seen_at,
  updated_at = excluded.updated_at,
  rev        = feed_items.rev + 1
RETURNING *;

-- name: ListFeedItemsByFeed :many
SELECT * FROM feed_items WHERE feed_id = ? AND deleted_at IS NULL ORDER BY seen_at DESC;

-- name: GetFeedItem :one
SELECT * FROM feed_items WHERE id = ? AND deleted_at IS NULL LIMIT 1;

-- name: UpdateFeedItemStatus :exec
UPDATE feed_items SET status = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: ClearCompletedJobs :exec
UPDATE jobs SET deleted_at = ?, updated_at = ?
WHERE status IN ('done', 'dead') AND deleted_at IS NULL;

-- name: ListJobs :many
SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100;

-- name: ListJobsByStatus :many
SELECT * FROM jobs WHERE status = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100;

-- name: ListJobsByKind :many
SELECT * FROM jobs WHERE kind = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100;

-- name: ListJobsByStatusAndKind :many
SELECT * FROM jobs WHERE status = ? AND kind = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100;

-- name: GetJob :one
SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL LIMIT 1;

-- name: RetryJob :exec
UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: SoftDeleteJob :exec
UPDATE jobs SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: MarkJobLastError :exec
UPDATE jobs SET last_error = ?, updated_at = ? WHERE id = ?;

-- name: InsertAnnotation :one
INSERT INTO annotations (id, document_id, highlight_id, exact, prefix, suffix, pos_start, pos_end, color, note, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
RETURNING *;

-- name: GetAnnotation :one
SELECT * FROM annotations WHERE id = ? AND deleted_at IS NULL LIMIT 1;

-- name: ListAnnotationsByDocument :many
SELECT * FROM annotations WHERE document_id = ? AND deleted_at IS NULL ORDER BY pos_start ASC;

-- name: UpdateAnnotation :exec
UPDATE annotations SET note = ?, color = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND deleted_at IS NULL;

-- name: SoftDeleteAnnotation :exec
UPDATE annotations SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: SoftDeleteDocument :exec
UPDATE documents SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND deleted_at IS NULL;

-- name: ListDocumentsWithAnnotationCount :many
SELECT d.id, d.canonical_url, d.title, d.markdown, d.fetched_at, d.excerpt,
       d.hero_image_url, d.author, d.source_feed_id, d.created_at, d.updated_at,
       d.rev, d.deleted_at,
       COALESCE(COUNT(a.id), 0) AS annotation_count
FROM documents d
LEFT JOIN annotations a ON a.document_id = d.id AND a.deleted_at IS NULL
WHERE d.deleted_at IS NULL
GROUP BY d.id
ORDER BY d.created_at DESC;
