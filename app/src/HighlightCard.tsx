import { useMemo } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import type { Highlight } from './api'
import MarkdownBody from './MarkdownBody'

type Props = {
  item: Highlight
  linkedDocuments?: Record<string, string>
  onPress?: () => void
  onPin?: () => void
  onDelete?: () => void
  onAnnotate?: () => void
  onTags?: () => void
  onDocumentPress?: (docId: string) => void
  busy?: boolean
  pinned?: boolean
}

export default function HighlightCard({
  item, linkedDocuments, onPress, onPin, onDelete, onAnnotate, onTags, onDocumentPress, busy, pinned,
}: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const kindColor = useMemo(() => ({
    summary: theme.colors.accent,
    link: '#6b8cff',
    note: '#b8a0ff',
  } as Record<string, string>), [theme])

  return (
    <Pressable style={[s.card, pinned && s.cardPinned]} onPress={onPress}>
      <View style={s.cardHeader}>
        <View style={[s.kindBadge, { backgroundColor: kindColor[item.kind] ?? '#888' }]}>
          <Text style={s.kindText}>{item.kind}</Text>
        </View>
        <Text style={s.hlTitle} numberOfLines={1}>{item.title}</Text>
        {busy
          ? <ActivityIndicator size="small" color={theme.colors.accent} />
          : onPin
            ? <Pressable style={s.starBtn} onPress={onPin} hitSlop={8}>
                <Text style={[s.starIcon, pinned && s.starIconActive]}>
                  {pinned ? '★' : '☆'}
                </Text>
              </Pressable>
            : null}
      </View>

      <MarkdownBody linkedDocuments={linkedDocuments} onDocumentPress={onDocumentPress}>
        {item.body}
      </MarkdownBody>

      <View style={s.cardFooter}>
        <Pressable style={s.deleteBtn} onPress={onDelete} hitSlop={6}>
          <Text style={s.deleteBtnText}>🗑</Text>
        </Pressable>
        <View style={s.footerSpacer} />
        {onAnnotate
          ? <Pressable style={s.footerBtn} onPress={onAnnotate} hitSlop={6}>
              <Text style={s.footerBtnText}>✏</Text>
            </Pressable>
          : null}
        {onTags
          ? <Pressable style={s.footerBtn} onPress={onTags} hitSlop={6}>
              <Text style={s.footerBtnText}># Tags</Text>
            </Pressable>
          : null}
      </View>
    </Pressable>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    card: {
      backgroundColor: t.colors.surface,
      borderRadius: 10,
      padding: 14,
      borderWidth: 1,
      borderColor: t.colors.border,
      gap: 8,
    },
    cardPinned: {
      borderColor: t.colors.accent,
      borderWidth: 2,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    kindBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
    kindText: { color: '#fff', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
    hlTitle: { flex: 1, color: t.colors.text, fontSize: 13, fontWeight: '600' },
    starBtn: { padding: 2 },
    starIcon: { fontSize: 18, color: t.colors.muted },
    starIconActive: { color: '#facc15' },
    cardFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: 1,
      borderTopColor: t.colors.border,
      paddingTop: 8,
      marginTop: 2,
      gap: 6,
    },
    footerSpacer: { flex: 1 },
    deleteBtn: {
      width: 30,
      height: 30,
      borderRadius: 6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    deleteBtnText: { fontSize: 16 },
    footerBtn: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 6,
      backgroundColor: t.colors.background,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    footerBtnText: { color: t.colors.muted, fontSize: 12, fontWeight: '600' },
  })
}
