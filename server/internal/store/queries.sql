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
