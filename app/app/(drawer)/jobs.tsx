import { useCallback, useMemo, useState } from 'react'
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
import { useRouter, useFocusEffect } from 'expo-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useUnistyles } from 'react-native-unistyles'
import { v5 as uuidv5 } from 'uuid'
import {
  fetchJobsPage, fetchDocuments, retryJob, rerunJob, clearCompletedJobs,
  resumeJob, resumeAllJobs, deleteJob, clearQueuedJobs,
  queueFeedPipelines, queueDocumentPipelines,
} from '../../src/api'
import type { Job, Document } from '../../src/api'
import { useConnection } from '../../src/ConnectionContext'
import { useToast } from '../../src/ToastContext'

const STATUS_FILTERS = ['all', 'queued', 'paused', 'running', 'dead', 'done'] as const
type Filter = (typeof STATUS_FILTERS)[number]

const STATUS_COLOR: Record<string, string> = {
  queued:  '#facc15',
  paused:  '#a78bfa',
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

// Human-readable execution time: 1.2s, 850ms, 2m3s.
function formatDuration(ms: number): string {
  if (ms <= 0) return ''
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s % 60)}s`
}

// shortModel collapses a model id to a compact badge label.
// claude-opus-4-8 → opus · claude-haiku-4-5-20251001 → haiku · others → first segment.
function shortModel(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return model.split(/[/:]/).pop()?.slice(0, 16) ?? model
}

// uniqueModels returns the distinct short model labels used by a job.
function uniqueModels(llm?: { model: string }[]): string[] {
  if (!llm || llm.length === 0) return []
  return [...new Set(llm.map(u => shortModel(u.model)))]
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

const PAGE_LIMIT = 30

export default function JobsScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { status, activeUrl, token } = useConnection()
  const router = useRouter()
  const { toast } = useToast()

  const [docMap, setDocMap] = useState<Map<string, Document>>(new Map())
  const [filter, setFilter] = useState<Filter>('all')
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [resumingAll, setResumingAll] = useState(false)
  const [clearingQueue, setClearingQueue] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [queueingPipelinesId, setQueueingPipelinesId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [rerunPreviewId, setRerunPreviewId] = useState<string | null>(null)
  const [rerunningId, setRerunningId] = useState<string | null>(null)

  const enabled = status === 'connected' && !!activeUrl && !!token

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useInfiniteQuery({
    queryKey: ['jobs', activeUrl, filter, showHistory],
    queryFn: async ({ pageParam }) => {
      const opts = {
        offset: pageParam as number,
        limit: PAGE_LIMIT,
        ...(showHistory ? { includeSuperseded: true } : {}),
        ...(filter !== 'all' && !showHistory ? { status: filter } : {}),
      }
      return fetchJobsPage(activeUrl!, token!, opts)
    },
    initialPageParam: 0,
    getNextPageParam: (page) =>
      page.has_more ? page.offset + page.items.length : undefined,
    enabled,
    refetchInterval: (query) => {
      const allJobs = query.state.data?.pages.flatMap(p => p.items) ?? []
      const hasActive = allJobs.some(j => j.status === 'queued' || j.status === 'running')
      return hasActive ? 3000 : false
    },
  })

  // Load documents map for title lookups (not paged — lightweight)
  const loadDocMap = useCallback(async () => {
    if (!activeUrl || !token) return
    try {
      const docsData = await fetchDocuments(activeUrl, token)
      const m = new Map<string, Document>()
      for (const d of (docsData ?? [])) m.set(d.id, d)
      setDocMap(m)
    } catch { /* non-critical */ }
  }, [activeUrl, token])

  // Refetch on screen focus
  useFocusEffect(
    useCallback(() => {
      if (status === 'connected') {
        void refetch()
        void loadDocMap()
      }
    }, [status, refetch, loadDocMap])
  )

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
    await refetch()
  }

  async function handleRetry(job: Job) {
    if (!activeUrl || !token || retryingId) return
    setRetryingId(job.id)
    try {
      await retryJob(activeUrl, token, job.id)
      await refetch()
    } catch { /* ignore */ }
    finally { setRetryingId(null) }
  }

  async function handleRerunConfirm(job: Job) {
    if (!activeUrl || !token || rerunningId) return
    setRerunningId(job.id)
    try {
      await rerunJob(activeUrl, token, job.id)
      toast('Rerun queued — subtree regenerating', 'success')
      setRerunPreviewId(null)
      await refetch()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Rerun failed', 'error')
    } finally { setRerunningId(null) }
  }

  async function handleResume(job: Job) {
    if (!activeUrl || !token || resumingId) return
    setResumingId(job.id)
    try {
      await resumeJob(activeUrl, token, job.id)
      await refetch()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to resume', 'error')
    } finally { setResumingId(null) }
  }

  async function handleDelete(job: Job) {
    if (!activeUrl || !token || deletingId) return
    setDeletingId(job.id)
    try {
      await deleteJob(activeUrl, token, job.id)
      await refetch()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to delete', 'error')
    } finally { setDeletingId(null) }
  }

  async function handleResumeAll() {
    if (!activeUrl || !token || resumingAll) return
    setResumingAll(true)
    try {
      await resumeAllJobs(activeUrl, token)
      toast('All paused jobs resumed', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to resume all', 'error')
    } finally {
      setResumingAll(false)
      await refetch()
    }
  }

  async function handleClearQueue() {
    if (!activeUrl || !token || clearingQueue) return
    setClearingQueue(true)
    try {
      const n = await clearQueuedJobs(activeUrl, token)
      toast(n > 0 ? `Cleared ${n} queued job${n === 1 ? '' : 's'}` : 'Queue already empty', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to clear queue', 'error')
    } finally {
      setClearingQueue(false)
      await refetch()
    }
  }

  async function handleQueueFeedPipelines(job: Job, feedId: string) {
    if (!activeUrl || !token || queueingPipelinesId) return
    setQueueingPipelinesId(job.id)
    try {
      const result = await queueFeedPipelines(activeUrl, token, feedId, true, job.id)
      toast(
        result.queued > 0
          ? `Queued ${result.queued} pipeline job${result.queued === 1 ? '' : 's'} (paused)${result.skipped > 0 ? `, ${result.skipped} skipped` : ''}`
          : `No new pipeline jobs (${result.skipped} already active)`,
        result.queued > 0 ? 'success' : 'info',
      )
      await refetch()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to queue pipelines', 'error')
    } finally { setQueueingPipelinesId(null) }
  }

  async function handleQueueDocPipelines(job: Job, docId: string) {
    if (!activeUrl || !token || queueingPipelinesId) return
    setQueueingPipelinesId(job.id)
    try {
      const result = await queueDocumentPipelines(activeUrl, token, docId, true, job.id)
      toast(
        result.queued > 0
          ? `Queued ${result.queued} pipeline job${result.queued === 1 ? '' : 's'} (paused)${result.skipped > 0 ? `, ${result.skipped} skipped` : ''}`
          : `No new pipeline jobs (${result.skipped} already active)`,
        result.queued > 0 ? 'success' : 'info',
      )
      await refetch()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to queue pipelines', 'error')
    } finally { setQueueingPipelinesId(null) }
  }

  function toggleCollapse(id: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Flatten all pages
  const jobs = useMemo(
    () => data?.pages.flatMap(p => p.items) ?? [],
    [data]
  )

  // Affected subtree (node + all descendants) for the rerun preview highlight.
  const affectedIds = useMemo(() => {
    const set = new Set<string>()
    if (!rerunPreviewId) return set
    const byParent = new Map<string, Job[]>()
    for (const j of jobs) {
      if (j.parent_job_id) {
        const arr = byParent.get(j.parent_job_id) ?? []
        arr.push(j)
        byParent.set(j.parent_job_id, arr)
      }
    }
    set.add(rerunPreviewId)
    const stack = [rerunPreviewId]
    while (stack.length) {
      const id = stack.pop()!
      for (const c of byParent.get(id) ?? []) {
        if (!set.has(c.id)) { set.add(c.id); stack.push(c.id) }
      }
    }
    return set
  }, [rerunPreviewId, jobs])

  // Version labels (v1, v2 current, …) for run_pipeline jobs grouped by
  // (pipeline_id, document_id) — only meaningful in the history view.
  const versionLabels = useMemo(() => {
    const m = new Map<string, string>()
    if (!showHistory) return m
    const groups = new Map<string, Job[]>()
    for (const j of jobs) {
      if (j.kind !== 'run_pipeline') continue
      const p = parsePayload(j.payload)
      const key = `${p.pipeline_id ?? ''}|${p.document_id ?? ''}`
      if (key === '|') continue
      const arr = groups.get(key) ?? []
      arr.push(j)
      groups.set(key, arr)
    }
    for (const arr of groups.values()) {
      if (arr.length < 2) continue
      arr.sort((a, b) => a.created_at.localeCompare(b.created_at))
      arr.forEach((j, i) => m.set(j.id, j.deleted_at ? `v${i + 1}` : `v${i + 1} current`))
    }
    return m
  }, [jobs, showHistory])

  // Build flat tree list; collapse subtrees for collapsed roots
  const treeItems = useMemo(() => {
    const byId = new Map<string, Job>()
    const byParent = new Map<string, Job[]>()
    for (const j of jobs) {
      byId.set(j.id, j)
      if (j.parent_job_id) {
        const arr = byParent.get(j.parent_job_id) ?? []
        arr.push(j)
        byParent.set(j.parent_job_id, arr)
      }
    }

    const flatTree = buildTree(jobs)

    // Group same-URL scrape_url root-blocks so duplicates/retries render together
    // (server dedup prevents NEW dupes; this collapses legacy dupes + history runs).
    // buildTree emits each root immediately followed by its subtree, so a "block"
    // is a root item plus the following non-root items until the next root.
    type TreeItem = typeof flatTree[number]
    const blocks: { rootId: string; url: string; items: TreeItem[] }[] = []
    for (const it of flatTree) {
      if (it.isRoot) {
        const url = it.job.kind === 'scrape_url' ? (parsePayload(it.job.payload).url ?? '') : ''
        blocks.push({ rootId: it.job.id, url, items: [it] })
      } else if (blocks.length) {
        blocks[blocks.length - 1].items.push(it)
      }
    }
    const groupOrder: string[] = []
    const groups = new Map<string, typeof blocks>()
    for (const b of blocks) {
      const key = b.url ? `u:${b.url}` : `b:${b.rootId}` // empty-url roots stay singletons
      if (!groups.has(key)) { groups.set(key, []); groupOrder.push(key) }
      groups.get(key)!.push(b)
    }
    // urlGroup meta per root: run N of M (chronological; newest block = run M), and
    // a groupStart flag on the first (newest) block of a multi-run URL group.
    const urlGroup = new Map<string, { size: number; run: number; groupStart: boolean }>()
    const tree: TreeItem[] = []
    for (const key of groupOrder) {
      const gblocks = groups.get(key)!
      gblocks.forEach((b, i) => {
        urlGroup.set(b.rootId, { size: gblocks.length, run: gblocks.length - i, groupStart: i === 0 && gblocks.length > 1 })
        tree.push(...b.items)
      })
    }

    // Filter out children of collapsed roots
    const collapsedRoots = new Set<string>()
    for (const { job, isRoot } of tree) {
      if (isRoot && collapsed.has(job.id)) collapsedRoots.add(job.id)
    }

    const queuePositions = new Map<string, number>()
    let qPos = 0
    for (const j of jobs) {
      if (j.status === 'queued') queuePositions.set(j.id, ++qPos)
    }

    // Count all descendants recursively for each root
    function countDescendants(id: string): number {
      const children = byParent.get(id) ?? []
      return children.reduce((sum, c) => sum + 1 + countDescendants(c.id), 0)
    }

    return tree
      .filter(({ job }) => {
        if (!job.parent_job_id) return true
        // Walk ancestor chain — hide if any ancestor is a collapsed root
        let parentId: string | undefined = job.parent_job_id
        while (parentId) {
          if (collapsedRoots.has(parentId)) return false
          parentId = byId.get(parentId)?.parent_job_id ?? undefined
        }
        return true
      })
      .map(item => ({
        ...item,
        childCount: item.isRoot ? countDescendants(item.job.id) : 0,
        groupStatus: item.isRoot ? groupStatus(item.job.id, byParent) : '',
        queuePos: queuePositions.get(item.job.id),
        urlGroup: item.isRoot ? (urlGroup.get(item.job.id) ?? null) : null,
      }))
  }, [jobs, collapsed])

  function renderItem({ item }: { item: typeof treeItems[0] }) {
    const { job, depth, isRoot, childCount, groupStatus: gStatus, queuePos, urlGroup } = item
    const inUrlGroup = !!urlGroup && urlGroup.size > 1
    const statusColor = STATUS_COLOR[job.status] ?? '#9ca3af'
    const p = parsePayload(job.payload)
    const r = parseResult(job.result)
    const isRetrying = retryingId === job.id
    const isCollapsed = isRoot && collapsed.has(job.id)
    const isSuperseded = !!job.deleted_at
    const isAffected = affectedIds.has(job.id)
    const versionLabel = versionLabels.get(job.id)
    const skipped = r.skipped === true

    const payloadUrl = p.url ?? ''
    const feedId = p.feed_id ?? ''
    const feedUrl = p.feed_url ?? ''
    const deviceName = p.device_name ?? ''
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
      <View style={[
        s.card,
        depth > 0 && s.childCard,
        isSuperseded && s.supersededCard,
        isAffected && s.previewCard,
        urlGroup?.groupStart && s.urlGroupStart,
        { marginLeft: indentPx },
      ]}>
        {/* Header when several jobs share one URL — the group of retries/runs. */}
        {urlGroup?.groupStart && (
          <Text style={s.urlGroupHeader} numberOfLines={1}>↳ {urlGroup.size} runs of this URL</Text>
        )}
        {/* Connector line for children */}
        {depth > 0 && <View style={s.connectorLine} />}

        <View style={s.cardTop}>
          <View style={[s.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[s.kindText, isSuperseded && s.supersededText]}>{kindLabel(job.kind)}</Text>
          {versionLabel && (
            <View style={s.versionBadge}><Text style={s.versionBadgeText}>{versionLabel}</Text></View>
          )}
          {inUrlGroup && (
            <View style={s.versionBadge}><Text style={s.versionBadgeText}>run {urlGroup!.run}/{urlGroup!.size}</Text></View>
          )}
          {isSuperseded && (
            <View style={s.supersededBadge}><Text style={s.supersededBadgeText}>superseded</Text></View>
          )}
          {skipped && (
            <View style={s.skippedBadge}><Text style={s.skippedBadgeText}>skipped</Text></View>
          )}
          {uniqueModels(job.llm).map(m => (
            <View key={m} style={s.modelBadge}>
              <Text style={s.modelBadgeText}>{m}</Text>
            </View>
          ))}
          {!!job.llm_cost_usd && job.llm_cost_usd > 0 && (
            <Text style={s.costText}>${job.llm_cost_usd < 0.01 ? '<0.01' : job.llm_cost_usd.toFixed(2)}</Text>
          )}
          {job.duration_ms > 0 && (job.status === 'done' || job.status === 'dead') && (
            <Text style={s.durationText}>⏱ {formatDuration(job.duration_ms)}</Text>
          )}
          <Text style={s.ageText}>{formatAge(job.updated_at)}</Text>
          {job.status === 'queued' && queuePos != null && (
            <Text style={s.queueLabel}>#{queuePos} queued</Text>
          )}
          {job.status === 'running' && (
            <Text style={s.queueLabel}>processing</Text>
          )}

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
        {job.kind === 'scrape_url' && !feedUrl && (
          <Text style={s.sourceText} numberOfLines={1}>
            {deviceName ? `Manual — ${deviceName}` : 'Manual'}
          </Text>
        )}
        {job.kind === 'scrape_url' && job.status === 'done' && !!docId && (
          <Pressable
            style={({ pressed }) => [s.queuePipelinesBtn, (queueingPipelinesId === job.id || pressed) && s.queuePipelinesBtnPressed]}
            onPress={() => handleQueueDocPipelines(job, docId)}
            disabled={!!queueingPipelinesId}
          >
            {queueingPipelinesId === job.id
              ? <ActivityIndicator size="small" color="#a78bfa" />
              : <Text style={s.queuePipelinesBtnText}>▶ Queue Pipelines</Text>
            }
          </Pressable>
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
        {job.kind === 'poll_feed' && job.status === 'done' && discovered > 0 && !!feedId && (
          <Pressable
            style={({ pressed }) => [s.queuePipelinesBtn, (queueingPipelinesId === job.id || pressed) && s.queuePipelinesBtnPressed]}
            onPress={() => handleQueueFeedPipelines(job, feedId)}
            disabled={!!queueingPipelinesId}
          >
            {queueingPipelinesId === job.id
              ? <ActivityIndicator size="small" color="#a78bfa" />
              : <Text style={s.queuePipelinesBtnText}>▶ Queue Pipelines</Text>
            }
          </Pressable>
        )}

        {/* run_pipeline */}
        {job.kind === 'run_pipeline' && (() => {
          const rpDocId = p.document_id ?? ''
          const rpDoc = rpDocId ? docMap.get(rpDocId) : undefined
          const rpTitle = rpDoc?.title ?? documentTitle
          return (
            <Pressable
              disabled={!rpDocId}
              onPress={() => rpDocId ? router.push(`/(drawer)/document/${rpDocId}`) : undefined}
            >
              <Text style={[s.pipelineText, !!rpDocId && s.pipelineLinkText]} numberOfLines={2}>
                {pipelineName || 'pipeline'}{rpTitle ? ` → ${rpTitle}` : ''}{rpDocId ? ' →' : ''}
              </Text>
            </Pressable>
          )
        })()}

        {/* run_pipeline_step */}
        {job.kind === 'run_pipeline_step' && (() => {
          const rpsDocId = p.document_id ?? ''
          const rpsDoc = rpsDocId ? docMap.get(rpsDocId) : undefined
          const rpsTitle = rpsDoc?.title ?? documentTitle
          return (
            <Pressable
              disabled={!rpsDocId}
              onPress={() => rpsDocId ? router.push(`/(drawer)/document/${rpsDocId}`) : undefined}
            >
              <Text style={[s.pipelineText, !!rpsDocId && s.pipelineLinkText]} numberOfLines={2}>
                {pipelineName || 'pipeline'}{stepIndex >= 0 ? ` step ${stepIndex + 1}` : ''}{rpsTitle ? ` → ${rpsTitle}` : ''}{rpsDocId ? ' →' : ''}
              </Text>
            </Pressable>
          )
        })()}

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
        {job.status === 'paused' && (
          <View style={s.pausedActions}>
            <Pressable
              style={({ pressed }) => [s.resumeBtn, (resumingId === job.id || pressed) && s.resumeBtnPressed]}
              onPress={() => handleResume(job)}
              disabled={!!resumingId || !!deletingId}
            >
              {resumingId === job.id
                ? <ActivityIndicator size="small" color="#0b0b0c" />
                : <Text style={s.resumeBtnText}>Resume</Text>
              }
            </Pressable>
            <Pressable
              style={({ pressed }) => [s.deletePausedBtn, (deletingId === job.id || pressed) && s.deletePausedBtnPressed]}
              onPress={() => handleDelete(job)}
              disabled={!!resumingId || !!deletingId}
            >
              {deletingId === job.id
                ? <ActivityIndicator size="small" color="#f87171" />
                : <Text style={s.deletePausedBtnText}>Delete</Text>
              }
            </Pressable>
          </View>
        )}

        {/* Rerun: forced regenerate of this node's whole subtree */}
        {!isSuperseded && rerunPreviewId !== job.id && (
          <Pressable
            style={({ pressed }) => [s.rerunBtn, pressed && s.rerunBtnPressed]}
            onPress={() => setRerunPreviewId(job.id)}
          >
            <Text style={s.rerunBtnText}>⟳ Rerun</Text>
          </Pressable>
        )}
        {rerunPreviewId === job.id && (
          <View style={s.rerunConfirm}>
            <Text style={s.rerunConfirmText}>
              Erase this subtree's results and regenerate? Interacted highlights are kept.
            </Text>
            <View style={s.rerunConfirmActions}>
              <Pressable
                style={({ pressed }) => [s.rerunGoBtn, (rerunningId === job.id || pressed) && s.rerunBtnPressed]}
                onPress={() => handleRerunConfirm(job)}
                disabled={!!rerunningId}
              >
                {rerunningId === job.id
                  ? <ActivityIndicator size="small" color="#0b0b0c" />
                  : <Text style={s.rerunGoText}>Erase & regenerate</Text>
                }
              </Pressable>
              <Pressable
                style={({ pressed }) => [s.rerunCancelBtn, pressed && s.rerunBtnPressed]}
                onPress={() => setRerunPreviewId(null)}
                disabled={!!rerunningId}
              >
                <Text style={s.rerunCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    )
  }

  const errorMessage = isError ? (error instanceof Error ? error.message : 'Failed to load') : null

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.wrapper}>
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
        <View style={s.bulkActions}>
          <View style={s.bulkRow}>
            <Pressable
              style={({ pressed }) => [s.clearBtn, pressed && s.clearBtnPressed]}
              onPress={() => setShowHistory(v => !v)}
            >
              <Text style={[s.historyBtnText, showHistory && s.historyBtnActive]}>
                {showHistory ? '✓ history' : 'history'}
              </Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [s.clearBtn, (resumingAll || pressed) && s.clearBtnPressed]}
              onPress={handleResumeAll}
              disabled={resumingAll}
            >
              {resumingAll
                ? <ActivityIndicator size="small" color="#a78bfa" />
                : <Text style={s.resumeAllBtnText}>resume all</Text>
              }
            </Pressable>
          </View>
          <View style={s.bulkRow}>
            <Pressable
              style={({ pressed }) => [s.clearBtn, (clearingQueue || pressed) && s.clearBtnPressed]}
              onPress={handleClearQueue}
              disabled={clearingQueue}
            >
              {clearingQueue
                ? <ActivityIndicator size="small" color="#facc15" />
                : <Text style={s.clearQueueBtnText}>clr queue</Text>
              }
            </Pressable>
            <Pressable
              style={({ pressed }) => [s.clearBtn, (clearing || pressed) && s.clearBtnPressed]}
              onPress={handleClear}
              disabled={clearing}
            >
              {clearing
                ? <ActivityIndicator size="small" color="#f87171" />
                : <Text style={s.clearBtnText}>clear done</Text>
              }
            </Pressable>
          </View>
        </View>
      </View>

      {isLoading && !isRefetching
        ? <View style={s.centered}><ActivityIndicator color={theme.colors.accent} size="large" /></View>
        : errorMessage
          ? <View style={s.centered}>
              <Text style={s.errText}>{errorMessage}</Text>
              <Pressable onPress={() => refetch()} style={s.reloadBtn}>
                <Text style={s.reloadText}>Retry</Text>
              </Pressable>
            </View>
          : <FlatList
              data={treeItems}
              keyExtractor={item => item.job.id}
              renderItem={renderItem}
              refreshControl={
                <RefreshControl
                  refreshing={isRefetching}
                  onRefresh={() => refetch()}
                  tintColor={theme.colors.accent}
                />
              }
              contentContainerStyle={treeItems.length === 0 ? s.emptyContainer : s.list}
              ItemSeparatorComponent={() => <View style={s.sep} />}
              ListEmptyComponent={
                <Text style={s.emptyText}>No {filter === 'all' ? '' : filter + ' '}jobs.</Text>
              }
              onEndReachedThreshold={0.3}
              onEndReached={() => {
                if (hasNextPage && !isFetchingNextPage) {
                  void fetchNextPage()
                }
              }}
              ListFooterComponent={
                isFetchingNextPage
                  ? <View style={s.footerSpinner}><ActivityIndicator color={theme.colors.accent} /></View>
                  : null
              }
            />
      }
      </View>
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    wrapper: { flex: 1, maxWidth: 800, alignSelf: 'center', width: '100%' },
    toolbar: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: t.colors.border, backgroundColor: t.colors.surface },
    filters: { flex: 1, flexDirection: 'row', paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.sm, gap: t.spacing.xs, flexWrap: 'wrap' },
    clearBtn: { paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, minWidth: 52, alignItems: 'center' },
    clearBtnPressed: { opacity: 0.5 },
    clearBtnText: { color: '#f87171', fontSize: 12, fontFamily: 'monospace', fontWeight: '600' },
    filterBtn: { paddingHorizontal: t.spacing.sm, paddingVertical: 4, borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.colors.border },
    filterBtnActive: { backgroundColor: t.colors.accent, borderColor: t.colors.accent },
    filterText: { color: t.colors.muted, fontSize: 12, fontFamily: 'monospace' },
    filterTextActive: { color: t.colors.background, fontWeight: '700' },
    list: { padding: t.spacing.sm, maxWidth: 800, alignSelf: 'center', width: '100%' },
    sep: { height: t.spacing.xs },
    card: { backgroundColor: t.colors.surface, borderRadius: t.radius.sm, padding: t.spacing.md, borderWidth: 1, borderColor: t.colors.border },
    childCard: { borderLeftWidth: 2, borderLeftColor: t.colors.accent + '55', borderRadius: t.radius.sm },
    supersededCard: { opacity: 0.55, borderStyle: 'dashed' },
    supersededText: { textDecorationLine: 'line-through' },
    previewCard: { borderColor: '#f87171', borderWidth: 2, backgroundColor: '#f8717111' },
    versionBadge: { backgroundColor: t.colors.accent + '22', borderRadius: t.radius.sm, paddingHorizontal: 6, paddingVertical: 1, flexShrink: 0 },
    versionBadgeText: { color: t.colors.accent, fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
    urlGroupStart: { marginTop: 14, borderTopWidth: 2, borderTopColor: t.colors.accent + '44' },
    urlGroupHeader: { color: t.colors.muted, fontSize: 11, fontWeight: '600', marginBottom: 4 },
    supersededBadge: { backgroundColor: '#9ca3af33', borderRadius: t.radius.sm, paddingHorizontal: 6, paddingVertical: 1, flexShrink: 0 },
    supersededBadgeText: { color: '#9ca3af', fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
    skippedBadge: { backgroundColor: '#60a5fa33', borderRadius: t.radius.sm, paddingHorizontal: 6, paddingVertical: 1, flexShrink: 0 },
    skippedBadgeText: { color: '#60a5fa', fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
    historyBtnText: { color: t.colors.muted, fontSize: 12, fontFamily: 'monospace', fontWeight: '600' },
    historyBtnActive: { color: t.colors.accent },
    rerunBtn: { alignSelf: 'flex-start', marginTop: t.spacing.sm, borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.sm, paddingHorizontal: t.spacing.md, paddingVertical: 4 },
    rerunBtnPressed: { opacity: 0.6 },
    rerunBtnText: { color: t.colors.muted, fontSize: 11, fontFamily: 'monospace', fontWeight: '600' },
    rerunConfirm: { marginTop: t.spacing.sm, padding: t.spacing.sm, borderWidth: 1, borderColor: '#f87171', borderRadius: t.radius.sm, backgroundColor: '#f8717111' },
    rerunConfirmText: { color: t.colors.text, fontSize: 12, marginBottom: t.spacing.sm, lineHeight: 17 },
    rerunConfirmActions: { flexDirection: 'row', gap: t.spacing.sm },
    rerunGoBtn: { backgroundColor: '#f87171', borderRadius: t.radius.sm, paddingHorizontal: t.spacing.md, paddingVertical: 5, minWidth: 140, alignItems: 'center' },
    rerunGoText: { color: '#0b0b0c', fontSize: 12, fontWeight: '700' },
    rerunCancelBtn: { borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.sm, paddingHorizontal: t.spacing.md, paddingVertical: 5, alignItems: 'center' },
    rerunCancelText: { color: t.colors.muted, fontSize: 12, fontWeight: '600' },
    connectorLine: { position: 'absolute', left: -1, top: 0, bottom: 0, width: 2, backgroundColor: t.colors.accent + '33' },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginBottom: 4 },
    statusDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
    kindText: { flex: 1, color: t.colors.text, fontSize: 13, fontFamily: 'monospace', fontWeight: '600' },
    modelBadge: { backgroundColor: t.colors.accent + '22', borderRadius: t.radius.sm, paddingHorizontal: 6, paddingVertical: 1, flexShrink: 0 },
    modelBadgeText: { color: t.colors.accent, fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
    costText: { color: t.colors.placeholder, fontSize: 11, fontFamily: 'monospace', flexShrink: 0 },
    durationText: { color: t.colors.placeholder, fontSize: 11, fontFamily: 'monospace', flexShrink: 0 },
    ageText: { color: t.colors.placeholder, fontSize: 11 },
    queueLabel: { color: t.colors.placeholder, fontSize: 10, fontFamily: 'monospace' },
    collapseBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 4 },
    collapseIcon: { color: t.colors.muted, fontSize: 10 },
    groupBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 8, backgroundColor: t.colors.border },
    groupBadgeText: { color: t.colors.text, fontSize: 10, fontFamily: 'monospace', fontWeight: '700' },
    urlText: { color: t.colors.muted, fontSize: 11, fontFamily: 'monospace', marginBottom: 4, textDecorationLine: 'underline' },
    docLinkText: { color: t.colors.accent, fontSize: 13, fontFamily: 'monospace', fontWeight: '600', textDecorationLine: 'none' },
    mutedText: { color: t.colors.muted, fontSize: 11, fontFamily: 'monospace', marginBottom: 4 },
    sourceText: { color: t.colors.placeholder, fontSize: 10, fontFamily: 'monospace', marginBottom: 4 },
    pipelineText: { color: t.colors.text, fontSize: 12, fontFamily: 'monospace', marginBottom: 4 },
    pipelineLinkText: { color: t.colors.accent, fontWeight: '600', textDecorationLine: 'underline' },
    resultRow: { flexDirection: 'row', gap: t.spacing.sm, marginBottom: 4, alignItems: 'center' },
    resultText: { color: t.colors.muted, fontSize: 12 },
    nothingNew: { color: t.colors.placeholder, fontSize: 11, fontStyle: 'italic' },
    errorText: { color: t.colors.error, fontSize: 12, marginTop: 4, marginBottom: 4, lineHeight: 17 },
    attemptsText: { color: t.colors.placeholder, fontSize: 11, marginBottom: 4 },
    retryBtn: { alignSelf: 'flex-start', marginTop: t.spacing.sm, backgroundColor: t.colors.accent, borderRadius: t.radius.sm, paddingHorizontal: t.spacing.md, paddingVertical: 5, minWidth: 64, alignItems: 'center' },
    retryBtnPressed: { opacity: 0.75 },
    retryBtnText: { color: t.colors.background, fontSize: 12, fontWeight: '700' },
    queuePipelinesBtn: { alignSelf: 'flex-start', marginTop: t.spacing.sm, borderWidth: 1, borderColor: '#a78bfa', borderRadius: t.radius.sm, paddingHorizontal: t.spacing.md, paddingVertical: 5, minWidth: 120, alignItems: 'center' },
    queuePipelinesBtnPressed: { opacity: 0.6 },
    queuePipelinesBtnText: { color: '#a78bfa', fontSize: 12, fontWeight: '600', fontFamily: 'monospace' },
    pausedActions: { flexDirection: 'row', gap: t.spacing.sm, marginTop: t.spacing.sm },
    resumeBtn: { backgroundColor: '#a78bfa', borderRadius: t.radius.sm, paddingHorizontal: t.spacing.md, paddingVertical: 5, minWidth: 72, alignItems: 'center' },
    resumeBtnPressed: { opacity: 0.75 },
    resumeBtnText: { color: '#0b0b0c', fontSize: 12, fontWeight: '700' },
    deletePausedBtn: { borderWidth: 1, borderColor: t.colors.error, borderRadius: t.radius.sm, paddingHorizontal: t.spacing.md, paddingVertical: 5, minWidth: 64, alignItems: 'center' },
    deletePausedBtnPressed: { opacity: 0.75 },
    deletePausedBtnText: { color: t.colors.error, fontSize: 12, fontWeight: '600' },
    bulkActions: { flexDirection: 'column', alignItems: 'flex-end' },
    bulkRow: { flexDirection: 'row', alignItems: 'center' },
    resumeAllBtnText: { color: '#a78bfa', fontSize: 12, fontFamily: 'monospace', fontWeight: '600' },
    clearQueueBtnText: { color: '#facc15', fontSize: 12, fontFamily: 'monospace', fontWeight: '600' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    reloadBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    reloadText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl, maxWidth: 800, alignSelf: 'center', width: '100%' },
    emptyText: { color: t.colors.muted, fontSize: 15 },
    footerSpinner: { paddingVertical: 16, alignItems: 'center' },
  })
}
