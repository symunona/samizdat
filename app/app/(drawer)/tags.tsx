import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { fetchTags } from '../../src/api'
import type { Tag } from '../../src/api'
import { useConnection } from '../../src/ConnectionContext'

function tagDotColor(color: string): string {
  switch (color) {
    case 'red': return '#f87171'
    case 'orange': return '#e8743b'
    case 'yellow': return '#facc15'
    case 'green': return '#4ade80'
    case 'blue': return '#60a5fa'
    case 'purple': return '#a78bfa'
    case 'pink': return '#f472b6'
    default: return '#9ca3af'
  }
}

export default function TagsScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { activeUrl, token, status } = useConnection()

  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadTags = useCallback(async (isRefresh = false) => {
    if (!activeUrl || !token) return
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const data = await fetchTags(activeUrl, token)
      setTags(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load tags')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [activeUrl, token])

  useEffect(() => {
    if (status === 'connected') loadTags()
    else if (status === 'disconnected') { setError('Not connected'); setLoading(false) }
  }, [status, loadTags])

  function renderItem({ item }: { item: Tag }) {
    const docCount = typeof item.doc_count === 'number' ? item.doc_count : Number(item.doc_count ?? 0)
    const annCount = typeof item.ann_count === 'number' ? item.ann_count : Number(item.ann_count ?? 0)
    return (
      <Pressable style={s.item} onPress={() => router.push(`/tags/${item.id}`)}>
        <View style={s.itemLeft}>
          <View style={[s.dot, { backgroundColor: tagDotColor(item.color) }]} />
          <Text style={s.itemName}>{item.name}</Text>
        </View>
        <View style={s.chips}>
          {docCount > 0 && (
            <View style={s.chip}>
              <Text style={s.chipText}>{docCount} doc{docCount !== 1 ? 's' : ''}</Text>
            </View>
          )}
          {annCount > 0 && (
            <View style={[s.chip, s.chipAnn]}>
              <Text style={s.chipText}>{annCount} ann{annCount !== 1 ? 's' : ''}</Text>
            </View>
          )}
          {docCount === 0 && annCount === 0 && (
            <Text style={s.emptyChip}>empty</Text>
          )}
        </View>
      </Pressable>
    )
  }

  if (loading && !refreshing) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.centered}><ActivityIndicator color={theme.colors.accent} size="large" /></View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={s.screen}>
      {error ? (
        <View style={s.centered}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable onPress={() => loadTags()} style={s.retryBtn}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={tags}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={tags.length === 0 ? s.emptyContainer : s.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadTags(true)}
              tintColor={theme.colors.accent}
            />
          }
          ListEmptyComponent={
            <Text style={s.emptyText}>No tags yet. Create tags from an annotation or document.</Text>
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
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errorText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    listContent: { paddingVertical: t.spacing.xs },
    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    emptyText: { color: t.colors.muted, fontSize: 15, textAlign: 'center' },
    separator: { height: 1, backgroundColor: t.colors.border, marginLeft: t.spacing.md },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.md,
      backgroundColor: t.colors.background,
    },
    itemLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    dot: { width: 12, height: 12, borderRadius: 6, flexShrink: 0 },
    itemName: { color: t.colors.text, fontSize: 15, fontWeight: '600' },
    chips: { flexDirection: 'row', gap: t.spacing.xs, alignItems: 'center' },
    chip: {
      backgroundColor: t.colors.surface,
      borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: 3,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    chipAnn: { borderColor: t.colors.accent + '55' },
    chipText: { color: t.colors.muted, fontSize: 11, fontWeight: '600' },
    emptyChip: { color: t.colors.placeholder, fontSize: 11 },
  })
}
