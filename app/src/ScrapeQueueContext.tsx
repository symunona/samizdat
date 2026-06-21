import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useRouter } from 'expo-router'
import { useConnection } from './ConnectionContext'
import { submitScrapeJob, fetchJob } from './api'

const POLL_INTERVAL_MS = 2000
const DONE_LINGER_MS = 10000
const ERROR_LINGER_MS = 8000

type ScrapeState = 'scraping' | 'done' | 'error'

interface ScrapeEntry {
  url: string
  title: string
  state: ScrapeState
  jobId?: string
  docId?: string
  error?: string
}

interface ScrapeQueueCtx {
  // url → entry, for any in-flight or recently-finished scrape (overlay cards)
  entries: Record<string, ScrapeEntry>
  // url → document id, for scrapes resolved this session (persists after the
  // overlay card clears, so inline link icons stay 📄 without a feed refetch)
  resolvedDocs: Record<string, string>
  startScrape: (url: string, title?: string) => void
}

const Ctx = createContext<ScrapeQueueCtx>({ entries: {}, resolvedDocs: {}, startScrape: () => {} })

export function useScrapeQueue(): ScrapeQueueCtx {
  return useContext(Ctx)
}

export function ScrapeQueueProvider({ children }: { children: React.ReactNode }) {
  const { activeUrl, token } = useConnection()
  const router = useRouter()
  const [entries, setEntries] = useState<Record<string, ScrapeEntry>>({})
  const [resolvedDocs, setResolvedDocs] = useState<Record<string, string>>({})

  const activeUrlRef = useRef(activeUrl)
  const tokenRef = useRef(token)
  useEffect(() => { activeUrlRef.current = activeUrl }, [activeUrl])
  useEffect(() => { tokenRef.current = token }, [token])

  const lingerTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const remove = useCallback((url: string) => {
    const t = lingerTimers.current.get(url)
    if (t) { clearTimeout(t); lingerTimers.current.delete(url) }
    setEntries(prev => { const next = { ...prev }; delete next[url]; return next })
  }, [])

  const scheduleRemove = useCallback((url: string, ms: number) => {
    const existing = lingerTimers.current.get(url)
    if (existing) clearTimeout(existing)
    lingerTimers.current.set(url, setTimeout(() => remove(url), ms))
  }, [remove])

  const startScrape = useCallback(async (url: string, title?: string) => {
    const aUrl = activeUrlRef.current
    const tok = tokenRef.current
    if (!aUrl || !tok) return
    // already tracked (scraping or done) — don't double-submit
    let already = false
    setEntries(prev => {
      if (prev[url]) { already = true; return prev }
      return { ...prev, [url]: { url, title: title || url, state: 'scraping' } }
    })
    if (already) return
    try {
      const { job_id } = await submitScrapeJob(aUrl, tok, url)
      setEntries(prev => prev[url] ? { ...prev, [url]: { ...prev[url], jobId: job_id } } : prev)
    } catch (e) {
      setEntries(prev => prev[url] ? { ...prev, [url]: { ...prev[url], state: 'error', error: e instanceof Error ? e.message : 'scrape failed' } } : prev)
      scheduleRemove(url, ERROR_LINGER_MS)
    }
  }, [scheduleRemove])

  // Single poller for all in-flight jobs.
  useEffect(() => {
    const hasActive = Object.values(entries).some(e => e.state === 'scraping' && e.jobId)
    if (!hasActive) return
    const id = setInterval(async () => {
      const aUrl = activeUrlRef.current
      const tok = tokenRef.current
      if (!aUrl || !tok) return
      const active = Object.values(entries).filter(e => e.state === 'scraping' && e.jobId)
      for (const e of active) {
        try {
          const job = await fetchJob(aUrl, tok, e.jobId!)
          if (job.status === 'done') {
            const result = JSON.parse(job.result || '{}') as { document_id?: string }
            const docId = result.document_id ?? null
            if (docId) {
              setEntries(prev => prev[e.url] ? { ...prev, [e.url]: { ...prev[e.url], state: 'done', docId } } : prev)
              setResolvedDocs(prev => ({ ...prev, [e.url]: docId }))
              scheduleRemove(e.url, DONE_LINGER_MS)
            } else {
              setEntries(prev => prev[e.url] ? { ...prev, [e.url]: { ...prev[e.url], state: 'error', error: 'no document' } } : prev)
              scheduleRemove(e.url, ERROR_LINGER_MS)
            }
          } else if (job.status === 'dead') {
            setEntries(prev => prev[e.url] ? { ...prev, [e.url]: { ...prev[e.url], state: 'error', error: job.last_error || 'scrape failed' } } : prev)
            scheduleRemove(e.url, ERROR_LINGER_MS)
          }
        } catch { /* transient — retry next tick */ }
      }
    }, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [entries, scheduleRemove])

  useEffect(() => {
    const timers = lingerTimers.current
    return () => { timers.forEach(t => clearTimeout(t)) }
  }, [])

  const openDoc = useCallback((entry: ScrapeEntry) => {
    if (!entry.docId) return
    remove(entry.url)
    router.push(`/document/${encodeURIComponent(entry.docId)}`)
  }, [remove, router])

  const value = useMemo(() => ({ entries, resolvedDocs, startScrape }), [entries, resolvedDocs, startScrape])
  const list = Object.values(entries)

  return (
    <Ctx.Provider value={value}>
      {children}
      {list.length > 0 && (
        <View style={styles.container} pointerEvents="box-none">
          {list.map(e => <ScrapeCard key={e.url} entry={e} onOpen={openDoc} onDismiss={remove} />)}
        </View>
      )}
    </Ctx.Provider>
  )
}

function ScrapeCard({ entry, onOpen, onDismiss }: {
  entry: ScrapeEntry
  onOpen: (e: ScrapeEntry) => void
  onDismiss: (url: string) => void
}) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const done = entry.state === 'done'
  const error = entry.state === 'error'

  return (
    <Pressable
      style={[s.card, done && s.cardDone, error && s.cardError]}
      onPress={() => done && onOpen(entry)}
      disabled={!done}
    >
      {entry.state === 'scraping'
        ? <ActivityIndicator size="small" color={theme.colors.accent} />
        : <Text style={s.glyph}>{done ? '📄' : '⚠'}</Text>}
      <View style={s.body}>
        <Text style={s.title} numberOfLines={1}>{entry.title}</Text>
        <Text style={[s.sub, error && s.subError]} numberOfLines={1}>
          {error ? (entry.error || 'scrape failed') : done ? 'Ready — tap to open' : 'Reading as document…'}
        </Text>
      </View>
      <Pressable style={s.closeBtn} onPress={() => onDismiss(entry.url)} hitSlop={8}>
        <Text style={s.closeText}>✕</Text>
      </Pressable>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 24,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 8,
    zIndex: 9998,
  },
})

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      width: '92%',
      maxWidth: 420,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderRadius: t.radius.md,
      backgroundColor: t.colors.surface,
      borderWidth: 1,
      borderColor: t.colors.border,
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
      elevation: 10,
    },
    cardDone: { borderColor: t.colors.accent },
    cardError: { borderColor: t.colors.error },
    glyph: { fontSize: 18 },
    body: { flex: 1 },
    title: { color: t.colors.text, fontSize: 14, fontWeight: '600' },
    sub: { color: t.colors.muted, fontSize: 12, marginTop: 1 },
    subError: { color: t.colors.error },
    closeBtn: { padding: 4 },
    closeText: { color: t.colors.muted, fontSize: 15, fontWeight: '700' },
  })
}
