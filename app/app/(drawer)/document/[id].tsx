import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useUnistyles } from 'react-native-unistyles'
import WebView from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'
import {
  fetchDocument,
  fetchReadingProgress,
  saveReadingProgress,
  fetchDocumentHtml,
  fetchAnnotations,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  deleteDocument,
  lookupDocumentByURL,
  submitScrapeJob,
  fetchJob,
  fetchPipelines,
  fetchDocumentHighlights,
  fetchDocumentPipelineRuns,
  deleteDocumentHighlights,
  runPipelineOnDocument,
} from '../../../src/api'
import type { Document, Annotation, Pipeline, Highlight, PipelineRun } from '../../../src/api'
import { useConnection } from '../../../src/ConnectionContext'
import AnnotationPanel from '../../../src/AnnotationPanel'
import type { PendingSelection, ExistingAnnotation } from '../../../src/AnnotationPanel'
import TagSelectorModal from '../../../src/TagSelectorModal'

const DEBOUNCE_MS = 1000
const POLL_INTERVAL_MS = 2000
const POLL_MAX_TRIES = 60

type ParsedMsg = { type: string; fraction?: number; data?: PendingSelection; id?: string; href?: string; doc_id?: string }

export default function DocumentViewer() {
  const { id, from, highlight } = useLocalSearchParams<{ id: string; from?: string; highlight?: string }>()
  const router = useRouter()
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])

  const [doc, setDoc] = useState<Document | null>(null)
  const [htmlContent, setHtmlContent] = useState<string | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scrollProgress, setScrollProgress] = useState(0)

  const { activeUrl, token, status } = useConnection()

  const webViewRef = useRef<WebView>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iframeRef = useRef<any>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedProgressRef = useRef(0)
  const headerAnim = useRef(new Animated.Value(0)).current
  const headerHeightRef = useRef(56)
  const headerVisibleRef = useRef(true)
  const lastScrollFracRef = useRef(0)

  // Pipeline / Highlights state
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRun[]>([])
  const [hlLoading, setHlLoading] = useState(false)
  const hlPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadHighlights = useCallback(async () => {
    if (!activeUrl || !token) return
    try {
      const [hl, runs, pls] = await Promise.all([
        fetchDocumentHighlights(activeUrl, token, id),
        fetchDocumentPipelineRuns(activeUrl, token, id),
        fetchPipelines(activeUrl, token),
      ])
      setHighlights(hl)
      setPipelineRuns(runs)
      setPipelines(pls)
    } catch { /* ignore */ }
  }, [activeUrl, token, id])

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
    loadHighlights()
    // Poll every 3s while panel is open (for in-progress runs)
    if (hlPollRef.current) clearInterval(hlPollRef.current)
    hlPollRef.current = setInterval(loadHighlights, 3000)
  }, [metaAnim, loadHighlights])

  const closeMetaPanel = useCallback(() => {
    if (hlPollRef.current) { clearInterval(hlPollRef.current); hlPollRef.current = null }
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
      console.error('document delete failed', e)
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

  // Link action modal state
  const [linkUrl, setLinkUrl] = useState<string | null>(null)
  const [linkScraping, setLinkScraping] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  const handleOpenTagModal = useCallback((annotationId: string) => {
    setTagTargetId(annotationId)
    setAnnVisible(false)
    setTagModalVisible(true)
  }, [])

  const load = useCallback(async () => {
    if (!activeUrl || !token) return
    setLoading(true)
    setError(null)
    try {
      const [d, progress, html, anns, hl] = await Promise.all([
        fetchDocument(activeUrl, token, id),
        fetchReadingProgress(activeUrl, token, id),
        fetchDocumentHtml(activeUrl, token, id),
        fetchAnnotations(activeUrl, token, id),
        fetchDocumentHighlights(activeUrl, token, id),
      ])
      setDoc(d)
      setHtmlContent(html)
      setAnnotations(anns)
      setHighlights(hl)
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
      if (hlPollRef.current) clearInterval(hlPollRef.current)
    }
  }, [id, status, load])

  const handleHeaderLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    headerHeightRef.current = e.nativeEvent.layout.height
  }, [])

  // Inject JS or send postMessage to iframe (platform-aware)
  const injectScrollTo = useCallback((frac: number) => {
    if (Platform.OS === 'web') {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ type: 'scrollTo', fraction: frac }), '*',
      )
    } else {
      webViewRef.current?.injectJavaScript(`window.__scrollTo && window.__scrollTo(${frac}); true;`)
    }
  }, [])

  const injectAddMark = useCallback((ann: Annotation) => {
    if (Platform.OS === 'web') {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ type: 'addMark', annotation: ann }), '*',
      )
    } else {
      webViewRef.current?.injectJavaScript(`window.addMark && window.addMark(${JSON.stringify(ann)}); true;`)
    }
  }, [])

  const injectRemoveMark = useCallback((annId: string) => {
    if (Platform.OS === 'web') {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ type: 'removeMark', id: annId }), '*',
      )
    } else {
      webViewRef.current?.injectJavaScript(`window.removeMark && window.removeMark(${JSON.stringify(annId)}); true;`)
    }
  }, [])

  const injectHighlightAnnotation = useCallback((annId: string) => {
    if (Platform.OS === 'web') {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ type: 'highlightAnnotation', id: annId }), '*',
      )
    } else {
      webViewRef.current?.injectJavaScript(
        `(function(){var m=document.querySelector('mark[data-ann-id="${annId}"]');if(m){m.classList.add('focused');m.scrollIntoView({behavior:'smooth',block:'center'});}})(); true;`,
      )
    }
  }, [])

  const handleDocumentLoad = useCallback(() => {
    if (highlight) {
      setTimeout(() => injectHighlightAnnotation(highlight), 400)
    } else if (savedProgressRef.current > 0) {
      const frac = savedProgressRef.current
      setTimeout(() => {
        injectScrollTo(frac)
        savedProgressRef.current = 0
      }, 300)
    }
  }, [injectScrollTo, injectHighlightAnnotation, highlight])

  const handleLinkPress = useCallback(async (href: string) => {
    if (!activeUrl || !token) return
    const existing = await lookupDocumentByURL(activeUrl, token, href)
    if (existing) {
      router.push(`/document/${encodeURIComponent(existing.id)}`)
      return
    }
    setLinkUrl(href)
    setLinkError(null)
  }, [activeUrl, token, router])

  const handleParsedMessage = useCallback((msg: ParsedMsg) => {
    if (msg.type === 'scroll') {
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
    }
  }, [id, activeUrl, token, headerAnim, annotations, handleLinkPress])

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
      if (annMode === 'create' && pendingSelection) {
        const ann = await createAnnotation(activeUrl, token, id, { ...pendingSelection, ...data })
        setAnnotations(prev => [...prev, ann])
        injectAddMark(ann)
      } else if (annMode === 'edit' && existingAnnotation) {
        const ann = await updateAnnotation(activeUrl, token, existingAnnotation.id, data)
        setAnnotations(prev => prev.map(a => a.id === ann.id ? ann : a))
        injectRemoveMark(ann.id)
        injectAddMark(ann)
      }
    } catch (e) {
      console.error('annotation save failed', e)
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
      console.error('annotation delete failed', e)
    }
  }, [existingAnnotation, activeUrl, token, injectRemoveMark])

  const openInWeb = useCallback(() => {
    if (doc?.canonical_url) Linking.openURL(doc.canonical_url)
  }, [doc])

  const openLinkInBrowser = useCallback(() => {
    if (!linkUrl) return
    if (Platform.OS === 'web') {
      window.open(linkUrl, '_blank', 'noopener,noreferrer')
    } else {
      Linking.openURL(linkUrl)
    }
    setLinkUrl(null)
  }, [linkUrl])

  const scrapeLink = useCallback(async () => {
    if (!linkUrl || !activeUrl || !token) return
    setLinkScraping(true)
    setLinkError(null)
    try {
      const { job_id } = await submitScrapeJob(activeUrl, token, linkUrl)
      let docId: string | null = null
      for (let i = 0; i < POLL_MAX_TRIES; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
        const job = await fetchJob(activeUrl, token, job_id)
        if (job.status === 'done') {
          const result = JSON.parse(job.result || '{}') as { document_id?: string }
          docId = result.document_id ?? null
          break
        }
        if (job.status === 'dead') {
          throw new Error(job.last_error || 'scrape failed')
        }
      }
      if (!docId) throw new Error('scrape timed out')
      setLinkUrl(null)
      router.push(`/document/${encodeURIComponent(docId)}`)
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : 'scrape failed')
    } finally {
      setLinkScraping(false)
    }
  }, [linkUrl, activeUrl, token, router])

  const progressPct = Math.round(scrollProgress * 100)

  const displayHtml = useMemo(() => {
    if (!htmlContent) return htmlContent
    if (highlights.length === 0) return htmlContent
    const kindColors: Record<string, string> = {
      summary: theme.colors.accent,
      link: '#6b8cff',
      note: '#b8a0ff',
    }
    const cards = highlights.map(hl => {
      const kc = kindColors[hl.kind] ?? '#888'
      const titleHtml = hl.title
        ? `<div style="font-size:13px;font-weight:600;color:${theme.colors.text};flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(hl.title)}</div>`
        : ''
      return `<div style="background:${theme.colors.surface};border:1px solid ${theme.colors.border};border-radius:10px;padding:14px;margin-bottom:10px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="background:${kc};color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;text-transform:uppercase">${escHtml(hl.kind)}</span>${titleHtml}</div><p style="margin:0;font-size:14px;line-height:1.6;color:${theme.colors.text}">${escHtml(hl.body)}</p></div>`
    }).join('')
    const section = `<div style="padding:12px;background:${theme.colors.background}">${cards}</div>`
    return htmlContent.replace(/<body([^>]*)>/i, `<body$1>${section}`)
  }, [htmlContent, highlights, theme])

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
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <iframe
                ref={iframeRef}
                srcDoc={displayHtml ?? ''}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' } as any}
                onLoad={handleDocumentLoad}
              />
            </View>
          ) : (
            <WebView
              ref={webViewRef}
              source={{ html: displayHtml ?? '', baseUrl: activeUrl ?? '' }}
              style={s.webView}
              onMessage={handleMessage}
              onLoad={handleDocumentLoad}
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
        objectType="annotation"
        onClose={() => setTagModalVisible(false)}
      />

      {linkUrl && (
        <Pressable style={s.linkOverlay} onPress={() => { if (!linkScraping) setLinkUrl(null) }}>
          <Pressable style={s.linkSheet} onPress={e => e.stopPropagation()}>
            <Text style={s.linkHost} numberOfLines={1}>
              {(() => { try { return new URL(linkUrl).hostname } catch { return linkUrl } })()}
            </Text>
            <Text style={s.linkHref} numberOfLines={2}>{linkUrl}</Text>
            {linkError ? <Text style={s.linkErr}>{linkError}</Text> : null}
            <Pressable
              style={[s.linkBtn, s.linkBtnPrimary, linkScraping && s.btnDisabled]}
              onPress={scrapeLink}
              disabled={linkScraping}
            >
              {linkScraping ? (
                <ActivityIndicator size="small" color="#0b0b0c" />
              ) : null}
              <Text style={s.linkBtnPrimaryText}>{linkScraping ? 'Scraping…' : 'Read as document'}</Text>
            </Pressable>
            <Pressable
              style={[s.linkBtn, s.linkBtnSecondary, linkScraping && s.btnDisabled]}
              onPress={openLinkInBrowser}
              disabled={linkScraping}
            >
              <Text style={s.linkBtnSecondaryText}>Open in browser</Text>
            </Pressable>
            <Pressable
              style={s.linkBtnCancel}
              onPress={() => setLinkUrl(null)}
              disabled={linkScraping}
            >
              <Text style={s.linkBtnCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      )}

      {metaVisible && doc && (
        <Pressable style={s.metaOverlay} onPress={closeMetaPanel}>
          <Animated.View style={[s.metaPanel, { transform: [{ translateX: metaAnim }] }]}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: theme.spacing.xl }} onStartShouldSetResponder={() => true}>
            <View style={s.metaHeader}>
              <Text style={s.metaTitle}>Document info</Text>
              <Pressable onPress={closeMetaPanel} hitSlop={12}>
                <Text style={s.metaClose}>×</Text>
              </Pressable>
            </View>
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
            <View style={s.metaDivider} />
            <Pressable style={s.viewWebBtn} onPress={() => { closeMetaPanel(); openInWeb() }}>
              <Ionicons name="open-outline" size={18} color={theme.colors.accent} />
              <Text style={s.viewWebBtnText}>View on web</Text>
            </Pressable>
            <View style={s.metaDivider} />
            <HighlightsSection
              docId={id}
              serverUrl={activeUrl ?? ''}
              token={token ?? ''}
              highlights={highlights}
              pipelineRuns={pipelineRuns}
              pipelines={pipelines}
              hlLoading={hlLoading}
              setHlLoading={setHlLoading}
              reload={loadHighlights}
            />
            <View style={s.metaDivider} />
            {!deleteConfirm ? (
              <Pressable style={s.deleteBtn} onPress={() => setDeleteConfirm(true)}>
                <Text style={s.deleteBtnText}>Delete document</Text>
              </Pressable>
            ) : (
              <View style={s.confirmRow}>
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
            </ScrollView>
          </Animated.View>
        </Pressable>
      )}
    </SafeAreaView>
  )
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
      width: 300,
      flex: 1,
      backgroundColor: t.colors.surface,
      borderLeftWidth: 1, borderLeftColor: t.colors.border,
    },
    metaHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: t.spacing.md },
    metaTitle: { color: t.colors.text, fontSize: 16, fontWeight: '700' },
    metaClose: { color: t.colors.muted, fontSize: 24, lineHeight: 28 },
    metaRow: { marginBottom: t.spacing.sm },
    metaLabel: { color: t.colors.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
    metaValue: { color: t.colors.text, fontSize: 14 },
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
    linkErr: { color: t.colors.error, fontSize: 13 },
    linkBtn: {
      borderRadius: 10, paddingVertical: t.spacing.md, paddingHorizontal: t.spacing.lg,
      alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: t.spacing.sm,
    },
    linkBtnPrimary: { backgroundColor: t.colors.accent },
    linkBtnPrimaryText: { color: '#0b0b0c', fontSize: 15, fontWeight: '700' },
    linkBtnSecondary: { borderWidth: 1, borderColor: t.colors.border },
    linkBtnSecondaryText: { color: t.colors.text, fontSize: 15, fontWeight: '500' },
    linkBtnCancel: { alignItems: 'center', paddingVertical: t.spacing.sm },
    linkBtnCancelText: { color: t.colors.muted, fontSize: 14 },
  })
}

// ── Highlights section in meta panel ─────────────────────────────────────────

type HighlightsSectionProps = {
  docId: string
  serverUrl: string
  token: string
  highlights: Highlight[]
  pipelineRuns: PipelineRun[]
  pipelines: Pipeline[]
  hlLoading: boolean
  setHlLoading: (v: boolean) => void
  reload: () => void
}

function HighlightsSection({
  docId, serverUrl, token, highlights, pipelineRuns, pipelines, hlLoading, setHlLoading, reload,
}: HighlightsSectionProps) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildHlStyles(theme), [theme])

  const handleDeleteAll = useCallback(async () => {
    setHlLoading(true)
    try { await deleteDocumentHighlights(serverUrl, token, docId) } catch { /* */ }
    reload()
    setHlLoading(false)
  }, [serverUrl, token, docId, reload, setHlLoading])

  const handleRerun = useCallback(async (pipelineId: string) => {
    setHlLoading(true)
    try {
      await deleteDocumentHighlights(serverUrl, token, docId)
      await runPipelineOnDocument(serverUrl, token, pipelineId, docId)
    } catch { /* */ }
    reload()
    setHlLoading(false)
  }, [serverUrl, token, docId, reload, setHlLoading])

  const anyRunning = pipelineRuns.some(r => r.status === 'queued' || r.status === 'running')

  if (pipelines.length === 0 && highlights.length === 0) {
    return (
      <Text style={s.empty}>No pipelines configured.</Text>
    )
  }

  return (
    <View>
      <View style={s.header}>
        <Text style={s.sectionTitle}>Pipelines</Text>
        {anyRunning && <ActivityIndicator size="small" color={theme.colors.accent} />}
      </View>

      {pipelineRuns.map(run => {
        const pl = pipelines.find(p => p.id === run.pipeline_id)
        const runHighlights = highlights.filter(h => h.pipeline_run_id === run.id)
        return (
          <View key={run.id} style={s.runBlock}>
            <View style={s.runHeader}>
              <Text style={s.runName}>{pl?.name ?? 'Pipeline'}</Text>
              <View style={[s.statusBadge, run.status === 'done' ? s.statusDone : run.status === 'failed' ? s.statusFailed : s.statusRunning]}>
                <Text style={s.statusText}>{run.status}</Text>
              </View>
            </View>
            {runHighlights.length === 0 && run.status !== 'done' && (
              <Text style={s.waiting}>
                {run.status === 'running' || run.status === 'queued' ? 'Running…' : 'No highlights'}
              </Text>
            )}
            {pl && (
              <Pressable
                style={[s.rerunBtn, hlLoading && s.rerunDisabled]}
                onPress={() => handleRerun(pl.id)}
                disabled={hlLoading}
              >
                <Text style={s.rerunText}>Delete all & rerun</Text>
              </Pressable>
            )}
          </View>
        )
      })}

      {pipelineRuns.length === 0 && pipelines.length > 0 && (
        <View>
          <Text style={s.empty}>No runs yet. Runs trigger on new documents.</Text>
          {pipelines.map(pl => (
            <Pressable
              key={pl.id}
              style={[s.rerunBtn, hlLoading && s.rerunDisabled]}
              onPress={() => handleRerun(pl.id)}
              disabled={hlLoading}
            >
              <Text style={s.rerunText}>Run "{pl.name}"</Text>
            </Pressable>
          ))}
        </View>
      )}

      {highlights.length > 0 && (
        <Pressable
          style={[s.deleteAllBtn, hlLoading && s.rerunDisabled]}
          onPress={handleDeleteAll}
          disabled={hlLoading}
        >
          <Text style={s.deleteAllText}>Delete all highlights</Text>
        </Pressable>
      )}
    </View>
  )
}

function buildHlStyles(t: ReturnType<typeof useUnistyles>['theme']) {
  return StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: t.spacing.sm },
    sectionTitle: { color: t.colors.text, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
    empty: { color: t.colors.muted, fontSize: 13, marginBottom: t.spacing.sm },
    runBlock: { marginBottom: t.spacing.md },
    runHeader: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginBottom: t.spacing.sm },
    runName: { color: t.colors.text, fontSize: 13, fontWeight: '600', flex: 1 },
    statusBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
    statusDone: { backgroundColor: '#166534' },
    statusFailed: { backgroundColor: '#7f1d1d' },
    statusRunning: { backgroundColor: '#1e3a5f' },
    statusText: { color: '#fff', fontSize: 10, fontWeight: '600' },
    waiting: { color: t.colors.muted, fontSize: 12, marginBottom: t.spacing.sm },
    rerunBtn: {
      borderWidth: 1, borderColor: t.colors.accent, borderRadius: 6,
      paddingVertical: t.spacing.sm, alignItems: 'center', marginTop: t.spacing.sm,
    },
    rerunText: { color: t.colors.accent, fontSize: 12, fontWeight: '600' },
    rerunDisabled: { opacity: 0.4 },
    deleteAllBtn: {
      borderWidth: 1, borderColor: '#b91c1c', borderRadius: 6,
      paddingVertical: t.spacing.sm, alignItems: 'center', marginTop: t.spacing.sm,
    },
    deleteAllText: { color: '#b91c1c', fontSize: 12, fontWeight: '600' },
  })
}
