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
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT
);

CREATE INDEX IF NOT EXISTS jobs_status_run_after ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,
    canonical_url TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    markdown      TEXT NOT NULL DEFAULT '',
    fetched_at    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    rev           INTEGER NOT NULL DEFAULT 0,
    deleted_at    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS documents_canonical_url ON documents(canonical_url);

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
`

func migrate(db *sql.DB) error {
	if _, err := db.Exec(schema); err != nil {
		return fmt.Errorf("schema exec: %w", err)
	}
	// Additive column migrations — safe to re-run; ignore "duplicate column" errors.
	additiveMigrations := []string{
		`ALTER TABLE devices ADD COLUMN last_seen_at TEXT`,
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
