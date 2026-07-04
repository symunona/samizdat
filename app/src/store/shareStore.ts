import { create } from 'zustand'

// One-shot channel for a URL shared into the app via the Android share sheet
// (ShareIntentBridge → Documents screen). A plain store (not a router param)
// avoids expo-router's setParams re-render loop and leaves no stale param in the
// URL; consuming clears it so a normal later visit to Documents doesn't re-prefill.
interface ShareStore {
  pendingUrl: string | null
  setPendingUrl: (url: string) => void
  consume: () => string | null
}

export const useShareStore = create<ShareStore>((set, get) => ({
  pendingUrl: null,
  setPendingUrl: (url) => set({ pendingUrl: url }),
  consume: () => {
    const url = get().pendingUrl
    if (url) set({ pendingUrl: null })
    return url
  },
}))
