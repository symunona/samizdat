import { memo, useMemo } from 'react'
import { StyleSheet, Text } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { useUnistyles } from 'react-native-unistyles'
import ImageViewer from './ImageViewer'
import { useScrapeQueue } from './ScrapeQueueContext'

type Props = {
  children: string
  linkedDocuments?: Record<string, string>
  onDocumentPress?: (docId: string) => void
  onLinkAction?: (url: string) => void
}

function MarkdownBody({ children, linkedDocuments, onDocumentPress, onLinkAction }: Props) {
  const { theme } = useUnistyles()
  const mdStyles = useMemo(() => buildMdStyles(theme), [theme])
  const { entries, resolvedDocs } = useScrapeQueue()

  const rules = useMemo(() => ({
    image: (node: { key: string; attributes: { src?: string; alt?: string } }) => (
      <ImageViewer key={node.key} src={node.attributes.src ?? ''} alt={node.attributes.alt} />
    ),
    // Custom link rule: render the link text, then an inline status icon so a
    // link reads with breathing room (📄 already a Document · 🔗 not yet · ⏳ scraping).
    link: (node: { key: string; attributes: { href?: string } }, mdChildren: React.ReactNode) => {
      const href = node.attributes.href ?? ''
      const entry = entries[href]
      const docId = entry?.docId ?? resolvedDocs[href] ?? linkedDocuments?.[href]
      const scraping = entry?.state === 'scraping'
      const icon = scraping ? '⏳' : docId ? '📄' : '🔗'
      const onPress = () => {
        if (docId && onDocumentPress) onDocumentPress(docId)
        else if (onLinkAction) onLinkAction(href)
      }
      return (
        <Text key={node.key} style={mdStyles.link} onPress={onPress}>
          {mdChildren}
          <Text style={iconStyle.icon} onPress={onPress}>{' '}{icon}{' '}</Text>
        </Text>
      )
    },
  }), [entries, resolvedDocs, linkedDocuments, onDocumentPress, onLinkAction, mdStyles.link])

  return (
    <Markdown style={mdStyles} mergeStyle rules={rules}>
      {children}
    </Markdown>
  )
}

export default memo(MarkdownBody)

const iconStyle = StyleSheet.create({
  icon: { fontSize: 12 },
})

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildMdStyles(t: Theme): StyleSheet.NamedStyles<Record<string, unknown>> {
  const text = { color: t.colors.text, fontSize: 14, lineHeight: 21 }
  return {
    body: { ...text },
    paragraph: { ...text, marginTop: 0, marginBottom: 8 },
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
      marginBottom: 8,
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
      marginBottom: 8,
    },
    code_block: {
      fontFamily: 'monospace',
      fontSize: 12,
      backgroundColor: t.colors.surface,
      color: t.colors.text,
      padding: 10,
      borderRadius: 6,
      marginBottom: 8,
    },
    bullet_list: { marginBottom: 4 },
    ordered_list: { marginBottom: 4 },
    list_item: { marginBottom: 4 },
    list_item_content: { flex: 1 },
    bullet_list_icon: { color: t.colors.accent, marginRight: 8, marginTop: 3 },
    ordered_list_icon: { color: t.colors.muted, marginRight: 8, marginTop: 3 },
    hr: { backgroundColor: t.colors.border, height: 1, marginVertical: 8 },
  }
}
