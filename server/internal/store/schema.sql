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
