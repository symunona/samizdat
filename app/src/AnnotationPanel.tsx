import { useMemo, useState } from 'react'
import {
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

const COLORS = ['yellow', 'green', 'blue', 'pink'] as const
type AnnotationColor = typeof COLORS[number]

const COLOR_HEX: Record<AnnotationColor, string> = {
  yellow: '#fde68a',
  green:  '#bbf7d0',
  blue:   '#bfdbfe',
  pink:   '#fbcfe8',
}

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
  pending?: PendingSelection
  existing?: ExistingAnnotation
  onSave: (data: { note: string; color: string }) => void
  onDelete?: () => void
  onCancel: () => void
}

export default function AnnotationPanel({ visible, mode, pending, existing, onSave, onDelete, onCancel }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const [note, setNote] = useState(existing?.note ?? '')
  const [color, setColor] = useState<AnnotationColor>((existing?.color as AnnotationColor) ?? 'yellow')

  // Reset when panel opens
  useMemo(() => {
    if (visible) {
      setNote(existing?.note ?? '')
      setColor((existing?.color as AnnotationColor) ?? 'yellow')
    }
  }, [visible, existing])

  const quote = mode === 'create' ? pending?.exact : existing?.exact

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <TouchableWithoutFeedback onPress={onCancel}>
        <View style={s.backdrop} />
      </TouchableWithoutFeedback>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.kvContainer}>
        <View style={s.panel}>
          <View style={s.handle} />
          {quote ? (
            <Text style={s.quote} numberOfLines={3}>"{quote}"</Text>
          ) : null}

          {/* Color picker */}
          <View style={s.colorRow}>
            {COLORS.map((c) => (
              <Pressable
                key={c}
                style={[s.colorDot, { backgroundColor: COLOR_HEX[c] }, color === c && s.colorDotSelected]}
                onPress={() => setColor(c)}
              />
            ))}
          </View>

          {/* Note input */}
          <TextInput
            style={s.noteInput}
            placeholder="Add a note… (optional)"
            placeholderTextColor={theme.colors.placeholder}
            multiline
            value={note}
            onChangeText={setNote}
            autoFocus
            returnKeyType="done"
            blurOnSubmit
          />

          {/* Actions */}
          <View style={s.actions}>
            {mode === 'edit' && onDelete ? (
              <Pressable style={s.deleteBtn} onPress={onDelete}>
                <Text style={s.deleteBtnText}>Delete</Text>
              </Pressable>
            ) : (
              <Pressable style={s.cancelBtn} onPress={onCancel}>
                <Text style={s.cancelBtnText}>Cancel</Text>
              </Pressable>
            )}
            <Pressable style={s.saveBtn} onPress={() => { Keyboard.dismiss(); onSave({ note, color }) }}>
              <Text style={s.saveBtnText}>{mode === 'create' ? 'Save annotation' : 'Update'}</Text>
            </Pressable>
          </View>
          {mode === 'edit' && (
            <Pressable style={[s.cancelBtn, { marginTop: 8 }]} onPress={onCancel}>
              <Text style={s.cancelBtnText}>Cancel</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
    kvContainer: { justifyContent: 'flex-end' },
    panel: {
      backgroundColor: t.colors.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      padding: t.spacing.lg,
      paddingBottom: 32,
      gap: t.spacing.md,
    },
    handle: { width: 36, height: 4, backgroundColor: t.colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 4 },
    quote: { color: t.colors.muted, fontSize: 13, fontStyle: 'italic', lineHeight: 18, borderLeftWidth: 2, borderLeftColor: t.colors.accent, paddingLeft: 10 },
    colorRow: { flexDirection: 'row', gap: 12 },
    colorDot: { width: 28, height: 28, borderRadius: 14 },
    colorDotSelected: { borderWidth: 2.5, borderColor: t.colors.text },
    noteInput: {
      backgroundColor: t.colors.background,
      color: t.colors.text,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
      padding: t.spacing.md,
      fontSize: 15,
      minHeight: 80,
      textAlignVertical: 'top',
    },
    actions: { flexDirection: 'row', gap: t.spacing.sm },
    saveBtn: { flex: 1, backgroundColor: t.colors.accent, borderRadius: t.radius.sm, padding: t.spacing.sm, alignItems: 'center' },
    saveBtnText: { color: t.colors.background, fontSize: 15, fontWeight: '700' },
    cancelBtn: { backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.sm, padding: t.spacing.sm, alignItems: 'center', minWidth: 80 },
    cancelBtnText: { color: t.colors.muted, fontSize: 15 },
    deleteBtn: { backgroundColor: '#450a0a', borderRadius: t.radius.sm, padding: t.spacing.sm, alignItems: 'center', minWidth: 80 },
    deleteBtnText: { color: t.colors.error, fontSize: 15, fontWeight: '600' },
  })
}
