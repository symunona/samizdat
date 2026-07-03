// Single per-platform clipboard entry point. Native (`navigator.clipboard` is
// undefined there) goes through expo-clipboard; web uses the async Clipboard API
// with a legacy execCommand fallback for non-secure contexts. Always use this —
// never call navigator.clipboard directly (it silently no-ops on the phone).
import * as Clipboard from 'expo-clipboard'
import { Platform } from 'react-native'

function legacyWebCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// Copy text to the clipboard. Resolves true on success, false on failure (caller
// shows a toast). Never throws.
export async function copyToClipboard(text: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch { /* fall back to execCommand (e.g. non-secure context) */ }
    return legacyWebCopy(text)
  }
  try {
    await Clipboard.setStringAsync(text)
    return true
  } catch {
    return false
  }
}
