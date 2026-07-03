import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { useShareIntent } from 'expo-share-intent'
import type { ShareIntent } from 'expo-share-intent'
import { useConnection } from './ConnectionContext'
import { useScrapeQueue } from './ScrapeQueueContext'
import { useToast } from './ToastContext'

const URL_RE = /https?:\/\/[^\s]+/i

// A shared payload is either a bare URL (browser / YouTube "share link") or text
// with a URL embedded ("Look at this https://…"). Prefer the module's parsed
// webUrl; fall back to the first http(s) URL in the text.
function extractUrl(si: ShareIntent): string | null {
  if (si.webUrl) return si.webUrl.trim()
  const m = si.text?.match(URL_RE)
  return m ? m[0] : null
}

// Bridges Android's ACTION_SEND share sheet into the scrape queue: a URL shared
// from any app is queued as a Document (same path as the Documents "Add URL" box)
// and the app navigates to Documents, where the in-flight scrape card shows
// progress → tap-to-open. Native-only; the web build resolves ShareIntentBridge.web.
export default function ShareIntentBridge() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent()
  const { status } = useConnection()
  const { startScrape } = useScrapeQueue()
  const { toast } = useToast()
  const router = useRouter()

  // URL captured from a share intent, held until the connection is up.
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const navigatedRef = useRef(false)

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
    navigatedRef.current = false
    setPendingUrl(url)
    toast('Adding shared link…')
  }, [hasShareIntent, shareIntent, resetShareIntent, toast])

  // Fire the scrape once connected (a cold-start share can land before the
  // connection probe finishes), then land the user on Documents.
  useEffect(() => {
    if (!pendingUrl || status !== 'connected') return
    startScrape(pendingUrl)
    setPendingUrl(null)
    if (!navigatedRef.current) {
      navigatedRef.current = true
      router.push('/documents')
    }
  }, [pendingUrl, status, startScrape, router])

  return null
}
