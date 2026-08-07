// Minimal async key-value backend (AsyncStorage's shape) — injected so the chunking
// logic is unit-testable without the native module.
export type KVBackend = {
  getItem(k: string): Promise<string | null>
  setItem(k: string, v: string): Promise<void>
  removeItem(k: string): Promise<void>
}

// Android AsyncStorage is SQLite-backed with a ~2MB per-row CursorWindow limit: reading
// a value bigger than that throws "Row too big to fit into CursorWindow" (a Java
// exception). Our synced replica (documents + markdown + transcripts) is several MB, so
// under plain AsyncStorage it never hydrates on a device → the store is empty → offline
// breaks app-wide and the feed resets to zero. (Web localStorage has no such limit, which
// is why this only bites native.)
//
// This adapter transparently splits the persisted value into sub-limit chunks stored under
// separate keys, so no single row is ever too big. Drop-in for zustand's persist storage.
//
// Layout: `<name>` holds a tiny manifest {__chunks:N}; the payload lives in `<name>.0`…
// `<name>.N-1`. A legacy single-blob value (or a partial/corrupt read) is treated as "no
// state" so the store starts clean and the next persist rewrites it chunked.

// Char count per chunk. Kept well under 2MB even at 4 bytes/char (UTF-8) so a single row
// can never hit the CursorWindow limit.
const CHUNK_CHARS = 256 * 1024

// Chunking bounds a single ROW; it cannot bound the whole DB. AsyncStorage's Android
// backend also caps the entire SQLite file (`getDatabaseSize()`, 6MB by default), and
// past that every write rejects with SQLiteFullException. zustand's persist calls
// setItem() on every set() and never awaits the promise, so such a rejection is an
// unhandled rejection and the snapshot silently stops advancing. isStorageFullError
// separates that (the case worth naming to the user) from an ordinary write error.
export function isStorageFullError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e)
  return /SQLiteFull|disk is full|QuotaExceeded|quota/i.test(msg)
}

// Observer for one persist attempt: null on success, the error on failure.
export type WriteObserver = (err: unknown | null) => void

function chunkCount(meta: string | null): number {
  if (!meta) return 0
  try {
    const n = JSON.parse(meta).__chunks
    return typeof n === 'number' ? n : 0
  } catch {
    return 0 // legacy unchunked blob — not our manifest
  }
}

// `onWrite` (optional so this module stays free of zustand/RN imports and unit-testable)
// is called once per setItem — one logical "the snapshot was saved", not once per row.
export function makeChunkedStorage(kv: KVBackend, onWrite?: WriteObserver): KVBackend {
  return {
    async getItem(name: string): Promise<string | null> {
      let meta: string | null
      try {
        meta = await kv.getItem(name)
      } catch {
        // Legacy oversized row throws CursorWindow on read → treat as empty; the next
        // persist replaces it with a chunked value.
        return null
      }
      const count = chunkCount(meta)
      if (count === 0) return null // no manifest (fresh, legacy blob, or empty)
      const parts: string[] = []
      for (let i = 0; i < count; i++) {
        let part: string | null
        try {
          part = await kv.getItem(`${name}.${i}`)
        } catch {
          return null
        }
        if (part == null) return null // partial write — discard, start clean
        parts.push(part)
      }
      return parts.join('')
    },

    async setItem(name: string, value: string): Promise<void> {
      try {
        const count = Math.max(1, Math.ceil(value.length / CHUNK_CHARS))
        const prev = chunkCount(await kv.getItem(name).catch(() => null))
        for (let i = 0; i < count; i++) {
          await kv.setItem(`${name}.${i}`, value.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS))
        }
        // Drop stale chunks left over from a previously larger value.
        for (let i = count; i < prev; i++) await kv.removeItem(`${name}.${i}`)
        await kv.setItem(name, JSON.stringify({ __chunks: count }))
        onWrite?.(null)
      } catch (e) {
        // Swallow after reporting: zustand is the only caller and it already drops the
        // promise, so re-throwing would just restore the silent unhandled rejection the
        // observer exists to replace.
        onWrite?.(e)
      }
    },

    async removeItem(name: string): Promise<void> {
      const count = chunkCount(await kv.getItem(name).catch(() => null))
      for (let i = 0; i < count; i++) await kv.removeItem(`${name}.${i}`)
      await kv.removeItem(name)
    },
  }
}
