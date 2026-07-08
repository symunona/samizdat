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

function chunkCount(meta: string | null): number {
  if (!meta) return 0
  try {
    const n = JSON.parse(meta).__chunks
    return typeof n === 'number' ? n : 0
  } catch {
    return 0 // legacy unchunked blob — not our manifest
  }
}

export function makeChunkedStorage(kv: KVBackend): KVBackend {
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
      const count = Math.max(1, Math.ceil(value.length / CHUNK_CHARS))
      const prev = chunkCount(await kv.getItem(name).catch(() => null))
      for (let i = 0; i < count; i++) {
        await kv.setItem(`${name}.${i}`, value.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS))
      }
      // Drop stale chunks left over from a previously larger value.
      for (let i = count; i < prev; i++) await kv.removeItem(`${name}.${i}`)
      await kv.setItem(name, JSON.stringify({ __chunks: count }))
    },

    async removeItem(name: string): Promise<void> {
      const count = chunkCount(await kv.getItem(name).catch(() => null))
      for (let i = 0; i < count; i++) await kv.removeItem(`${name}.${i}`)
      await kv.removeItem(name)
    },
  }
}
