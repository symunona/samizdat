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
UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?;

-- name: MarkJobFailed :exec
UPDATE jobs SET status = ?, attempts = ?, run_after = ?, updated_at = ? WHERE id = ?;

-- name: GetDocumentByCanonicalURL :one
SELECT * FROM documents WHERE canonical_url = ? AND deleted_at IS NULL LIMIT 1;

-- name: InsertDocument :one
INSERT INTO documents (id, canonical_url, title, markdown, fetched_at, created_at, updated_at, rev)
VALUES (?, ?, ?, ?, ?, ?, ?, 0)
RETURNING *;

-- name: ListDocuments :many
SELECT * FROM documents WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50;

-- name: GetDocumentByID :one
SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL LIMIT 1;
