import { create } from 'zustand'
import { loadDebugLogStream, saveDebugLogStream } from '../storage'

// Shared toggle for the device debug-log channel so the Settings switch and the
// DebugLogBridge (app/_layout.tsx) stay in sync. Persisted via storage.ts;
// defaults ON for this debug build. See src/debugLog.ts.
interface DebugLogState {
  enabled: boolean
  hydrated: boolean
  hydrate: () => Promise<void>
  setEnabled: (on: boolean) => void
}

export const useDebugLogStore = create<DebugLogState>((set) => ({
  enabled: true,
  hydrated: false,
  hydrate: async () => {
    const on = await loadDebugLogStream()
    set({ enabled: on, hydrated: true })
  },
  setEnabled: (on: boolean) => {
    set({ enabled: on })
    void saveDebugLogStream(on)
  },
}))
