import { Pressable, StyleSheet, Text } from 'react-native'
import type { PressableProps } from 'react-native'
import { ON_PALETTE, tagColor } from './tagColor'

// Where a Digest opens: its newest issue, or the one named.
export const digestHref = (digestId: string, issueId?: string) =>
  `/digest/${digestId}${issueId ? `?issue=${issueId}` : ''}` as const

type Props = Pick<PressableProps, 'onPress' | 'onPressIn' | 'testID'> & {
  name: string
  color: string        // a palette name; '' (a Digest older than colours) reads grey
  size?: 'sm' | 'md'   // sm on a Highlight card, md where the Digest is the heading
}

// A Digest's name on its colour — the one way a Digest is named on screen, so the
// list, the issue header and a Highlight card all agree. Mirrored as `.hl-digest-chip`
// in the WebView card (webview/document-viewer.ts).
export default function DigestChip({ name, color, size = 'sm', onPress, onPressIn, testID }: Props) {
  return (
    <Pressable
      style={[s.chip, size === 'md' && s.chipMd, { backgroundColor: tagColor(color) }]}
      onPress={onPress}
      onPressIn={onPressIn}
      disabled={!onPress}
      hitSlop={4}
      testID={testID}
      accessibilityLabel={`Digest ${name}`}
    >
      <Text style={[s.text, size === 'md' && s.textMd]} numberOfLines={1}>{name}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  chip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, alignSelf: 'flex-start', maxWidth: '100%' },
  chipMd: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12 },
  text: { color: ON_PALETTE, fontSize: 11, fontWeight: '700' },
  textMd: { fontSize: 15 },
})
