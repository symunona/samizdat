import { useMemo } from 'react'
import { Platform, Pressable, StyleSheet, Text } from 'react-native'
import { Linking } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'

interface Props {
  url: string | null
  onReadAsDocument: (url: string) => void
  onClose: () => void
}

// Shared link-action selector. Same sheet on the feed and the document viewer.
// Pure UI — "Read as document" hands off to the caller (ScrapeQueue, non-blocking).
export default function LinkActionSheet({ url, onReadAsDocument, onClose }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])

  if (!url) return null

  const host = (() => { try { return new URL(url).hostname } catch { return url } })()

  const openInBrowser = () => {
    if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer')
    else Linking.openURL(url)
    onClose()
  }

  return (
    <Pressable style={s.overlay} onPress={onClose}>
      <Pressable style={s.sheet} onPress={e => e.stopPropagation()}>
        <Text style={s.host} numberOfLines={1}>{host}</Text>
        <Text style={s.href} numberOfLines={2}>{url}</Text>
        <Pressable style={[s.btn, s.btnPrimary]} onPress={() => { onReadAsDocument(url); onClose() }}>
          <Text style={s.btnPrimaryText}>Read as document</Text>
        </Pressable>
        <Pressable style={[s.btn, s.btnSecondary]} onPress={openInBrowser}>
          <Text style={s.btnSecondaryText}>Open in browser</Text>
        </Pressable>
        <Pressable style={s.btnCancel} onPress={onClose}>
          <Text style={s.btnCancelText}>Cancel</Text>
        </Pressable>
      </Pressable>
    </Pressable>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    overlay: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.55)', zIndex: 30,
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: t.colors.surface,
      borderTopLeftRadius: 14, borderTopRightRadius: 14,
      borderTopWidth: 1, borderTopColor: t.colors.border,
      padding: t.spacing.lg,
      paddingBottom: t.spacing.xl + 8,
      gap: t.spacing.sm,
    },
    host: { color: t.colors.text, fontSize: 16, fontWeight: '700' },
    href: { color: t.colors.muted, fontSize: 12, marginBottom: t.spacing.sm },
    btn: {
      borderRadius: 10, paddingVertical: t.spacing.md, paddingHorizontal: t.spacing.lg,
      alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: t.spacing.sm,
    },
    btnPrimary: { backgroundColor: t.colors.accent },
    btnPrimaryText: { color: '#0b0b0c', fontSize: 15, fontWeight: '700' },
    btnSecondary: { borderWidth: 1, borderColor: t.colors.border },
    btnSecondaryText: { color: t.colors.text, fontSize: 15, fontWeight: '500' },
    btnCancel: { alignItems: 'center', paddingVertical: t.spacing.sm },
    btnCancelText: { color: t.colors.muted, fontSize: 14 },
  })
}
