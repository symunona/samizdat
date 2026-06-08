import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import Markdown from 'react-native-markdown-display'
import { fetchDocument, findReachable } from '../../src/api'
import type { Document } from '../../src/api'
import { loadConnection } from '../../src/storage'

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

export default function DocumentViewer() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const mdStyle = useMemo(() => buildMarkdownStyles(theme), [theme])

  const [doc, setDoc] = useState<Document | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const saved = await loadConnection()
      if (!saved) throw new Error('Not connected')
      const found = await findReachable(saved.serverUrls, saved.token)
      if (!found) throw new Error('Server unreachable')
      const d = await fetchDocument(found.url, saved.token, id)
      setDoc(d)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load document')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return (
    <SafeAreaView style={s.screen}>
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn} hitSlop={12}>
          <Text style={s.backText}>← Documents</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={s.centered}>
          <ActivityIndicator color={theme.colors.accent} size="large" />
        </View>
      ) : error ? (
        <View style={s.centered}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable onPress={load} style={s.retryBtn}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : doc ? (
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.title}>{doc.title || doc.canonical_url}</Text>
          <Pressable onPress={() => Linking.openURL(doc.canonical_url)}>
            <Text style={s.url} numberOfLines={2}>
              {doc.canonical_url}
            </Text>
          </Pressable>
          <Text style={s.meta}>Fetched {formatDate(doc.fetched_at)}</Text>
          <View style={s.divider} />
          {doc.markdown ? (
            <Markdown style={mdStyle}>{doc.markdown}</Markdown>
          ) : (
            <Text style={s.empty}>No content extracted.</Text>
          )}
        </ScrollView>
      ) : null}
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    header: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
      backgroundColor: t.colors.surface,
    },
    backBtn: { alignSelf: 'flex-start' },
    backText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errorText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    content: { padding: t.spacing.md, paddingBottom: t.spacing.xl * 2 },
    title: { color: t.colors.text, fontSize: 20, fontWeight: '700', lineHeight: 28, marginBottom: t.spacing.sm },
    url: { color: t.colors.accent, fontSize: 13, fontFamily: 'monospace', marginBottom: t.spacing.xs },
    meta: { color: t.colors.placeholder, fontSize: 12, marginBottom: t.spacing.md },
    divider: { height: 1, backgroundColor: t.colors.border, marginBottom: t.spacing.md },
    empty: { color: t.colors.muted, fontSize: 15, fontStyle: 'italic' },
  })
}

function buildMarkdownStyles(t: Theme) {
  return StyleSheet.create({
    body: { color: t.colors.text, fontSize: 15, lineHeight: 24, backgroundColor: t.colors.background },
    heading1: { color: t.colors.text, fontSize: 22, fontWeight: '700', marginTop: t.spacing.lg, marginBottom: t.spacing.sm },
    heading2: { color: t.colors.text, fontSize: 19, fontWeight: '700', marginTop: t.spacing.md, marginBottom: t.spacing.sm },
    heading3: { color: t.colors.text, fontSize: 17, fontWeight: '600', marginTop: t.spacing.md, marginBottom: t.spacing.xs },
    paragraph: { marginBottom: t.spacing.md, color: t.colors.text },
    link: { color: t.colors.accent, textDecorationLine: 'underline' },
    blockquote: { backgroundColor: t.colors.surface, borderLeftWidth: 3, borderLeftColor: t.colors.accent, paddingLeft: t.spacing.md, paddingVertical: t.spacing.xs, marginBottom: t.spacing.md },
    code_inline: { backgroundColor: t.colors.surface, color: t.colors.accent, fontFamily: 'monospace', paddingHorizontal: 4, borderRadius: 3 },
    fence: { backgroundColor: t.colors.surface, padding: t.spacing.md, borderRadius: t.radius.sm, marginBottom: t.spacing.md },
    code_block: { backgroundColor: t.colors.surface, padding: t.spacing.md, borderRadius: t.radius.sm, marginBottom: t.spacing.md, fontFamily: 'monospace', color: t.colors.text },
    bullet_list: { marginBottom: t.spacing.sm },
    ordered_list: { marginBottom: t.spacing.sm },
    list_item: { marginBottom: 4, color: t.colors.text },
    hr: { backgroundColor: t.colors.border, height: 1, marginVertical: t.spacing.md },
    strong: { fontWeight: '700', color: t.colors.text },
    em: { fontStyle: 'italic', color: t.colors.text },
    image: { marginBottom: t.spacing.md },
  })
}
