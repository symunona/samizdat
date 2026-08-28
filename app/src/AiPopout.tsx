import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useUnistyles } from 'react-native-unistyles'
import { askLLM } from './llmAsk'
import { copyToClipboard } from './clipboard'
import { translateText } from './translate'
import type { TranslateEngine } from './translate'
import { useConnection } from './ConnectionContext'
import { useToast } from './ToastContext'
import MarkdownBody from './MarkdownBody'

// What the popout was asked to do. `ask` renders a template; `translate` picks the
// engine (LLM or the browser's built-in) — one popout serves both so there is a
// single place that shows loading, an answer, an error and the Save affordance.
export type AiRequest = {
  title: string
  kind: 'ask' | 'translate'
  /** ask: the rendered prompt. translate: the text to translate. */
  text: string
  system?: string
  provider?: string
  model?: string
  lang?: string
  engine?: TranslateEngine
}

interface Props {
  request: AiRequest | null
  /** Hands the answer to the annotator, which anchors it to the ORIGINAL selection. */
  onSave: (answer: string) => void
  onClose: () => void
}

// A single popout, sibling of AnnotationPanel: it composes nothing itself — the
// caller renders the template — it runs the call, shows the loading state, and
// offers the two things worth doing with an answer (copy it, keep it as an
// Annotation). Nothing is persisted unless Save is pressed.
export default function AiPopout({ request, onSave, onClose }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { activeUrl, token } = useConnection()
  const { toast } = useToast()

  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [served, setServed] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  // Bumping this re-runs the effect below — Retry with the same request object.
  const [attempt, setAttempt] = useState(0)

  const run = useCallback(async (req: AiRequest, signal: AbortSignal) => {
    if (req.kind === 'translate') {
      const res = await translateText({
        text: req.text, lang: req.lang ?? 'en', engine: req.engine ?? 'llm',
        serverUrl: activeUrl, token, system: req.system,
        provider: req.provider, model: req.model, signal,
      })
      return { text: res.text, served: res.engine === 'browser' ? 'browser translator' : res.model }
    }
    if (!activeUrl || !token) throw new Error('Not connected')
    const res = await askLLM(activeUrl, token, {
      prompt: req.text, system: req.system, provider: req.provider, model: req.model,
    }, signal)
    return { text: res.reply, served: res.model }
  }, [activeUrl, token])

  useEffect(() => {
    if (!request) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    setAnswer('')
    setServed('')
    run(request, ctrl.signal)
      .then(r => {
        if (ctrl.signal.aborted) return
        setAnswer(r.text.trim())
        setServed(r.served)
      })
      .catch(e => {
        if (ctrl.signal.aborted) return
        setError(e instanceof Error ? e.message : 'Request failed')
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
    return () => ctrl.abort()
  }, [request, attempt, run])

  const handleClose = useCallback(() => {
    abortRef.current?.abort()
    onClose()
  }, [onClose])

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(answer)
    toast(ok ? 'Copied' : 'Copy failed', ok ? 'success' : 'error')
  }, [answer, toast])

  if (!request) return null

  return (
    <Modal transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable style={s.overlay} onPress={handleClose}>
        <Pressable style={s.sheet} onPress={e => e.stopPropagation()}>

          <View style={s.header}>
            <Ionicons name="sparkles-outline" size={18} color={theme.colors.accent} />
            <Text style={s.title} numberOfLines={1}>{request.title}</Text>
            <Pressable onPress={handleClose} style={s.xBtn} hitSlop={10}>
              <Ionicons name="close" size={16} color={theme.colors.muted} />
            </Pressable>
          </View>

          <ScrollView style={s.body} contentContainerStyle={s.bodyContent}>
            {loading && (
              <View style={s.loading} testID="ai-popout-loading">
                <ActivityIndicator color={theme.colors.accent} />
                <Text style={s.loadingText}>Thinking…</Text>
              </View>
            )}
            {!loading && error !== null && (
              <Text style={s.error} testID="ai-popout-error">{error}</Text>
            )}
            {!loading && error === null && (
              <View testID="ai-popout-answer">
                <MarkdownBody>{answer || '(empty answer)'}</MarkdownBody>
              </View>
            )}
          </ScrollView>

          {served !== '' && <Text style={s.served} numberOfLines={1}>via {served}</Text>}

          <View style={s.footer}>
            <Pressable
              style={[s.iconBtn, loading && s.btnDisabled]}
              onPress={() => setAttempt(n => n + 1)}
              disabled={loading}
              testID="ai-popout-retry"
            >
              <Ionicons name="refresh-outline" size={16} color={theme.colors.muted} />
            </Pressable>
            <Pressable
              style={[s.iconBtn, (loading || !answer) && s.btnDisabled]}
              onPress={handleCopy}
              disabled={loading || !answer}
            >
              <Ionicons name="copy-outline" size={16} color={theme.colors.muted} />
            </Pressable>
            <View style={s.spacer} />
            <Pressable
              style={[s.saveBtn, (loading || !answer) && s.btnDisabled]}
              onPress={() => onSave(answer)}
              disabled={loading || !answer}
              testID="ai-popout-save"
            >
              <Text style={s.saveText}>Save as note</Text>
            </Pressable>
          </View>

        </Pressable>
      </Pressable>
    </Modal>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: t.colors.surface,
      borderTopLeftRadius: 18, borderTopRightRadius: 18,
      borderTopWidth: 1, borderTopColor: t.colors.border,
      paddingHorizontal: t.spacing.lg,
      paddingTop: t.spacing.md,
      paddingBottom: t.spacing.xl,
      gap: t.spacing.sm,
      // Bounded by the screen, not by a fixed pixel height: a short phone (or
      // landscape) would otherwise push the footer — Save included — off-screen.
      maxHeight: '85%' as unknown as number,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    title: { flex: 1, color: t.colors.text, fontSize: 16, fontWeight: '700' },
    xBtn: {
      width: 28, height: 28, borderRadius: 14,
      backgroundColor: t.colors.background, alignItems: 'center', justifyContent: 'center',
    },
    body: { flexShrink: 1 },
    bodyContent: { paddingVertical: t.spacing.xs },
    loading: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.lg },
    loadingText: { color: t.colors.muted, fontSize: 14 },
    error: { color: t.colors.error, fontSize: 14, paddingVertical: t.spacing.md },
    served: { color: t.colors.muted, fontSize: 11 },
    footer: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    iconBtn: {
      paddingHorizontal: t.spacing.sm + 2, paddingVertical: t.spacing.sm,
      borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.colors.border,
      backgroundColor: t.colors.background,
    },
    btnDisabled: { opacity: 0.4 },
    spacer: { flex: 1 },
    saveBtn: {
      backgroundColor: t.colors.accent, borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm,
    },
    saveText: { color: t.colors.background, fontSize: 15, fontWeight: '700' },
  })
}
