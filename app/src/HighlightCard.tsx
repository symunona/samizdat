import { useMemo, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import type { Highlight } from './api'
import MarkdownBody from './MarkdownBody'

const MAX_BODY_HEIGHT = 400

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

  const [contentHeight, setContentHeight] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const isClipped = contentHeight > MAX_BODY_HEIGHT

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

      <View style={[s.bodyClip, isClipped && s.bodyClipMax]}>
        <View onLayout={e => setContentHeight(e.nativeEvent.layout.height)}>
          <MarkdownBody linkedDocuments={linkedDocuments} onDocumentPress={onDocumentPress}>
            {item.body}
          </MarkdownBody>
        </View>
        {isClipped && (
          <Pressable style={s.expandOverlay} onPress={() => setModalOpen(true)}>
            <Text style={s.expandText}>Tap to expand</Text>
          </Pressable>
        )}
      </View>

      {modalOpen && (
        <Modal transparent animationType="fade" onRequestClose={() => setModalOpen(false)}>
          <Pressable style={s.modalBackdrop} onPress={() => setModalOpen(false)}>
            <Pressable style={s.modalSheet} onPress={() => {}}>
              <View style={s.modalHeader}>
                <Text style={s.modalTitle} numberOfLines={2}>{item.title}</Text>
                <Pressable style={s.modalCloseBtn} onPress={() => setModalOpen(false)} hitSlop={10}>
                  <Text style={s.modalCloseText}>✕</Text>
                </Pressable>
              </View>
              <ScrollView style={s.modalScroll} contentContainerStyle={s.modalScrollContent}>
                <MarkdownBody linkedDocuments={linkedDocuments} onDocumentPress={(id) => { setModalOpen(false); onDocumentPress?.(id) }}>
                  {item.body}
                </MarkdownBody>
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
      )}

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
    bodyClip: { overflow: 'hidden' },
    bodyClipMax: { maxHeight: MAX_BODY_HEIGHT },
    expandOverlay: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: 60,
      backgroundColor: 'transparent',
      alignItems: 'center',
      justifyContent: 'flex-end',
      paddingBottom: 4,
    },
    expandText: {
      color: t.colors.accent,
      fontSize: 12,
      fontWeight: '700',
      backgroundColor: t.colors.surface,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: t.colors.accent,
      overflow: 'hidden',
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      justifyContent: 'flex-end',
    },
    modalSheet: {
      backgroundColor: t.colors.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      maxHeight: '85%',
      paddingTop: 16,
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: 16,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
      gap: 8,
    },
    modalTitle: { flex: 1, color: t.colors.text, fontSize: 15, fontWeight: '700' },
    modalCloseBtn: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },
    modalCloseText: { color: t.colors.muted, fontSize: 18 },
    modalScroll: { flexShrink: 1 },
    modalScrollContent: { padding: 16 },
  })
}
