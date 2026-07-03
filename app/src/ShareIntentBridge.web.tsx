// Web has no Android share sheet; the native module isn't bundled here.
// Metro resolves this .web variant for web/e2e builds. See ShareIntentBridge.tsx.
export default function ShareIntentBridge() {
  return null
}
