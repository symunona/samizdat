package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

// Open opens (or creates) the SQLite DB at path, applies WAL + normal sync,
// and runs the embedded schema migration.
func Open(path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, fmt.Errorf("create db dir: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	// Single writer, multiple readers.
	db.SetMaxOpenConns(1)

	pragmas := []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			return nil, fmt.Errorf("pragma %q: %w", p, err)
		}
	}

	if err := migrate(db); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return db, nil
}

const schema = `
CREATE TABLE IF NOT EXISTS devices (
    id           TEXT    PRIMARY KEY,
    name         TEXT    NOT NULL DEFAULT '',
    token_hash   TEXT    NOT NULL,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL,
    rev          INTEGER NOT NULL DEFAULT 0,
    deleted_at   TEXT,
    last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS pair_codes (
    code        TEXT PRIMARY KEY,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
);

CREATE TABLE IF NOT EXISTS server_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT    PRIMARY KEY,
    kind        TEXT    NOT NULL,
    payload     TEXT    NOT NULL DEFAULT '{}',
    status      TEXT    NOT NULL DEFAULT 'queued',
    attempts    INTEGER NOT NULL DEFAULT 0,
    run_after   TEXT    NOT NULL,
    last_error  TEXT    NOT NULL DEFAULT '',
    result      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT
);

CREATE INDEX IF NOT EXISTS jobs_status_run_after ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS documents (
    id              TEXT PRIMARY KEY,
    canonical_url   TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT '',
    markdown        TEXT NOT NULL DEFAULT '',
    fetched_at      TEXT NOT NULL,
    excerpt         TEXT NOT NULL DEFAULT '',
    hero_image_url  TEXT NOT NULL DEFAULT '',
    author          TEXT NOT NULL DEFAULT '',
    source_feed_id  TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    rev             INTEGER NOT NULL DEFAULT 0,
    deleted_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS documents_canonical_url ON documents(canonical_url);

CREATE TABLE IF NOT EXISTS media_assets (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL REFERENCES documents(id),
    original_url TEXT NOT NULL,
    local_path   TEXT NOT NULL,
    kind         TEXT NOT NULL,
    width        INTEGER,
    height       INTEGER,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    rev          INTEGER NOT NULL DEFAULT 0,
    deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS media_assets_document_id ON media_assets(document_id);
CREATE UNIQUE INDEX IF NOT EXISTS media_assets_original_url ON media_assets(original_url);

CREATE TABLE IF NOT EXISTS read_states (
    id          TEXT    PRIMARY KEY,
    device_id   TEXT    NOT NULL REFERENCES devices(id),
    document_id TEXT    NOT NULL REFERENCES documents(id),
    scroll_y    REAL    NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS read_states_device_doc ON read_states(device_id, document_id);

CREATE TABLE IF NOT EXISTS feeds (
    id              TEXT    PRIMARY KEY,
    url             TEXT    NOT NULL UNIQUE,
    kind            TEXT    NOT NULL,
    title           TEXT    NOT NULL DEFAULT '',
    config          TEXT    NOT NULL DEFAULT '{}',
    last_polled_at  TEXT,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    rev             INTEGER NOT NULL DEFAULT 0,
    deleted_at      TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id          TEXT    PRIMARY KEY,
    feed_id     TEXT    NOT NULL REFERENCES feeds(id),
    interval_h  INTEGER NOT NULL DEFAULT 24,
    next_run_at TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS feed_items (
    id          TEXT    PRIMARY KEY,
    feed_id     TEXT    NOT NULL REFERENCES feeds(id),
    url         TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',
    seen_at     TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    UNIQUE(feed_id, url)
);
CREATE INDEX IF NOT EXISTS feed_items_feed_id ON feed_items(feed_id);

CREATE TABLE IF NOT EXISTS annotations (
    id           TEXT    PRIMARY KEY,
    document_id  TEXT    NOT NULL REFERENCES documents(id),
    highlight_id TEXT,
    exact        TEXT    NOT NULL,
    prefix       TEXT    NOT NULL DEFAULT '',
    suffix       TEXT    NOT NULL DEFAULT '',
    pos_start    INTEGER NOT NULL DEFAULT 0,
    pos_end      INTEGER NOT NULL DEFAULT 0,
    color        TEXT    NOT NULL DEFAULT 'yellow',
    note         TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL,
    rev          INTEGER NOT NULL DEFAULT 0,
    deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS annotations_document_id ON annotations(document_id);

CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    rev        INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS document_tags (
    id          TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    tag_id      TEXT NOT NULL REFERENCES tags(id),
    created_at  TEXT NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    UNIQUE(document_id, tag_id)
);

CREATE TABLE IF NOT EXISTS annotation_tags (
    id            TEXT PRIMARY KEY,
    annotation_id TEXT NOT NULL REFERENCES annotations(id),
    tag_id        TEXT NOT NULL REFERENCES tags(id),
    created_at    TEXT NOT NULL,
    rev           INTEGER NOT NULL DEFAULT 0,
    deleted_at    TEXT,
    UNIQUE(annotation_id, tag_id)
);

CREATE TABLE IF NOT EXISTS pipelines (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    trigger     TEXT    NOT NULL DEFAULT 'on_new_document',
    filter      TEXT    NOT NULL DEFAULT '{}',
    steps       TEXT    NOT NULL DEFAULT '[]',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id          TEXT    PRIMARY KEY,
    pipeline_id TEXT    NOT NULL REFERENCES pipelines(id),
    document_id TEXT    NOT NULL REFERENCES documents(id),
    status      TEXT    NOT NULL DEFAULT 'queued',
    step_index  INTEGER NOT NULL DEFAULT 0,
    state       TEXT    NOT NULL DEFAULT '{}',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT
);

CREATE INDEX IF NOT EXISTS pipeline_runs_document_id ON pipeline_runs(document_id);
CREATE INDEX IF NOT EXISTS pipeline_runs_pipeline_id ON pipeline_runs(pipeline_id);

CREATE TABLE IF NOT EXISTS highlights (
    id              TEXT    PRIMARY KEY,
    document_id     TEXT    NOT NULL REFERENCES documents(id),
    pipeline_run_id TEXT    NOT NULL REFERENCES pipeline_runs(id),
    kind            TEXT    NOT NULL DEFAULT 'note',
    body            TEXT    NOT NULL DEFAULT '',
    metadata        TEXT    NOT NULL DEFAULT '{}',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    rev             INTEGER NOT NULL DEFAULT 0,
    deleted_at      TEXT
);

CREATE INDEX IF NOT EXISTS highlights_document_id ON highlights(document_id);
CREATE INDEX IF NOT EXISTS highlights_pipeline_run_id ON highlights(pipeline_run_id);
`

func migrate(db *sql.DB) error {
	if _, err := db.Exec(schema); err != nil {
		return fmt.Errorf("schema exec: %w", err)
	}
	// Additive column migrations — safe to re-run; ignore "duplicate column" errors.
	additiveMigrations := []string{
		`ALTER TABLE devices ADD COLUMN last_seen_at TEXT`,
		`ALTER TABLE documents ADD COLUMN excerpt TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE documents ADD COLUMN hero_image_url TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE documents ADD COLUMN author TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE jobs ADD COLUMN last_error TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE jobs ADD COLUMN result TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE documents ADD COLUMN source_feed_id TEXT`,
		// Pipeline tables — additive; CREATE TABLE IF NOT EXISTS handles new installs.
		// These ALTER TABLE lines are no-ops on fresh DBs but keep old DBs current.
		`CREATE TABLE IF NOT EXISTS pipelines (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, trigger TEXT NOT NULL DEFAULT 'on_new_document', filter TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, deleted_at TEXT)`,
		`CREATE TABLE IF NOT EXISTS pipeline_runs (id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL, document_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', step_index INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, deleted_at TEXT)`,
		`CREATE TABLE IF NOT EXISTS highlights (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, pipeline_run_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', body TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, deleted_at TEXT)`,
		`CREATE INDEX IF NOT EXISTS pipeline_runs_document_id ON pipeline_runs(document_id)`,
		`CREATE INDEX IF NOT EXISTS pipeline_runs_pipeline_id ON pipeline_runs(pipeline_id)`,
		`CREATE INDEX IF NOT EXISTS highlights_document_id ON highlights(document_id)`,
		`CREATE INDEX IF NOT EXISTS highlights_pipeline_run_id ON highlights(pipeline_run_id)`,
	}
	for _, m := range additiveMigrations {
		if _, err := db.Exec(m); err != nil {
			// SQLite error message for duplicate column
			if !strings.Contains(err.Error(), "duplicate column name") {
				return fmt.Errorf("migration %q: %w", m, err)
			}
		}
	}
	return nil
}
