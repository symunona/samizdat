import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import WebView from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'
import type { Annotation, HighlightWithDoc } from './api'
import { buildDocumentHtml } from './markdownToHtml'
import { useSyncStore } from './store/syncStore'
import * as mut from './store/mutations'
import { useConnection } from './ConnectionContext'
import IconButton from './IconButton'
import AnnotationPanel from './AnnotationPanel'
import type { PendingSelection, ExistingAnnotation } from './AnnotationPanel'

type ParsedMsg = {
  type: string
  data?: PendingSelection
  id?: string
  href?: string
  doc_id?: string
}

type Props = {
  item: HighlightWithDoc
  visible: boolean
  onClose: () => void
  onOpenDoc: () => void
  onDocumentPress?: (docId: string) => void
  onLinkAction?: (url: string) => void
}

// HighlightDetail — the highlight "more" overlay as a selectable WebView/iframe.
// Reuses the document-viewer bundle (its selection + mark + message protocol is body-
// agnostic) and AnnotationPanel to let the user select text in a highlight and create an
// annotation anchored to that HIGHLIGHT (W3C TextQuoteSelector), plus render existing
// highlight annotations as marks. Store-only (offline-first): body from item.body
// markdown, marks from the store filtered by highlight_id — no network.
export default function HighlightDetail({
  item, visible, onClose, onOpenDoc, onDocumentPress, onLinkAction,
}: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { activeUrl } = useConnection()

  const webViewRef = useRef<WebView>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iframeRef = useRef<any>(null)
  const isLoadedRef = useRef(false)

  // Marks come straight from the store (offline-first): pick the raw slice (stable ref)
  // and filter in a useMemo — mapping to fresh objects inside a selector would spin a
  // render loop (React #185). Reactive: a mut.* create/edit/delete re-renders here and
  // the setAnnotations effect re-syncs the marks.
  const annById = useSyncStore(state => state.annotations)
  const annotations = useMemo<Annotation[]>(
    () => Object.values(annById).filter(a => a.highlight_id === item.id && !a.deleted_at),
    [annById, item.id],
  )
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations

  // Highlights already store markdown `body`; render it (empty title → no duplicate h1,
  // the sheet header already shows the title). activeUrl absolutizes /api/v1/media images.
  const htmlContent = useMemo(
    () => buildDocumentHtml(item.body, '', item.linked_documents ?? {}, activeUrl ?? ''),
    [item.body, item.linked_documents, activeUrl],
  )

  const { bg, fg, su, bo, ac, mu } = useMemo(() => ({
    bg: theme.colors.background, fg: theme.colors.text, su: theme.colors.surface,
    bo: theme.colors.border, ac: theme.colors.accent, mu: theme.colors.muted,
  }), [theme.colors])

  const sendToWebView = useCallback((msg: object) => {
    const json = JSON.stringify(msg)
    if (Platform.OS === 'web') {
      iframeRef.current?.contentWindow?.postMessage(json, '*')
    } else {
      webViewRef.current?.injectJavaScript(`window.__handleMsg && window.__handleMsg(${json}); true;`)
    }
  }, [])

  // A fresh iframe/WebView boots on every open — reset the loaded flag so the next
  // `ready` re-seeds annotations (the modal unmounts its host when hidden).
  useEffect(() => { if (!visible) isLoadedRef.current = false }, [visible])

  // Re-sync marks whenever the annotation set changes (create/edit/delete/store pull).
  useEffect(() => {
    if (!isLoadedRef.current) return
    sendToWebView({ type: 'setAnnotations', annotations })
  }, [sendToWebView, annotations])

  useEffect(() => {
    if (!isLoadedRef.current) return
    sendToWebView({ type: 'setTheme', theme: { background: bg, text: fg, surface: su, border: bo, accent: ac, muted: mu } })
  }, [sendToWebView, bg, fg, su, bo, ac, mu])

  // Annotation panel state
  const [annVisible, setAnnVisible] = useState(false)
  const [annMode, setAnnMode] = useState<'create' | 'edit'>('create')
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | undefined>()
  const [existingAnnotation, setExistingAnnotation] = useState<ExistingAnnotation | undefined>()

  const handleParsedMessage = useCallback((msg: ParsedMsg) => {
    if (msg.type === 'ready') {
      isLoadedRef.current = true
      sendToWebView({
        type: 'init',
        doc: { title: '' },
        highlights: [],
        annotations: annotationsRef.current,
        theme: { background: bg, text: fg, surface: su, border: bo, accent: ac, muted: mu },
        hlExpanded: true,
        scrollFraction: 0,
      })
    } else if (msg.type === 'selection' && msg.data) {
      setPendingSelection(msg.data)
      setAnnMode('create')
      setExistingAnnotation(undefined)
      setAnnVisible(true)
    } else if (msg.type === 'tap_annotation' && msg.id) {
      const ann = annotationsRef.current.find(a => a.id === msg.id)
      if (ann) {
        setExistingAnnotation({ id: ann.id, exact: ann.exact, note: ann.note, color: ann.color })
        setAnnMode('edit')
        setPendingSelection(undefined)
        setAnnVisible(true)
      }
    } else if (msg.type === 'link_press' && msg.href) {
      if (msg.doc_id) onDocumentPress?.(msg.doc_id)
      else onLinkAction?.(msg.href)
    }
  }, [sendToWebView, bg, fg, su, bo, ac, mu, onDocumentPress, onLinkAction])

  const handleMessage = useCallback((e: WebViewMessageEvent) => {
    try { handleParsedMessage(JSON.parse(e.nativeEvent.data) as ParsedMsg) }
    catch { /* ignore parse errors */ }
  }, [handleParsedMessage])

  // Web iframe message listener
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const handler = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      try { handleParsedMessage(JSON.parse(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) as ParsedMsg) }
      catch { /* ignore parse errors */ }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [handleParsedMessage])

  // Local-first: write to the store + outbox (no network). Store reactivity re-syncs marks.
  const handleAnnSave = useCallback((data: { note: string; color: string }) => {
    setAnnVisible(false)
    if (annMode === 'create') {
      const sel = pendingSelection ?? { exact: '', prefix: '', suffix: '', pos_start: 0, pos_end: 0 }
      mut.createAnnotation({
        documentId: item.document_id, highlightId: item.id,
        exact: sel.exact, prefix: sel.prefix, suffix: sel.suffix,
        posStart: sel.pos_start, posEnd: sel.pos_end, note: data.note, color: data.color,
      })
    } else if (annMode === 'edit' && existingAnnotation) {
      mut.updateAnnotation(existingAnnotation.id, data.note, data.color)
    }
  }, [annMode, pendingSelection, existingAnnotation, item.document_id, item.id])

  const handleAnnDelete = useCallback(() => {
    if (!existingAnnotation) return
    setAnnVisible(false)
    mut.deleteAnnotation(existingAnnotation.id)
  }, [existingAnnotation])

  if (!visible) return null

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      {/* Tap zones (per UX spec, mirrors the old overlay):
          - greyed backdrop above the sheet = close
          - header (title + ↗) = open the document
          - ✕ top-right = close
          - body = the WebView/iframe; owns selection + annotate */}
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdropFill} onPress={onClose} />
        <View style={s.modalSheet}>
          <Pressable style={s.modalHeader} onPress={onOpenDoc}>
            <Text style={s.modalTitle} numberOfLines={2}>{item.title}</Text>
            <IconButton name="open-outline" onPress={onOpenDoc} size={18} hitSlop={8} />
            <Pressable style={s.modalCloseBtn} onPress={onClose} hitSlop={10}>
              <Text style={s.modalCloseText}>✕</Text>
            </Pressable>
          </Pressable>

          <View style={s.body}>
            {Platform.OS === 'web' ? (
              <iframe
                ref={iframeRef}
                srcDoc={htmlContent}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                style={{ width: '100%', height: '100%', border: 'none' } as any}
              />
            ) : (
              <WebView
                ref={webViewRef}
                source={{ html: htmlContent, baseUrl: activeUrl ?? '' }}
                style={s.webView}
                onMessage={handleMessage}
                originWhitelist={['*']}
                mixedContentMode="always"
                scrollEnabled
                showsVerticalScrollIndicator={false}
                onShouldStartLoadWithRequest={(req) => req.navigationType !== 'click'}
              />
            )}
          </View>
        </View>
      </View>

      <AnnotationPanel
        visible={annVisible}
        mode={annMode}
        existing={existingAnnotation}
        onSave={handleAnnSave}
        onDelete={annMode === 'edit' ? handleAnnDelete : undefined}
        onCancel={() => setAnnVisible(false)}
      />
    </Modal>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    modalRoot: { flex: 1, justifyContent: 'flex-end' },
    modalBackdropFill: {
      position: 'absolute',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.6)',
    },
    modalSheet: {
      backgroundColor: t.colors.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      height: '85%',
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
    modalCloseBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    modalCloseText: { color: t.colors.muted, fontSize: 18 },
    body: { flex: 1, overflow: 'hidden', borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
    webView: { flex: 1, backgroundColor: t.colors.background },
  })
}
