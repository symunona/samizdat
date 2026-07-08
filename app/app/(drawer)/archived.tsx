import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, ActivityIndicator } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useRouter } from 'expo-router'
import { useConnection } from '../../src/ConnectionContext'
import { fetchHighlights, HighlightWithDoc } from '../../src/api'
import * as mut from '../../src/store/mutations'
import { useSyncStore } from '../../src/store/syncStore'
import { highlightsFromStore } from '../../src/store/highlightsFromStore'
import HighlightCard from '../../src/HighlightCard'

export default function ArchivedScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { activeUrl, token, status } = useConnection()

  const [highlights, setHighlights] = useState<HighlightWithDoc[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Offline-first: archived highlights are already in the local replica.
  const loadFromStore = useCallback((): boolean => {
    const hls = highlightsFromStore(h => !!h.archived_at)
    if (hls.length > 0) setHighlights(hls) // don't wipe a populated list with an empty store
    return hls.length > 0
  }, [])

  const load = useCallback(async () => {
    if (!activeUrl || !token) { loadFromStore(); return }
    setLoading(true)
    setError(null)
    try {
      const data = await fetchHighlights(activeUrl, token, 200, true)
      setHighlights(data)
    } catch {
      if (!loadFromStore()) setError('Failed to load archived highlights')
    } finally {
      setLoading(false)
    }
  }, [activeUrl, token, loadFromStore])

  useEffect(() => {
    if (status === 'connected') load()
  }, [status, load])

  const storeHlCount = useSyncStore(st => Object.keys(st.highlights).length)
  useEffect(() => {
    if (status !== 'connected') loadFromStore()
  }, [status, storeHlCount, loadFromStore])

  const handleUnarchive = useCallback((item: HighlightWithDoc) => {
    mut.archiveHighlight(item.id, null)
    setHighlights(prev => prev.filter(h => h.id !== item.id))
  }, [])

  const renderItem = useCallback(({ item }: { item: HighlightWithDoc }) => (
    <View style={s.itemWrapper}>
      <HighlightCard
        item={item}
        linkedDocuments={item.linked_documents}
        onPress={() => router.push(`/document/${item.document_id}?from=/archived`)}
        onDocumentPress={(docId) => router.push(`/document/${encodeURIComponent(docId)}?from=/archived`)}
      />
      <Pressable style={s.unarchiveBtn} onPress={() => handleUnarchive(item)}>
        <Text style={s.unarchiveBtnText}>↩ Restore</Text>
      </Pressable>
    </View>
  ), [handleUnarchive, router, s])

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
        <Text style={s.placeholder}>No archived highlights.</Text>
      </View>
    )
  }

  return (
    <FlatList
      style={s.list}
      contentContainerStyle={s.listContent}
      data={highlights}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      onRefresh={load}
      refreshing={loading}
    />
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    list: { flex: 1, backgroundColor: t.colors.background },
    listContent: { padding: 12, gap: 12, maxWidth: 800, alignSelf: 'center', width: '100%' },
    center: { flex: 1, backgroundColor: t.colors.background, justifyContent: 'center', alignItems: 'center', gap: 12 },
    itemWrapper: { gap: 4, opacity: 0.65 },
    unarchiveBtn: {
      alignSelf: 'flex-end',
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 6,
      backgroundColor: t.colors.background,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    unarchiveBtnText: { color: t.colors.muted, fontSize: 12, fontWeight: '600' },
    placeholder: { color: t.colors.muted, fontSize: 16 },
    errorText: { color: '#ff6b6b', fontSize: 15 },
    retryBtn: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: t.colors.accent, borderRadius: 6 },
    retryText: { color: '#fff', fontWeight: '600' },
  })
}
