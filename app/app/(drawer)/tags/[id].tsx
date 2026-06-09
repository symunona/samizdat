import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { fetchTags, fetchTagDocuments, fetchTagAnnotations } from '../../../src/api'
import type { Tag, Document, Annotation } from '../../../src/api'
import { useConnection } from '../../../src/ConnectionContext'

export default function TagDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { activeUrl, token, status } = useConnection()

  const [tag, setTag] = useState<Tag | null>(null)
  const [documents, setDocuments] = useState<Document[]>([])
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (isRefresh = false) => {
    if (!activeUrl || !token || !id) return
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const [allTags, docs, anns] = await Promise.all([
        fetchTags(activeUrl, token),
        fetchTagDocuments(activeUrl, token, id),
        fetchTagAnnotations(activeUrl, token, id),
      ])
      const found = allTags.find(t => t.id === id)
      setTag(found ?? null)
      setDocuments(docs)
      setAnnotations(anns)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load tag')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [activeUrl, token, id])

  useEffect(() => {
    if (status === 'connected') load()
    else if (status === 'disconnected') { setError('Not connected'); setLoading(false) }
  }, [status, load])

  type SectionItem =
    | { kind: 'doc'; data: Document }
    | { kind: 'ann'; data: Annotation }

  if (loading && !refreshing) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.centered}><ActivityIndicator color={theme.colors.accent} size="large" /></View>
      </SafeAreaView>
    )
  }

  if (error) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.centered}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable onPress={() => load()} style={s.retryBtn}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    )
  }

  const sections = [
    {
      title: `Documents (${documents.length})`,
      data: documents.map(d => ({ kind: 'doc' as const, data: d })),
    },
    {
      title: `Annotations (${annotations.length})`,
      data: annotations.map(a => ({ kind: 'ann' as const, data: a })),
    },
  ]

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.headerBar}>
        <Pressable onPress={() => router.back()} style={s.backBtn} hitSlop={12}>
          <Text style={s.backText}>←</Text>
        </Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>
          {tag ? tag.name : 'Tag'}
        </Text>
        <Text style={s.headerCount}>
          {documents.length + annotations.length} items
        </Text>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item, idx) => item.data.id + idx}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={theme.colors.accent}
          />
        }
        renderSectionHeader={({ section }) => (
          <View style={s.sectionHeader}>
            <Text style={s.sectionTitle}>{section.title}</Text>
          </View>
        )}
        renderItem={({ item }: { item: SectionItem }) => {
          if (item.kind === 'doc') {
            const doc = item.data
            return (
              <Pressable
                style={s.docCard}
                onPress={() => router.push(`/document/${doc.id}`)}
              >
                <Text style={s.docTitle} numberOfLines={2}>
                  {doc.title || doc.canonical_url}
                </Text>
                {doc.excerpt ? (
                  <Text style={s.docExcerpt} numberOfLines={2}>{doc.excerpt}</Text>
                ) : null}
              </Pressable>
            )
          }
          const ann = item.data
          const exactSnippet = ann.exact.length > 80 ? ann.exact.slice(0, 80) + '…' : ann.exact
          return (
            <Pressable
              style={s.annCard}
              onPress={() => router.push(`/document/${ann.document_id}?highlight=${ann.id}`)}
            >
              <Text style={s.annExact} numberOfLines={3}>{exactSnippet}</Text>
              {ann.note ? (
                <Text style={s.annNote} numberOfLines={1}>{ann.note}</Text>
              ) : null}
            </Pressable>
          )
        }}
        ListEmptyComponent={
          <View style={s.centered}>
            <Text style={s.emptyText}>Nothing tagged yet.</Text>
          </View>
        }
        contentContainerStyle={s.listContent}
        ItemSeparatorComponent={() => <View style={s.separator} />}
      />
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    headerBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
      backgroundColor: t.colors.surface,
      gap: t.spacing.sm,
    },
    backBtn: { flexShrink: 0, padding: t.spacing.sm },
    backText: { color: t.colors.accent, fontSize: 20, fontWeight: '400' },
    headerTitle: { flex: 1, color: t.colors.text, fontSize: 16, fontWeight: '700' },
    headerCount: { color: t.colors.muted, fontSize: 12 },
    sectionHeader: {
      backgroundColor: t.colors.surface,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
    },
    sectionTitle: { color: t.colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
    listContent: { paddingBottom: t.spacing.xl },
    separator: { height: 1, backgroundColor: t.colors.border, marginLeft: t.spacing.md },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errorText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    emptyText: { color: t.colors.muted, fontSize: 15, textAlign: 'center' },
    docCard: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.md,
      backgroundColor: t.colors.background,
    },
    docTitle: { color: t.colors.text, fontSize: 15, fontWeight: '600', lineHeight: 20, marginBottom: 2 },
    docExcerpt: { color: t.colors.muted, fontSize: 13, lineHeight: 18 },
    annCard: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.md,
      backgroundColor: t.colors.background,
      borderLeftWidth: 3,
      borderLeftColor: t.colors.accent,
    },
    annExact: { color: t.colors.text, fontSize: 14, lineHeight: 20, fontStyle: 'italic', marginBottom: 4 },
    annNote: { color: t.colors.muted, fontSize: 12, lineHeight: 16 },
  })
}
