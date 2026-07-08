import { useMemo, useState } from 'react'

const CLIP_CHAR_THRESHOLD = 800
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import type { HighlightWithDoc } from './api'
import MarkdownBody from './MarkdownBody'
import NoteEditButton from './NoteEditButton'
import IconButton from './IconButton'
import { isTouchDevice } from './touch'
import { tagColor } from './tagColor'

const MAX_BODY_HEIGHT = 400

type Props = {
  item: HighlightWithDoc
  linkedDocuments?: Record<string, string>
  onPress?: () => void
  onPin?: () => void
  onDelete?: () => void
  onAnnotate?: () => void
  onTags?: () => void
  onDocumentPress?: (docId: string) => void
  onLinkAction?: (url: string) => void
  busy?: boolean
  pinned?: boolean
}

export default function HighlightCard({
  item, linkedDocuments, onPress, onPin, onDelete, onAnnotate, onTags, onDocumentPress, onLinkAction, busy, pinned,
}: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const touch = isTouchDevice()
  const kindColor = useMemo(() => ({
    summary: theme.colors.accent,
    link: '#6b8cff',
    note: '#b8a0ff',
  } as Record<string, string>), [theme])

  const [modalOpen, setModalOpen] = useState(false)
  // Popout navigates to the document at the right place (highlight deep-link); only ✕ closes.
  const goToDoc = () => { setModalOpen(false); onPress?.() }
  const publishedLabel = useMemo(() => {
    if (!item.document_published_at) return null
    const d = new Date(item.document_published_at)
    if (isNaN(d.getTime())) return null
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  }, [item.document_published_at])
  const isClipped = item.body.length > CLIP_CHAR_THRESHOLD || item.body.includes('![')
  // Stabilize by item.id: linked_documents are computed once per highlight and don't change.
  // Prevents new object refs from React Query refetches bypassing MarkdownBody memo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableLinkedDocs = useMemo(() => linkedDocuments, [item.id])

  return (
    <View style={[s.card, pinned && s.cardPinned]}>
      <View style={s.cardHeader}>
        <View style={[s.kindBadge, { backgroundColor: kindColor[item.kind] ?? '#888' }]}>
          <Text style={s.kindText}>{item.kind}</Text>
        </View>
        <Pressable style={s.titlePress} onPress={onPress}>
          <Text style={s.hlTitle} numberOfLines={1}>{item.title}</Text>
        </Pressable>
        {busy
          ? <ActivityIndicator size="small" color={theme.colors.accent} />
          : onPin && !touch
            ? <Pressable style={s.starBtn} onPress={onPin} hitSlop={8}>
                <Text style={[s.starIcon, pinned && s.starIconActive]}>
                  {pinned ? '★' : '☆'}
                </Text>
              </Pressable>
            : null}
      </View>

      <Pressable style={s.bodyClipMax} onPress={() => setModalOpen(true)}>
        <View>
          <MarkdownBody linkedDocuments={stableLinkedDocs} onDocumentPress={onDocumentPress} onLinkAction={onLinkAction}>
            {item.body}
          </MarkdownBody>
        </View>
        {isClipped && (
          <Pressable style={s.expandOverlay} onPress={() => setModalOpen(true)}>
            <Text style={s.expandText}>More…</Text>
          </Pressable>
        )}
      </Pressable>

      {modalOpen && (
        <Modal transparent animationType="fade" onRequestClose={() => setModalOpen(false)}>
          <Pressable style={s.modalBackdrop} onPress={() => setModalOpen(false)}>
            {/* Sheet press → goToDoc: title & body are non-Pressable, so taps bubble here.
                Only the ✕ Pressable (and markdown links) intercept. */}
            <Pressable style={s.modalSheet} onPress={goToDoc}>
              <View style={s.modalHeader}>
                <Text style={s.modalTitle} numberOfLines={2}>{item.title}</Text>
                <Pressable style={s.modalCloseBtn} onPress={() => setModalOpen(false)} hitSlop={10}>
                  <Text style={s.modalCloseText}>✕</Text>
                </Pressable>
              </View>
              <ScrollView style={s.modalScroll} contentContainerStyle={s.modalScrollContent}>
                <MarkdownBody linkedDocuments={stableLinkedDocs} onDocumentPress={(id) => { setModalOpen(false); onDocumentPress?.(id) }} onLinkAction={onLinkAction}>
                  {item.body}
                </MarkdownBody>
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {item.tags && item.tags.length > 0 && (
        <View style={s.tagRow}>
          {item.tags.map(tag => (
            <Pressable
              key={tag.id}
              style={[s.tagChip, { borderColor: tagColor(tag.color) }]}
              onPress={onTags}
              hitSlop={4}
            >
              <Text style={[s.tagText, { color: tagColor(tag.color) }]}>#{tag.name}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={s.cardFooter}>
        {!touch && onDelete ? (
          <IconButton name="trash-outline" onPress={onDelete} hitSlop={6} hoverColor="#ef4444" />
        ) : null}
        {publishedLabel ? <Text style={s.dateText}>{publishedLabel}</Text> : null}
        <View style={s.footerSpacer} />
        {onTags ? <IconButton name="pricetag-outline" onPress={onTags} hitSlop={6} /> : null}
        {onAnnotate ? <NoteEditButton onPress={onAnnotate} hitSlop={6} /> : null}
      </View>
    </View>
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
    titlePress: { flex: 1 },
    hlTitle: { color: t.colors.text, fontSize: 13, fontWeight: '600' },
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
    dateText: { color: t.colors.muted, fontSize: 11, opacity: 0.8 },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    tagChip: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 10,
      borderWidth: 1,
    },
    tagText: { fontSize: 11, fontWeight: '600' },
    bodyClipMax: { maxHeight: MAX_BODY_HEIGHT, overflow: 'hidden' },
    expandOverlay: {
      position: 'absolute',
      bottom: 4,
      right: 6,
    },
    expandText: {
      color: t.colors.accent,
      fontSize: 11,
      fontWeight: '700',
      backgroundColor: t.colors.surface,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 10,
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
