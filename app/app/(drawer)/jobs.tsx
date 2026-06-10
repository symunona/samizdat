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

// Group jobs into a tree: roots at top, children indented.
// A job is a root if it has no parent_job_id or the parent is not in the visible set.
function buildTree(jobs: Job[]): { job: Job; isRoot: boolean; depth: number }[] {
  const byId = new Map<string, Job>()
  for (const j of jobs) byId.set(j.id, j)

  const result: { job: Job; isRoot: boolean; depth: number }[] = []
  const visited = new Set<string>()

  function collectGroup(job: Job, depth: number) {
    if (visited.has(job.id)) return
    visited.add(job.id)
    result.push({ job, isRoot: depth === 0, depth })
    // Find direct children
    for (const j of jobs) {
      if (j.parent_job_id === job.id && !visited.has(j.id)) {
        collectGroup(j, depth + 1)
      }
    }
  }

  // Process roots first (no parent, or parent not in set)
  for (const job of jobs) {
    if (!job.parent_job_id || !byId.has(job.parent_job_id)) {
      collectGroup(job, 0)
    }
  }
  // Orphans (parent_job_id set but parent not in filtered view)
  for (const job of jobs) {
    if (!visited.has(job.id)) {
      collectGroup(job, 0)
    }
  }

  return result
}

// Aggregate status of a group (root + its subtree)
function groupStatus(rootId: string, byParent: Map<string, Job[]>): string {
  const children = byParent.get(rootId) ?? []
  if (children.length === 0) return ''
  const statuses = new Set(children.map(c => c.status))
  if (statuses.has('running')) return 'running'
  if (statuses.has('dead')) return 'dead'
  if (statuses.has('queued')) return 'queued'
  return 'done'
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

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

  function toggleCollapse(id: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filtered = useMemo(() =>
    filter === 'all' ? jobs : jobs.filter(j => j.status === filter),
    [jobs, filter]
  )

  // Build flat tree list; collapse subtrees for collapsed roots
  const treeItems = useMemo(() => {
    const byParent = new Map<string, Job[]>()
    for (const j of filtered) {
      if (j.parent_job_id) {
        const arr = byParent.get(j.parent_job_id) ?? []
        arr.push(j)
        byParent.set(j.parent_job_id, arr)
      }
    }

    const tree = buildTree(filtered)

    // Filter out children of collapsed roots
    const collapsedRoots = new Set<string>()
    for (const { job, isRoot } of tree) {
      if (isRoot && collapsed.has(job.id)) collapsedRoots.add(job.id)
    }

    return tree
      .filter(({ job }) => {
        if (!job.parent_job_id) return true
        return !collapsedRoots.has(job.parent_job_id)
      })
      .map(item => ({
        ...item,
        childCount: item.isRoot ? (byParent.get(item.job.id)?.length ?? 0) : 0,
        groupStatus: item.isRoot ? groupStatus(item.job.id, byParent) : '',
      }))
  }, [filtered, collapsed])

  function renderItem({ item }: { item: typeof treeItems[0] }) {
    const { job, depth, isRoot, childCount, groupStatus: gStatus } = item
    const statusColor = STATUS_COLOR[job.status] ?? '#9ca3af'
    const p = parsePayload(job.payload)
    const r = parseResult(job.result)
    const isRetrying = retryingId === job.id
    const isCollapsed = isRoot && collapsed.has(job.id)

    const payloadUrl = p.url ?? ''
    const feedId = p.feed_id ?? ''
    const feedUrl = p.feed_url ?? ''
    const pipelineName = p.pipeline_name ?? ''
    const documentTitle = p.document_title ?? ''
    const stepIndex = typeof p.step_index === 'number' ? p.step_index : (p.step_index != null ? parseInt(p.step_index as string, 10) : -1)

    const docId: string = (typeof r.document_id === 'string' && r.document_id)
      ? r.document_id
      : (job.kind === 'scrape_url' && payloadUrl ? docIdFromUrl(payloadUrl) : '')

    const doc = docId ? docMap.get(docId) : undefined
    const docTitle = doc?.title ?? (typeof r.title === 'string' ? r.title : '')

    const discovered = typeof r.discovered === 'number' ? r.discovered : -1
    const newItems = typeof r.new === 'number' ? r.new : -1

    const indentPx = depth * 16

    return (
      <View style={[s.card, depth > 0 && s.childCard, { marginLeft: indentPx }]}>
        {/* Connector line for children */}
        {depth > 0 && <View style={s.connectorLine} />}

        <View style={s.cardTop}>
          <View style={[s.statusDot, { backgroundColor: statusColor }]} />
          <Text style={s.kindText}>{kindLabel(job.kind)}</Text>
          <Text style={s.ageText}>{formatAge(job.updated_at)}</Text>

          {/* Collapse toggle for roots with children */}
          {isRoot && childCount > 0 && (
            <Pressable onPress={() => toggleCollapse(job.id)} style={s.collapseBtn}>
              <View style={[s.groupBadge, gStatus ? { backgroundColor: STATUS_COLOR[gStatus] + '33' } : undefined]}>
                <Text style={s.groupBadgeText}>{childCount}</Text>
              </View>
              <Text style={s.collapseIcon}>{isCollapsed ? '▶' : '▼'}</Text>
            </Pressable>
          )}
        </View>

        {/* scrape_url */}
        {job.kind === 'scrape_url' && !!payloadUrl && (
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
        {job.kind === 'scrape_url' && !!feedUrl && (
          <Text style={s.sourceText} numberOfLines={1}>from feed: {feedUrl}</Text>
        )}

        {/* other job kinds: external URL */}
        {job.kind !== 'scrape_url' && !!payloadUrl && (
          <Pressable onPress={() => Linking.openURL(payloadUrl)}>
            <Text style={s.urlText} numberOfLines={1}>{payloadUrl}</Text>
          </Pressable>
        )}

        {/* poll_feed */}
        {job.kind === 'poll_feed' && (
          <Text style={s.mutedText} numberOfLines={1}>
            {feedUrl || (feedId ? `feed: ${feedId.slice(0, 8)}` : '')}
          </Text>
        )}
        {job.kind === 'poll_feed' && discovered >= 0 && (
          <View style={s.resultRow}>
            <Text style={s.resultText}>{discovered} discovered</Text>
            {newItems === 0
              ? <Text style={s.nothingNew}>nothing new</Text>
              : <Text style={[s.resultText, { color: '#4ade80' }]}>{newItems} new</Text>
            }
          </View>
        )}

        {/* run_pipeline */}
        {job.kind === 'run_pipeline' && (
          <Text style={s.pipelineText} numberOfLines={2}>
            {pipelineName || 'pipeline'}{documentTitle ? ` → ${documentTitle}` : ''}
          </Text>
        )}

        {/* run_pipeline_step */}
        {job.kind === 'run_pipeline_step' && (
          <Text style={s.pipelineText} numberOfLines={2}>
            {pipelineName || 'pipeline'}{stepIndex >= 0 ? ` step ${stepIndex + 1}` : ''}{documentTitle ? ` → ${documentTitle}` : ''}
          </Text>
        )}

        {/* fetch_assets */}
        {job.kind === 'fetch_assets' && !!documentTitle && (
          <Text style={s.mutedText} numberOfLines={1}>{documentTitle}</Text>
        )}

        {!!job.last_error && (
          <Text style={s.errorText} numberOfLines={3}>{job.last_error}</Text>
        )}

        {job.attempts > 0 && job.status !== 'done' && (
          <Text style={s.attemptsText}>Attempts: {job.attempts}</Text>
        )}

        {job.status === 'dead' && (
          <Pressable
            style={({ pressed }) => [s.retryBtn, (isRetrying || pressed) && s.retryBtnPressed]}
            onPress={() => handleRetry(job)}
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
              data={treeItems}
              keyExtractor={item => item.job.id}
              renderItem={renderItem}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={theme.colors.accent} />}
              contentContainerStyle={treeItems.length === 0 ? s.emptyContainer : s.list}
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
    childCard: { borderLeftWidth: 2, borderLeftColor: t.colors.accent + '55', borderRadius: t.radius.sm },
    connectorLine: { position: 'absolute', left: -1, top: 0, bottom: 0, width: 2, backgroundColor: t.colors.accent + '33' },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginBottom: 4 },
    statusDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
    kindText: { flex: 1, color: t.colors.text, fontSize: 13, fontFamily: 'monospace', fontWeight: '600' },
    ageText: { color: t.colors.placeholder, fontSize: 11 },
    collapseBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 4 },
    collapseIcon: { color: t.colors.muted, fontSize: 10 },
    groupBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 8, backgroundColor: t.colors.border },
    groupBadgeText: { color: t.colors.text, fontSize: 10, fontFamily: 'monospace', fontWeight: '700' },
    urlText: { color: t.colors.muted, fontSize: 11, fontFamily: 'monospace', marginBottom: 4, textDecorationLine: 'underline' },
    docLinkText: { color: t.colors.accent, fontSize: 13, fontFamily: 'monospace', fontWeight: '600', textDecorationLine: 'none' },
    mutedText: { color: t.colors.muted, fontSize: 11, fontFamily: 'monospace', marginBottom: 4 },
    sourceText: { color: t.colors.placeholder, fontSize: 10, fontFamily: 'monospace', marginBottom: 4 },
    pipelineText: { color: t.colors.text, fontSize: 12, fontFamily: 'monospace', marginBottom: 4 },
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
