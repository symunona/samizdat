import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useRouter } from 'expo-router'
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable'
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { useConnection } from '../../src/ConnectionContext'
import { fetchHighlights, deleteHighlight, pinHighlight, createAnnotation, HighlightWithDoc } from '../../src/api'
import HighlightCard from '../../src/HighlightCard'
import TagSelectorModal from '../../src/TagSelectorModal'
import AnnotationPanel from '../../src/AnnotationPanel'

export default function FeedScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { activeUrl, token, status } = useConnection()

  const [highlights, setHighlights] = useState<HighlightWithDoc[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tagModalId, setTagModalId] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set())
  const [annotateItem, setAnnotateItem] = useState<HighlightWithDoc | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())

  const swipeRefs = useRef<Map<string, SwipeableMethods | null>>(new Map())
  const deleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

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

    return (
      <ReanimatedSwipeable
        ref={(r) => {
          if (r) swipeRefs.current.set(item.id, r)
          else swipeRefs.current.delete(item.id)
        }}
        containerStyle={s.swipeContainer}
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
        />
      </ReanimatedSwipeable>
    )
  }, [actionLoading, deletingIds, handlePin, initiateDelete, undoDelete, router, s])

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
    </>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    list: { flex: 1, backgroundColor: t.colors.background },
    listContent: { padding: 12, gap: 12 },
    center: { flex: 1, backgroundColor: t.colors.background, justifyContent: 'center', alignItems: 'center', gap: 12 },
    swipeContainer: {
      borderRadius: 10,
      overflow: 'hidden',
    },
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
    placeholder: { color: t.colors.muted, fontSize: 16 },
    hint: { color: t.colors.muted, fontSize: 13, opacity: 0.6 },
    errorText: { color: '#ff6b6b', fontSize: 15 },
    retryBtn: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: t.colors.accent, borderRadius: 6 },
    retryText: { color: '#fff', fontWeight: '600' },
  })
}
