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
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { useConnection } from '../../src/ConnectionContext'
import { useAnnotations, useSyncStatus, type AnnotationWithContext } from '../../src/store/hooks'
import { forceSync } from '../../src/store/syncEngine'
import * as mut from '../../src/store/mutations'
import AnnotationPanel, { type ExistingAnnotation } from '../../src/AnnotationPanel'
import TagSelectorModal from '../../src/TagSelectorModal'

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

export default function NotesScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { activeUrl, token, status } = useConnection()

  const notes = useAnnotations()
  const { status: syncStatus, error: syncError } = useSyncStatus()
  const [refreshing, setRefreshing] = useState(false)

  // Editor state: panel for create/edit, plus the tag modal target.
  const [panelOpen, setPanelOpen] = useState(false)
  const [editing, setEditing] = useState<ExistingAnnotation | null>(null)
  const [tagFor, setTagFor] = useState<string | null>(null)

  const ready = !!activeUrl && !!token

  async function refresh() {
    if (!ready) return
    setRefreshing(true)
    try {
      await forceSync(activeUrl, token)
    } finally {
      setRefreshing(false)
    }
  }

  function openCreate() {
    setEditing(null)
    setPanelOpen(true)
  }

  // Standalone notes edit in place; document-anchored annotations open their
  // source document scrolled to the anchor (webview focuses mark[data-ann-id]).
  function openItem(n: AnnotationWithContext) {
    if (n.document_id) {
      router.push(`/document/${n.document_id}?from=/notes&highlight=${n.id}`)
      return
    }
    setEditing({ id: n.id, exact: '', note: n.note, color: n.color })
    setPanelOpen(true)
  }

  // Local-first: the list reads from the store (useAnnotations), so a store mutation
  // reflects instantly with no network; the outbox pusher syncs it when online.
  function handleSave(data: { note: string; color: string }) {
    setPanelOpen(false)
    if (editing) {
      mut.updateAnnotation(editing.id, data.note, data.color)
    } else {
      mut.createAnnotation({ documentId: null, note: data.note, color: data.color })
    }
  }

  function handleDelete() {
    if (!editing) return
    setPanelOpen(false)
    mut.deleteAnnotation(editing.id)
  }

  function handleTag(annotationId: string) {
    setPanelOpen(false)
    setTagFor(annotationId)
  }

  function closeTagModal() {
    setTagFor(null)
  }

  function renderItem({ item }: { item: AnnotationWithContext }) {
    const anchored = !!item.document_id
    const preview = item.note.trim() || (anchored ? '' : '(empty note)')
    return (
      <Pressable style={s.item} onPress={() => openItem(item)}>
        {anchored && item.exact.trim().length > 0 && (
          <Text style={s.itemQuote} numberOfLines={3}>{item.exact.trim()}</Text>
        )}
        {preview.length > 0 && (
          <Text style={s.itemNote} numberOfLines={4}>{preview}</Text>
        )}
        {anchored && (
          <View style={s.sourceRow}>
            <Ionicons name="document-text-outline" size={13} color={theme.colors.muted} />
            <Text style={s.sourceText} numberOfLines={1}>{item.docTitle ?? 'Source document'}</Text>
            <Ionicons name="chevron-forward" size={13} color={theme.colors.muted} />
          </View>
        )}
        {item.tags.length > 0 && (
          <View style={s.chips}>
            {item.tags.map((t) => (
              <View key={t.id} style={s.chip}>
                <View style={[s.dot, { backgroundColor: tagDotColor(t.color) }]} />
                <Text style={s.chipText}>{t.name}</Text>
              </View>
            ))}
          </View>
        )}
      </Pressable>
    )
  }

  const loading = status === 'loading' || (syncStatus === 'syncing' && notes.length === 0)

  return (
    <SafeAreaView style={s.screen}>
      {loading ? (
        <View style={s.centered}><ActivityIndicator color={theme.colors.accent} size="large" /></View>
      ) : syncStatus === 'error' && notes.length === 0 ? (
        <View style={s.centered}>
          <Text style={s.errorText}>{syncError ?? 'Sync failed'}</Text>
          <Pressable onPress={refresh} style={s.retryBtn}><Text style={s.retryText}>Retry</Text></Pressable>
        </View>
      ) : (
        <FlatList
          data={notes}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={notes.length === 0 ? s.emptyContainer : s.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.colors.accent} />
          }
          ListEmptyComponent={
            <Text style={s.emptyText}>No notes or annotations yet. Tap + to write a note, or highlight text in a document.</Text>
          }
          ItemSeparatorComponent={() => <View style={s.separator} />}
        />
      )}

      {/* Create-note FAB */}
      <Pressable style={s.fab} onPress={openCreate} accessibilityLabel="New note" hitSlop={8}>
        <Ionicons name="add" size={28} color={theme.colors.background} />
      </Pressable>

      <AnnotationPanel
        visible={panelOpen}
        mode={editing ? 'edit' : 'create'}
        existing={editing ?? undefined}
        onSave={handleSave}
        onDelete={editing ? handleDelete : undefined}
        onCancel={() => setPanelOpen(false)}
        onTag={handleTag}
      />

      {tagFor && (
        <TagSelectorModal
          visible={!!tagFor}
          objectId={tagFor}
          objectType="annotation"
          onClose={closeTagModal}
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
    listContent: { paddingVertical: t.spacing.xs, maxWidth: 800, alignSelf: 'center', width: '100%' },
    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl, maxWidth: 800, alignSelf: 'center', width: '100%' },
    emptyText: { color: t.colors.muted, fontSize: 15, textAlign: 'center', lineHeight: 22 },
    separator: { height: 1, backgroundColor: t.colors.border, marginLeft: t.spacing.md },
    item: { paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.md, backgroundColor: t.colors.background, gap: t.spacing.sm },
    itemQuote: {
      color: t.colors.text, fontSize: 14, lineHeight: 20, fontStyle: 'italic',
      borderLeftWidth: 3, borderLeftColor: t.colors.border, paddingLeft: t.spacing.sm,
    },
    itemNote: { color: t.colors.text, fontSize: 15, lineHeight: 21 },
    sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    sourceText: { color: t.colors.muted, fontSize: 12, flexShrink: 1 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs, alignItems: 'center' },
    chip: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      backgroundColor: t.colors.surface, borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.sm, paddingVertical: 3,
      borderWidth: 1, borderColor: t.colors.border,
    },
    dot: { width: 8, height: 8, borderRadius: 4 },
    chipText: { color: t.colors.muted, fontSize: 11, fontWeight: '600' },
    fab: {
      position: 'absolute', right: 20, bottom: 28,
      width: 56, height: 56, borderRadius: 28,
      backgroundColor: t.colors.accent, alignItems: 'center', justifyContent: 'center',
      shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 5, elevation: 6,
    },
  })
}
