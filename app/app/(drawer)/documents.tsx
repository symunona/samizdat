import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { fetchDocuments, submitScrapeJob } from '../../src/api'
import type { Document } from '../../src/api'
import { useConnection } from '../../src/ConnectionContext'

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

export default function DocumentsScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { status, error: connError, activeUrl, token, probe } = useConnection()

  const [documents, setDocuments] = useState<Document[]>([])
  const [fetchLoading, setFetchLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const [urlInput, setUrlInput] = useState('')
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'queued' | 'error'>('idle')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const queuedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Redirect only when no credentials stored
  useEffect(() => {
    if (status === 'disconnected' && !token) {
      router.replace('/connect')
    }
  }, [status, token, router])

  const loadDocuments = useCallback(
    async (isRefresh = false) => {
      if (!activeUrl || !token) return
      if (isRefresh) {
        setRefreshing(true)
      } else {
        setFetchLoading(true)
      }
      setFetchError(null)
      try {
        const docs = await fetchDocuments(activeUrl, token)
        setDocuments(docs)
      } catch (e: unknown) {
        setFetchError(e instanceof Error ? e.message : 'Failed to load documents')
      } finally {
        setFetchLoading(false)
        setRefreshing(false)
      }
    },
    [activeUrl, token],
  )

  // Fetch documents once connection is ready
  useEffect(() => {
    if (status === 'connected') {
      loadDocuments()
    }
  }, [status, loadDocuments])

  async function handleSubmitUrl() {
    if (!activeUrl || !token) return
    const trimmed = urlInput.trim()
    if (!trimmed) return

    setSubmitState('submitting')
    setSubmitError(null)
    try {
      await submitScrapeJob(activeUrl!, token!, trimmed)
      setUrlInput('')
      setSubmitState('queued')
      if (queuedTimerRef.current) clearTimeout(queuedTimerRef.current)
      queuedTimerRef.current = setTimeout(() => setSubmitState('idle'), 3000)
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : 'Failed to queue job')
      setSubmitState('error')
    }
  }

  function renderItem({ item }: { item: Document }) {
    const displayTitle = item.title?.trim() ? item.title : item.canonical_url
    return (
      <Pressable
        style={({ pressed }) => [s.item, pressed && s.itemPressed]}
        onPress={() => router.push(`/document/${item.id}`)}
      >
        <Text style={s.itemTitle} numberOfLines={2}>
          {displayTitle}
        </Text>
        <Text style={s.itemUrl} numberOfLines={1}>
          {item.canonical_url}
        </Text>
        <Text style={s.itemDate}>Fetched {formatDate(item.fetched_at)}</Text>
      </Pressable>
    )
  }

  if (status === 'loading') {
    return (
      <SafeAreaView style={s.screen}>
        <ActivityIndicator color={theme.colors.accent} size="large" />
      </SafeAreaView>
    )
  }

  if (status === 'disconnected' && connError) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.centered}>
          <Text style={s.errorText}>{connError}</Text>
          <Pressable onPress={probe} style={s.retryBtn}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={s.screen}>
      {/* URL submit row */}
      <View style={s.addRow}>
        <TextInput
          style={s.urlInputField}
          placeholder="https://example.com/article"
          placeholderTextColor={theme.colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={urlInput}
          onChangeText={setUrlInput}
          onSubmitEditing={handleSubmitUrl}
          returnKeyType="send"
        />
        <Pressable
          style={({ pressed }) => [
            s.addButton,
            submitState === 'submitting' && s.addButtonDisabled,
            pressed && s.addButtonPressed,
          ]}
          onPress={handleSubmitUrl}
          disabled={submitState === 'submitting'}
        >
          {submitState === 'submitting' ? (
            <ActivityIndicator color={theme.colors.background} size="small" />
          ) : (
            <Text style={s.addButtonText}>Add URL</Text>
          )}
        </Pressable>
      </View>

      {/* Feedback row */}
      {submitState === 'queued' && (
        <View style={s.feedbackRow}>
          <Text style={s.feedbackQueued}>Queued!</Text>
        </View>
      )}
      {submitState === 'error' && submitError && (
        <View style={s.feedbackRow}>
          <Text style={s.feedbackError}>{submitError}</Text>
        </View>
      )}

      {/* Document list */}
      {fetchLoading && !refreshing ? (
        <View style={s.centered}>
          <ActivityIndicator color={theme.colors.accent} size="large" />
        </View>
      ) : fetchError ? (
        <View style={s.centered}>
          <Text style={s.errorText}>{fetchError}</Text>
          <Pressable onPress={() => loadDocuments()} style={s.retryBtn}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={documents}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={documents.length === 0 ? s.emptyContainer : s.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadDocuments(true)}
              tintColor={theme.colors.accent}
            />
          }
          ListEmptyComponent={
            <Text style={s.emptyText}>No documents yet. Add a URL above.</Text>
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
    screen: {
      flex: 1,
      backgroundColor: t.colors.background,
    },
    addRow: {
      flexDirection: 'row',
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      gap: t.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
      backgroundColor: t.colors.surface,
    },
    urlInputField: {
      flex: 1,
      backgroundColor: t.colors.background,
      color: t.colors.text,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      fontSize: 14,
    },
    addButton: {
      backgroundColor: t.colors.accent,
      borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      justifyContent: 'center',
      alignItems: 'center',
      minWidth: 80,
    },
    addButtonDisabled: { opacity: 0.6 },
    addButtonPressed: { opacity: 0.85 },
    addButtonText: { color: t.colors.background, fontSize: 14, fontWeight: '700' },
    feedbackRow: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.xs,
      backgroundColor: t.colors.surface,
    },
    feedbackQueued: { color: t.colors.online, fontSize: 13, fontWeight: '600' },
    feedbackError: { color: t.colors.error, fontSize: 13 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errorText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    listContent: { paddingVertical: t.spacing.xs },
    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    emptyText: { color: t.colors.muted, fontSize: 15, textAlign: 'center' },
    separator: { height: 1, backgroundColor: t.colors.border, marginLeft: t.spacing.md },
    item: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.md,
      backgroundColor: t.colors.background,
    },
    itemPressed: { backgroundColor: t.colors.surface },
    itemTitle: { color: t.colors.text, fontSize: 15, fontWeight: '600', lineHeight: 20, marginBottom: 2 },
    itemUrl: { color: t.colors.muted, fontSize: 12, fontFamily: 'monospace', marginBottom: 2 },
    itemDate: { color: t.colors.placeholder, fontSize: 11 },
  })
}
