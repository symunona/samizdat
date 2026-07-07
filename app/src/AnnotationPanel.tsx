import { useMemo, useRef, useState } from 'react'
import {
  InteractionManager,
  Keyboard,
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

export type PendingSelection = {
  exact: string
  prefix: string
  suffix: string
  pos_start: number
  pos_end: number
}

export type ExistingAnnotation = {
  id: string
  exact: string
  note: string
  color: string
}

type Props = {
  visible: boolean
  mode: 'create' | 'edit'
  existing?: ExistingAnnotation
  onSave: (data: { note: string; color: string }) => void
  onDelete?: () => void
  onCancel: () => void
  onTag?: (annotationId: string) => void
}

export default function AnnotationPanel({ visible, mode, existing, onSave, onDelete, onCancel, onTag }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const [note, setNote] = useState(existing?.note ?? '')
  const [moreOpen, setMoreOpen] = useState(false)
  const inputRef = useRef<TextInput>(null)

  // Native soft-keyboard fix: bare `autoFocus` fires mid slide-animation, so the
  // input focuses (cursor blinks) but the OS never raises the IME until a 2nd tap.
  // Modal `onShow` fires after the entrance settles; focus then reliably shows the
  // keyboard. Web has no such handshake — `autoFocus` alone is enough there.
  function handleShow() {
    if (Platform.OS === 'web') return
    InteractionManager.runAfterInteractions(() => inputRef.current?.focus())
  }

  useMemo(() => {
    if (visible) {
      setNote(existing?.note ?? '')
      setMoreOpen(false)
    }
  }, [visible, existing])

  function handleSave() {
    Keyboard.dismiss()
    onSave({ note, color: existing?.color ?? 'yellow' })
  }

  function handleDelete() {
    setMoreOpen(false)
    onDelete?.()
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onShow={handleShow} onRequestClose={onCancel}>
      <TouchableWithoutFeedback onPress={() => { setMoreOpen(false); onCancel() }}>
        <View style={s.backdrop} />
      </TouchableWithoutFeedback>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.kav}>
        <View style={s.panel}>

          {/* Header */}
          <View style={s.header}>
            <View style={s.handle} />
            <Text style={s.headerTitle}>Annotation</Text>
            <Pressable onPress={onCancel} style={s.xBtn} hitSlop={10}>
              <Text style={s.xBtnText}>✕</Text>
            </Pressable>
          </View>

          {/* Note input */}
          <TextInput
            ref={inputRef}
            style={s.noteInput}
            placeholder="Add a note…"
            placeholderTextColor={theme.colors.placeholder}
            multiline
            value={note}
            onChangeText={setNote}
            autoFocus={Platform.OS === 'web'}
            blurOnSubmit={false}
          />

          {/* Footer row */}
          <View style={s.footer}>

            {/* ··· more menu */}
            <View>
              <Pressable
                style={[s.iconBtn, moreOpen && s.iconBtnActive]}
                onPress={() => setMoreOpen(v => !v)}
                hitSlop={8}
              >
                <Text style={s.iconBtnText}>···</Text>
              </Pressable>
              {moreOpen && onDelete && (
                <View style={s.moreMenu}>
                  <Pressable style={s.deleteMenuItem} onPress={handleDelete}>
                    <Text style={s.deleteMenuText}>🗑  Delete</Text>
                  </Pressable>
                </View>
              )}
            </View>

            {/* Tag button (tagger will wire this up) */}
            <Pressable
              style={s.iconBtn}
              onPress={() => existing?.id && onTag?.(existing.id)}
              hitSlop={8}
            >
              <Text style={s.iconBtnText}>#</Text>
            </Pressable>

            <View style={s.spacer} />

            {/* Primary action */}
            <Pressable style={s.saveBtn} onPress={handleSave}>
              <Text style={s.saveBtnText}>{mode === 'create' ? 'Save' : 'Update'}</Text>
            </Pressable>

          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
    kav: { justifyContent: 'flex-end' },
    panel: {
      backgroundColor: t.colors.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingHorizontal: t.spacing.lg,
      paddingBottom: 32,
      gap: t.spacing.md,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: t.spacing.md,
      gap: t.spacing.sm,
    },
    handle: {
      width: 36,
      height: 4,
      backgroundColor: t.colors.border,
      borderRadius: 2,
      position: 'absolute',
      top: -14,
      alignSelf: 'center',
      left: '50%' as unknown as number,
      marginLeft: -18,
    },
    headerTitle: { flex: 1, color: t.colors.text, fontSize: 16, fontWeight: '700' },
    xBtn: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: t.colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    xBtnText: { color: t.colors.muted, fontSize: 14, fontWeight: '600' },
    noteInput: {
      backgroundColor: t.colors.background,
      color: t.colors.text,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
      padding: t.spacing.md,
      fontSize: 15,
      minHeight: 90,
      textAlignVertical: 'top',
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
    },
    iconBtn: {
      paddingHorizontal: t.spacing.sm + 2,
      paddingVertical: t.spacing.sm,
      borderRadius: t.radius.sm,
      backgroundColor: t.colors.background,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    iconBtnActive: { borderColor: t.colors.accent },
    iconBtnText: { color: t.colors.muted, fontSize: 13, fontWeight: '600' },
    spacer: { flex: 1 },
    saveBtn: {
      backgroundColor: t.colors.accent,
      borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.sm,
      alignItems: 'center',
    },
    saveBtnText: { color: t.colors.background, fontSize: 15, fontWeight: '700' },
    moreMenu: {
      position: 'absolute',
      bottom: 44,
      left: 0,
      backgroundColor: t.colors.surface,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
      paddingVertical: 4,
      minWidth: 130,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -2 },
      shadowOpacity: 0.25,
      shadowRadius: 6,
      elevation: 8,
      zIndex: 100,
    },
    deleteMenuItem: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm + 2,
    },
    deleteMenuText: { color: '#f87171', fontSize: 14, fontWeight: '600' },
  })
}
