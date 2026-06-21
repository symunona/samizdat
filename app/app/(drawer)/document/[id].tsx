import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLogger } from '../../../src/logger'

const log = createLogger('document')
import {
  ActivityIndicator,
  Animated,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles'
import WebView from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  fetchDocument,
  fetchReadingProgress,
  saveReadingProgress,
  fetchAnnotations,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  deleteDocument,
  lookupDocumentByURL,
  fetchDocumentHighlights,
  deleteHighlight,
  pinHighlight,
  fetchFeed,
  queueDocumentPipelines,
} from '../../../src/api'
import type { Document, Annotation, HighlightWithDoc, Feed } from '../../../src/api'
import { useConnection } from '../../../src/ConnectionContext'
import { useToast } from '../../../src/ToastContext'
import { saveTheme } from '../../../src/storage'
import AnnotationPanel from '../../../src/AnnotationPanel'
import type { PendingSelection, ExistingAnnotation } from '../../../src/AnnotationPanel'
import TagSelectorModal from '../../../src/TagSelectorModal'
import LinkActionSheet from '../../../src/LinkActionSheet'
import { useScrapeQueue } from '../../../src/ScrapeQueueContext'
import { buildDocumentHtml } from '../../../src/markdownToHtml'
import { useSyncStore } from '../../../src/store/syncStore'

const DEBOUNCE_MS = 1000

type ParsedMsg = {
  type: string
  fraction?: number
  data?: PendingSelection
  id?: string
  href?: string
  doc_id?: string
}

export default function DocumentViewer() {
  const { id, from, highlight } = useLocalSearchParams<{ id: string; from?: string; highlight?: string }>()
  const router = useRouter()
  const { theme, rt } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const isDark = rt.themeName === 'dark'

  const [doc, setDoc] = useState<Document | null>(null)
  const [htmlContent, setHtmlContent] = useState<string | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scrollProgress, setScrollProgress] = useState(0)

  const { activeUrl, token, status } = useConnection()
  const { toast } = useToast()

  const [queueingPipelines, setQueueingPipelines] = useState(false)

  const webViewRef = useRef<WebView>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iframeRef = useRef<any>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedProgressRef = useRef(0)
  const headerAnim = useRef(new Animated.Value(0)).current
  const headerHeightRef = useRef(56)
  const headerVisibleRef = useRef(true)
  const lastScrollFracRef = useRef(0)
  const isDocLoadedRef = useRef(false)

  // Highlights state
  const [highlights, setHighlights] = useState<HighlightWithDoc[]>([])
  const [hlExpanded, setHlExpanded] = useState(true)

  useEffect(() => {
    AsyncStorage.getItem(`doc_hl_exp_${id}`).then(val => {
      if (val !== null) setHlExpanded(val === '1')
    }).catch(() => {})
  }, [id])

  const [sourceFeed, setSourceFeed] = useState<Feed | null>(null)

  const handleThemeToggle = useCallback(async () => {
    const next = isDark ? 'light' : 'dark'
    UnistylesRuntime.setTheme(next)
    await saveTheme(next)
  }, [isDark])

  const { bg, fg, su, bo, ac, mu } = useMemo(() => ({
    bg: theme.colors.background,
    fg: theme.colors.text,
    su: theme.colors.surface,
    bo: theme.colors.border,
    ac: theme.colors.accent,
    mu: theme.colors.muted,
  }), [theme.colors.background, theme.colors.text, theme.colors.surface, theme.colors.border, theme.colors.accent, theme.colors.muted])

  // Send typed message to WebView/iframe
  const sendToWebView = useCallback((msg: object) => {
    const json = JSON.stringify(msg)
    if (Platform.OS === 'web') {
      iframeRef.current?.contentWindow?.postMessage(json, '*')
    } else {
      webViewRef.current?.injectJavaScript(`window.__handleMsg && window.__handleMsg(${json}); true;`)
    }
  }, [])

  // Re-send theme when colors change (only after doc is loaded)
  useEffect(() => {
    if (!isDocLoadedRef.current) return
    sendToWebView({ type: 'setTheme', theme: { background: bg, text: fg, surface: su, border: bo, accent: ac, muted: mu } })
  }, [sendToWebView, bg, fg, su, bo, ac, mu])

  // Meta panel state
  const [metaVisible, setMetaVisible] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const metaAnim = useRef(new Animated.Value(320)).current

  const openMetaPanel = useCallback(() => {
    setMetaVisible(true)
    setDeleteConfirm(false)
    metaAnim.setValue(320)
    Animated.timing(metaAnim, { toValue: 0, duration: 220, useNativeDriver: true }).start()
  }, [metaAnim])

  const closeMetaPanel = useCallback(() => {
    Animated.timing(metaAnim, { toValue: 320, duration: 180, useNativeDriver: true }).start(() => {
      setMetaVisible(false)
      setDeleteConfirm(false)
    })
  }, [metaAnim])

  const handleDeleteDocument = useCallback(async () => {
    if (!activeUrl || !token) return
    setDeleting(true)
    try {
      await deleteDocument(activeUrl, token, id)
      closeMetaPanel()
      router.replace((from as string) ?? '/documents')
    } catch (e) {
      log.error('delete failed', e)
      setDeleting(false)
      setDeleteConfirm(false)
    }
  }, [activeUrl, token, id, router, from, closeMetaPanel])

  // Annotation panel state
  const [annVisible, setAnnVisible] = useState(false)
  const [annMode, setAnnMode] = useState<'create' | 'edit'>('create')
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | undefined>()
  const [existingAnnotation, setExistingAnnotation] = useState<ExistingAnnotation | undefined>()

  // Tag selector modal state
  const [tagModalVisible, setTagModalVisible] = useState(false)
  const [tagTargetId, setTagTargetId] = useState<string>('')
  const [tagTargetType, setTagTargetType] = useState<'document' | 'annotation' | 'highlight'>('annotation')

  // Link action modal state
  const [linkUrl, setLinkUrl] = useState<string | null>(null)
  const { startScrape } = useScrapeQueue()

  const handleOpenTagModal = useCallback((annotationId: string) => {
    setTagTargetId(annotationId)
    setTagTargetType('annotation')
    setAnnVisible(false)
    setTagModalVisible(true)
  }, [])

  const handleOpenDocTags = useCallback(() => {
    if (!id) return
    setTagTargetId(id)
    setTagTargetType('document')
    setTagModalVisible(true)
  }, [id])

  const handleAddDocNote = useCallback(() => {
    setPendingSelection({ exact: '', prefix: '', suffix: '', pos_start: 0, pos_end: 0 })
    setAnnMode('create')
    setExistingAnnotation(undefined)
    setAnnVisible(true)
  }, [])

  const load = useCallback(async () => {
    if (!activeUrl || !token) return
    isDocLoadedRef.current = false
    setLoading(true)
    setError(null)
    try {
      const storeDocs = useSyncStore.getState().documents
      const docsByUrl: Record<string, string> = {}
      for (const d of Object.values(storeDocs)) {
        if (!d.deleted_at) docsByUrl[d.canonical_url] = d.id
      }
      const [d, progress, anns, hl] = await Promise.all([
        fetchDocument(activeUrl, token, id),
        fetchReadingProgress(activeUrl, token, id),
        fetchAnnotations(activeUrl, token, id),
        fetchDocumentHighlights(activeUrl, token, id),
      ])
      setDoc(d)
      setHtmlContent(buildDocumentHtml(d.markdown, d.title || d.canonical_url, docsByUrl))
      setAnnotations(anns)
      setHighlights(hl)
      if (d.source_feed_id) {
        fetchFeed(activeUrl, token, d.source_feed_id).then(setSourceFeed).catch(() => {})
      } else {
        setSourceFeed(null)
      }
      if (progress && progress.scroll_y > 0) {
        savedProgressRef.current = progress.scroll_y
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load document')
    } finally {
      setLoading(false)
    }
  }, [activeUrl, token, id])

  useEffect(() => {
    if (status === 'connected') load()
    else if (status === 'disconnected') { setError('Not connected'); setLoading(false) }
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [id, status, load])

  const handleHeaderLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    headerHeightRef.current = e.nativeEvent.layout.height
  }, [])

  const injectAddMark = useCallback((ann: Annotation) => {
    sendToWebView({ type: 'addMark', annotation: ann })
  }, [sendToWebView])

  const injectRemoveMark = useCallback((annId: string) => {
    sendToWebView({ type: 'removeMark', id: annId })
  }, [sendToWebView])

  const handleLinkPress = useCallback(async (href: string) => {
    if (!activeUrl || !token) return
    const existing = await lookupDocumentByURL(activeUrl, token, href)
    if (existing) {
      router.push(`/document/${encodeURIComponent(existing.id)}`)
      return
    }
    setLinkUrl(href)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUrl, token])

  // Build HlData array for WebView
  const toHlData = useCallback((hls: HighlightWithDoc[]) =>
    hls.map(h => ({
      id: h.id,
      kind: h.kind,
      title: h.title,
      bodyHtml: h.body_html ?? h.body,
      pinned: h.pinned as 0 | 1,
    })), [])

  const handleParsedMessage = useCallback((msg: ParsedMsg) => {
    if (msg.type === 'ready') {
      isDocLoadedRef.current = true
      sendToWebView({
        type: 'init',
        doc: { title: doc?.title ?? '' },
        highlights: toHlData(highlights),
        annotations,
        theme: { background: bg, text: fg, surface: su, border: bo, accent: ac, muted: mu },
        hlExpanded,
        scrollFraction: savedProgressRef.current,
        focusAnnotationId: highlight,
      })
      savedProgressRef.current = 0
    } else if (msg.type === 'scroll') {
      const frac = msg.fraction ?? 0
      setScrollProgress(frac)
      const dy = frac - lastScrollFracRef.current
      lastScrollFracRef.current = frac
      if (dy > 0.005 && headerVisibleRef.current) {
        headerVisibleRef.current = false
        Animated.timing(headerAnim, { toValue: -headerHeightRef.current, duration: 180, useNativeDriver: true }).start()
      } else if (dy < -0.005 && !headerVisibleRef.current) {
        headerVisibleRef.current = true
        Animated.timing(headerAnim, { toValue: 0, duration: 180, useNativeDriver: true }).start()
      }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        if (activeUrl && token) saveReadingProgress(activeUrl, token, id, frac)
      }, DEBOUNCE_MS)
    } else if (msg.type === 'selection' && msg.data) {
      setPendingSelection(msg.data)
      setAnnMode('create')
      setExistingAnnotation(undefined)
      setAnnVisible(true)
    } else if (msg.type === 'tap_annotation' && msg.id) {
      const ann = annotations.find(a => a.id === msg.id)
      if (ann) {
        setExistingAnnotation({ id: ann.id, exact: ann.exact, note: ann.note, color: ann.color })
        setAnnMode('edit')
        setPendingSelection(undefined)
        setAnnVisible(true)
      }
    } else if (msg.type === 'link_press' && msg.href) {
      if (msg.doc_id) {
        router.push(`/document/${encodeURIComponent(msg.doc_id)}`)
      } else {
        handleLinkPress(msg.href)
      }
    } else if (msg.type === 'hl_pin' && msg.id) {
      const hlItem = highlights.find(h => h.id === msg.id)
      if (!hlItem || !activeUrl || !token) return
      const next = hlItem.pinned !== 1
      pinHighlight(activeUrl, token, msg.id, next)
        .then(() => setHighlights(prev => {
          const updated = prev.map(h => h.id === msg.id ? { ...h, pinned: (next ? 1 : 0) as 0 | 1 } : h)
          sendToWebView({ type: 'setHighlights', highlights: toHlData(updated), expanded: hlExpanded })
          return updated
        }))
        .catch(() => toast('Failed to pin', 'error'))
    } else if (msg.type === 'hl_delete' && msg.id) {
      if (!activeUrl || !token) return
      deleteHighlight(activeUrl, token, msg.id)
        .then(() => setHighlights(prev => {
          const updated = prev.filter(h => h.id !== msg.id)
          sendToWebView({ type: 'setHighlights', highlights: toHlData(updated), expanded: hlExpanded })
          return updated
        }))
        .catch(() => toast('Failed to delete', 'error'))
    } else if (msg.type === 'hl_annotate') {
      setPendingSelection({ exact: '', prefix: '', suffix: '', pos_start: 0, pos_end: 0 })
      setAnnMode('create')
      setExistingAnnotation(undefined)
      setAnnVisible(true)
    } else if (msg.type === 'hl_tags' && msg.id) {
      setTagTargetId(msg.id)
      setTagTargetType('highlight')
      setTagModalVisible(true)
    } else if (msg.type === 'hl_toggle_section') {
      setHlExpanded(prev => {
        const next = !prev
        AsyncStorage.setItem(`doc_hl_exp_${id}`, next ? '1' : '0').catch(() => {})
        sendToWebView({ type: 'setHighlights', highlights: toHlData(highlights), expanded: next })
        return next
      })
    }
  }, [id, activeUrl, token, headerAnim, annotations, highlights, hlExpanded, highlight,
    doc, bg, fg, su, bo, ac, mu, sendToWebView, toHlData, handleLinkPress, toast])

  // Native WebView message handler
  const handleMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as ParsedMsg
      handleParsedMessage(msg)
    } catch { /* ignore parse errors */ }
  }, [handleParsedMessage])

  // Web iframe message listener
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const handler = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      try {
        const msg = JSON.parse(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) as ParsedMsg
        handleParsedMessage(msg)
      } catch { /* ignore parse errors */ }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [handleParsedMessage])

  const handleAnnSave = useCallback(async (data: { note: string; color: string }) => {
    if (!activeUrl || !token) return
    setAnnVisible(false)
    try {
      if (annMode === 'create') {
        const sel = pendingSelection ?? { exact: '', prefix: '', suffix: '', pos_start: 0, pos_end: 0 }
        const ann = await createAnnotation(activeUrl, token, id, { ...sel, ...data })
        setAnnotations(prev => [...prev, ann])
        if (sel.exact) injectAddMark(ann)
      } else if (annMode === 'edit' && existingAnnotation) {
        const ann = await updateAnnotation(activeUrl, token, existingAnnotation.id, data)
        setAnnotations(prev => prev.map(a => a.id === ann.id ? ann : a))
        injectRemoveMark(ann.id)
        injectAddMark(ann)
      }
    } catch (e) {
      log.error('annotation save failed', e)
    }
  }, [annMode, pendingSelection, existingAnnotation, activeUrl, token, id, injectAddMark, injectRemoveMark])

  const handleAnnDelete = useCallback(async () => {
    if (!activeUrl || !token || !existingAnnotation) return
    setAnnVisible(false)
    try {
      await deleteAnnotation(activeUrl, token, existingAnnotation.id)
      setAnnotations(prev => prev.filter(a => a.id !== existingAnnotation.id))
      injectRemoveMark(existingAnnotation.id)
    } catch (e) {
      log.error('annotation delete failed', e)
    }
  }, [existingAnnotation, activeUrl, token, injectRemoveMark])

  const handleQueuePipelines = useCallback(async () => {
    if (!activeUrl || !token || queueingPipelines) return
    setQueueingPipelines(true)
    try {
      const result = await queueDocumentPipelines(activeUrl, token, id, true)
      toast(
        result.queued > 0
          ? `Queued ${result.queued} pipeline job${result.queued === 1 ? '' : 's'} (paused)${result.skipped > 0 ? `, ${result.skipped} skipped` : ''}`
          : `No new pipeline jobs (${result.skipped} already active)`,
        result.queued > 0 ? 'success' : 'info',
      )
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to queue pipelines', 'error')
    } finally {
      setQueueingPipelines(false)
    }
  }, [activeUrl, token, id, queueingPipelines, toast])

  const openInWeb = useCallback(() => {
    if (doc?.canonical_url) Linking.openURL(doc.canonical_url)
  }, [doc])

  const handleReadLinkAsDocument = useCallback((href: string) => {
    let title = href
    try { title = new URL(href).hostname } catch { /* keep href */ }
    startScrape(href, title)
  }, [startScrape])

  const progressPct = Math.round(scrollProgress * 100)

  return (
    <SafeAreaView style={s.screen}>
      <Animated.View style={[s.header, { transform: [{ translateY: headerAnim }] }]} onLayout={handleHeaderLayout}>
        <Pressable onPress={() => router.navigate((from as string) ?? '/documents')} style={s.backBtn} hitSlop={12}>
          <Text style={s.backText}>←</Text>
        </Pressable>
        {doc && (
          <Text style={s.headerTitle} numberOfLines={1}>{doc.title || doc.canonical_url}</Text>
        )}
        {doc && (
          <Pressable onPress={openInWeb} style={s.openWebBtn} hitSlop={12}>
            <Ionicons name="open-outline" size={22} color={theme.colors.accent} />
          </Pressable>
        )}
        <Pressable onPress={openMetaPanel} style={s.menuBtn} hitSlop={12}>
          <Text style={s.menuText}>⋮</Text>
        </Pressable>
      </Animated.View>

      {loading ? (
        <View style={s.centered}><ActivityIndicator color={theme.colors.accent} size="large" /></View>
      ) : error ? (
        <View style={s.centered}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable onPress={load} style={s.retryBtn}><Text style={s.retryText}>Retry</Text></Pressable>
        </View>
      ) : htmlContent ? (
        <View style={s.contentArea}>
          {Platform.OS === 'web' ? (
            <View style={s.webView}>
              <iframe
                ref={iframeRef}
                srcDoc={htmlContent ?? ''}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' } as any}
              />
            </View>
          ) : (
            <WebView
              ref={webViewRef}
              source={{ html: htmlContent ?? '', baseUrl: activeUrl ?? '' }}
              style={s.webView}
              onMessage={handleMessage}
              originWhitelist={['*']}
              allowsInlineMediaPlayback
              scrollEnabled
              showsVerticalScrollIndicator={false}
              onShouldStartLoadWithRequest={(req) => req.navigationType !== 'click'}
            />
          )}
        </View>
      ) : null}

      {doc && (
        <View style={s.progressBar}>
          <View style={[s.progressFill, { width: `${progressPct}%` as `${number}%` }]} />
        </View>
      )}

      <AnnotationPanel
        visible={annVisible}
        mode={annMode}
        existing={existingAnnotation}
        onSave={handleAnnSave}
        onDelete={annMode === 'edit' ? handleAnnDelete : undefined}
        onCancel={() => setAnnVisible(false)}
        onTag={handleOpenTagModal}
      />

      <TagSelectorModal
        visible={tagModalVisible}
        objectId={tagTargetId}
        objectType={tagTargetType}
        onClose={() => setTagModalVisible(false)}
      />

      {deleteConfirm && !metaVisible && (
        <Pressable style={s.linkOverlay} onPress={() => { if (!deleting) setDeleteConfirm(false) }}>
          <Pressable style={s.linkSheet} onPress={e => e.stopPropagation()}>
            <Text style={s.linkHost}>Delete document?</Text>
            <Text style={s.linkHref}>This document won't be scraped again.</Text>
            <Pressable
              style={[s.linkBtn, s.deleteConfirmBtn, deleting && s.btnDisabled]}
              onPress={handleDeleteDocument}
              disabled={deleting}
            >
              {deleting ? <ActivityIndicator size="small" color="#fff" /> : null}
              <Text style={s.deleteConfirmBtnText}>{deleting ? 'Deleting…' : 'Confirm delete'}</Text>
            </Pressable>
            <Pressable style={s.linkBtnCancel} onPress={() => setDeleteConfirm(false)} disabled={deleting}>
              <Text style={s.linkBtnCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      )}

      <LinkActionSheet
        url={linkUrl}
        onReadAsDocument={handleReadLinkAsDocument}
        onClose={() => setLinkUrl(null)}
      />

      {metaVisible && doc && (
        <Pressable style={s.metaOverlay} onPress={closeMetaPanel}>
          <Animated.View style={[s.metaPanel, { transform: [{ translateX: metaAnim }] }]}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: theme.spacing.xl }} onStartShouldSetResponder={() => true}>
            <View style={s.metaHeader}>
              <Text style={s.metaTitle}>Document info</Text>
              <Pressable onPress={handleThemeToggle} style={s.themeToggleBtn} hitSlop={8}>
                <Text style={{ fontSize: 16 }}>{isDark ? '☀' : '☾'}</Text>
                <Text style={s.themeToggleTxt}>{isDark ? 'Light' : 'Dark'}</Text>
              </Pressable>
              <Pressable onPress={closeMetaPanel} hitSlop={12}>
                <Text style={s.metaClose}>×</Text>
              </Pressable>
            </View>
            <View style={s.metaActions}>
              <Pressable style={s.metaActionPrimary} onPress={handleAddDocNote}>
                <Ionicons name="create-outline" size={13} color="#fff" />
                <Text style={s.metaActionPrimaryText}>Note</Text>
              </Pressable>
              <Pressable style={s.metaActionOutline} onPress={handleOpenDocTags}>
                <Text style={s.metaActionOutlineText}># Tags</Text>
              </Pressable>
              <Pressable
                style={[s.metaActionPipeline, queueingPipelines && s.btnDisabled]}
                onPress={handleQueuePipelines}
                disabled={queueingPipelines}
              >
                {queueingPipelines
                  ? <ActivityIndicator size="small" color="#a78bfa" />
                  : <Text style={s.metaActionPipelineText}>▶ Pipeline</Text>
                }
              </Pressable>
              <Pressable style={s.metaActionDelete} onPress={() => setDeleteConfirm(true)}>
                <Text style={s.metaActionDeleteText}>🗑</Text>
              </Pressable>
            </View>
            {deleteConfirm && (
              <View style={[s.confirmRow, { marginBottom: theme.spacing.md }]}>
                <Text style={s.confirmText}>Delete this document? It won't be scraped again.</Text>
                <View style={s.confirmBtns}>
                  <Pressable style={s.cancelBtn} onPress={() => setDeleteConfirm(false)} disabled={deleting}>
                    <Text style={s.cancelBtnText}>Cancel</Text>
                  </Pressable>
                  <Pressable style={[s.deleteBtn, deleting && s.btnDisabled]} onPress={handleDeleteDocument} disabled={deleting}>
                    <Text style={s.deleteBtnText}>{deleting ? 'Deleting…' : 'Confirm delete'}</Text>
                  </Pressable>
                </View>
              </View>
            )}
            <View style={s.metaDivider} />
            <View style={s.metaRow}>
              <Text style={s.metaLabel}>URL</Text>
              <Text style={s.metaValue} numberOfLines={3}>{doc.canonical_url}</Text>
            </View>
            {doc.author ? (
              <View style={s.metaRow}>
                <Text style={s.metaLabel}>Author</Text>
                <Text style={s.metaValue}>{doc.author}</Text>
              </View>
            ) : null}
            <View style={s.metaRow}>
              <Text style={s.metaLabel}>Scraped</Text>
              <Text style={s.metaValue}>{new Date(doc.fetched_at).toLocaleString()}</Text>
            </View>
            <View style={s.metaRow}>
              <Text style={s.metaLabel}>Source</Text>
              {sourceFeed ? (
                <Text style={s.metaValue} numberOfLines={2}>
                  {sourceFeed.title || (() => { try { return new URL(sourceFeed.url).hostname } catch { return sourceFeed.url } })()}
                  {'\n'}<Text style={s.metaMuted}>{sourceFeed.kind} feed</Text>
                </Text>
              ) : (
                <Text style={s.metaValue}>Manual</Text>
              )}
            </View>
            <View style={s.metaDivider} />
            <Pressable style={s.viewWebBtn} onPress={() => { closeMetaPanel(); openInWeb() }}>
              <Ionicons name="open-outline" size={18} color={theme.colors.accent} />
              <Text style={s.viewWebBtnText}>View on web</Text>
            </Pressable>
            </ScrollView>
          </Animated.View>
        </Pressable>
      )}
    </SafeAreaView>
  )
}


type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    header: {
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
      paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm,
      borderBottomWidth: 1, borderBottomColor: t.colors.border,
      backgroundColor: t.colors.surface,
      flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
    },
    backBtn: { flexShrink: 0, padding: t.spacing.sm },
    backText: { color: t.colors.accent, fontSize: 20, fontWeight: '400' },
    headerTitle: { flex: 1, color: t.colors.text, fontSize: 15, fontWeight: '600' },
    openWebBtn: { flexShrink: 0, padding: t.spacing.sm },
    menuBtn: { flexShrink: 0, padding: t.spacing.sm },
    menuText: { color: t.colors.text, fontSize: 22, fontWeight: '400', lineHeight: 24 },
    deleteConfirmBtn: { backgroundColor: '#b91c1c' },
    deleteConfirmBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
    centered: { flex: 1, marginTop: 56, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errorText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    contentArea: { flex: 1, marginTop: 56 },
    webView: { flex: 1, backgroundColor: t.colors.background },
    progressBar: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 4, overflow: 'hidden' },
    progressFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: t.colors.accent, opacity: 0.6 },
    metaOverlay: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.45)', zIndex: 20,
      flexDirection: 'row', justifyContent: 'flex-end',
    },
    metaPanel: {
      width: 320,
      maxWidth: 320,
      backgroundColor: t.colors.surface,
      borderLeftWidth: 1, borderLeftColor: t.colors.border,
    },
    metaHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: t.spacing.md },
    metaTitle: { color: t.colors.text, fontSize: 16, fontWeight: '700', flex: 1 },
    metaClose: { color: t.colors.muted, fontSize: 24, lineHeight: 28 },
    themeToggleBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: t.spacing.sm },
    themeToggleTxt: { color: t.colors.muted, fontSize: 13 },
    metaRow: { marginBottom: t.spacing.sm },
    metaLabel: { color: t.colors.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
    metaValue: { color: t.colors.text, fontSize: 14 },
    metaMuted: { color: t.colors.muted, fontSize: 12 },
    metaDivider: { height: 1, backgroundColor: t.colors.border, marginVertical: t.spacing.md },
    viewWebBtn: {
      flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
      borderRadius: 8, borderWidth: 1, borderColor: t.colors.accent,
      paddingVertical: t.spacing.sm, paddingHorizontal: t.spacing.md,
    },
    viewWebBtnText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    deleteBtn: {
      backgroundColor: '#b91c1c',
      borderRadius: 8,
      paddingVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      alignItems: 'center',
    },
    deleteBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
    confirmRow: { gap: t.spacing.sm },
    confirmText: { color: t.colors.text, fontSize: 13, lineHeight: 18 },
    confirmBtns: { flexDirection: 'row', gap: t.spacing.sm },
    cancelBtn: {
      flex: 1, borderRadius: 8, borderWidth: 1, borderColor: t.colors.border,
      paddingVertical: t.spacing.sm, alignItems: 'center',
    },
    cancelBtnText: { color: t.colors.text, fontSize: 15, fontWeight: '500' },
    btnDisabled: { opacity: 0.5 },
    linkOverlay: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.55)', zIndex: 30,
      justifyContent: 'flex-end',
    },
    linkSheet: {
      backgroundColor: t.colors.surface,
      borderTopLeftRadius: 14, borderTopRightRadius: 14,
      borderTopWidth: 1, borderTopColor: t.colors.border,
      padding: t.spacing.lg,
      paddingBottom: t.spacing.xl + 8,
      gap: t.spacing.sm,
    },
    linkHost: { color: t.colors.text, fontSize: 16, fontWeight: '700' },
    linkHref: { color: t.colors.muted, fontSize: 12, marginBottom: t.spacing.sm },
    linkBtn: {
      borderRadius: 10, paddingVertical: t.spacing.md, paddingHorizontal: t.spacing.lg,
      alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: t.spacing.sm,
    },
    linkBtnCancel: { alignItems: 'center', paddingVertical: t.spacing.sm },
    linkBtnCancelText: { color: t.colors.muted, fontSize: 14 },
    metaActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginBottom: t.spacing.md,
    },
    metaActionPrimary: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: t.colors.accent,
    },
    metaActionPrimaryText: { color: '#fff', fontSize: 12, fontWeight: '700' },
    metaActionOutline: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    metaActionOutlineText: { color: t.colors.muted, fontSize: 12, fontWeight: '600' },
    metaActionPipeline: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: '#a78bfa',
      minWidth: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },
    metaActionPipelineText: { color: '#a78bfa', fontSize: 12, fontWeight: '700' },
    metaActionDelete: {
      width: 30,
      height: 30,
      borderRadius: 6,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    metaActionDeleteText: { fontSize: 14, color: t.colors.muted },
  })
}
