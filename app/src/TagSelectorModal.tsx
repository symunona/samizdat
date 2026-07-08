import { useCallback, useEffect, useMemo, useState } from 'react'
import {
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
import { useSyncStore } from './store/syncStore'
import * as mut from './store/mutations'
import type { JunctionType } from './store/outbox'
import type { Tag } from './api'
import { TAG_COLORS, tagColor } from './tagColor'

type Props = {
  visible: boolean
  objectId: string
  objectType: 'document' | 'annotation' | 'highlight'
  onClose: () => void
  // Fires with the object's full applied-tag list after every add/remove/create,
  // so the caller can patch its list in place (the modal doesn't refetch the feed).
  onChanged?: (objectId: string, tags: Tag[]) => void
}

const TYPE_MAP: Record<Props['objectType'], JunctionType> = {
  document: 'doc', annotation: 'ann', highlight: 'hl',
}
const SLICE: Record<Props['objectType'], 'documentTags' | 'annotationTags' | 'highlightTags'> = {
  document: 'documentTags', annotation: 'annotationTags', highlight: 'highlightTags',
}

// Store-driven + local-first: tags and their applications are read straight from the
// synced store and mutated through the outbox, so tagging works offline and the UI
// reacts instantly (no network, no spinners). Selectors follow the CLAUDE.md rule —
// select raw store slices (stable refs) and derive in useMemo, never map fresh objects
// inside a useShallow selector (React #185 crash).
export default function TagSelectorModal({ visible, objectId, objectType, onClose, onChanged }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])

  const tagsMap = useSyncStore((st) => st.tags)
  const junctionMap = useSyncStore((st) => st[SLICE[objectType]])

  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('default')

  useEffect(() => {
    if (visible) { setNewTagName(''); setNewTagColor('default') }
  }, [visible])

  const allTags = useMemo(
    () => Object.values(tagsMap).filter((t) => !t.deleted_at).sort((a, b) => a.name.localeCompare(b.name)),
    [tagsMap],
  )
  const appliedIds = useMemo(() => new Set(junctionMap[objectId] ?? []), [junctionMap, objectId])

  // Resolve the object's current applied tags from the store and notify the caller.
  const emitChanged = useCallback(() => {
    if (!onChanged) return
    const st = useSyncStore.getState()
    const ids = st[SLICE[objectType]][objectId] ?? []
    const tags = ids.map((tid) => st.tags[tid]).filter((t): t is Tag => !!t && !t.deleted_at)
    onChanged(objectId, tags)
  }, [onChanged, objectId, objectType])

  const toggleTag = useCallback((tag: Tag) => {
    const type = TYPE_MAP[objectType]
    if (appliedIds.has(tag.id)) mut.removeTag(type, objectId, tag.id)
    else mut.addTag(type, objectId, tag.id)
    emitChanged()
  }, [appliedIds, objectId, objectType, emitChanged])

  const handleCreateTag = useCallback(() => {
    const name = newTagName.trim()
    if (!name) return
    const tag = mut.createTag({ name, color: newTagColor })
    mut.addTag(TYPE_MAP[objectType], objectId, tag.id)
    setNewTagName('')
    emitChanged()
  }, [newTagName, newTagColor, objectId, objectType, emitChanged])

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

          <FlatList
            data={allTags}
            keyExtractor={item => item.id}
            style={s.list}
            renderItem={({ item }) => {
              const isApplied = appliedIds.has(item.id)
              return (
                <Pressable
                  style={[s.tagRow, isApplied && s.tagRowApplied]}
                  onPress={() => toggleTag(item)}
                >
                  <View style={[s.dot, { backgroundColor: tagColor(item.color) }]} />
                  <Text style={[s.tagName, isApplied && s.tagNameApplied]}>{item.name}</Text>
                  {isApplied ? <Text style={s.check}>✓</Text> : null}
                </Pressable>
              )
            }}
            ListEmptyComponent={
              <Text style={s.emptyText}>No tags yet. Create one below.</Text>
            }
          />

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
                style={[s.createBtn, !newTagName.trim() && s.createBtnDisabled]}
                onPress={handleCreateTag}
                disabled={!newTagName.trim()}
              >
                <Text style={s.createBtnText}>＋</Text>
              </Pressable>
            </View>
            <View style={s.colorRow}>
              {TAG_COLORS.map(c => (
                <Pressable
                  key={c}
                  style={[s.colorDot, { backgroundColor: tagColor(c) }, newTagColor === c && s.colorDotSelected]}
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
