import { useMemo } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useUnistyles } from 'react-native-unistyles'
import type { ContextMenuItem, ContextMenuKind } from './api'

interface Props {
  visible: boolean
  /** The selected text, echoed at the top so the sheet says what it will act on. */
  selection: string
  items: ContextMenuItem[]
  /** True while the config is still being read (server or replica cache). */
  loading?: boolean
  onPick: (item: ContextMenuItem) => void
  onClose: () => void
}

const ICONS: Record<ContextMenuKind, keyof typeof Ionicons.glyphMap> = {
  copy: 'copy-outline',
  web_search: 'search-outline',
  translate: 'language-outline',
  ask: 'sparkles-outline',
}

// The "···" next to Annotate opens this. The menu is RN, not DOM: its actions need
// the clipboard shim, the network and a model config, none of which exist inside
// the document WebView — so the viewer only reports the selection and the host
// renders the choices. A sheet (rather than a popover anchored to the button) is
// the same affordance on native and web, with no iframe→RN coordinate math.
export default function SelectionMenuSheet({ visible, selection, items, loading, onPick, onClose }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])

  if (!visible) return null

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable style={s.sheet} onPress={e => e.stopPropagation()}>
          <Text style={s.quote} numberOfLines={3} ellipsizeMode="tail">{selection}</Text>
          <ScrollView style={s.list} contentContainerStyle={s.listContent}>
            {items.map(item => (
              <Pressable key={item.id} style={s.row} onPress={() => onPick(item)} testID={`ctxmenu-${item.id}`}>
                <Ionicons name={ICONS[item.kind]} size={18} color={theme.colors.accent} />
                <Text style={s.rowText} numberOfLines={1}>{item.title}</Text>
              </Pressable>
            ))}
            {items.length === 0 && (
              <Text style={s.empty}>
                {loading ? 'Loading actions…' : 'No actions enabled — add them in Settings → Context Menu.'}
              </Text>
            )}
          </ScrollView>
          <View style={s.footer}>
            <Pressable style={s.cancel} onPress={onClose}>
              <Text style={s.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: t.colors.surface,
      borderTopLeftRadius: 14, borderTopRightRadius: 14,
      borderTopWidth: 1, borderTopColor: t.colors.border,
      padding: t.spacing.lg,
      paddingBottom: t.spacing.xl,
      gap: t.spacing.sm,
      // Never taller than the screen: the action list scrolls inside instead.
      maxHeight: '85%' as unknown as number,
    },
    quote: {
      borderLeftWidth: 3, borderLeftColor: t.colors.accent,
      paddingLeft: t.spacing.sm,
      color: t.colors.muted, fontStyle: 'italic', fontSize: 13, lineHeight: 18,
    },
    list: { flexShrink: 1 },
    listContent: { gap: 2 },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: t.spacing.md,
      paddingVertical: t.spacing.md, paddingHorizontal: t.spacing.sm,
      borderRadius: t.radius.sm,
    },
    rowText: { flex: 1, color: t.colors.text, fontSize: 15, fontWeight: '600' },
    empty: { color: t.colors.muted, fontSize: 13, paddingVertical: t.spacing.md },
    footer: { alignItems: 'center' },
    cancel: { paddingVertical: t.spacing.sm },
    cancelText: { color: t.colors.muted, fontSize: 14 },
  })
}
