// EVERY SQL string in the app lives here. Nothing else — not repo.ts, not a driver, and
// certainly not a screen — may contain SQL text; a linter enforces that wall so the
// schema has exactly one place to change and no query can hide in a component.
//
// This file is data only: named constants, no logic, no imports beyond the junction-type
// vocabulary used to key the three parallel tag tables.

import type { JunctionType } from '../store/outbox'

// ── schema ────────────────────────────────────────────────────────────────────
// Mirrors the server's tables: same names, same columns, so a synced row IS the API
// row. Every synced table carries `rev` + `updated_at` + a `deleted_at` tombstone.
// The junction tables are the one deliberate narrowing — see UPSERT_JUNCTION below.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id               TEXT PRIMARY KEY,
  canonical_url    TEXT NOT NULL DEFAULT '',
  title            TEXT NOT NULL DEFAULT '',
  markdown         TEXT NOT NULL DEFAULT '',
  fetched_at       TEXT NOT NULL DEFAULT '',
  excerpt          TEXT NOT NULL DEFAULT '',
  hero_image_url   TEXT NOT NULL DEFAULT '',
  author           TEXT NOT NULL DEFAULT '',
  source_feed_id   TEXT,
  media_type       TEXT,
  media_metadata   TEXT,
  transcript       TEXT,
  error_reason     TEXT,
  annotation_count INTEGER,
  highlight_count  INTEGER,
  capture_ms       INTEGER,
  added_via        TEXT,
  created_at       TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL DEFAULT '',
  rev              INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (created_at DESC);

CREATE TABLE IF NOT EXISTS highlights (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL DEFAULT '',
  pipeline_run_id TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  body_html       TEXT,
  metadata        TEXT NOT NULL DEFAULT '',
  pinned          INTEGER NOT NULL DEFAULT 0,
  archived_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL DEFAULT '',
  rev             INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_highlights_document ON highlights (document_id);
CREATE INDEX IF NOT EXISTS idx_highlights_archived ON highlights (archived_at);
CREATE INDEX IF NOT EXISTS idx_highlights_pinned ON highlights (pinned);

CREATE TABLE IF NOT EXISTS annotations (
  id           TEXT PRIMARY KEY,
  document_id  TEXT,
  highlight_id TEXT,
  exact        TEXT NOT NULL DEFAULT '',
  prefix       TEXT NOT NULL DEFAULT '',
  suffix       TEXT NOT NULL DEFAULT '',
  pos_start    INTEGER NOT NULL DEFAULT 0,
  pos_end      INTEGER NOT NULL DEFAULT 0,
  media_ts_ms  INTEGER NOT NULL DEFAULT 0,
  color        TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT '',
  rev          INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_annotations_document ON annotations (document_id);
CREATE INDEX IF NOT EXISTS idx_annotations_highlight ON annotations (highlight_id);

CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  rev        INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL,
  tag_id      TEXT NOT NULL,
  PRIMARY KEY (document_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_document_tags_tag ON document_tags (tag_id);

CREATE TABLE IF NOT EXISTS annotation_tags (
  annotation_id TEXT NOT NULL,
  tag_id        TEXT NOT NULL,
  PRIMARY KEY (annotation_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_annotation_tags_tag ON annotation_tags (tag_id);

CREATE TABLE IF NOT EXISTS highlight_tags (
  highlight_id TEXT NOT NULL,
  tag_id       TEXT NOT NULL,
  PRIMARY KEY (highlight_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_highlight_tags_tag ON highlight_tags (tag_id);

CREATE TABLE IF NOT EXISTS outbox (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,
  args         TEXT NOT NULL,
  tries        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT '',
  base_rev     INTEGER NOT NULL DEFAULT 0,
  coalesce_key TEXT
);

CREATE TABLE IF NOT EXISTS dirty (
  key      TEXT PRIMARY KEY,
  base_rev INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS media_files (
  document_id TEXT PRIMARY KEY,
  uri         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`

// ── meta ──────────────────────────────────────────────────────────────────────
export const SELECT_META = 'SELECT value FROM meta WHERE key = ?'
export const UPSERT_META = 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'

// ── documents ─────────────────────────────────────────────────────────────────
// The list projection NAMES its columns and leaves out markdown + transcript: those two
// run to ~28KB each, so `SELECT *` would drag the whole corpus into memory on every
// list read. Bodies are fetched one document at a time by SELECT_DOCUMENT.
export const SELECT_DOCUMENTS_META = `
SELECT id, canonical_url, title, fetched_at, excerpt, hero_image_url, author,
       source_feed_id, media_type, media_metadata, error_reason, annotation_count,
       highlight_count, capture_ms, added_via, created_at, updated_at, rev, deleted_at
FROM documents`
export const SELECT_DOCUMENT = 'SELECT * FROM documents WHERE id = ?'
export const UPSERT_DOCUMENT = `
INSERT OR REPLACE INTO documents (
  id, canonical_url, title, markdown, fetched_at, excerpt, hero_image_url, author,
  source_feed_id, media_type, media_metadata, transcript, error_reason,
  annotation_count, highlight_count, capture_ms, added_via, created_at, updated_at,
  rev, deleted_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
export const DELETE_DOCUMENT = 'DELETE FROM documents WHERE id = ?'

// ── highlights ────────────────────────────────────────────────────────────────
export const SELECT_HIGHLIGHTS = 'SELECT * FROM highlights'
export const UPSERT_HIGHLIGHT = `
INSERT OR REPLACE INTO highlights (
  id, document_id, pipeline_run_id, kind, title, body, body_html, metadata, pinned,
  archived_at, created_at, updated_at, rev, deleted_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
export const DELETE_HIGHLIGHT = 'DELETE FROM highlights WHERE id = ?'

// ── annotations ───────────────────────────────────────────────────────────────
export const SELECT_ANNOTATIONS = 'SELECT * FROM annotations'
export const UPSERT_ANNOTATION = `
INSERT OR REPLACE INTO annotations (
  id, document_id, highlight_id, exact, prefix, suffix, pos_start, pos_end,
  media_ts_ms, color, note, created_at, updated_at, rev, deleted_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
export const DELETE_ANNOTATION = 'DELETE FROM annotations WHERE id = ?'

// ── tags ──────────────────────────────────────────────────────────────────────
export const SELECT_TAGS = 'SELECT * FROM tags'
export const UPSERT_TAG = `
INSERT OR REPLACE INTO tags (id, name, color, created_at, updated_at, rev, deleted_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`
export const DELETE_TAG = 'DELETE FROM tags WHERE id = ?'

// ── tag junctions ─────────────────────────────────────────────────────────────
// Membership only: the server's junction row id, rev and tombstone are never read by
// the app (the push path replays parentId + tagId), and a bare (parent, tag) pair is
// what both the UI map and the pull-merge speak. One row per live application.
export const SELECT_JUNCTION: Record<JunctionType, string> = {
  doc: 'SELECT document_id AS parent_id, tag_id FROM document_tags',
  ann: 'SELECT annotation_id AS parent_id, tag_id FROM annotation_tags',
  hl: 'SELECT highlight_id AS parent_id, tag_id FROM highlight_tags',
}
export const UPSERT_JUNCTION: Record<JunctionType, string> = {
  doc: 'INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)',
  ann: 'INSERT OR IGNORE INTO annotation_tags (annotation_id, tag_id) VALUES (?, ?)',
  hl: 'INSERT OR IGNORE INTO highlight_tags (highlight_id, tag_id) VALUES (?, ?)',
}
export const DELETE_JUNCTION: Record<JunctionType, string> = {
  doc: 'DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?',
  ann: 'DELETE FROM annotation_tags WHERE annotation_id = ? AND tag_id = ?',
  hl: 'DELETE FROM highlight_tags WHERE highlight_id = ? AND tag_id = ?',
}

// ── outbox ────────────────────────────────────────────────────────────────────
// `seq` is AUTOINCREMENT, so it never reuses a rowid freed by a drained intent: FIFO
// order therefore survives a restart, which is the durability the blob store lost.
export const SELECT_OUTBOX = `
SELECT id, kind, args, tries, created_at, base_rev, coalesce_key
FROM outbox ORDER BY seq ASC`
export const INSERT_OUTBOX = `
INSERT INTO outbox (id, kind, args, tries, created_at, base_rev, coalesce_key)
VALUES (?, ?, ?, ?, ?, ?, ?)`
export const DELETE_OUTBOX = 'DELETE FROM outbox WHERE id = ?'
export const DELETE_OUTBOX_COALESCED = 'DELETE FROM outbox WHERE coalesce_key = ?'
export const BUMP_OUTBOX_TRIES = 'UPDATE outbox SET tries = tries + 1 WHERE id = ?'

// ── dirty keys ────────────────────────────────────────────────────────────────
export const SELECT_DIRTY = 'SELECT key, base_rev FROM dirty'
export const UPSERT_DIRTY = 'INSERT OR IGNORE INTO dirty (key, base_rev) VALUES (?, ?)'
export const UPDATE_DIRTY_BASE_REV = 'UPDATE dirty SET base_rev = ? WHERE key = ?'
export const DELETE_DIRTY = 'DELETE FROM dirty WHERE key = ?'

// ── settings ──────────────────────────────────────────────────────────────────
export const SELECT_SETTING = 'SELECT value FROM settings WHERE key = ?'
export const UPSERT_SETTING = 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'

// ── offline media files ───────────────────────────────────────────────────────
export const SELECT_MEDIA_FILE = 'SELECT uri FROM media_files WHERE document_id = ?'
export const SELECT_MEDIA_FILES = 'SELECT document_id, uri FROM media_files'
export const UPSERT_MEDIA_FILE = 'INSERT OR REPLACE INTO media_files (document_id, uri) VALUES (?, ?)'
export const DELETE_MEDIA_FILE = 'DELETE FROM media_files WHERE document_id = ?'

// ── wipe ──────────────────────────────────────────────────────────────────────
// Empties every row but keeps the schema (and the recorded schema_version), so the next
// pull starts from since=null against a DB that is ready to write.
export const WIPE_SQL = [
  'DELETE FROM documents',
  'DELETE FROM highlights',
  'DELETE FROM annotations',
  'DELETE FROM tags',
  'DELETE FROM document_tags',
  'DELETE FROM annotation_tags',
  'DELETE FROM highlight_tags',
  'DELETE FROM outbox',
  'DELETE FROM dirty',
  'DELETE FROM settings',
  'DELETE FROM media_files',
  "DELETE FROM meta WHERE key <> 'schema_version'",
]
