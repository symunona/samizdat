import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import IconButton from '../../src/IconButton'
import { useConfirm } from '../../src/ConfirmContext'
import { useToast } from '../../src/ToastContext'
import { useSyncStore } from '../../src/store/syncStore'
import { parseMediaMetadata } from '../../src/api'
import {
  listOfflineMedia,
  deleteOfflineMedia,
  totalOfflineBytes,
  formatBytes,
  type OfflineMediaItem,
} from '../../src/offlineCache'

const isWeb = Platform.OS === 'web'

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function OfflineCacheScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { confirm } = useConfirm()
  const { toast } = useToast()
  const documents = useSyncStore((state) => state.documents)

  const [items, setItems] = useState<OfflineMediaItem[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await listOfflineMedia())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleDelete = useCallback(async (item: OfflineMediaItem) => {
    const title = documents[item.docId]?.title || item.docId
    const ok = await confirm({
      title: 'Delete offline media',
      message: `Remove the offline copy of "${title}" (${formatBytes(item.sizeBytes)})? It can be re-synced later from the player.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setDeleting((prev) => new Set(prev).add(item.docId))
    try {
      await deleteOfflineMedia(item.docId)
      setItems((prev) => prev.filter((it) => it.docId !== item.docId))
      toast('Offline media deleted', 'success')
    } catch {
      toast('Failed to delete', 'error')
    } finally {
      setDeleting((prev) => { const next = new Set(prev); next.delete(item.docId); return next })
    }
  }, [confirm, documents, toast])

  const totalBytes = totalOfflineBytes(items)

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn} hitSlop={12}>
          <Ionicons name="arrow-back" size={22} color={theme.colors.accent} />
        </Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>Offline cache</Text>
      </View>

      {isWeb ? (
        <View style={s.centerBox}>
          <Ionicons name="phone-portrait-outline" size={40} color={theme.colors.muted} />
          <Text style={s.centerText}>Offline cache is available in the mobile app</Text>
        </View>
      ) : (
        <ScrollView style={s.scroll} contentContainerStyle={s.content}>
          <View style={s.totalCard}>
            <Text style={s.totalLabel}>Total offline media</Text>
            <Text style={s.totalValue}>{formatBytes(totalBytes)}</Text>
          </View>

          {loading ? (
            <ActivityIndicator color={theme.colors.accent} style={{ marginTop: theme.spacing.xl }} />
          ) : items.length === 0 ? (
            <Text style={s.emptyText}>No offline media</Text>
          ) : (
            <View style={s.list}>
              {items.map((item, i) => {
                const doc = documents[item.docId]
                const title = doc?.title || item.docId
                const durationMs = doc ? parseMediaMetadata(doc).duration_ms ?? 0 : 0
                const isDeleting = deleting.has(item.docId)
                return (
                  <View key={item.docId} style={[s.row, i === items.length - 1 && s.rowLast]}>
                    <View style={s.rowMain}>
                      <Text style={s.rowTitle} numberOfLines={2}>{title}</Text>
                      <View style={s.rowMeta}>
                        <Text style={s.rowMetaText}>{formatBytes(item.sizeBytes)}</Text>
                        {durationMs > 0 ? <Text style={s.rowMetaText}>· {fmtDuration(durationMs)}</Text> : null}
                      </View>
                    </View>
                    {isDeleting ? (
                      <ActivityIndicator size="small" color={theme.colors.error} style={s.rowSpinner} />
                    ) : (
                      <IconButton name="trash-outline" onPress={() => handleDelete(item)} color={theme.colors.error} hoverColor={theme.colors.error} />
                    )}
                  </View>
                )
              })}
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    header: {
      flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm,
      borderBottomWidth: 1, borderBottomColor: t.colors.border, backgroundColor: t.colors.surface,
    },
    backBtn: { flexShrink: 0, padding: t.spacing.sm },
    headerTitle: { flex: 1, color: t.colors.text, fontSize: 15, fontWeight: '600' },
    scroll: { flex: 1 },
    content: { padding: t.spacing.md, gap: t.spacing.md, paddingBottom: t.spacing.xl, maxWidth: 800, alignSelf: 'center', width: '100%' },
    totalCard: {
      backgroundColor: t.colors.surface, borderRadius: t.radius.md,
      borderWidth: 1, borderColor: t.colors.border, padding: t.spacing.md,
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    },
    totalLabel: { color: t.colors.muted, fontSize: 13 },
    totalValue: { color: t.colors.accent, fontSize: 16, fontWeight: '700' },
    list: {
      backgroundColor: t.colors.surface, borderRadius: t.radius.md,
      borderWidth: 1, borderColor: t.colors.border, overflow: 'hidden',
    },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
      paddingVertical: t.spacing.sm, paddingHorizontal: t.spacing.md,
      borderBottomWidth: 1, borderBottomColor: t.colors.border,
    },
    rowLast: { borderBottomWidth: 0 },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { color: t.colors.text, fontSize: 14, fontWeight: '600' },
    rowMeta: { flexDirection: 'row', gap: 6, alignItems: 'center' },
    rowMetaText: { color: t.colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
    rowSpinner: { paddingHorizontal: t.iconButton.padX },
    emptyText: { color: t.colors.muted, fontSize: 14, textAlign: 'center', paddingVertical: t.spacing.xl },
    centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.spacing.md, padding: t.spacing.xl },
    centerText: { color: t.colors.muted, fontSize: 15, textAlign: 'center' },
  })
}
