import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, ActivityIndicator, Alert, useWindowDimensions } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useRouter } from 'expo-router'
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable'
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { useConnection } from '../../src/ConnectionContext'
import { fetchHighlights, deleteHighlight, pinHighlight, archiveHighlight, createAnnotation, HighlightWithDoc } from '../../src/api'
import HighlightCard from '../../src/HighlightCard'
import TagSelectorModal from '../../src/TagSelectorModal'
import AnnotationPanel from '../../src/AnnotationPanel'
import LinkActionSheet from '../../src/LinkActionSheet'
import { useScrapeQueue } from '../../src/ScrapeQueueContext'

export default function FeedScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { activeUrl, token, status } = useConnection()
  const { height: windowHeight } = useWindowDimensions()
  const { startScrape } = useScrapeQueue()

  const [linkUrl, setLinkUrl] = useState<string | null>(null)

  const [highlights, setHighlights] = useState<HighlightWithDoc[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tagModalId, setTagModalId] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set())
  const [annotateItem, setAnnotateItem] = useState<HighlightWithDoc | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())

  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set())

  const handleUnarchive = useCallback(async (id: string) => {
    if (!activeUrl || !token) return
    setArchivedIds(prev => { const s = new Set(prev); s.delete(id); return s })
    archiveHighlight(activeUrl, token, id, null).catch(() => {})
  }, [activeUrl, token])

  const swipeRefs = useRef<Map<string, SwipeableMethods | null>>(new Map())
  const deleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // scroll-to-archive tracking
  const scrollYRef = useRef(0)
  const itemFirstSeenYRef = useRef<Map<string, number>>(new Map())
  const pendingArchiveRef = useRef<Map<string, number>>(new Map())
  const activeUrlRef = useRef(activeUrl)
  const tokenRef = useRef(token)
  useEffect(() => { activeUrlRef.current = activeUrl }, [activeUrl])
  useEffect(() => { tokenRef.current = token }, [token])

  const viewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 30 }), [])
  const onViewableItemsChanged = useCallback(({ changed }: { changed: Array<{ item: HighlightWithDoc; isViewable: boolean }> }) => {
    const currentY = scrollYRef.current
    changed.forEach(({ item, isViewable }) => {
      if (isViewable) {
        itemFirstSeenYRef.current.set(item.id, currentY)
        pendingArchiveRef.current.delete(item.id)
      } else {
        const seenY = itemFirstSeenYRef.current.get(item.id)
        itemFirstSeenYRef.current.delete(item.id)
        // scrolled down past it (not pinned) — queue for 300px-later archive
        if (seenY !== undefined && currentY > seenY && !item.pinned) {
          pendingArchiveRef.current.set(item.id, currentY)
        }
      }
    })
  }, [])

  useEffect(() => {
    const timers = deleteTimers.current
    return () => { timers.forEach(t => clearTimeout(t)) }
  }, [])

  const load = useCallback(async () => {
    if (!activeUrl || !token) return
    setLoading(true)
    setError(null)
    try {
      const data = await fetchHighlights(activeUrl, token, 200)
      setHighlights(data)
    } catch {
      setError('Failed to load highlights')
    } finally {
      setLoading(false)
    }
  }, [activeUrl, token])

  useEffect(() => {
    if (status === 'connected') load()
  }, [status, load])

  const handlePin = useCallback(async (item: HighlightWithDoc) => {
    if (!activeUrl || !token) return
    const next = item.pinned === 1 ? false : true
    setActionLoading(prev => new Set(prev).add(item.id))
    try {
      await pinHighlight(activeUrl, token, item.id, next)
      setHighlights(prev =>
        prev.map(h => h.id === item.id ? { ...h, pinned: next ? 1 : 0 } : h)
      )
    } catch {
      Alert.alert('Error', 'Failed to update pin')
    } finally {
      setActionLoading(prev => { const s = new Set(prev); s.delete(item.id); return s })
    }
  }, [activeUrl, token])

  const initiateDelete = useCallback((item: HighlightWithDoc) => {
    if (!activeUrl || !token) return
    setDeletingIds(prev => new Set(prev).add(item.id))
    const timer = setTimeout(async () => {
      deleteTimers.current.delete(item.id)
      try {
        await deleteHighlight(activeUrl, token, item.id)
      } catch {
        // best-effort; remove from list either way
      }
      setHighlights(prev => prev.filter(h => h.id !== item.id))
      setDeletingIds(prev => { const s = new Set(prev); s.delete(item.id); return s })
    }, 5000)
    deleteTimers.current.set(item.id, timer)
  }, [activeUrl, token])

  const undoDelete = useCallback((id: string) => {
    const timer = deleteTimers.current.get(id)
    if (timer) clearTimeout(timer)
    deleteTimers.current.delete(id)
    setDeletingIds(prev => { const s = new Set(prev); s.delete(id); return s })
  }, [])

  const handleAnnotateSave = useCallback(async ({ note, color }: { note: string; color: string }) => {
    if (!activeUrl || !token || !annotateItem) return
    try {
      await createAnnotation(activeUrl, token, annotateItem.document_id, {
        exact: annotateItem.body.slice(0, 300),
        prefix: '',
        suffix: '',
        pos_start: 0,
        pos_end: 0,
        note,
        color,
        highlight_id: annotateItem.id,
      })
      setAnnotateItem(null)
    } catch {
      Alert.alert('Error', 'Failed to save annotation')
    }
  }, [activeUrl, token, annotateItem])

  const renderItem = useCallback(({ item }: { item: HighlightWithDoc }) => {
    const isArchived = archivedIds.has(item.id)
    if (deletingIds.has(item.id)) {
      return (
        <View style={s.deletedCard}>
          <Text style={s.deletedTitle} numberOfLines={1}>
            {item.title || item.document_title || item.document_url}
          </Text>
          <Text style={s.deletedLabel}>deleted</Text>
          <Pressable style={s.undoBtn} onPress={() => undoDelete(item.id)}>
            <Text style={s.undoBtnText}>Undo</Text>
          </Pressable>
        </View>
      )
    }

    const busy = actionLoading.has(item.id)
    const isPinned = item.pinned === 1

    const handleSwipeOpen = (direction: string) => {
      const ref = swipeRefs.current.get(item.id)
      ref?.close()
      if (direction === 'right') {
        initiateDelete(item)
      } else {
        handlePin(item)
      }
    }

    const card = (
      <HighlightCard
        item={item}
        linkedDocuments={item.linked_documents}
        pinned={isPinned}
        busy={busy}
        onPress={() => router.push(`/document/${item.document_id}?from=/`)}
        onPin={() => handlePin(item)}
        onDelete={() => initiateDelete(item)}
        onAnnotate={() => setAnnotateItem(item)}
        onTags={() => setTagModalId(item.id)}
        onDocumentPress={(docId) => router.push(`/document/${encodeURIComponent(docId)}?from=/`)}
        onLinkAction={(url) => setLinkUrl(url)}
      />
    )

    const unarchiveBtn = isArchived ? (
      <Pressable style={s.unarchiveBtn} onPress={() => handleUnarchive(item.id)} hitSlop={8}>
        <Text style={s.unarchiveBtnText}>Unread</Text>
      </Pressable>
    ) : null

    return (
      <View style={s.cardWrapper}>
        <ReanimatedSwipeable
          ref={(r) => {
            if (r) swipeRefs.current.set(item.id, r)
            else swipeRefs.current.delete(item.id)
          }}
          containerStyle={[s.swipeContainer, isArchived && s.archivedContainer]}
          renderLeftActions={() => (
            <View style={s.deleteAction}>
              <Text style={s.swipeIcon}>🗑</Text>
              <Text style={s.swipeLabel}>Delete</Text>
            </View>
          )}
          renderRightActions={() => (
            <View style={[s.starAction, isPinned && s.starActionActive]}>
              <Text style={s.swipeIcon}>{isPinned ? '★' : '☆'}</Text>
              <Text style={s.swipeLabel}>{isPinned ? 'Unpin' : 'Star'}</Text>
            </View>
          )}
          overshootLeft={false}
          overshootRight={false}
          onSwipeableOpen={handleSwipeOpen}
        >
          {card}
        </ReanimatedSwipeable>
        {unarchiveBtn}
      </View>
    )
  }, [actionLoading, archivedIds, deletingIds, handlePin, handleUnarchive, initiateDelete, undoDelete, router, s])

  if (loading && highlights.length === 0) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    )
  }

  if (error) {
    return (
      <View style={s.center}>
        <Text style={s.errorText}>{error}</Text>
        <Pressable style={s.retryBtn} onPress={load}>
          <Text style={s.retryText}>Retry</Text>
        </Pressable>
      </View>
    )
  }

  if (!loading && highlights.length === 0) {
    return (
      <View style={s.center}>
        <Text style={s.placeholder}>No highlights yet.</Text>
        <Text style={s.hint}>Run a pipeline on a document to generate highlights.</Text>
      </View>
    )
  }

  return (
    <>
      <FlatList
        style={s.list}
        contentContainerStyle={s.listContent}
        data={highlights}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        onRefresh={load}
        refreshing={loading}
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y
          scrollYRef.current = y
          pendingArchiveRef.current.forEach((exitY, id) => {
            if (y - exitY > 300) {
              pendingArchiveRef.current.delete(id)
              setArchivedIds(prev => new Set(prev).add(id))
              const url = activeUrlRef.current
              const tok = tokenRef.current
              if (url && tok) archiveHighlight(url, tok, id).catch(() => {})
            }
          })
        }}
        scrollEventThrottle={16}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        ListFooterComponent={
          <View style={[s.footerSpacer, { height: windowHeight }]}>
            <Text style={s.footerHint}>Scroll past to clear the feed</Text>
          </View>
        }
      />
      <TagSelectorModal
        visible={tagModalId !== null}
        objectId={tagModalId ?? ''}
        objectType="highlight"
        onClose={() => setTagModalId(null)}
      />
      <AnnotationPanel
        visible={annotateItem !== null}
        mode="create"
        onSave={handleAnnotateSave}
        onCancel={() => setAnnotateItem(null)}
      />
      <LinkActionSheet
        url={linkUrl}
        onReadAsDocument={(url) => {
          let title = url
          try { title = new URL(url).hostname } catch { /* keep url */ }
          startScrape(url, title)
        }}
        onClose={() => setLinkUrl(null)}
      />
    </>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    list: { flex: 1, backgroundColor: t.colors.background },
    listContent: { padding: 12, gap: 12, maxWidth: 800, alignSelf: 'center', width: '100%' },
    center: { flex: 1, backgroundColor: t.colors.background, justifyContent: 'center', alignItems: 'center', gap: 12 },
    cardWrapper: { position: 'relative' },
    swipeContainer: {
      borderRadius: 10,
      overflow: 'hidden',
    },
    archivedWrapper: {
      position: 'relative',
      opacity: 0.45,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: t.colors.border,
      borderRadius: 10,
    },
    archivedContainer: {
      opacity: 0.45,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: t.colors.border,
      borderRadius: 10,
    },
    unarchiveBtn: {
      position: 'absolute',
      top: 8,
      right: 8,
      backgroundColor: t.colors.accent,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
      zIndex: 10,
    },
    unarchiveBtnText: { color: '#fff', fontSize: 11, fontWeight: '700' },
    deleteAction: {
      width: 80,
      backgroundColor: '#ef4444',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
    },
    starAction: {
      width: 80,
      backgroundColor: '#ca8a04',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
    },
    starActionActive: { backgroundColor: t.colors.accent },
    swipeIcon: { fontSize: 20 },
    swipeLabel: { color: '#fff', fontSize: 11, fontWeight: '700' },
    deletedCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.colors.surface,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: t.colors.border,
      opacity: 0.5,
      gap: 8,
    },
    deletedTitle: { flex: 1, color: t.colors.muted, fontSize: 13, fontStyle: 'italic' },
    deletedLabel: { color: t.colors.muted, fontSize: 11 },
    undoBtn: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 6,
      backgroundColor: t.colors.background,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    undoBtnText: { color: t.colors.accent, fontSize: 12, fontWeight: '700' },
    footerSpacer: { alignItems: 'center', paddingTop: 24 },
    footerHint: { color: t.colors.muted, fontSize: 13, opacity: 0.5 },
    placeholder: { color: t.colors.muted, fontSize: 16 },
    hint: { color: t.colors.muted, fontSize: 13, opacity: 0.6 },
    errorText: { color: '#ff6b6b', fontSize: 15 },
    retryBtn: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: t.colors.accent, borderRadius: 6 },
    retryText: { color: '#fff', fontWeight: '600' },
  })
}
