import { create } from 'zustand'
import {
  loadReadingPrefs, saveReadingMode, savePageThreshold, clampThreshold,
  DEFAULT_READING_MODE, DEFAULT_PAGE_THRESHOLD,
} from '../storage'
import type { ReadingMode } from '../storage'

// The ONE reading preference: the document viewer's 3-way control and the
// Settings "Auto page mode" card both read and write this store (the Settings
// switch is `mode === 'auto'`, not a second flag). Persisted via storage.ts,
// which also migrates the old boolean `samizdat_page_mode` key.
interface ReadingModeState {
  mode: ReadingMode
  threshold: number
  hydrated: boolean
  hydrate: () => Promise<void>
  setMode: (mode: ReadingMode) => void
  setThreshold: (n: number) => void
}

let hydrating: Promise<void> | null = null

export const useReadingModeStore = create<ReadingModeState>((set, get) => ({
  mode: DEFAULT_READING_MODE,
  threshold: DEFAULT_PAGE_THRESHOLD,
  hydrated: false,
  // Idempotent: every consumer calls it on mount, only the first read runs.
  hydrate: async () => {
    if (get().hydrated) return
    if (!hydrating) {
      hydrating = loadReadingPrefs().then(({ mode, threshold }) => {
        set({ mode, threshold, hydrated: true })
      })
    }
    await hydrating
  },
  setMode: (mode: ReadingMode) => {
    set({ mode })
    void saveReadingMode(mode)
  },
  setThreshold: (n: number) => {
    const threshold = clampThreshold(n)
    set({ threshold })
    void savePageThreshold(threshold)
  },
}))
