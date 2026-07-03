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

-- name: GetDeviceByName :one
SELECT * FROM devices
WHERE name = ? AND deleted_at IS NULL
ORDER BY created_at
LIMIT 1;

-- name: UpdateDeviceToken :exec
UPDATE devices SET token_hash = ?, updated_at = ?, rev = ?
WHERE id = ? AND deleted_at IS NULL;

-- name: ListDevices :many
SELECT * FROM devices WHERE deleted_at IS NULL ORDER BY created_at;

-- name: UpdateDeviceLastSeen :exec
UPDATE devices SET last_seen_at = ? WHERE id = ?;

-- name: UpdateDeviceName :exec
UPDATE devices SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL;

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
INSERT INTO jobs (id, kind, payload, status, attempts, run_after, created_at, updated_at, rev, parent_job_id)
VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, 0, ?)
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
UPDATE jobs SET status = 'done', result = ?, duration_ms = ?, updated_at = ? WHERE id = ?;

-- name: MarkJobFailed :exec
UPDATE jobs SET status = ?, attempts = ?, run_after = ?, duration_ms = ?, updated_at = ? WHERE id = ?;

-- name: GetScrapeDurationByDocument :one
-- Execution time of the most recent (non-deleted) scrape_url job that produced
-- this document. Used to show "Capture time" on the document metadata panel.
SELECT duration_ms FROM jobs
WHERE kind = 'scrape_url' AND deleted_at IS NULL
  AND json_valid(result) AND json_extract(result, '$.document_id') = ?
ORDER BY updated_at DESC LIMIT 1;

-- name: ResetStuckJobs :exec
-- Reset jobs stuck in 'running' for longer than the given cutoff time back to 'queued'
-- so the worker can retry them. Cutoff is an ISO8601 timestamp; jobs with updated_at
-- older than that are considered stuck (crashed worker, lost context, hung HTTP call).
UPDATE jobs SET status = 'queued', run_after = ?, updated_at = ?
WHERE status = 'running' AND updated_at < ? AND deleted_at IS NULL;

-- name: GetDocumentByCanonicalURL :one
SELECT * FROM documents WHERE canonical_url = ? AND deleted_at IS NULL LIMIT 1;

-- name: UpsertDocument :one
INSERT INTO documents (id, canonical_url, title, markdown, fetched_at, excerpt, hero_image_url, author, published_at, source_feed_id, content_hash, media_type, media_metadata, transcript, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(canonical_url) DO UPDATE SET
  title          = excluded.title,
  markdown       = excluded.markdown,
  fetched_at     = excluded.fetched_at,
  excerpt        = excluded.excerpt,
  hero_image_url = excluded.hero_image_url,
  author         = excluded.author,
  published_at   = COALESCE(excluded.published_at, documents.published_at),
  source_feed_id = COALESCE(excluded.source_feed_id, documents.source_feed_id),
  content_hash   = excluded.content_hash,
  media_type     = excluded.media_type,
  media_metadata = excluded.media_metadata,
  transcript     = excluded.transcript,
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

-- name: UpsertMediaPosition :one
-- Patch-style: only touches media_pos_ms so an article scroll_y save never
-- clobbers the playback position (they come from different callers).
INSERT INTO read_states (id, device_id, document_id, media_pos_ms, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(device_id, document_id) DO UPDATE SET
    media_pos_ms = excluded.media_pos_ms,
    updated_at   = excluded.updated_at,
    rev          = read_states.rev + 1
RETURNING *;

-- name: GetMediaPosition :one
-- Latest playback position across ALL devices for the document (cross-device resume).
SELECT media_pos_ms FROM read_states
WHERE document_id = ? AND deleted_at IS NULL AND media_pos_ms > 0
ORDER BY updated_at DESC LIMIT 1;

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

-- name: GetMediaAssetByDocumentAndKind :one
SELECT * FROM media_assets WHERE document_id = ? AND kind = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;

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

-- name: GetNewsletterFeedByToken :one
SELECT * FROM feeds WHERE kind = 'newsletter' AND config LIKE '%"token":"' || ? || '"%' AND deleted_at IS NULL LIMIT 1;

-- name: ListFeeds :many
SELECT * FROM feeds WHERE deleted_at IS NULL ORDER BY created_at DESC;

-- name: MarkFeedPolled :exec
UPDATE feeds SET last_polled_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: UpdateFeedConfig :exec
UPDATE feeds SET config = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: SoftDeleteFeed :exec
UPDATE feeds SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: DeleteSubscriptionsByFeed :exec
UPDATE subscriptions SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE feed_id = ? AND deleted_at IS NULL;

-- name: InsertSubscription :one
INSERT INTO subscriptions (id, feed_id, interval_h, next_run_at, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, 0)
RETURNING *;

-- name: GetSubscription :one
SELECT * FROM subscriptions WHERE id = ? AND deleted_at IS NULL LIMIT 1;

-- name: ListSubscriptions :many
SELECT * FROM subscriptions WHERE deleted_at IS NULL ORDER BY created_at DESC;

-- name: ListDueSubscriptions :many
SELECT * FROM subscriptions WHERE next_run_at <= ? AND deleted_at IS NULL AND paused = 0;

-- name: BumpSubscriptionNextRun :exec
UPDATE subscriptions SET next_run_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: UpdateSubscriptionPaused :exec
UPDATE subscriptions SET paused = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

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

-- name: InsertJobPaused :one
INSERT INTO jobs (id, kind, payload, status, attempts, run_after, created_at, updated_at, rev, parent_job_id)
VALUES (?, ?, ?, 'paused', 0, ?, ?, ?, 0, ?)
RETURNING *;

-- name: ResumeJob :exec
UPDATE jobs SET status = 'queued', run_after = ?, updated_at = ?, rev = rev + 1
WHERE id = ? AND status = 'paused';

-- name: ResumeAllPausedJobs :exec
UPDATE jobs SET status = 'queued', run_after = ?, updated_at = ?, rev = rev + 1
WHERE status = 'paused' AND deleted_at IS NULL;

-- name: CountActiveScrapeJobsForURL :one
SELECT COUNT(*) FROM jobs
WHERE kind = 'scrape_url'
  AND json_extract(payload, '$.url') = ?
  AND status IN ('queued', 'running', 'paused')
  AND deleted_at IS NULL;

-- name: CountActivePollFeedJobsForFeed :one
SELECT COUNT(*) FROM jobs
WHERE kind = 'poll_feed'
  AND json_extract(payload, '$.feed_id') = ?
  AND status IN ('queued', 'running')
  AND deleted_at IS NULL;

-- name: CountActiveRunPipelineJobsForDoc :one
SELECT COUNT(*) FROM jobs
WHERE kind = 'run_pipeline'
  AND json_extract(payload, '$.document_id') = ?
  AND json_extract(payload, '$.pipeline_id') = ?
  AND status IN ('queued', 'running', 'paused')
  AND deleted_at IS NULL;

-- name: ClearCompletedJobs :execresult
UPDATE jobs SET deleted_at = ?, updated_at = ?
WHERE status IN ('done', 'dead', 'paused') AND deleted_at IS NULL;

-- name: ClearQueuedJobs :execresult
UPDATE jobs SET deleted_at = ?, updated_at = ?
WHERE status = 'queued' AND deleted_at IS NULL;

-- name: ListJobs :many
SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100;

-- name: ListJobsByStatus :many
SELECT * FROM jobs WHERE status = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100;

-- name: ListJobsByKind :many
SELECT * FROM jobs WHERE kind = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100;

-- name: ListJobsByStatusAndKind :many
SELECT * FROM jobs WHERE status = ? AND kind = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100;

-- name: GetJob :one
SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL LIMIT 1;

-- name: RetryJob :exec
UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: SoftDeleteJob :exec
UPDATE jobs SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: MarkJobLastError :exec
UPDATE jobs SET last_error = ?, updated_at = ? WHERE id = ?;

-- name: InsertAnnotation :one
INSERT INTO annotations (id, document_id, highlight_id, exact, prefix, suffix, pos_start, pos_end, media_ts_ms, color, note, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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

-- name: InsertTag :one
INSERT INTO tags (id, name, color, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, 0)
RETURNING *;

-- name: GetTag :one
SELECT * FROM tags WHERE id = ? AND deleted_at IS NULL LIMIT 1;

-- name: GetTagByName :one
SELECT * FROM tags WHERE name = ? AND deleted_at IS NULL LIMIT 1;

-- name: ListTagsWithCounts :many
SELECT t.id, t.name, t.color, t.created_at, t.updated_at, t.rev, t.deleted_at,
       COALESCE(SUM(CASE WHEN dt.id IS NOT NULL AND dt.deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS doc_count,
       COALESCE(SUM(CASE WHEN at2.id IS NOT NULL AND at2.deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS ann_count
FROM tags t
LEFT JOIN document_tags dt ON dt.tag_id = t.id
LEFT JOIN annotation_tags at2 ON at2.tag_id = t.id
WHERE t.deleted_at IS NULL
GROUP BY t.id
ORDER BY (COALESCE(SUM(CASE WHEN dt.deleted_at IS NULL THEN 1 ELSE 0 END), 0) + COALESCE(SUM(CASE WHEN at2.deleted_at IS NULL THEN 1 ELSE 0 END), 0)) DESC, t.name ASC;

-- name: SoftDeleteTag :exec
UPDATE tags SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: InsertDocumentTag :one
INSERT INTO document_tags (id, document_id, tag_id, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, 0)
RETURNING *;

-- name: DeleteDocumentTag :exec
UPDATE document_tags SET deleted_at = ?, updated_at = ?, rev = rev + 1
WHERE document_id = ? AND tag_id = ? AND deleted_at IS NULL;

-- name: ListTagsByDocument :many
SELECT t.* FROM tags t
JOIN document_tags dt ON dt.tag_id = t.id
WHERE dt.document_id = ? AND dt.deleted_at IS NULL AND t.deleted_at IS NULL
ORDER BY t.name ASC;

-- name: ListDocumentsByTag :many
SELECT d.* FROM documents d
JOIN document_tags dt ON dt.document_id = d.id
WHERE dt.tag_id = ? AND dt.deleted_at IS NULL AND d.deleted_at IS NULL
ORDER BY d.created_at DESC;

-- name: InsertAnnotationTag :one
INSERT INTO annotation_tags (id, annotation_id, tag_id, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, 0)
RETURNING *;

-- name: DeleteAnnotationTag :exec
UPDATE annotation_tags SET deleted_at = ?, updated_at = ?, rev = rev + 1
WHERE annotation_id = ? AND tag_id = ? AND deleted_at IS NULL;

-- name: ListTagsByAnnotation :many
SELECT t.* FROM tags t
JOIN annotation_tags at2 ON at2.tag_id = t.id
WHERE at2.annotation_id = ? AND at2.deleted_at IS NULL AND t.deleted_at IS NULL
ORDER BY t.name ASC;

-- name: ListAnnotationsByTag :many
SELECT a.* FROM annotations a
JOIN annotation_tags at2 ON at2.annotation_id = a.id
WHERE at2.tag_id = ? AND at2.deleted_at IS NULL AND a.deleted_at IS NULL
ORDER BY a.created_at DESC;

-- name: ListDocumentsWithAnnotationCount :many
SELECT d.id, d.canonical_url, d.title, d.markdown, d.fetched_at, d.excerpt,
       d.hero_image_url, d.author, d.published_at, d.source_feed_id, d.content_hash, d.created_at, d.updated_at,
       d.rev, d.deleted_at,
       COALESCE(COUNT(DISTINCT a.id), 0) AS annotation_count,
       COALESCE(COUNT(DISTINCT h.id), 0) AS highlight_count
FROM documents d
LEFT JOIN annotations a ON a.document_id = d.id AND a.deleted_at IS NULL
LEFT JOIN highlights h ON h.document_id = d.id AND h.deleted_at IS NULL
WHERE d.deleted_at IS NULL
GROUP BY d.id
ORDER BY d.created_at DESC;

--  Pipelines

-- name: InsertPipeline :one
INSERT INTO pipelines (id, name, enabled, trigger, filter, steps, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
RETURNING *;

-- name: GetPipeline :one
SELECT * FROM pipelines WHERE id = ? AND deleted_at IS NULL LIMIT 1;

-- name: ListPipelines :many
SELECT * FROM pipelines WHERE deleted_at IS NULL ORDER BY created_at DESC;

-- name: ListEnabledPipelines :many
SELECT * FROM pipelines WHERE enabled = 1 AND deleted_at IS NULL ORDER BY created_at;

-- name: UpdatePipeline :exec
UPDATE pipelines SET name = ?, enabled = ?, trigger = ?, filter = ?, steps = ?, updated_at = ?, rev = rev + 1
WHERE id = ?;

-- name: SoftDeletePipeline :exec
UPDATE pipelines SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

--  PipelineRuns

-- name: InsertPipelineRun :one
INSERT INTO pipeline_runs (id, pipeline_id, document_id, job_id, document_content_hash, status, step_index, state, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, 'queued', 0, '{}', ?, ?, 0)
RETURNING *;

-- name: GetPipelineRun :one
SELECT * FROM pipeline_runs WHERE id = ? LIMIT 1;

-- name: ListPipelineRunsByDocument :many
SELECT * FROM pipeline_runs WHERE document_id = ? AND deleted_at IS NULL ORDER BY created_at DESC;

-- name: GetPipelineRunByDocumentAndPipeline :one
SELECT * FROM pipeline_runs
WHERE document_id = ? AND pipeline_id = ? AND deleted_at IS NULL
ORDER BY created_at DESC LIMIT 1;

-- name: GetLatestDoneRunForDoc :one
SELECT * FROM pipeline_runs
WHERE pipeline_id = ? AND document_id = ? AND status = 'done' AND deleted_at IS NULL
ORDER BY created_at DESC LIMIT 1;

-- name: UpdatePipelineRunProgress :exec
UPDATE pipeline_runs SET status = ?, step_index = ?, state = ?, updated_at = ?, rev = rev + 1
WHERE id = ?;

-- name: SoftDeletePipelineRunsByDocument :exec
UPDATE pipeline_runs SET deleted_at = ?, updated_at = ? WHERE document_id = ? AND deleted_at IS NULL;

--  Highlights

-- name: InsertHighlight :one
INSERT INTO highlights (id, document_id, pipeline_run_id, kind, title, body, metadata, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
RETURNING *;

-- name: ListHighlights :many
SELECT * FROM highlights WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at DESC LIMIT ?;

-- name: ListArchivedHighlights :many
SELECT * FROM highlights WHERE deleted_at IS NULL AND archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT ?;

-- name: ListPinnedHighlights :many
SELECT * FROM highlights WHERE deleted_at IS NULL AND pinned = 1 ORDER BY created_at DESC LIMIT ?;

-- name: ListHighlightsByDocument :many
SELECT * FROM highlights WHERE document_id = ? AND deleted_at IS NULL ORDER BY created_at ASC;

-- name: ListHighlightsByPipelineRun :many
SELECT * FROM highlights WHERE pipeline_run_id = ? AND deleted_at IS NULL ORDER BY created_at ASC;

-- name: ListRecentTopicHighlightsByFeed :many
-- Recent non-summary highlights from other documents of the same feed, for
-- cross-issue dedup (feed the model what it already covered). Excludes the current
-- document so a re-run doesn't dedup against its own prior output.
SELECT h.title, h.body, h.kind
FROM highlights h
JOIN documents d ON d.id = h.document_id
WHERE d.source_feed_id = ?
  AND h.document_id != ?
  AND h.deleted_at IS NULL
  AND h.kind != 'summary'
  AND h.created_at >= ?
ORDER BY h.created_at DESC
LIMIT ?;

-- name: UpdateHighlightBody :exec
UPDATE highlights SET body = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: SoftDeleteHighlight :exec
UPDATE highlights SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: SoftDeleteHighlightsByPipelineRun :exec
UPDATE highlights SET deleted_at = ?, updated_at = ?, rev = rev + 1
WHERE pipeline_run_id = ? AND deleted_at IS NULL;

-- name: UpdateHighlightPinned :exec
UPDATE highlights SET pinned = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: ArchiveHighlight :exec
UPDATE highlights SET archived_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?;

-- name: InsertHighlightTag :one
INSERT INTO highlight_tags (id, highlight_id, tag_id, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, 0)
RETURNING *;

-- name: DeleteHighlightTag :exec
UPDATE highlight_tags SET deleted_at = ?, updated_at = ?, rev = rev + 1
WHERE highlight_id = ? AND tag_id = ? AND deleted_at IS NULL;

-- name: ListTagsByHighlight :many
SELECT t.* FROM tags t
JOIN highlight_tags ht ON ht.tag_id = t.id
WHERE ht.highlight_id = ? AND ht.deleted_at IS NULL AND t.deleted_at IS NULL
ORDER BY t.name ASC;

-- name: ListHighlightsByTag :many
SELECT h.* FROM highlights h
JOIN highlight_tags ht ON ht.highlight_id = h.id
WHERE ht.tag_id = ? AND ht.deleted_at IS NULL AND h.deleted_at IS NULL
ORDER BY h.created_at DESC;

-- Differential sync queries (returns all rows changed after since, including tombstones)

-- name: ListDocumentsSince :many
SELECT * FROM documents WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListHighlightsSince :many
SELECT * FROM highlights WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListAnnotationsSince :many
SELECT * FROM annotations WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListTagsSince :many
SELECT * FROM tags WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListDocumentTagsSince :many
SELECT * FROM document_tags WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListAnnotationTagsSince :many
SELECT * FROM annotation_tags WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListHighlightTagsSince :many
SELECT * FROM highlight_tags WHERE updated_at > ? ORDER BY updated_at ASC;

-- Jobs paging (offset-based for the admin UI)

-- name: ListJobsPage :many
SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?;

-- name: ListJobsByStatusPage :many
SELECT * FROM jobs WHERE status = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?;

-- name: ListJobsByKindPage :many
SELECT * FROM jobs WHERE kind = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?;

-- name: ListJobsByStatusAndKindPage :many
SELECT * FROM jobs WHERE status = ? AND kind = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?;

-- name: CountJobs :one
SELECT COUNT(*) FROM jobs WHERE deleted_at IS NULL;

-- name: CountJobsByStatus :one
SELECT COUNT(*) FROM jobs WHERE status = ? AND deleted_at IS NULL;

-- name: CountJobsByKind :one
SELECT COUNT(*) FROM jobs WHERE kind = ? AND deleted_at IS NULL;

-- name: CountJobsByStatusAndKind :one
SELECT COUNT(*) FROM jobs WHERE status = ? AND kind = ? AND deleted_at IS NULL;

-- Root-only paging: paginate by top-level jobs (parent_job_id IS NULL)

-- name: ListRootJobsPage :many
SELECT * FROM jobs WHERE parent_job_id IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?;

-- name: ListRootJobsByStatusPage :many
SELECT * FROM jobs WHERE parent_job_id IS NULL AND status = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?;

-- name: ListRootJobsByKindPage :many
SELECT * FROM jobs WHERE parent_job_id IS NULL AND kind = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?;

-- name: ListRootJobsByStatusAndKindPage :many
SELECT * FROM jobs WHERE parent_job_id IS NULL AND status = ? AND kind = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?;

-- name: CountRootJobs :one
SELECT COUNT(*) FROM jobs WHERE parent_job_id IS NULL AND deleted_at IS NULL;

-- Root paging including superseded (tombstoned) roots, for the jobs history view.
-- name: ListRootJobsPageInclDeleted :many
SELECT * FROM jobs WHERE parent_job_id IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?;

-- name: CountRootJobsInclDeleted :one
SELECT COUNT(*) FROM jobs WHERE parent_job_id IS NULL;

-- name: CountRootJobsByStatus :one
SELECT COUNT(*) FROM jobs WHERE parent_job_id IS NULL AND status = ? AND deleted_at IS NULL;

-- name: CountRootJobsByKind :one
SELECT COUNT(*) FROM jobs WHERE parent_job_id IS NULL AND kind = ? AND deleted_at IS NULL;

-- name: CountRootJobsByStatusAndKind :one
SELECT COUNT(*) FROM jobs WHERE parent_job_id IS NULL AND status = ? AND kind = ? AND deleted_at IS NULL;

-- name: ListJobsByPipelineId :many
SELECT * FROM jobs WHERE json_extract(payload, '$.pipeline_id') = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?;

-- name: CountJobsByPipelineId :one
SELECT COUNT(*) FROM jobs WHERE json_extract(payload, '$.pipeline_id') = ? AND deleted_at IS NULL;

-- name: ListDocumentsByPipeline :many
SELECT DISTINCT d.id, d.canonical_url, d.title, d.markdown, d.fetched_at, d.excerpt,
       d.hero_image_url, d.author, d.published_at, d.source_feed_id, d.content_hash,
       d.media_type, d.media_metadata, d.transcript, d.created_at, d.updated_at,
       d.rev, d.deleted_at
FROM documents d
JOIN pipeline_runs pr ON pr.document_id = d.id
WHERE pr.pipeline_id = ? AND pr.deleted_at IS NULL AND d.deleted_at IS NULL
ORDER BY pr.updated_at DESC
LIMIT 200;

-- name: ListDocumentsByFeed :many
SELECT d.id, d.canonical_url, d.title, d.markdown, d.fetched_at, d.excerpt,
       d.hero_image_url, d.author, d.published_at, d.source_feed_id, d.content_hash,
       d.media_type, d.media_metadata, d.transcript, d.created_at, d.updated_at,
       d.rev, d.deleted_at
FROM documents d
WHERE d.source_feed_id = ? AND d.deleted_at IS NULL
ORDER BY d.created_at DESC;

-- LLM usage audit log

-- name: InsertLLMUsage :exec
INSERT INTO llm_usages (id, job_id, pipeline_run_id, provider, model, input_tokens, output_tokens, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetLLMUsageTotals :one
SELECT
    COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
    COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
    COUNT(*)                         AS total_calls
FROM llm_usages;

-- name: GetLLMUsageTotalsByModel :many
SELECT model,
       COALESCE(SUM(input_tokens), 0)  AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens
FROM llm_usages
GROUP BY model;
