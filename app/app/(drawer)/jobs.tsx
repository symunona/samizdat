import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { v5 as uuidv5 } from 'uuid'
import { fetchJobs, fetchDocuments, retryJob, clearCompletedJobs } from '../../src/api'
import type { Job, Document } from '../../src/api'
import { useConnection } from '../../src/ConnectionContext'
import { useToast } from '../../src/ToastContext'

const STATUS_FILTERS = ['all', 'queued', 'running', 'dead', 'done'] as const
type Filter = (typeof STATUS_FILTERS)[number]

const STATUS_COLOR: Record<string, string> = {
  queued:  '#facc15',
  running: '#60a5fa',
  done:    '#4ade80',
  dead:    '#f87171',
}

// Must match server's IDFromURL: uuid.NewSHA1(uuid.NameSpaceURL, []byte(url))
const UUID_NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
function docIdFromUrl(url: string): string {
  return uuidv5(url, UUID_NAMESPACE_URL)
}

function formatAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function kindLabel(kind: string): string {
  return kind.replace(/_/g, ' ')
}

function parsePayload(payload: string): Record<string, string> {
  try { return JSON.parse(payload) as Record<string, string> } catch { return {} }
}

function parseResult(result: string): Record<string, unknown> {
  try { return JSON.parse(result) as Record<string, unknown> } catch { return {} }
}

export default function JobsScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { status, activeUrl, token } = useConnection()
  const router = useRouter()
  const { toast } = useToast()

  const [jobs, setJobs] = useState<Job[]>([])
  const [docMap, setDocMap] = useState<Map<string, Document>>(new Map())
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)

  const load = useCallback(async (isRefresh = false) => {
    if (!activeUrl || !token) return
    isRefresh ? setRefreshing(true) : setLoading(true)
    setError(null)
    try {
      const opts = filter === 'all' ? {} : { status: filter }
      const [jobsData, docsData] = await Promise.all([
        fetchJobs(activeUrl, token, opts),
        fetchDocuments(activeUrl, token),
      ])
      setJobs(jobsData ?? [])
      const m = new Map<string, Document>()
      for (const d of (docsData ?? [])) m.set(d.id, d)
      setDocMap(m)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [activeUrl, token, filter])

  useEffect(() => {
    if (status === 'connected') load()
  }, [status, load])

  async function handleClear() {
    if (!activeUrl || !token || clearing) return
    setClearing(true)
    try {
      const n = await clearCompletedJobs(activeUrl, token)
      toast(n > 0 ? `Cleared ${n} job${n === 1 ? '' : 's'}` : 'No jobs to clear', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to clear jobs', 'error')
    } finally {
      setClearing(false)
    }
    await load()
  }

  async function handleRetry(job: Job) {
    if (!activeUrl || !token || retryingId) return
    setRetryingId(job.id)
    try {
      await retryJob(activeUrl, token, job.id)
      await load()
    } catch { /* ignore */ }
    finally { setRetryingId(null) }
  }

  const filtered = useMemo(() =>
    filter === 'all' ? jobs : jobs.filter(j => j.status === filter),
    [jobs, filter]
  )

  function renderItem({ item }: { item: Job }) {
    const statusColor = STATUS_COLOR[item.status] ?? '#9ca3af'
    const p = parsePayload(item.payload)
    const r = parseResult(item.result)
    const isRetrying = retryingId === item.id

    const payloadUrl = p.url ?? ''
    const feedId = p.feed_id ?? ''

    // Derive document ID: prefer result (new jobs), fall back to uuid-v5 from URL (legacy)
    const docId: string = (typeof r.document_id === 'string' && r.document_id)
      ? r.document_id
      : (item.kind === 'scrape_url' && payloadUrl ? docIdFromUrl(payloadUrl) : '')

    const doc = docId ? docMap.get(docId) : undefined
    const docTitle = doc?.title ?? (typeof r.title === 'string' ? r.title : '')

    const discovered = typeof r.discovered === 'number' ? r.discovered : -1
    const newItems = typeof r.new === 'number' ? r.new : -1

    return (
      <View style={s.card}>
        <View style={s.cardTop}>
          <View style={[s.statusDot, { backgroundColor: statusColor }]} />
          <Text style={s.kindText}>{kindLabel(item.kind)}</Text>
          <Text style={s.ageText}>{formatAge(item.updated_at)}</Text>
        </View>

        {/* scrape_url: show title (or url) linking in-app to document */}
        {item.kind === 'scrape_url' && !!payloadUrl && (
          <Pressable onPress={() =>
            doc
              ? router.push(`/(drawer)/document/${docId}`)
              : Linking.openURL(payloadUrl)
          }>
            <Text style={[s.urlText, !!doc && s.docLinkText]} numberOfLines={2}>
              {docTitle || payloadUrl}{!!doc ? ' →' : ''}
            </Text>
          </Pressable>
        )}

        {/* other job kinds: just show the URL externally */}
        {item.kind !== 'scrape_url' && !!payloadUrl && (
          <Pressable onPress={() => Linking.openURL(payloadUrl)}>
            <Text style={s.urlText} numberOfLines={1}>{payloadUrl}</Text>
          </Pressable>
        )}

        {/* Feed ID label (poll_feed jobs) */}
        {!payloadUrl && !!feedId && (
          <Text style={s.mutedText} numberOfLines={1}>feed: {feedId.slice(0, 8)}</Text>
        )}

        {/* poll_feed result summary */}
        {item.kind === 'poll_feed' && discovered >= 0 && (
          <View style={s.resultRow}>
            <Text style={s.resultText}>{discovered} discovered</Text>
            {newItems === 0
              ? <Text style={s.nothingNew}>nothing new</Text>
              : <Text style={[s.resultText, { color: '#4ade80' }]}>{newItems} new</Text>
            }
          </View>
        )}

        {!!item.last_error && (
          <Text style={s.errorText} numberOfLines={3}>{item.last_error}</Text>
        )}

        {item.attempts > 0 && item.status !== 'done' && (
          <Text style={s.attemptsText}>Attempts: {item.attempts}</Text>
        )}

        {item.status === 'dead' && (
          <Pressable
            style={({ pressed }) => [s.retryBtn, (isRetrying || pressed) && s.retryBtnPressed]}
            onPress={() => handleRetry(item)}
            disabled={!!retryingId}
          >
            {isRetrying
              ? <ActivityIndicator size="small" color="#0b0b0c" />
              : <Text style={s.retryBtnText}>Retry</Text>
            }
          </Pressable>
        )}
      </View>
    )
  }

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.toolbar}>
        <View style={s.filters}>
          {STATUS_FILTERS.map(f => (
            <Pressable
              key={f}
              style={[s.filterBtn, filter === f && s.filterBtnActive]}
              onPress={() => setFilter(f)}
            >
              <Text style={[s.filterText, filter === f && s.filterTextActive]}>
                {f}
              </Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          style={({ pressed }) => [s.clearBtn, (clearing || pressed) && s.clearBtnPressed]}
          onPress={handleClear}
          disabled={clearing}
        >
          {clearing
            ? <ActivityIndicator size="small" color="#f87171" />
            : <Text style={s.clearBtnText}>clear</Text>
          }
        </Pressable>
      </View>

      {loading && !refreshing
        ? <View style={s.centered}><ActivityIndicator color={theme.colors.accent} size="large" /></View>
        : error
          ? <View style={s.centered}>
              <Text style={s.errText}>{error}</Text>
              <Pressable onPress={() => load()} style={s.reloadBtn}>
                <Text style={s.reloadText}>Retry</Text>
              </Pressable>
            </View>
          : <FlatList
              data={filtered}
              keyExtractor={item => item.id}
              renderItem={renderItem}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={theme.colors.accent} />}
              contentContainerStyle={filtered.length === 0 ? s.emptyContainer : s.list}
              ItemSeparatorComponent={() => <View style={s.sep} />}
              ListEmptyComponent={
                <Text style={s.emptyText}>No {filter === 'all' ? '' : filter + ' '}jobs.</Text>
              }
            />
      }
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    toolbar: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: t.colors.border, backgroundColor: t.colors.surface },
    filters: { flex: 1, flexDirection: 'row', paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.sm, gap: t.spacing.xs, flexWrap: 'wrap' },
    clearBtn: { paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, minWidth: 52, alignItems: 'center' },
    clearBtnPressed: { opacity: 0.5 },
    clearBtnText: { color: '#f87171', fontSize: 12, fontFamily: 'monospace', fontWeight: '600' },
    filterBtn: { paddingHorizontal: t.spacing.sm, paddingVertical: 4, borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.colors.border },
    filterBtnActive: { backgroundColor: t.colors.accent, borderColor: t.colors.accent },
    filterText: { color: t.colors.muted, fontSize: 12, fontFamily: 'monospace' },
    filterTextActive: { color: t.colors.background, fontWeight: '700' },
    list: { padding: t.spacing.sm },
    sep: { height: t.spacing.xs },
    card: { backgroundColor: t.colors.surface, borderRadius: t.radius.sm, padding: t.spacing.md, borderWidth: 1, borderColor: t.colors.border },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginBottom: 4 },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    kindText: { flex: 1, color: t.colors.text, fontSize: 13, fontFamily: 'monospace', fontWeight: '600' },
    ageText: { color: t.colors.placeholder, fontSize: 11 },
    urlText: { color: t.colors.muted, fontSize: 11, fontFamily: 'monospace', marginBottom: 4, textDecorationLine: 'underline' },
    docLinkText: { color: t.colors.accent, fontSize: 13, fontFamily: 'monospace', fontWeight: '600', textDecorationLine: 'none' },
    mutedText: { color: t.colors.muted, fontSize: 11, fontFamily: 'monospace', marginBottom: 4 },
    resultRow: { flexDirection: 'row', gap: t.spacing.sm, marginBottom: 4, alignItems: 'center' },
    resultText: { color: t.colors.muted, fontSize: 12 },
    nothingNew: { color: t.colors.placeholder, fontSize: 11, fontStyle: 'italic' },
    errorText: { color: t.colors.error, fontSize: 12, marginTop: 4, marginBottom: 4, lineHeight: 17 },
    attemptsText: { color: t.colors.placeholder, fontSize: 11, marginBottom: 4 },
    retryBtn: { alignSelf: 'flex-start', marginTop: t.spacing.sm, backgroundColor: t.colors.accent, borderRadius: t.radius.sm, paddingHorizontal: t.spacing.md, paddingVertical: 5, minWidth: 64, alignItems: 'center' },
    retryBtnPressed: { opacity: 0.75 },
    retryBtnText: { color: t.colors.background, fontSize: 12, fontWeight: '700' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    reloadBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    reloadText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    emptyText: { color: t.colors.muted, fontSize: 15 },
  })
}
