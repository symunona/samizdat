import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Link, useLocalSearchParams } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { submitScrapeJob, deleteDocument, fetchPipelineDocuments, fetchJobs } from '../../src/api'
import type { Document, Job } from '../../src/api'
import { useConnection } from '../../src/ConnectionContext'
import { useDocuments, useSyncStatus } from '../../src/store/hooks'
import { useShareStore } from '../../src/store/shareStore'
import { forceSync, requestSync } from '../../src/store/syncEngine'

function jobUrl(job: Job): string {
  try {
    return (JSON.parse(job.payload || '{}') as { url?: string }).url ?? ''
  } catch {
    return ''
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

export default function DocumentsScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { status, error: connError, activeUrl, token, probe } = useConnection()
  const { feed_id: feedIdParam, pipeline_id: pipelineIdParam } = useLocalSearchParams<{ feed_id?: string; pipeline_id?: string }>()

  const allDocuments = useDocuments()
  const { status: syncStatus } = useSyncStatus()
  const [refreshing, setRefreshing] = useState(false)
  const [pipelineDocs, setPipelineDocs] = useState<Document[] | null>(null)
  const [pipelineDocsLoading, setPipelineDocsLoading] = useState(false)

  // ids being deleted (optimistically hidden from list while waiting for server)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set())
  const [pendingDeletes, setPendingDeletes] = useState<Record<string, { doc: Document; countdown: number }>>({})
  const pendingTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({})

  // Load pipeline-filtered docs from server when pipeline_id param is set
  useEffect(() => {
    if (!pipelineIdParam || !activeUrl || !token) return
    setPipelineDocsLoading(true)
    fetchPipelineDocuments(activeUrl, token, pipelineIdParam)
      .then(data => setPipelineDocs(data))
      .catch(() => setPipelineDocs([]))
      .finally(() => setPipelineDocsLoading(false))
  }, [pipelineIdParam, activeUrl, token])

  const documents = useMemo(() => {
    if (pipelineIdParam) {
      return (pipelineDocs ?? []).filter(d => !pendingDeleteIds.has(d.id))
    }
    let docs = allDocuments.filter((d) => !pendingDeleteIds.has(d.id))
    if (feedIdParam) {
      docs = docs.filter(d => d.source_feed_id === feedIdParam)
    }
    return docs
  }, [allDocuments, pendingDeleteIds, feedIdParam, pipelineIdParam, pipelineDocs])

  const startDelete = useCallback(
    (doc: Document) => {
      // item stays visible as placeholder — pendingDeleteIds untouched until real delete fires
      setPendingDeletes((prev) => ({ ...prev, [doc.id]: { doc, countdown: 5 } }))

      const tick = setInterval(() => {
        setPendingDeletes((prev) => {
          const entry = prev[doc.id]
          if (!entry || entry.countdown <= 1) return prev
          return { ...prev, [doc.id]: { ...entry, countdown: entry.countdown - 1 } }
        })
      }, 1000)
      pendingTimers.current[doc.id] = tick

      setTimeout(async () => {
        clearInterval(tick)
        delete pendingTimers.current[doc.id]
        setPendingDeletes((prev) => {
          const next = { ...prev }
          delete next[doc.id]
          return next
        })
        if (!activeUrl || !token) return
        // hide immediately as real delete fires
        setPendingDeleteIds((prev) => new Set([...prev, doc.id]))
        try {
          await deleteDocument(activeUrl, token, doc.id)
          // trigger sync so store gets the tombstone
          requestSync(activeUrl, token)
        } catch {
          // restore on failure
          setPendingDeleteIds((prev) => { const s = new Set(prev); s.delete(doc.id); return s })
        }
      }, 5000)
    },
    [activeUrl, token],
  )

  const undoDelete = useCallback(
    (id: string) => {
      clearInterval(pendingTimers.current[id])
      delete pendingTimers.current[id]
      setPendingDeletes((prev) => { const next = { ...prev }; delete next[id]; return next })
      setPendingDeleteIds((prev) => { const s = new Set(prev); s.delete(id); return s })
    },
    [],
  )

  const [urlInput, setUrlInput] = useState('')
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'error'>('idle')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const urlInputRef = useRef<TextInput>(null)

  // A shared link (Android share sheet → ShareIntentBridge) arrives via the
  // one-shot share store: fill the Add-URL box and focus it so the user just
  // taps Add. `consume` clears the store, so a normal later visit won't re-fill
  // and a fresh share re-fires.
  const pendingShareUrl = useShareStore((st) => st.pendingUrl)
  const consumeShare = useShareStore((st) => st.consume)
  useEffect(() => {
    if (!pendingShareUrl) return
    const url = consumeShare()
    if (!url) return
    setUrlInput(url)
    const t = setTimeout(() => urlInputRef.current?.focus(), 120)
    return () => clearTimeout(t)
  }, [pendingShareUrl, consumeShare])

  // Queued / running scrape jobs, shown as pinned rows above the document list.
  const [pendingJobs, setPendingJobs] = useState<Job[]>([])
  const showPending = !pipelineIdParam && !feedIdParam

  const loadPendingJobs = useCallback(async () => {
    if (!activeUrl || !token) return
    try {
      const [running, queued] = await Promise.all([
        fetchJobs(activeUrl, token, { status: 'running', kind: 'scrape_url' }),
        fetchJobs(activeUrl, token, { status: 'queued', kind: 'scrape_url' }),
      ])
      setPendingJobs([...running, ...queued])
    } catch {
      // transient — keep current state, next poll retries
    }
  }, [activeUrl, token])

  // Cheap background poll so externally-added jobs (e.g. from the clipper)
  // surface without a reload: slow when idle, faster while jobs are pending.
  useEffect(() => {
    if (status !== 'connected' || !showPending) return
    loadPendingJobs()
    const id = setInterval(loadPendingJobs, pendingJobs.length > 0 ? 3000 : 10000)
    return () => clearInterval(id)
  }, [status, showPending, pendingJobs.length, loadPendingJobs])

  async function handleSubmitUrl() {
    if (!activeUrl || !token) return
    const trimmed = urlInput.trim()
    if (!trimmed) return
    setSubmitState('submitting')
    setSubmitError(null)
    try {
      const { job_id } = await submitScrapeJob(activeUrl, token, trimmed)
      setUrlInput('')
      setSubmitState('idle')
      // Show the URL immediately, before the poll round-trips.
      const now = new Date().toISOString()
      const optimistic: Job = {
        id: job_id, kind: 'scrape_url', payload: JSON.stringify({ url: trimmed }),
        status: 'queued', attempts: 0, run_after: now, last_error: '', result: '',
        duration_ms: 0, created_at: now, updated_at: now, parent_job_id: null,
      }
      setPendingJobs((prev) => [optimistic, ...prev.filter((j) => j.id !== job_id)])
      loadPendingJobs()
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : 'Failed to queue job')
      setSubmitState('error')
    }
  }

  async function handleRefresh() {
    if (!activeUrl || !token) return
    setRefreshing(true)
    try {
      await forceSync(activeUrl, token)
    } finally {
      setRefreshing(false)
    }
  }

  function renderPendingHeader() {
    if (!showPending || pendingJobs.length === 0) return null
    return (
      <View style={s.pendingSection}>
        {pendingJobs.map((job) => {
          const url = jobUrl(job)
          return (
            <View key={job.id} style={s.pendingRow}>
              <ActivityIndicator size="small" color={theme.colors.accent} />
              <View style={s.pendingBody}>
                <Text style={s.pendingUrl} numberOfLines={1}>{url || '(queued URL)'}</Text>
                <Text style={s.pendingLabel}>{job.status === 'running' ? 'Reading…' : 'Queued'}</Text>
              </View>
            </View>
          )
        })}
      </View>
    )
  }

  function renderItem({ item }: { item: Document }) {
    const displayTitle = item.title?.trim() ? item.title : item.canonical_url
    const pending = pendingDeletes[item.id]

    if (pending) {
      return (
        <View style={[s.itemRow, s.itemRowDeleted]}>
          <View style={[s.item, s.itemDeletedContent]}>
            <Text style={[s.itemTitle, s.itemTitleDeleted]} numberOfLines={2}>{displayTitle}</Text>
            <Text style={[s.itemUrl, s.itemDeletedMuted]} numberOfLines={1}>{item.canonical_url}</Text>
            <Text style={[s.itemDate, s.itemDeletedMuted]}>Fetched {formatDate(item.fetched_at)}</Text>
          </View>
          <Pressable
            style={({ pressed }) => [s.undoBtnInline, pressed && s.undoBtnInlinePressed]}
            onPress={() => undoDelete(item.id)}
            hitSlop={8}
          >
            <Text style={s.undoBtnInlineText}>Undo ({pending.countdown}s)</Text>
          </Pressable>
        </View>
      )
    }

    return (
      <View style={s.itemRow}>
        <Link href={`/document/${item.id}?from=/documents`} style={s.item}>
          <Text style={s.itemTitle} numberOfLines={2}>{displayTitle}</Text>
          <Text style={s.itemUrl} numberOfLines={1}>{item.canonical_url}</Text>
          <Text style={s.itemDate}>Fetched {formatDate(item.fetched_at)}</Text>
          {((item.highlight_count && item.highlight_count > 0) || (item.annotation_count && item.annotation_count > 0)) ? (
            <View style={s.badgeRow}>
              {item.highlight_count && item.highlight_count > 0 ? (
                <Text style={s.hlBadge}>◆ {item.highlight_count} highlight{item.highlight_count > 1 ? 's' : ''}</Text>
              ) : null}
              {item.annotation_count && item.annotation_count > 0 ? (
                <Text style={s.annBadge}>✏ {item.annotation_count} annotation{item.annotation_count > 1 ? 's' : ''}</Text>
              ) : null}
            </View>
          ) : null}
        </Link>
        <Pressable
          style={({ pressed }) => [s.deleteBtn, pressed && s.deleteBtnPressed]}
          onPress={() => startDelete(item)}
          hitSlop={8}
        >
          <Text style={s.deleteBtnText}>✕</Text>
        </Pressable>
      </View>
    )
  }

  if (status === 'loading') {
    return (
      <SafeAreaView style={s.screen}>
        <ActivityIndicator color={theme.colors.accent} size="large" />
      </SafeAreaView>
    )
  }

  if (status === 'disconnected' && connError) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.centered}>
          <Text style={s.errorText}>{connError}</Text>
          <Pressable onPress={probe} style={s.retryBtn}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.wrapper}>
      {/* URL submit row */}
      <View style={s.addRow}>
        <TextInput
          ref={urlInputRef}
          style={s.urlInputField}
          placeholder="https://example.com/article"
          placeholderTextColor={theme.colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={urlInput}
          onChangeText={setUrlInput}
          onSubmitEditing={handleSubmitUrl}
          returnKeyType="send"
        />
        <Pressable
          style={({ pressed }) => [
            s.addButton,
            submitState === 'submitting' && s.addButtonDisabled,
            pressed && s.addButtonPressed,
          ]}
          onPress={handleSubmitUrl}
          disabled={submitState === 'submitting'}
        >
          {submitState === 'submitting' ? (
            <ActivityIndicator color={theme.colors.background} size="small" />
          ) : (
            <Text style={s.addButtonText}>Add URL</Text>
          )}
        </Pressable>
      </View>

      {/* Feedback row */}
      {submitState === 'error' && submitError && (
        <View style={s.feedbackRow}>
          <Text style={s.feedbackError}>{submitError}</Text>
        </View>
      )}

      {/* Filter indicator */}
      {(feedIdParam || pipelineIdParam) && (
        <View style={s.filterBar}>
          <Text style={s.filterBarText}>
            {pipelineIdParam ? `pipeline: ${pipelineIdParam.slice(0, 8)}…` : `feed: ${feedIdParam?.slice(0, 8)}…`}
          </Text>
        </View>
      )}

      {/* Document list */}
      {(pipelineIdParam && pipelineDocsLoading) ? (
        <View style={s.centered}>
          <ActivityIndicator color={theme.colors.accent} size="large" />
        </View>
      ) : syncStatus === 'syncing' && documents.length === 0 && pendingJobs.length === 0 ? (
        <View style={s.centered}>
          <ActivityIndicator color={theme.colors.accent} size="large" />
        </View>
      ) : (
        <FlatList
          data={documents}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListHeaderComponent={renderPendingHeader()}
          contentContainerStyle={documents.length === 0 ? s.emptyContainer : s.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.accent}
            />
          }
          ListEmptyComponent={
            <Text style={s.emptyText}>No documents yet. Add a URL above.</Text>
          }
          ItemSeparatorComponent={() => <View style={s.separator} />}
        />
      )}
      </View>
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    wrapper: { flex: 1, maxWidth: 800, alignSelf: 'center', width: '100%' },
    addRow: {
      flexDirection: 'row',
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      gap: t.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
      backgroundColor: t.colors.surface,
    },
    urlInputField: {
      flex: 1,
      backgroundColor: t.colors.background,
      color: t.colors.text,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      fontSize: 14,
    },
    addButton: {
      backgroundColor: t.colors.accent,
      borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      justifyContent: 'center',
      alignItems: 'center',
      minWidth: 80,
    },
    addButtonDisabled: { opacity: 0.6 },
    addButtonPressed: { opacity: 0.85 },
    addButtonText: { color: t.colors.background, fontSize: 14, fontWeight: '700' },
    filterBar: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.xs,
      backgroundColor: t.colors.accent + '22',
      borderBottomWidth: 1,
      borderBottomColor: t.colors.accent + '55',
    },
    filterBarText: { color: t.colors.accent, fontSize: 12, fontFamily: 'monospace', fontWeight: '600' },
    feedbackRow: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.xs,
      backgroundColor: t.colors.surface,
    },
    feedbackError: { color: t.colors.error, fontSize: 13 },
    pendingSection: {
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
    },
    pendingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      backgroundColor: t.colors.accent + '14',
    },
    pendingBody: { flex: 1, minWidth: 0 },
    pendingUrl: { color: t.colors.text, fontSize: 12, fontFamily: 'monospace' },
    pendingLabel: { color: t.colors.muted, fontSize: 11, marginTop: 1 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errorText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    listContent: { paddingVertical: t.spacing.xs, maxWidth: 800, alignSelf: 'center', width: '100%' },
    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl, maxWidth: 800, alignSelf: 'center', width: '100%' },
    emptyText: { color: t.colors.muted, fontSize: 15, textAlign: 'center' },
    separator: { height: 1, backgroundColor: t.colors.border, marginLeft: t.spacing.md },
    item: {
      flex: 1,
      flexShrink: 1,
      minWidth: 0,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.md,
      backgroundColor: t.colors.background,
      display: 'flex',
      flexDirection: 'column',
      textDecorationLine: 'none',
    },
    itemTitle: { color: t.colors.text, fontSize: 15, fontWeight: '600', lineHeight: 20, marginBottom: 2 },
    itemUrl: { color: t.colors.muted, fontSize: 12, fontFamily: 'monospace', marginBottom: 2 },
    itemDate: { color: t.colors.placeholder, fontSize: 11 },
    badgeRow: { flexDirection: 'row', gap: 8, marginTop: 2 },
    annBadge: { color: '#e8743b', fontSize: 11, fontWeight: '600' },
    hlBadge: { color: '#7dd3fc', fontSize: 11, fontWeight: '600' },
    itemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.colors.background,
      overflow: 'hidden',
    },
    deleteBtn: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.md,
      justifyContent: 'center',
      alignItems: 'center',
      flexShrink: 0,
    },
    deleteBtnPressed: { opacity: 0.5 },
    deleteBtnText: { color: t.colors.muted, fontSize: 16, fontWeight: '400' },
    itemRowDeleted: { backgroundColor: t.colors.surface, opacity: 0.7 },
    itemDeletedContent: {
      flex: 1,
      flexShrink: 1,
      minWidth: 0,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.md,
      display: 'flex',
      flexDirection: 'column',
    },
    itemTitleDeleted: { color: t.colors.muted, fontSize: 15, fontWeight: '600', lineHeight: 20, marginBottom: 2, textDecorationLine: 'line-through' },
    itemDeletedMuted: { color: t.colors.placeholder },
    undoBtnInline: {
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.md,
      justifyContent: 'center',
      alignItems: 'center',
      flexShrink: 0,
      backgroundColor: '#e8743b',
      marginRight: t.spacing.sm,
      borderRadius: t.radius.sm,
      minWidth: 72,
    },
    undoBtnInlinePressed: { opacity: 0.75 },
    undoBtnInlineText: { color: '#fff', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  })
}
