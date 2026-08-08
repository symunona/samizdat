// Schema versioning. The DDL itself lives in queries.ts — that file is the single
// place SQL text is allowed, DDL included — so this module only orders the migrations
// and derives the version from them.
//
// There is no migration FROM the old zustand-persist replica: the vault is the source
// of truth and the replica is rebuildable, so a schema bump wipes and re-pulls from
// since=null rather than carrying a translation layer forever (design rule 1).

import { SCHEMA_SQL } from './queries'

// Append a new script to migrate; never edit an existing entry (a shipped device has
// already run it). MIGRATIONS[i] takes the DB from version i to version i+1.
export const MIGRATIONS: string[] = [SCHEMA_SQL]

export const SCHEMA_VERSION = MIGRATIONS.length

export const META_SCHEMA_VERSION = 'schema_version'
export const META_LAST_SYNCED_AT = 'last_synced_at'
