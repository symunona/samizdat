import { useMemo } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useUnistyles } from 'react-native-unistyles'
import type { ContextMenuItem } from './api'
import { ICONS } from './SelectionMenuSheet'
import IconButton from './IconButton'

interface Props {
  /** The selected text, echoed so the bar says what it will act on. */
  selection: string
  /** Label of the play-from-here pill (the selected line's m:ss); none = no pill. */
  playLabel?: string
  items: ContextMenuItem[]
  loading: boolean
  onPlay: () => void
  onAnnotate: () => void
  onPick: (item: ContextMenuItem) => void
  onClose: () => void
}

// A transcript selection's actions, laid over the player footer: every action at
// once, no "···" step. It lives outside the WebView because the OS selection
// toolbar hugs the selection — wherever the viewer put its own row, the toolbar
// could land on top of it. The bottom of the screen is the one place it never goes.
export default function SelectionBar({ selection, playLabel, items, loading, onPlay, onAnnotate, onPick, onClose }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])

  return (
    <View style={s.bar} testID="selection-bar">
      <View style={s.head}>
        <Text style={s.quote} numberOfLines={1} selectable={false}>{selection}</Text>
        <IconButton name="close" onPress={onClose} color={theme.colors.muted} size={20} accessibilityLabel="Clear selection" />
      </View>
      <View style={s.pills}>
        {playLabel ? (
          <Pressable style={[s.pill, s.pillAccent]} onPress={onPlay} testID="selection-bar-play">
            <Ionicons name="play" size={14} color={theme.colors.background} />
            <Text style={[s.pillText, s.pillTextAccent]} selectable={false}>{playLabel}</Text>
          </Pressable>
        ) : null}
        <Pressable style={[s.pill, s.pillAccent]} onPress={onAnnotate} testID="selection-bar-annotate">
          <Ionicons name="create-outline" size={14} color={theme.colors.background} />
          <Text style={[s.pillText, s.pillTextAccent]} selectable={false}>Annotate</Text>
        </Pressable>
        {items.map(item => (
          <Pressable key={item.id} style={s.pill} onPress={() => onPick(item)} testID={`ctxmenu-${item.id}`}>
            <Ionicons name={ICONS[item.kind]} size={14} color={theme.colors.accent} />
            <Text style={s.pillText} numberOfLines={1} selectable={false}>{item.title}</Text>
          </Pressable>
        ))}
        {loading ? <ActivityIndicator size="small" color={theme.colors.muted} /> : null}
      </View>
    </View>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    // Covers the footer it sits in, growing upward when the pills wrap past it.
    bar: {
      position: 'absolute', left: 0, right: 0, bottom: 0, minHeight: '100%' as unknown as number,
      backgroundColor: t.colors.surface, borderTopWidth: 1, borderTopColor: t.colors.border,
      paddingHorizontal: t.spacing.md, paddingTop: t.spacing.xs, paddingBottom: t.spacing.sm,
      gap: t.spacing.xs, zIndex: 10,
    },
    head: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    quote: {
      flex: 1, borderLeftWidth: 3, borderLeftColor: t.colors.accent, paddingLeft: t.spacing.sm,
      color: t.colors.muted, fontStyle: 'italic', fontSize: 13,
    },
    pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
    pill: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      paddingVertical: 7, paddingHorizontal: 12, borderRadius: 18,
      borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.background,
    },
    pillAccent: { backgroundColor: t.colors.accent, borderColor: t.colors.accent },
    pillText: { color: t.colors.text, fontSize: 13, fontWeight: '600' },
    pillTextAccent: { color: t.colors.background },
  })
}
