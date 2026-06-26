import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useRouter } from 'expo-router'
import { useConnection } from '../../src/ConnectionContext'
import { fetchHighlights, HighlightWithDoc, pinHighlight } from '../../src/api'
import HighlightCard from '../../src/HighlightCard'

export default function StarredScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { activeUrl, token, status } = useConnection()

  const [highlights, setHighlights] = useState<HighlightWithDoc[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!activeUrl || !token) return
    setLoading(true)
    setError(null)
    try {
      const data = await fetchHighlights(activeUrl, token, 200, false, true)
      setHighlights(data)
    } catch {
      setError('Failed to load starred highlights')
    } finally {
      setLoading(false)
    }
  }, [activeUrl, token])

  useEffect(() => {
    if (status === 'connected') load()
  }, [status, load])

  const handleUnpin = useCallback(async (item: HighlightWithDoc) => {
    if (!activeUrl || !token) return
    try {
      await pinHighlight(activeUrl, token, item.id, false)
      setHighlights(prev => prev.filter(h => h.id !== item.id))
    } catch {
      Alert.alert('Error', 'Failed to unpin')
    }
  }, [activeUrl, token])

  const handleDocumentPress = useCallback(
    (docId: string) => router.push(`/document/${encodeURIComponent(docId)}?from=/starred`),
    [router],
  )

  const renderItem = useCallback(({ item }: { item: HighlightWithDoc }) => (
    <View style={s.itemWrapper}>
      <HighlightCard
        item={item}
        linkedDocuments={item.linked_documents}
        pinned
        onPress={() => router.push(`/document/${item.document_id}?from=/starred&highlight=${item.id}`)}
        onDocumentPress={handleDocumentPress}
      />
      <Pressable style={s.unpinBtn} onPress={() => handleUnpin(item)}>
        <Text style={s.unpinBtnText}>☆ Unstar</Text>
      </Pressable>
    </View>
  ), [handleUnpin, handleDocumentPress, router, s])

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
        <Text style={s.placeholder}>No starred highlights.</Text>
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
    itemWrapper: { gap: 4 },
    unpinBtn: {
      alignSelf: 'flex-end',
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 6,
      backgroundColor: t.colors.background,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    unpinBtnText: { color: t.colors.muted, fontSize: 12, fontWeight: '600' },
    placeholder: { color: t.colors.muted, fontSize: 16 },
    errorText: { color: '#ff6b6b', fontSize: 15 },
    retryBtn: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: t.colors.accent, borderRadius: 6 },
    retryText: { color: '#fff', fontWeight: '600' },
  })
}
