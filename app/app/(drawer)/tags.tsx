import { useMemo, useState } from 'react'
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
import { useConnection } from '../../src/ConnectionContext'
import { useTagsWithCounts, useSyncStatus } from '../../src/store/hooks'
import type { TagWithCounts } from '../../src/store/hooks'
import { forceSync } from '../../src/store/syncEngine'

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

  const tags = useTagsWithCounts()
  const { status: syncStatus, error: syncError } = useSyncStatus()
  const [refreshing, setRefreshing] = useState(false)

  async function handleRefresh() {
    if (!activeUrl || !token) return
    setRefreshing(true)
    try {
      await forceSync(activeUrl, token)
    } finally {
      setRefreshing(false)
    }
  }

  function renderItem({ item }: { item: TagWithCounts }) {
    return (
      <Pressable style={s.item} onPress={() => router.push(`/tags/${item.id}`)}>
        <View style={s.itemLeft}>
          <View style={[s.dot, { backgroundColor: tagDotColor(item.color) }]} />
          <Text style={s.itemName}>{item.name}</Text>
        </View>
        <View style={s.chips}>
          {item.doc_count > 0 && (
            <View style={s.chip}>
              <Text style={s.chipText}>{item.doc_count} doc{item.doc_count !== 1 ? 's' : ''}</Text>
            </View>
          )}
          {item.ann_count > 0 && (
            <View style={[s.chip, s.chipAnn]}>
              <Text style={s.chipText}>{item.ann_count} ann{item.ann_count !== 1 ? 's' : ''}</Text>
            </View>
          )}
          {item.doc_count === 0 && item.ann_count === 0 && (
            <Text style={s.emptyChip}>empty</Text>
          )}
        </View>
      </Pressable>
    )
  }

  if (status === 'loading' || (syncStatus === 'syncing' && tags.length === 0)) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.centered}><ActivityIndicator color={theme.colors.accent} size="large" /></View>
      </SafeAreaView>
    )
  }

  if (syncStatus === 'error' && tags.length === 0) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.centered}>
          <Text style={s.errorText}>{syncError ?? 'Sync failed'}</Text>
          <Pressable onPress={handleRefresh} style={s.retryBtn}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={s.screen}>
      <FlatList
        data={tags}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={tags.length === 0 ? s.emptyContainer : s.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.accent}
          />
        }
        ListEmptyComponent={
          <Text style={s.emptyText}>No tags yet. Create tags from an annotation or document.</Text>
        }
        ItemSeparatorComponent={() => <View style={s.separator} />}
      />
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
