import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, Alert, Platform, useWindowDimensions } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useRouter, useNavigation } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable'
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { useConnection } from '../../src/ConnectionContext'
import { fetchHighlights, fetchSettings, updateSettings, HighlightWithDoc } from '../../src/api'
import * as db from '../../src/db'
import HighlightCard from '../../src/HighlightCard'
import IconButton from '../../src/IconButton'
import TagSelectorModal from '../../src/TagSelectorModal'
import AnnotationPanel from '../../src/AnnotationPanel'
import LinkActionSheet from '../../src/LinkActionSheet'
import AddUrlSheet from '../../src/AddUrlSheet'
import { useScrapeQueue } from '../../src/ScrapeQueueContext'
import FeedSkeleton from '../../src/FeedSkeleton'

// Horizontal travel (px) before a left/right swipe activates. RNGH's default is 10,
// which lets a mostly-vertical diagonal drag hijack the scroll into a swipe. Widening
// it makes vertical scroll the default: the FlatList's native scroll claims a vertical
// drag first (lower threshold), so a swipe only fires on a deliberately horizontal pull.
// (ReanimatedSwipeable doesn't expose failOffsetY, so this threshold is the only lever.)
const SWIPE_DRAG_OFFSET = 36

export default function FeedScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const navigation = useNavigation()
  const { activeUrl, token, status } = useConnection()
  const { status: syncStatus, lastSyncedAt } = db.useSyncStatus()
  const { height: windowHeight } = useWindowDimensions()
  const { startScrape, resolvedDocs } = useScrapeQueue()

  const [linkUrl, setLinkUrl] = useState<string | null>(null)
  const [addUrlOpen, setAddUrlOpen] = useState(false)

  const [highlights, setHighlights] = useState<HighlightWithDoc[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tagModalId, setTagModalId] = useState<string | null>(null)
  const [annotateItem, setAnnotateItem] = useState<HighlightWithDoc | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())

  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set())
  const [showUnreadAll, setShowUnreadAll] = useState(false)

  // Sticky "auto mark as read" toggle (server-persisted user prop). Gates the
  // scroll-past auto-archive below. Default true (preserves prior always-on).
  const [autoMarkRead, setAutoMarkRead] = useState(true)

  useEffect(() => {
    if (status !== 'connected' || !activeUrl || !token) return
    fetchSettings(activeUrl, token)
      .then(cfg => setAutoMarkRead(cfg.auto_mark_read))
      .catch(() => {})
  }, [status, activeUrl, token])

  const toggleAutoMarkRead = useCallback(() => {
    if (!activeUrl || !token) return
    const next = !autoMarkRead
    setAutoMarkRead(next) // optimistic
    updateSettings(activeUrl, token, { auto_mark_read: next }).catch(() => {
      setAutoMarkRead(!next) // revert on failure
      Alert.alert('Error', 'Failed to update setting')
    })
  }, [activeUrl, token, autoMarkRead])

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={s.headerActions}>
          <IconButton
            name="add"
            onPress={() => setAddUrlOpen(true)}
            size={24}
            color={theme.colors.text}
          />
          <IconButton
            name={autoMarkRead ? 'eye' : 'eye-off-outline'}
            onPress={toggleAutoMarkRead}
            size={22}
            color={autoMarkRead ? theme.colors.accent : theme.colors.muted}
          />
        </View>
      ),
    })
  }, [navigation, autoMarkRead, toggleAutoMarkRead, theme, s])

  const handleUnarchive = useCallback((id: string) => {
    setArchivedIds(prev => { const s = new Set(prev); s.delete(id); return s })
    db.archiveHighlight(id, null)
  }, [])

  const handleUnreadAll = useCallback(() => {
    setShowUnreadAll(false)
    setArchivedIds(prev => {
      prev.forEach(id => db.archiveHighlight(id, null))
      return new Set()
    })
  }, [])

  // fast-scroll detection → reveal bulk-unread escape hatch
  const lastScrollRef = useRef({ y: 0, t: 0 })
  const unreadHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const swipeRefs = useRef<Map<string, SwipeableMethods | null>>(new Map())
  const deleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // Scroll-preservation across a sync-injected prepend. New highlights sort
  // newest-first to the top, so a sync landing mid-read shoves the list down.
  // `maintainVisibleContentPosition` (below) anchors the visible cards on native;
  // web gets the same for free from the browser's overflow-anchor. This flag just
  // gates the scroll-past archive logic off during the resulting programmatic jump
  // so the auto-adjust isn't mistaken for a fast user scroll (see onScroll).
  const preservingScrollRef = useRef(false)
  // scroll-to-archive tracking
  const scrollYRef = useRef(0)
  const itemFirstSeenYRef = useRef<Map<string, number>>(new Map())
  const pendingArchiveRef = useRef<Map<string, number>>(new Map())

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
    return () => {
      timers.forEach(t => clearTimeout(t))
      if (unreadHideTimer.current) clearTimeout(unreadHideTimer.current)
    }
  }, [])

  // Offline fallback: the feed IS the highlights we already synced into the local
  // replica, so render it from the DB layer when the network is unavailable. Returns
  // false when the cache is empty.
  //
  // Read through a ref, not the hook value directly: `loadFromStore` feeds `load`, and a
  // callback that changed identity on every replica write would re-fetch the feed over
  // the network on every star/archive.
  const storeHighlights = db.useFeedHighlights()
  const storeRef = useRef(storeHighlights)
  storeRef.current = storeHighlights
  const loadFromStore = useCallback((): boolean => {
    const hls = storeRef.current
    // Never wipe a populated feed with an empty result (e.g. replica not yet open) —
    // that's the "feed resets to zero" flash.
    if (hls.length > 0) setHighlights(hls)
    return hls.length > 0
  }, [])

  const load = useCallback(async () => {
    if (!activeUrl || !token) { loadFromStore(); return }
    setLoading(true)
    setError(null)
    try {
      const data = await fetchHighlights(activeUrl, token, 200)
      setHighlights(data)
    } catch {
      // Offline / network error — show the cached feed instead of an error screen.
      if (!loadFromStore()) setError('Failed to load highlights')
    } finally {
      setLoading(false)
    }
  }, [activeUrl, token, loadFromStore])

  useEffect(() => {
    if (status === 'connected') load()
  }, [status, load])

  // Offline / not-yet-connected: render the cached feed, and re-render it as the
  // persisted store finishes hydrating or a background sync lands more highlights.
  const hasHydrated = db.useHydrated()
  const storeHlCount = db.useHighlightCount()
  useEffect(() => {
    if (status !== 'connected') loadFromStore()
  }, [status, storeHlCount, loadFromStore])

  // A sync may pull new highlights server-side; re-fetch once it settles so the
  // skeleton resolves to real cards instead of dropping straight to the empty state.
  // If the user has scrolled off the top, arm scroll-preservation: the injected
  // cards prepend and maintainVisibleContentPosition (native) / overflow-anchor (web)
  // shift the offset to hold their place — suppress the archive logic through it, and
  // clear the archive Y-baselines since that shift invalidates them.
  useEffect(() => {
    if (status !== 'connected' || !lastSyncedAt) return
    if (scrollYRef.current > 4) {
      preservingScrollRef.current = true
      pendingArchiveRef.current.clear()
      itemFirstSeenYRef.current.clear()
      setTimeout(() => { preservingScrollRef.current = false }, 1200)
    }
    load()
  }, [lastSyncedAt, status, load])

  // A queued scrape produced a Document — refetch so its highlights land in the feed
  // without a manual pull-to-refresh.
  const resolvedDocCount = Object.keys(resolvedDocs).length
  useEffect(() => {
    if (resolvedDocCount === 0 || status !== 'connected') return
    load()
  }, [resolvedDocCount, status, load])

  // Local-first: patch our list + the store immediately (no await), pusher syncs later.
  const handlePin = useCallback((item: HighlightWithDoc) => {
    const next = item.pinned === 1 ? false : true
    db.pinHighlight(item.id, next)
    setHighlights(prev =>
      prev.map(h => h.id === item.id ? { ...h, pinned: next ? 1 : 0 } : h)
    )
  }, [])

  // Swipe-to-archive. Same state path as the scroll-past auto-archive in onScroll, so
  // the card dims in place and keeps its Unread button — the reversible action gets the
  // easy gesture; delete lives on the footer button.
  const handleArchive = useCallback((id: string) => {
    pendingArchiveRef.current.delete(id)
    setArchivedIds(prev => new Set(prev).add(id))
    db.archiveHighlight(id, new Date().toISOString())
  }, [])

  const initiateDelete = useCallback((item: HighlightWithDoc) => {
    setDeletingIds(prev => new Set(prev).add(item.id))
    const timer = setTimeout(() => {
      deleteTimers.current.delete(item.id)
      db.deleteHighlight(item.id)
      setHighlights(prev => prev.filter(h => h.id !== item.id))
      setDeletingIds(prev => { const s = new Set(prev); s.delete(item.id); return s })
    }, 5000)
    deleteTimers.current.set(item.id, timer)
  }, [])

  const undoDelete = useCallback((id: string) => {
    const timer = deleteTimers.current.get(id)
    if (timer) clearTimeout(timer)
    deleteTimers.current.delete(id)
    setDeletingIds(prev => { const s = new Set(prev); s.delete(id); return s })
  }, [])

  const handleAnnotateSave = useCallback(({ note, color }: { note: string; color: string }) => {
    if (!annotateItem) return
    db.createAnnotation({
      documentId: annotateItem.document_id,
      highlightId: annotateItem.id,
      exact: annotateItem.body.slice(0, 300),
      note,
      color,
    })
    setAnnotateItem(null)
  }, [annotateItem])

  // Stable refs: passed straight into memo(MarkdownBody). Inline arrows here would
  // get a new identity on every scroll-driven re-render, defeating the memo and
  // remounting RN <Image> (visible flicker). Neither closes over `item`.
  const handleDocumentPress = useCallback(
    (docId: string) => router.push(`/document/${encodeURIComponent(docId)}?from=/`),
    [router],
  )
  const handleLinkAction = useCallback((url: string) => setLinkUrl(url), [])

  // Queue a URL for scraping. Shared by the header "+" sheet and the link sheet;
  // the ScrapeQueue overlay owns the pending / ready / failed card.
  const readAsDocument = useCallback((url: string) => {
    let title = url
    try { title = new URL(url).hostname } catch { /* keep url */ }
    startScrape(url, title)
  }, [startScrape])

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

    const isPinned = item.pinned === 1

    // RNGH reports the DRAG direction, not the panel side: dragging the card right
    // ('right') is what reveals renderLeftActions.
    const handleSwipeOpen = (direction: string) => {
      const ref = swipeRefs.current.get(item.id)
      ref?.close()
      if (direction === 'right') {
        handleArchive(item.id)
      } else {
        handlePin(item)
      }
    }

    const card = (
      <HighlightCard
        item={item}
        linkedDocuments={item.linked_documents}
        pinned={isPinned}
        busy={false}
        onPress={() => router.push(`/document/${item.document_id}?from=/&highlight=${item.id}`)}
        onPin={() => handlePin(item)}
        onDelete={() => initiateDelete(item)}
        onAnnotate={() => setAnnotateItem(item)}
        onTags={() => setTagModalId(item.id)}
        onDocumentPress={handleDocumentPress}
        onLinkAction={handleLinkAction}
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
            <View style={s.archiveAction}>
              <Ionicons name="archive-outline" size={20} color="#fff" />
              <Text style={s.swipeLabel}>Archive</Text>
            </View>
          )}
          renderRightActions={() => (
            <View style={[s.starAction, isPinned && s.starActionActive]}>
              <Ionicons name={isPinned ? 'star' : 'star-outline'} size={20} color="#fff" />
              <Text style={s.swipeLabel}>{isPinned ? 'Unpin' : 'Star'}</Text>
            </View>
          )}
          dragOffsetFromLeft={SWIPE_DRAG_OFFSET}
          dragOffsetFromRight={-SWIPE_DRAG_OFFSET}
          overshootLeft={false}
          overshootRight={false}
          onSwipeableOpen={handleSwipeOpen}
        >
          {card}
        </ReanimatedSwipeable>
        {unarchiveBtn}
      </View>
    )
  }, [archivedIds, deletingIds, handleArchive, handlePin, handleUnarchive, initiateDelete, undoDelete, handleDocumentPress, handleLinkAction, router, s])

  // Show the skeleton (not the empty state) while anything might still produce
  // highlights: the persisted store hasn't hydrated yet, the connection is still
  // resolving, a fetch is in flight, or a sync may pull rows. Only drop to
  // "No highlights yet" once everything has settled and there genuinely are none.
  const settling = highlights.length === 0 &&
    (loading || syncStatus === 'syncing' || !hasHydrated || status === 'loading')

  // The list is one of four states, but the sheets render in ALL of them — the header
  // "+" must still open the add-URL sheet on an empty/errored/loading feed.
  let body
  if (settling) {
    body = <FeedSkeleton />
  } else if (error) {
    body = (
      <View style={s.center}>
        <Text style={s.errorText}>{error}</Text>
        <Pressable style={s.retryBtn} onPress={load}>
          <Text style={s.retryText}>Retry</Text>
        </Pressable>
      </View>
    )
  } else if (highlights.length === 0) {
    body = (
      <View style={s.center}>
        <Text style={s.placeholder}>No highlights yet.</Text>
        <Text style={s.hint}>Run a pipeline on a document to generate highlights.</Text>
      </View>
    )
  } else {
    body = (
      <>
        <FlatList
          style={s.list}
          contentContainerStyle={s.listContent}
          data={highlights}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          onRefresh={load}
          refreshing={loading}
          // Hold the reader's place when a sync prepends newer highlights. Native-only:
          // RNW doesn't implement it (passing it there would warn on an unknown DOM prop),
          // and web already gets equivalent behaviour from the browser's overflow-anchor.
          maintainVisibleContentPosition={Platform.OS === 'web' ? undefined : { minIndexForVisible: 1 }}
          onScroll={(e) => {
            const y = e.nativeEvent.contentOffset.y
            scrollYRef.current = y
            // Programmatic re-anchor after a sync prepend — don't let the jump read as
            // a fast user scroll (velocity) or trip scroll-past archiving.
            if (preservingScrollRef.current) { lastScrollRef.current = { y, t: Date.now() }; return }
            if (!autoMarkRead) return // auto-mark-as-read off → never scroll-archive
            // velocity (px/ms); fast downward scroll mass-archives — offer bulk undo
            const now = Date.now()
            const last = lastScrollRef.current
            const dt = now - last.t
            if (dt > 0) {
              const v = (y - last.y) / dt
              if (v > 2.5) {
                setShowUnreadAll(true)
                if (unreadHideTimer.current) clearTimeout(unreadHideTimer.current)
                unreadHideTimer.current = setTimeout(() => setShowUnreadAll(false), 4000)
              }
            }
            lastScrollRef.current = { y, t: now }
            pendingArchiveRef.current.forEach((exitY, id) => {
              if (y - exitY > 300) {
                pendingArchiveRef.current.delete(id)
                setArchivedIds(prev => new Set(prev).add(id))
                db.archiveHighlight(id, new Date().toISOString())
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
        {showUnreadAll && archivedIds.size > 0 && (
          <Pressable style={s.unreadAllBtn} onPress={handleUnreadAll} hitSlop={8}>
            <Text style={s.unreadAllText}>↺ Unread all ({archivedIds.size})</Text>
          </Pressable>
        )}
      </>
    )
  }

  return (
    <>
      {body}
      <TagSelectorModal
        visible={tagModalId !== null}
        objectId={tagModalId ?? ''}
        objectType="highlight"
        onChanged={(id, tags) =>
          setHighlights(prev => prev.map(h => h.id === id ? { ...h, tags } : h))
        }
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
        onReadAsDocument={readAsDocument}
        onClose={() => setLinkUrl(null)}
      />
      <AddUrlSheet
        visible={addUrlOpen}
        onSubmit={readAsDocument}
        onClose={() => setAddUrlOpen(false)}
      />
    </>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingRight: 4 },
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
    unreadAllBtn: {
      position: 'absolute',
      top: 12,
      right: 12,
      backgroundColor: t.colors.accent,
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 8,
      zIndex: 100,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 4,
    },
    unreadAllText: { color: '#fff', fontSize: 13, fontWeight: '700' },
    archiveAction: {
      width: 80,
      backgroundColor: '#0ea5e9',
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
