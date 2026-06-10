import { useCallback, useEffect, useMemo, useState } from 'react'
import { createLogger } from './logger'

const log = createLogger('TagSelectorModal')
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useConnection } from './ConnectionContext'
import {
  fetchTags,
  fetchDocumentTags,
  fetchAnnotationTags,
  fetchHighlightTags,
  addDocumentTag,
  removeDocumentTag,
  addAnnotationTag,
  removeAnnotationTag,
  addHighlightTag,
  removeHighlightTag,
  createTag,
} from './api'
import type { Tag } from './api'

type Props = {
  visible: boolean
  objectId: string
  objectType: 'document' | 'annotation' | 'highlight'
  onClose: () => void
}

const TAG_COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']

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

export default function TagSelectorModal({ visible, objectId, objectType, onClose }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { activeUrl, token } = useConnection()

  const [allTags, setAllTags] = useState<Tag[]>([])
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [toggling, setToggling] = useState<Set<string>>(new Set())

  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('default')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    if (!activeUrl || !token || !objectId) return
    setLoading(true)
    try {
      const [all, applied] = await Promise.all([
        fetchTags(activeUrl, token),
        objectType === 'document'
          ? fetchDocumentTags(activeUrl, token, objectId)
          : objectType === 'annotation'
            ? fetchAnnotationTags(activeUrl, token, objectId)
            : fetchHighlightTags(activeUrl, token, objectId),
      ])
      setAllTags(all)
      setAppliedIds(new Set(applied.map(t => t.id)))
    } catch (e) {
      log.error('load error', e)
    } finally {
      setLoading(false)
    }
  }, [activeUrl, token, objectId, objectType])

  useEffect(() => {
    if (visible) {
      setNewTagName('')
      setNewTagColor('default')
      load()
    }
  }, [visible, load])

  const toggleTag = useCallback(async (tag: Tag) => {
    if (!activeUrl || !token) return
    const applied = appliedIds.has(tag.id)
    setToggling(prev => new Set(prev).add(tag.id))
    try {
      if (applied) {
        if (objectType === 'document') {
          await removeDocumentTag(activeUrl, token, objectId, tag.id)
        } else if (objectType === 'annotation') {
          await removeAnnotationTag(activeUrl, token, objectId, tag.id)
        } else {
          await removeHighlightTag(activeUrl, token, objectId, tag.id)
        }
        setAppliedIds(prev => { const s = new Set(prev); s.delete(tag.id); return s })
      } else {
        if (objectType === 'document') {
          await addDocumentTag(activeUrl, token, objectId, tag.id)
        } else if (objectType === 'annotation') {
          await addAnnotationTag(activeUrl, token, objectId, tag.id)
        } else {
          await addHighlightTag(activeUrl, token, objectId, tag.id)
        }
        setAppliedIds(prev => new Set(prev).add(tag.id))
      }
    } catch (e) {
      log.error('toggleTag', e)
    } finally {
      setToggling(prev => { const s = new Set(prev); s.delete(tag.id); return s })
    }
  }, [activeUrl, token, objectId, objectType, appliedIds])

  const handleCreateTag = useCallback(async () => {
    if (!activeUrl || !token || !newTagName.trim()) return
    setCreating(true)
    try {
      const tag = await createTag(activeUrl, token, { name: newTagName.trim(), color: newTagColor })
      setAllTags(prev => [tag, ...prev])
      setNewTagName('')
      if (objectType === 'document') {
        await addDocumentTag(activeUrl, token, objectId, tag.id)
      } else if (objectType === 'annotation') {
        await addAnnotationTag(activeUrl, token, objectId, tag.id)
      } else {
        await addHighlightTag(activeUrl, token, objectId, tag.id)
      }
      setAppliedIds(prev => new Set(prev).add(tag.id))
    } catch (e) {
      log.error('createTag', e)
    } finally {
      setCreating(false)
    }
  }, [activeUrl, token, newTagName, newTagColor, objectId, objectType])

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.overlay}>
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={s.backdrop} />
        </TouchableWithoutFeedback>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.kav}>
        <View style={s.panel}>
          <View style={s.handle} />
          <View style={s.header}>
            <Text style={s.title}>Tags</Text>
            <Pressable onPress={onClose} style={s.xBtn} hitSlop={10}>
              <Text style={s.xBtnText}>✕</Text>
            </Pressable>
          </View>

          {loading ? (
            <View style={s.loadingRow}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : (
            <FlatList
              data={allTags}
              keyExtractor={item => item.id}
              style={s.list}
              renderItem={({ item }) => {
                const isApplied = appliedIds.has(item.id)
                const isToggling = toggling.has(item.id)
                return (
                  <Pressable
                    style={[s.tagRow, isApplied && s.tagRowApplied]}
                    onPress={() => toggleTag(item)}
                    disabled={isToggling}
                  >
                    <View style={[s.dot, { backgroundColor: tagDotColor(item.color) }]} />
                    <Text style={[s.tagName, isApplied && s.tagNameApplied]}>{item.name}</Text>
                    {isToggling ? (
                      <ActivityIndicator size="small" color={theme.colors.accent} />
                    ) : isApplied ? (
                      <Text style={s.check}>✓</Text>
                    ) : null}
                  </Pressable>
                )
              }}
              ListEmptyComponent={
                <Text style={s.emptyText}>No tags yet. Create one below.</Text>
              }
            />
          )}

          <View style={s.createSection}>
            <Text style={s.createLabel}>New tag</Text>
            <View style={s.createRow}>
              <TextInput
                style={s.createInput}
                placeholder="Tag name…"
                placeholderTextColor={theme.colors.placeholder}
                value={newTagName}
                onChangeText={setNewTagName}
                returnKeyType="done"
                onSubmitEditing={handleCreateTag}
              />
              <Pressable
                style={[s.createBtn, (!newTagName.trim() || creating) && s.createBtnDisabled]}
                onPress={handleCreateTag}
                disabled={!newTagName.trim() || creating}
              >
                {creating ? (
                  <ActivityIndicator size="small" color={theme.colors.background} />
                ) : (
                  <Text style={s.createBtnText}>＋</Text>
                )}
              </Pressable>
            </View>
            <View style={s.colorRow}>
              {TAG_COLORS.map(c => (
                <Pressable
                  key={c}
                  style={[s.colorDot, { backgroundColor: tagDotColor(c) }, newTagColor === c && s.colorDotSelected]}
                  onPress={() => setNewTagColor(c)}
                />
              ))}
            </View>
          </View>
        </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    overlay: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)' },
    kav: { width: '100%' as unknown as number },
    panel: {
      backgroundColor: t.colors.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingHorizontal: t.spacing.lg,
      paddingBottom: 40,
      maxHeight: '85%' as unknown as number,
    },
    handle: {
      width: 36,
      height: 4,
      backgroundColor: t.colors.border,
      borderRadius: 2,
      alignSelf: 'center',
      marginTop: 10,
      marginBottom: t.spacing.sm,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: t.spacing.md,
    },
    title: { flex: 1, color: t.colors.text, fontSize: 16, fontWeight: '700' },
    xBtn: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: t.colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    xBtnText: { color: t.colors.muted, fontSize: 14, fontWeight: '600' },
    loadingRow: { paddingVertical: t.spacing.xl, alignItems: 'center' },
    list: { minHeight: 200, maxHeight: 440 },
    tagRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: t.spacing.sm + 2,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radius.sm,
      gap: t.spacing.sm,
    },
    tagRowApplied: { backgroundColor: t.colors.background },
    dot: { width: 12, height: 12, borderRadius: 6 },
    tagName: { flex: 1, color: t.colors.muted, fontSize: 15 },
    tagNameApplied: { color: t.colors.text, fontWeight: '600' },
    check: { color: t.colors.accent, fontSize: 16, fontWeight: '700' },
    emptyText: { color: t.colors.muted, fontSize: 14, textAlign: 'center', paddingVertical: t.spacing.md },
    createSection: {
      borderTopWidth: 1,
      borderTopColor: t.colors.border,
      paddingTop: t.spacing.md,
      gap: t.spacing.sm,
    },
    createLabel: { color: t.colors.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
    createRow: { flexDirection: 'row', gap: t.spacing.sm },
    createInput: {
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
    createBtn: {
      backgroundColor: t.colors.accent,
      borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 44,
    },
    createBtnDisabled: { opacity: 0.4 },
    createBtnText: { color: t.colors.background, fontSize: 18, fontWeight: '700', lineHeight: 22 },
    colorRow: { flexDirection: 'row', gap: t.spacing.sm, flexWrap: 'wrap' },
    colorDot: { width: 24, height: 24, borderRadius: 12 },
    colorDotSelected: { borderWidth: 2, borderColor: t.colors.text },
  })
}
