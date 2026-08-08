// User preferences — what the app remembers about ITSELF, as opposed to the synced
// library. Every one of them is a row in the replica's `settings` table.
//
// They used to be loose AsyncStorage keys. They are not any more, because AsyncStorage
// now holds exactly one thing: the connection record (src/storage.ts), which must
// survive a corrupt database since it is the only way back to the server. Everything
// else belongs in the DB layer — see app/CLAUDE.md, "DB layer is the only storage".
//
// The keys keep their old `samizdat_` names so the one-time carry-over in
// src/db/legacy.ts is a straight copy, not a translation table.

import { getSetting, setSetting } from './db'

const THEME_KEY = 'samizdat_theme'
const DEBUG_LOG_KEY = 'samizdat_debug_log_stream'
const LAST_URL_KEY = 'samizdat_last_url'
const URL_LAST_USED_KEY = 'samizdat_url_last_used'
const READING_MODE_KEY = 'samizdat_reading_mode'
const PAGE_THRESHOLD_KEY = 'samizdat_page_threshold'

// ── Server URLs ───────────────────────────────────────────────────────────────
// Which of the stored URLs worked last, and when each was last reachable. Hints for
// the connection probe and the Settings list — never the connection itself.

export async function saveLastSuccessfulUrl(url: string): Promise<void> {
  await setSetting(LAST_URL_KEY, url)
}

export async function loadLastSuccessfulUrl(): Promise<string | null> {
  return getSetting(LAST_URL_KEY)
}

export async function saveUrlLastUsed(url: string): Promise<void> {
  const map = await loadUrlLastUsedMap()
  map[url] = new Date().toISOString()
  await setSetting(URL_LAST_USED_KEY, JSON.stringify(map))
}

export async function loadUrlLastUsedMap(): Promise<Record<string, string>> {
  const raw = await getSetting(URL_LAST_USED_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

// ── Appearance / diagnostics ──────────────────────────────────────────────────

export async function saveTheme(theme: 'dark' | 'light'): Promise<void> {
  await setSetting(THEME_KEY, theme)
}

export async function loadTheme(): Promise<'dark' | 'light'> {
  return (await getSetting(THEME_KEY)) === 'light' ? 'light' : 'dark'
}

// Debug-log streaming toggle. Defaults ON — this is a debug-oriented build; the
// Settings switch lets the user silence it. See src/debugLog.ts.
export async function saveDebugLogStream(on: boolean): Promise<void> {
  await setSetting(DEBUG_LOG_KEY, on ? '1' : '0')
}

export async function loadDebugLogStream(): Promise<boolean> {
  return (await getSetting(DEBUG_LOG_KEY)) !== '0'
}

// ── Reading mode (document viewer) ────────────────────────────────────────────
// A global reading preference, not a property of one article. `auto` paginates
// only documents that would run past the threshold — the viewer resolves that
// itself (only it can measure). See src/store/readingModeStore.ts.

export type ReadingMode = 'flow' | 'auto' | 'page'

export const DEFAULT_READING_MODE: ReadingMode = 'auto'
export const DEFAULT_PAGE_THRESHOLD = 20
const MAX_PAGE_THRESHOLD = 999

// A junk threshold must not wedge the reader into a mode it can't leave.
export function clampThreshold(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PAGE_THRESHOLD
  return Math.min(MAX_PAGE_THRESHOLD, Math.max(1, Math.round(n)))
}

// The pre-three-way boolean key ('1' = paginate everything) is resolved once during
// db.open() — see src/db/legacy.ts — so nothing downstream has to know it existed.
export async function loadReadingPrefs(): Promise<{ mode: ReadingMode; threshold: number }> {
  const [raw, rawThreshold] = await Promise.all([
    getSetting(READING_MODE_KEY),
    getSetting(PAGE_THRESHOLD_KEY),
  ])
  const n = Number(rawThreshold)
  return {
    mode: raw === 'flow' || raw === 'auto' || raw === 'page' ? raw : DEFAULT_READING_MODE,
    threshold: n > 0 ? clampThreshold(n) : DEFAULT_PAGE_THRESHOLD,
  }
}

export async function saveReadingMode(mode: ReadingMode): Promise<void> {
  await setSetting(READING_MODE_KEY, mode)
}

export async function savePageThreshold(n: number): Promise<void> {
  await setSetting(PAGE_THRESHOLD_KEY, String(clampThreshold(n)))
}
