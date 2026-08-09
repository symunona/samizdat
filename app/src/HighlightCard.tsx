import { useMemo, useState } from 'react'

const CLIP_CHAR_THRESHOLD = 800
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import type { HighlightWithDoc } from './api'
import MarkdownBody from './MarkdownBody'
import HighlightDetail from './HighlightDetail'
import NoteEditButton from './NoteEditButton'
import IconButton from './IconButton'
import DateStamp from './DateStamp'
import { isTouchDevice } from './touch'
import { tagColor } from './tagColor'
import { hashColor } from './hashColor'

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
  // At least one Annotation anchors here. The whole card is marked, not just the icon —
  // scanning a feed for "the ones I wrote on" should not need a squint at a 14px glyph.
  hasNote?: boolean
}

export default function HighlightCard({
  item, linkedDocuments, onPress, onPin, onDelete, onAnnotate, onTags, onDocumentPress, onLinkAction, busy, pinned, hasNote,
}: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const touch = isTouchDevice()

  const [modalOpen, setModalOpen] = useState(false)
  // Popout navigates to the document at the right place (highlight deep-link); only ✕ closes.
  const goToDoc = () => { setModalOpen(false); onPress?.() }
  // Where it came from: the feed, or — for a document no feed produced — how it was
  // added (manual, or the pipeline that pulled it in).
  const originLabel = item.source_feed_title || item.added_via || ''
  const isClipped = item.body.length > CLIP_CHAR_THRESHOLD || item.body.includes('![')
  // Stabilize by item.id: linked_documents are computed once per highlight and don't change.
  // Prevents new object refs from React Query refetches bypassing MarkdownBody memo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableLinkedDocs = useMemo(() => linkedDocuments, [item.id])

  return (
    <View style={[s.card, hasNote && s.cardNoted, pinned && s.cardPinned]}>
      <View style={s.cardHeader}>
        <View style={[s.kindBadge, { backgroundColor: hashColor(item.kind) }]}>
          <Text style={s.kindText}>{item.kind}</Text>
        </View>
        {originLabel ? (
          <View style={[s.kindBadge, { backgroundColor: hashColor(originLabel) }]}>
            <Text style={s.kindText}>{originLabel}</Text>
          </View>
        ) : null}
        <Pressable style={s.titlePress} onPress={onPress}>
          <Text style={s.hlTitle} numberOfLines={1}>{item.title}</Text>
        </Pressable>
        {/* Affordance: the header opens the source document. */}
        {onPress ? <IconButton name="open-outline" onPress={onPress} size={16} hitSlop={6} /> : null}
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

      {/* The "more" overlay is a selectable WebView/iframe (HighlightDetail): select
          text → create a highlight-anchored annotation, existing ones render as marks.
          Same tap zones as before (backdrop=close, header=open doc, body=content). */}
      <HighlightDetail
        item={item}
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        onOpenDoc={goToDoc}
        onDocumentPress={(id) => { setModalOpen(false); onDocumentPress?.(id) }}
        onLinkAction={onLinkAction}
      />

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
        {/* Always rendered — on touch the swipe archives, so this is the ONLY delete
            path there (and it mirrors the WebView card, which never gated it). Safe
            without a confirm: the feed shows a 5s "deleted / Undo" card first. */}
        {onDelete ? (
          <IconButton name="trash-outline" onPress={onDelete} hitSlop={6} hoverColor="#ef4444" />
        ) : null}
        <DateStamp ingestedAt={item.created_at} publishedAt={item.document_published_at} />
        <View style={s.footerSpacer} />
        {onTags ? <IconButton name="pricetag-outline" onPress={onTags} hitSlop={6} /> : null}
        {onAnnotate ? (
          <NoteEditButton onPress={onAnnotate} hitSlop={6} color={hasNote ? theme.colors.accent : undefined} />
        ) : null}
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
    // Annotated: dotted accent. Pinned: solid accent — it is applied after, so a card
    // that is both reads as pinned (the ★ says so anyway) and the accent note icon in
    // the footer still marks the note.
    cardNoted: {
      borderColor: t.colors.accent,
      borderStyle: 'dotted',
      borderWidth: 2,
    },
    cardPinned: {
      borderColor: t.colors.accent,
      borderStyle: 'solid',
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
  })
}
