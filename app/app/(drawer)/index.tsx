import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useRouter } from 'expo-router'
import { useConnection } from '../../src/ConnectionContext'
import { fetchHighlights, deleteHighlight, pinHighlight, HighlightWithDoc } from '../../src/api'
import MarkdownBody from '../../src/MarkdownBody'
import TagSelectorModal from '../../src/TagSelectorModal'

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

  const load = useCallback(async () => {
    if (!activeUrl || !token) return
    setLoading(true)
    setError(null)
    try {
      const data = await fetchHighlights(activeUrl, token, 200)
      setHighlights(data)
    } catch (e) {
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

  const handleDelete = useCallback((item: HighlightWithDoc) => {
    if (!activeUrl || !token) return
    Alert.alert('Delete highlight?', item.title || item.body.slice(0, 60), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          setActionLoading(prev => new Set(prev).add(item.id))
          try {
            await deleteHighlight(activeUrl, token, item.id)
            setHighlights(prev => prev.filter(h => h.id !== item.id))
          } catch {
            Alert.alert('Error', 'Failed to delete highlight')
          } finally {
            setActionLoading(prev => { const s = new Set(prev); s.delete(item.id); return s })
          }
        }
      },
    ])
  }, [activeUrl, token])

  const kindColor: Record<string, string> = {
    summary: theme.colors.accent,
    link: '#6b8cff',
    note: '#b8a0ff',
  }

  const renderItem = ({ item }: { item: HighlightWithDoc }) => {
    const busy = actionLoading.has(item.id)
    const isPinned = item.pinned === 1
    return (
      <Pressable
        style={[s.card, isPinned && s.cardPinned]}
        onPress={() => router.push(`/document/${item.document_id}?from=/`)}
      >
        <View style={s.cardHeader}>
          <View style={[s.kindBadge, { backgroundColor: kindColor[item.kind] ?? '#888' }]}>
            <Text style={s.kindText}>{item.kind}</Text>
          </View>
          <Text style={s.hlTitle} numberOfLines={1}>
            {item.title || item.document_title || item.document_url}
          </Text>
          <View style={s.actions}>
            <Pressable
              style={[s.actionBtn, isPinned && s.actionBtnActive]}
              onPress={() => handlePin(item)}
              disabled={busy}
              hitSlop={6}
            >
              {busy ? (
                <ActivityIndicator size="small" color={theme.colors.accent} />
              ) : (
                <Text style={[s.actionIcon, isPinned && s.actionIconActive]}>
                  {isPinned ? '📌' : '📍'}
                </Text>
              )}
            </Pressable>
            <Pressable
              style={s.actionBtn}
              onPress={() => setTagModalId(item.id)}
              hitSlop={6}
            >
              <Text style={s.actionIcon}>🏷</Text>
            </Pressable>
            <Pressable
              style={s.actionBtn}
              onPress={() => handleDelete(item)}
              disabled={busy}
              hitSlop={6}
            >
              <Text style={s.actionIcon}>🗑</Text>
            </Pressable>
          </View>
        </View>
        <MarkdownBody
          linkedDocuments={item.linked_documents}
          onDocumentPress={(docId) => router.push(`/document/${encodeURIComponent(docId)}?from=/`)}
        >{item.body}</MarkdownBody>
      </Pressable>
    )
  }

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
    </>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    list: { flex: 1, backgroundColor: t.colors.background },
    listContent: { padding: 12, gap: 12 },
    center: { flex: 1, backgroundColor: t.colors.background, justifyContent: 'center', alignItems: 'center', gap: 12 },
    card: {
      backgroundColor: t.colors.surface,
      borderRadius: 10,
      padding: 14,
      borderWidth: 1,
      borderColor: t.colors.border,
      gap: 8,
    },
    cardPinned: {
      borderColor: t.colors.accent,
      borderWidth: 2,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    kindBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
    kindText: { color: '#fff', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
    hlTitle: { flex: 1, color: t.colors.text, fontSize: 13, fontWeight: '600' },
    actions: { flexDirection: 'row', gap: 4 },
    actionBtn: {
      width: 28,
      height: 28,
      borderRadius: 6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionBtnActive: { backgroundColor: t.colors.accent + '22' },
    actionIcon: { fontSize: 14 },
    actionIconActive: { opacity: 1 },
    placeholder: { color: t.colors.muted, fontSize: 16 },
    hint: { color: t.colors.muted, fontSize: 13, opacity: 0.6 },
    errorText: { color: '#ff6b6b', fontSize: 15 },
    retryBtn: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: t.colors.accent, borderRadius: 6 },
    retryText: { color: '#fff', fontWeight: '600' },
  })
}
