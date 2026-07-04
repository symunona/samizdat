import { useEffect } from 'react'
import { useRouter } from 'expo-router'
import { useShareIntent } from 'expo-share-intent'
import type { ShareIntent } from 'expo-share-intent'
import { useToast } from './ToastContext'
import { useShareStore } from './store/shareStore'

const URL_RE = /https?:\/\/[^\s]+/i

// A shared payload is either a bare URL (browser / YouTube "share link") or text
// with a URL embedded ("Look at this https://…"). Prefer the module's parsed
// webUrl; fall back to the first http(s) URL in the text.
function extractUrl(si: ShareIntent): string | null {
  if (si.webUrl) return si.webUrl.trim()
  const m = si.text?.match(URL_RE)
  return m ? m[0] : null
}

// Bridges Android's ACTION_SEND share sheet into the Documents screen: a URL
// shared from any app opens Documents with the "Add URL" field prefilled, so the
// user confirms (presses Add) and watches it land in the scrape queue. Native-only;
// the web build resolves ShareIntentBridge.web.
export default function ShareIntentBridge() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent()
  const { toast } = useToast()
  const router = useRouter()

  // Capture the shared URL the moment it arrives, then consume the intent so it
  // can't re-fire on the next foreground.
  useEffect(() => {
    if (!hasShareIntent) return
    const url = extractUrl(shareIntent)
    resetShareIntent()
    if (!url) {
      toast('No link found in shared content', 'error')
      return
    }
    // Hand the URL to the Documents screen via a one-shot store, then navigate.
    // The screen prefills + focuses the "Add URL" box; the user submits. No
    // connection needed to prefill (a cold-start share can beat the probe).
    useShareStore.getState().setPendingUrl(url)
    router.push('/documents')
  }, [hasShareIntent, shareIntent, resetShareIntent, toast, router])

  return null
}
