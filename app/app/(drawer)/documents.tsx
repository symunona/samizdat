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
import { submitScrapeJob, deleteDocument, fetchPipelineDocuments } from '../../src/api'
import type { Document } from '../../src/api'
import { useConnection } from '../../src/ConnectionContext'
import { useDocuments, useSyncStatus } from '../../src/store/hooks'
import { forceSync, requestSync } from '../../src/store/syncEngine'

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
      setPendingDeleteIds((prev) => new Set([...prev, doc.id]))
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
        if (!activeUrl || !token) {
          setPendingDeleteIds((prev) => { const s = new Set(prev); s.delete(doc.id); return s })
          return
        }
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
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'queued' | 'error'>('idle')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const queuedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function handleSubmitUrl() {
    if (!activeUrl || !token) return
    const trimmed = urlInput.trim()
    if (!trimmed) return
    setSubmitState('submitting')
    setSubmitError(null)
    try {
      await submitScrapeJob(activeUrl, token, trimmed)
      setUrlInput('')
      setSubmitState('queued')
      if (queuedTimerRef.current) clearTimeout(queuedTimerRef.current)
      queuedTimerRef.current = setTimeout(() => setSubmitState('idle'), 3000)
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

  function renderItem({ item }: { item: Document }) {
    const displayTitle = item.title?.trim() ? item.title : item.canonical_url
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
                <Text style={s.annBadge}>● {item.annotation_count} annotation{item.annotation_count > 1 ? 's' : ''}</Text>
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
      {/* URL submit row */}
      <View style={s.addRow}>
        <TextInput
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
      {submitState === 'queued' && (
        <View style={s.feedbackRow}>
          <Text style={s.feedbackQueued}>Queued!</Text>
        </View>
      )}
      {submitState === 'error' && submitError && (
        <View style={s.feedbackRow}>
          <Text style={s.feedbackError}>{submitError}</Text>
        </View>
      )}

      {/* Undo delete toasts */}
      {Object.entries(pendingDeletes).map(([id, { doc, countdown }]) => {
        const title = doc.title?.trim() ? doc.title : doc.canonical_url
        return (
          <View key={id} style={s.undoRow}>
            <Text style={s.undoText} numberOfLines={1}>Deleted: {title}</Text>
            <Pressable
              style={({ pressed }) => [s.undoBtn, pressed && s.undoBtnPressed]}
              onPress={() => undoDelete(id)}
            >
              <Text style={s.undoBtnText}>Undo ({countdown}s)</Text>
            </Pressable>
          </View>
        )
      })}

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
      ) : syncStatus === 'syncing' && documents.length === 0 ? (
        <View style={s.centered}>
          <ActivityIndicator color={theme.colors.accent} size="large" />
        </View>
      ) : (
        <FlatList
          data={documents}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
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
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
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
    feedbackQueued: { color: t.colors.online, fontSize: 13, fontWeight: '600' },
    feedbackError: { color: t.colors.error, fontSize: 13 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errorText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    listContent: { paddingVertical: t.spacing.xs },
    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
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
    undoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      backgroundColor: '#2a1a0e',
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
    },
    undoText: { color: '#f5c28a', fontSize: 13, flex: 1, marginRight: t.spacing.sm },
    undoBtn: {
      backgroundColor: '#e8743b',
      borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: 4,
    },
    undoBtnPressed: { opacity: 0.75 },
    undoBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  })
}
