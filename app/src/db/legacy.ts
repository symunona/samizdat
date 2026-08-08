// One-time carry-over from the pre-SQLite era, run once inside `open()`.
//
// Two jobs, and this is the only module that still knows both stores:
//
//  1. **Delete the old blob replica** — `samizdat_sync_store` plus every `.N` chunk it
//     was split into. Nothing reads it any more, and on Android those megabytes are the
//     very weight that pushed AsyncStorage past its whole-DB cap and froze every write.
//     Dropping the manifest alone would leave the chunks behind, i.e. all of the weight.
//  2. **Carry the loose keys** that were never part of the replica — the preferences,
//     the per-document highlight-panel state, and the offline audio file pointers — into
//     the `settings` / `media_files` tables, so an upgrade doesn't silently reset a
//     user's theme and reading mode or strand an already-downloaded podcast.
//
// After this AsyncStorage holds exactly one thing: the connection record (src/storage.ts),
// which must survive a corrupt DB because it is the only way back to the server.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { createLogger } from '../logger'
import { getSetting, setMediaFile, setSetting } from './repo'

const log = createLogger('db')

// Marks the pass as done. Lives in `settings`, so a `wipe()` re-arms it — by then the
// AsyncStorage keys are gone, which makes the re-run a single no-op key scan.
const MIGRATED_KEY = 'legacy_async_storage_migrated'

const BLOB_KEY = 'samizdat_sync_store'
const AUDIO_PREFIX = 'video_audio_'
const HL_EXPANDED_PREFIX = 'doc_hl_exp_'

// Pre-three-way page-mode flag ('1' = paginate everything). Resolved into the reading
// mode here, then dropped: a user who deliberately turned pagination OFF must land on
// `flow`, not on the newer `auto` default.
const LEGACY_PAGE_MODE_KEY = 'samizdat_page_mode'
const READING_MODE_KEY = 'samizdat_reading_mode'

// Preferences that keep their key — only the store underneath them changed.
const CARRIED_KEYS = [
  'samizdat_theme', 'samizdat_debug_log_stream', READING_MODE_KEY,
  'samizdat_page_threshold', 'samizdat_last_url', 'samizdat_url_last_used',
]

function isCarried(key: string): boolean {
  return CARRIED_KEYS.includes(key) || key === LEGACY_PAGE_MODE_KEY
    || key.startsWith(HL_EXPANDED_PREFIX) || key.startsWith(AUDIO_PREFIX)
}

export async function migrateFromAsyncStorage(): Promise<void> {
  if (await getSetting(MIGRATED_KEY)) return

  let keys: readonly string[]
  try {
    keys = await AsyncStorage.getAllKeys()
  } catch {
    return // no AsyncStorage on this runtime — nothing to carry
  }

  const carried = keys.filter(isCarried)
  const old = new Map<string, string>()
  for (const [key, value] of await AsyncStorage.multiGet([...carried])) {
    if (value != null) old.set(key, value)
  }

  for (const [key, value] of old) {
    if (key === LEGACY_PAGE_MODE_KEY) continue
    if (key.startsWith(AUDIO_PREFIX)) await setMediaFile(key.slice(AUDIO_PREFIX.length), value)
    else await setSetting(key, value)
  }
  const legacyPageMode = old.get(LEGACY_PAGE_MODE_KEY)
  if (legacyPageMode != null && !old.has(READING_MODE_KEY)) {
    await setSetting(READING_MODE_KEY, legacyPageMode === '1' ? 'page' : 'flow')
  }

  const stale = keys.filter((k) => k === BLOB_KEY || k.startsWith(`${BLOB_KEY}.`) || isCarried(k))
  if (stale.length) await AsyncStorage.multiRemove([...stale])
  await setSetting(MIGRATED_KEY, '1')
  log.log(`legacy AsyncStorage: ${old.size} keys carried over, ${stale.length} removed`)
}
