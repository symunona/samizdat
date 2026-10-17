import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import type { FeedDigestTopic } from './db'
import DigestChip, { digestHref } from './DigestChip'
import MarkdownBody from './MarkdownBody'
import { formatRelative } from './relativeTime'
import { tagColor } from './tagColor'

type Props = { item: FeedDigestTopic }

// One DigestTopic in the feed: what the issue says about one thing, over the stored
// Highlight bullets it cites. It is not a Highlight — no pin, archive, tag or note —
// so everything on it, a link in a bullet included, opens the issue it came from.
export default function DigestTopicCard({ item }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const open = () => router.push(digestHref(item.digestId, item.issueId))
  const { topic } = item

  return (
    <Pressable
      style={[s.card, { borderLeftColor: tagColor(item.color) }]}
      onPress={open}
      testID={`digest-topic-card-${item.key}`}
    >
      <View style={s.header}>
        <DigestChip name={item.name} color={item.color} onPress={open} testID={`digest-chip-${item.digestId}`} />
        <Text style={s.question} numberOfLines={1}>{topic.question_title}</Text>
        {/* The feed's date is its sort key: for a topic, when the issue's window closed. */}
        <Text style={s.date}>{formatRelative(item.at)}</Text>
      </View>
      <Text style={s.title}>{topic.title}</Text>
      {topic.why ? <Text style={s.why}>{topic.why}</Text> : null}
      {topic.refs.map((ref, i) => (
        <View key={`${ref.highlight_id}:${ref.bullet}:${i}`} style={s.bullet}>
          <MarkdownBody onLinkAction={open} onDocumentPress={open}>{ref.text ?? ''}</MarkdownBody>
          {ref.document_title ? <Text style={s.from} numberOfLines={1}>{ref.document_title}</Text> : null}
        </View>
      ))}
    </Pressable>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    // HighlightCard's frame, with the Digest's colour down the left edge.
    card: {
      backgroundColor: t.colors.surface,
      borderRadius: 10,
      padding: 14,
      borderWidth: 1,
      borderLeftWidth: 4,
      borderColor: t.colors.border,
      gap: 6,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    question: { flex: 1, color: t.colors.muted, fontSize: 11, fontWeight: '600' },
    date: { color: t.colors.muted, fontSize: 11 },
    title: { color: t.colors.text, fontSize: 15, fontWeight: '700' },
    why: { color: t.colors.muted, fontSize: 13 },
    bullet: { paddingTop: 6, borderTopWidth: 1, borderTopColor: t.colors.border + '55' },
    from: { color: t.colors.accent, fontSize: 11, marginTop: 2 },
  })
}
