import { useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, Modal, Platform, Pressable, StyleSheet, Text, TextInput } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useConnection } from './ConnectionContext'

interface Props {
  visible: boolean
  onSubmit: (url: string) => void
  onClose: () => void
}

// Bare host/path typed without a scheme is the common paste-slip; assume https
// rather than rejecting. Returns null when the result still isn't an http(s) URL.
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  try {
    const u = new URL(hasScheme ? trimmed : `https://${trimmed}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    // A guessed scheme means the user typed a bare host: require a dot so free text
    // ("not a url") is caught here instead of queueing a doomed scrape. An explicit
    // scheme is taken at face value (http://localhost:8765 is legitimate).
    if (!hasScheme && !u.hostname.includes('.')) return null
    return u.toString()
  } catch {
    return null
  }
}

// Quick "add a document by URL" sheet. Same bottom-sheet shape as LinkActionSheet;
// submitting hands the URL to the caller (ScrapeQueue), which owns the
// pending/done/error card — this stays pure input.
export default function AddUrlSheet({ visible, onSubmit, onClose }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { status } = useConnection()
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [kbHeight, setKbHeight] = useState(0)
  const inputRef = useRef<TextInput>(null)

  // Lift the sheet above the soft keyboard — KeyboardAvoidingView is a no-op inside
  // an Android <Modal> (separate window, never resized for the IME). See AnnotationPanel.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const subShow = Keyboard.addListener(showEvt, e => setKbHeight(e.endCoordinates?.height ?? 0))
    const subHide = Keyboard.addListener(hideEvt, () => setKbHeight(0))
    return () => { subShow.remove(); subHide.remove() }
  }, [])

  // Raise the keyboard on open: onShow is the early attempt, the delayed one below is
  // the reliable one (fires after the slide-in, once the Modal owns input). Web autoFocus.
  function handleShow() {
    if (Platform.OS !== 'web') inputRef.current?.focus()
  }
  useEffect(() => {
    if (!visible || Platform.OS === 'web') return
    const t = setTimeout(() => inputRef.current?.focus(), 400)
    return () => clearTimeout(t)
  }, [visible])

  useEffect(() => {
    if (visible) { setUrl(''); setError(null) }
  }, [visible])

  const connected = status === 'connected'

  function handleSubmit() {
    const normalized = normalizeUrl(url)
    if (!normalized) { setError('Enter a valid http(s) URL'); return }
    if (!connected) { setError('Not connected — can’t queue a scrape'); return }
    Keyboard.dismiss()
    onSubmit(normalized)
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onShow={handleShow} onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable style={[s.sheet, { marginBottom: kbHeight }]} onPress={e => e.stopPropagation()}>
          <Text style={s.title}>Add document</Text>
          <TextInput
            ref={inputRef}
            style={s.input}
            placeholder="https://example.com/article"
            placeholderTextColor={theme.colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={url}
            onChangeText={t => { setUrl(t); if (error) setError(null) }}
            onSubmitEditing={handleSubmit}
            returnKeyType="send"
            autoFocus={Platform.OS === 'web'}
          />
          {error ? <Text style={s.error}>{error}</Text> : null}
          <Pressable style={[s.btn, s.btnPrimary]} onPress={handleSubmit}>
            <Text style={s.btnPrimaryText}>Add</Text>
          </Pressable>
          <Pressable style={s.btnCancel} onPress={onClose}>
            <Text style={s.btnCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
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
    title: { color: t.colors.text, fontSize: 16, fontWeight: '700' },
    input: {
      backgroundColor: t.colors.background,
      color: t.colors.text,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm + 2,
      fontSize: 15,
    },
    error: { color: t.colors.error, fontSize: 12 },
    btn: {
      borderRadius: 10, paddingVertical: t.spacing.md, paddingHorizontal: t.spacing.lg,
      alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: t.spacing.sm,
    },
    btnPrimary: { backgroundColor: t.colors.accent },
    btnPrimaryText: { color: '#0b0b0c', fontSize: 15, fontWeight: '700' },
    btnCancel: { alignItems: 'center', paddingVertical: t.spacing.sm },
    btnCancelText: { color: t.colors.muted, fontSize: 14 },
  })
}
