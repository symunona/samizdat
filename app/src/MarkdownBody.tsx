import { useMemo } from 'react'
import { StyleSheet } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { useUnistyles } from 'react-native-unistyles'

type Props = {
  children: string
  numberOfLines?: number
}

export default function MarkdownBody({ children, numberOfLines }: Props) {
  const { theme } = useUnistyles()
  const mdStyles = useMemo(() => buildMdStyles(theme), [theme])
  return (
    <Markdown style={mdStyles} mergeStyle>
      {children}
    </Markdown>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildMdStyles(t: Theme): StyleSheet.NamedStyles<Record<string, unknown>> {
  const text = { color: t.colors.text, fontSize: 14, lineHeight: 21 }
  return {
    body: { ...text },
    paragraph: { ...text, marginTop: 0, marginBottom: 6 },
    heading1: { color: t.colors.text, fontSize: 18, fontWeight: '700', marginBottom: 6, marginTop: 4 },
    heading2: { color: t.colors.text, fontSize: 16, fontWeight: '700', marginBottom: 4, marginTop: 4 },
    heading3: { color: t.colors.text, fontSize: 15, fontWeight: '600', marginBottom: 4, marginTop: 4 },
    strong: { fontWeight: '700', color: t.colors.text },
    em: { fontStyle: 'italic', color: t.colors.text },
    link: { color: t.colors.accent, textDecorationLine: 'underline' },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: t.colors.accent,
      paddingLeft: 10,
      marginLeft: 0,
      marginBottom: 6,
      opacity: 0.85,
    },
    code_inline: {
      fontFamily: 'monospace',
      fontSize: 13,
      backgroundColor: t.colors.surface,
      color: t.colors.accent,
      paddingHorizontal: 4,
      borderRadius: 4,
    },
    fence: {
      fontFamily: 'monospace',
      fontSize: 12,
      backgroundColor: t.colors.surface,
      color: t.colors.text,
      padding: 10,
      borderRadius: 6,
      marginBottom: 6,
    },
    code_block: {
      fontFamily: 'monospace',
      fontSize: 12,
      backgroundColor: t.colors.surface,
      color: t.colors.text,
      padding: 10,
      borderRadius: 6,
      marginBottom: 6,
    },
    bullet_list: { marginBottom: 4 },
    ordered_list: { marginBottom: 4 },
    list_item: { marginBottom: 2 },
    bullet_list_icon: { color: t.colors.accent, marginRight: 6 },
    ordered_list_icon: { color: t.colors.muted, marginRight: 6 },
    hr: { backgroundColor: t.colors.border, height: 1, marginVertical: 8 },
  }
}
