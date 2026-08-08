#!/usr/bin/env node
// check-db-layer — the wall around app/src/db.
//
// The app has exactly ONE storage layer. Screens, the sync engine and the pusher all go
// through `app/src/db/index.ts`; nothing else opens a database, writes SQL, or reaches
// for AsyncStorage. That wall is the whole point of the refactor that replaced the
// zustand-persist blob replica — the moment a screen keeps its own copy of the library
// somewhere else, the two can disagree and the "why is my feed stale?" bug is back.
//
// Three rules, from plan/2026-08-07-sqlite-db-layer.md:
//   1. Only app/src/db/** may import a SQLite engine (expo-sqlite / wa-sqlite / node:sqlite).
//   2. Only app/src/db/queries.ts may contain SQL text.
//   3. Only app/src/db/** and app/src/storage.ts may import AsyncStorage. storage.ts
//      keeps the connection record ALONE: it must survive a corrupt database, because
//      it is the only way back to the server.
//
// Run: node tooling/check-db-layer.mjs   (wired into `just lint`)

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = process.env.REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_SRC = join(REPO_ROOT, 'app', 'src')
const APP_ROUTES = join(REPO_ROOT, 'app', 'app')

const DB_DIR = 'app/src/db/'
const QUERIES_FILE = 'app/src/db/queries.ts'
const CONNECTION_FILE = 'app/src/storage.ts'

const ENGINE_IMPORT = /from\s+['"](expo-sqlite[^'"]*|@?[\w@/.-]*wa-sqlite[^'"]*|node:sqlite)['"]/
const ASYNC_STORAGE_IMPORT = /from\s+['"]@react-native-async-storage\/async-storage['"]/
// SQL text: a statement keyword OPENING a string literal, plus its operand. Both halves
// matter — English uses these words too ("select the unzipped folder", "update the row"),
// and only a real query starts a quote with them.
//
// The rule covers statements that name a TABLE. `BEGIN`/`COMMIT`/`ROLLBACK`/`PRAGMA`
// are connection and transaction control, they belong to whichever engine the driver
// wraps, and hoisting them into queries.ts would put per-engine text in the one
// engine-agnostic file. They are deliberately not matched.
const SQL_TEXT = new RegExp(
  '[\'"`]\\s*(' + [
    'SELECT\\s+[\\w*(]', 'INSERT\\s+(INTO|OR)\\s', 'UPDATE\\s+\\w+\\s+SET\\b',
    'DELETE\\s+FROM\\s', 'CREATE\\s+(TABLE|INDEX|UNIQUE)\\b', 'DROP\\s+(TABLE|INDEX)\\b',
  ].join('|') + ')',
  'gi',
)

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

// Comments carry the vocabulary these rules are written in — "never import expo-sqlite
// here", "INSERT OR REPLACE" in a note about a query. Only real code is checked.
function stripComments(src) {
  return src
    // Keep the newlines a block comment spanned, or every reported line number after it
    // is wrong — the point of a linter is to say WHERE.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

const failures = []
function fail(file, line, message, detail) {
  failures.push({ file, line, message, detail })
}

const files = [...walk(APP_SRC), ...walk(APP_ROUTES)]
for (const full of files) {
  const path = relative(REPO_ROOT, full).replaceAll('\\', '/')
  const code = stripComments(readFileSync(full, 'utf8'))
  const inDb = path.startsWith(DB_DIR)

  code.split('\n').forEach((line, i) => {
    const n = i + 1
    if (!inDb && ENGINE_IMPORT.test(line)) {
      fail(path, n, 'imports a SQLite engine outside app/src/db/',
        'Only the DB layer opens a database. Import from src/db instead.')
    }
    if (!inDb && path !== CONNECTION_FILE && ASYNC_STORAGE_IMPORT.test(line)) {
      fail(path, n, 'imports AsyncStorage outside app/src/db/ and app/src/storage.ts',
        'AsyncStorage keeps the connection record ALONE. Preferences go through db.getSetting/setSetting (src/prefs.ts).')
    }
  })

  // Matched over the whole file, not per line: a query in a template literal opens on
  // the backtick and the statement starts on the next one.
  if (path !== QUERIES_FILE) {
    SQL_TEXT.lastIndex = 0
    for (const m of code.matchAll(SQL_TEXT)) {
      const n = code.slice(0, m.index).split('\n').length
      fail(path, n, 'contains SQL text outside app/src/db/queries.ts',
        'Every query (DDL included) is a named constant in queries.ts, so the schema has one place to change.')
    }
  }
}

if (failures.length) {
  console.error('ERROR: the DB layer wall was breached — see app/CLAUDE.md, "DB layer is the only storage":')
  for (const f of failures) {
    console.error(`  ${f.file}:${f.line} — ${f.message}`)
    console.error(`    ${f.detail}`)
  }
  process.exit(1)
}

console.log(`check-db-layer: OK (${files.length} app files scanned)`)
