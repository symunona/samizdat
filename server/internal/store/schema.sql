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
    id              TEXT    PRIMARY KEY,   -- UUID-v5 from url
    url             TEXT    NOT NULL UNIQUE,
    kind            TEXT    NOT NULL,      -- rss | html_links | js_script
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
    id          TEXT    PRIMARY KEY,  -- UUID-v5 of (feed_id || url)
    feed_id     TEXT    NOT NULL REFERENCES feeds(id),
    url         TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | scraped | skipped
    seen_at     TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    UNIQUE(feed_id, url)
);
CREATE INDEX IF NOT EXISTS feed_items_feed_id ON feed_items(feed_id);

-- NOTE: last_error column is added to existing jobs tables via additive migration in open.go
