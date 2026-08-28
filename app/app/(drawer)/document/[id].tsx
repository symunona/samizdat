import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLogger } from '../../../src/logger'

const log = createLogger('document')
import {
  ActivityIndicator,
  Animated,
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
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import WebView from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'
import {
  fetchDocument,
  fetchReadingProgress,
  fetchAnnotations,
  lookupDocumentByURL,
  fetchDocumentHighlights,
  fetchFeed,
  queueDocumentPipelines,
  fetchDocumentTags,
} from '../../../src/api'
import type { Document, Annotation, HighlightWithDoc, Feed, Tag } from '../../../src/api'
import * as db from '../../../src/db'
import { tagColor } from '../../../src/tagColor'
import { openExternal, isWebUrl } from '../../../src/openExternal'
import { useConnection } from '../../../src/ConnectionContext'
import { useFailedJobs, documentErrorText } from '../../../src/failedJobs'
import { useToast } from '../../../src/ToastContext'
import { saveTheme } from '../../../src/prefs'
import { useWebPageTitle } from '../../../src/webPageTitle'
import AnnotationPanel from '../../../src/AnnotationPanel'
import type { PendingSelection, ExistingAnnotation } from '../../../src/AnnotationPanel'
import SelectionActions from '../../../src/SelectionActions'
import TagSelectorModal from '../../../src/TagSelectorModal'
import LinkActionSheet from '../../../src/LinkActionSheet'
import { useScrapeQueue } from '../../../src/ScrapeQueueContext'
import { buildDocumentHtml, mdToHtml } from '../../../src/markdownToHtml'
import VideoDocument from '../../../src/VideoDocument'
import { useReadingModeStore } from '../../../src/store/readingModeStore'
import type { ReadingMode } from '../../../src/prefs'
import { ImageLightbox } from '../../../src/ImageViewer'
import PendingPipelineBanner from '../../../src/PendingPipelineBanner'

const DEBOUNCE_MS = 1000

// The 3-way reading preference (global, never per-document — see readingModeStore).
const READING_MODES: { key: ReadingMode; label: string }[] = [
  { key: 'flow', label: 'Flow' },
  { key: 'auto', label: 'Auto' },
  { key: 'page', label: 'Page' },
]

// The one info line under the control: what the setting does to THIS document.
// `resolved` is what the viewer reported back after measuring it.
function readingModeInfo(
  mode: ReadingMode,
  threshold: number,
  resolved: { paginated: boolean; pages: number } | null,
): string {
  if (mode === 'flow') return 'Continuous scrolling, however long the document is'
  if (mode === 'page') {
    return resolved?.pages
      ? `Always paginated — ${resolved.pages} pages here; swipe or ← → to turn`
      : 'Always paginated — swipe or ← → to turn'
  }
  if (!resolved) return `Paginates documents longer than ${threshold} pages`
  return `~${resolved.pages} pages here, limit ${threshold} → ${resolved.paginated ? 'paginated' : 'continuous'}`
}

type ParsedMsg = {
  type: string
  fraction?: number
  data?: PendingSelection
  id?: string
  href?: string
  doc_id?: string
  msg?: string
  src?: string
  alt?: string
  paginated?: boolean
  pages?: number
}

export default function DocumentViewer() {
  const { id, from, highlight } = useLocalSearchParams<{ id: string; from?: string; highlight?: string }>()
  const router = useRouter()
  const { theme, rt } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  // Header floats absolute at top:0, so RN SafeAreaView (a no-op on Android
  // anyway) can't push it clear of the status bar/notch — pad it (and the
  // content offset) by the top inset explicitly. See guard: `just check-safe-area`.
  const insets = useSafeAreaInsets()
  const isDark = rt.themeName === 'dark'

  const [doc, setDoc] = useState<Document | null>(null)
  const [htmlContent, setHtmlContent] = useState<string | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scrollProgress, setScrollProgress] = useState(0)
  // Image tapped inside the document-viewer WebView (raw DOM — no RN component there).
  const [lightbox, setLightbox] = useState<{ src: string; alt?: string } | null>(null)

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
  const htmlContentRef = useRef<string | null>(null)

  // Set the article HTML, but ONLY when it actually changed — a same-value refresh must
  // not reload the WebView (which would wipe injected annotation marks). Resetting
  // isDocLoadedRef=false is tied to a real reload here: the WebView flips it back true on
  // its next 'ready'. Setting it false on a no-op refresh would strand it (no reload =
  // no 'ready') and the annotations effect would stop syncing marks.
  const applyHtml = useCallback((html: string | null) => {
    if (htmlContentRef.current === html) return
    htmlContentRef.current = html
    isDocLoadedRef.current = false
    setHtmlContent(html)
  }, [])

  // Highlights state
  const [highlights, setHighlights] = useState<HighlightWithDoc[]>([])
  const [hlExpanded, setHlExpanded] = useState(true)
  // Which highlights already carry a note (see HighlightCard `hasNote` — the WebView
  // card mirrors it). Read through refs by the repaint effect below so a highlight
  // edit does not re-push the whole set.
  const notedIds = db.useAnnotatedHighlightIds()
  const highlightsRef = useRef(highlights)
  highlightsRef.current = highlights
  const hlExpandedRef = useRef(hlExpanded)
  hlExpandedRef.current = hlExpanded

  useEffect(() => {
    db.getSetting(`doc_hl_exp_${id}`).then(val => {
      if (val !== null) setHlExpanded(val === '1')
    }).catch(() => {})
  }, [id])

  // Reading mode: flow / auto / page. The pagination — and resolving `auto` against
  // this document's length — lives in the WebView (only it knows the laid-out box
  // sizes); the host owns the preference and reports back what it resolved to.
  const readingMode = useReadingModeStore(st => st.mode)
  const pageThreshold = useReadingModeStore(st => st.threshold)
  const hydrateReadingMode = useReadingModeStore(st => st.hydrate)
  const setReadingMode = useReadingModeStore(st => st.setMode)
  const [resolvedPaging, setResolvedPaging] = useState<{ paginated: boolean; pages: number } | null>(null)

  useEffect(() => { void hydrateReadingMode() }, [hydrateReadingMode])

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

  // Single source of truth for marks: whenever the annotation set changes (initial
  // async load, create, edit, delete), re-sync the whole set into the WebView. The
  // `init` message seeds annotations on `ready`, but the fetch can resolve AFTER the
  // WebView is up — without this the marks never render (VideoDocument has the same
  // effect; the article viewer previously relied on per-op injects and missed the race).
  useEffect(() => {
    if (!isDocLoadedRef.current) return
    sendToWebView({ type: 'setAnnotations', annotations })
  }, [sendToWebView, annotations])

  // Push the preference on every change — this also covers the store hydrating (or
  // Settings changing the threshold) AFTER the viewer already got its `init`.
  useEffect(() => {
    if (!isDocLoadedRef.current) return
    sendToWebView({ type: 'setReadingMode', mode: readingMode, threshold: pageThreshold })
  }, [sendToWebView, readingMode, pageThreshold])

  // Meta panel state
  const [metaVisible, setMetaVisible] = useState(false)
  const metaAnim = useRef(new Animated.Value(320)).current

  const openMetaPanel = useCallback(() => {
    setMetaVisible(true)
    metaAnim.setValue(320)
    Animated.timing(metaAnim, { toValue: 0, duration: 220, useNativeDriver: true }).start()
  }, [metaAnim])

  const closeMetaPanel = useCallback(() => {
    Animated.timing(metaAnim, { toValue: 320, duration: 180, useNativeDriver: true }).start(() => {
      setMetaVisible(false)
    })
  }, [metaAnim])

  // A pipeline-added document knows the document whose links it was pulled from —
  // jump there from the meta panel.
  const openLinkingDoc = useCallback(() => {
    const parentID = doc?.added_via?.document_id
    if (!parentID) return
    closeMetaPanel()
    router.push(`/document/${encodeURIComponent(parentID)}`)
  }, [doc, closeMetaPanel, router])

  // Annotation panel state
  const [annVisible, setAnnVisible] = useState(false)
  const [annMode, setAnnMode] = useState<'create' | 'edit'>('create')
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | undefined>()
  const [existingAnnotation, setExistingAnnotation] = useState<ExistingAnnotation | undefined>()
  // Body the annotation composer opens with — set only when an AI answer is kept.
  const [annInitialNote, setAnnInitialNote] = useState('')

  // Selection context menu ("···" next to Annotate). Null = closed.
  const [menuSelection, setMenuSelection] = useState<PendingSelection | null>(null)

  // Tag selector modal state
  const [tagModalVisible, setTagModalVisible] = useState(false)
  const [tagTargetId, setTagTargetId] = useState<string>('')
  const [tagTargetType, setTagTargetType] = useState<'document' | 'annotation' | 'highlight'>('annotation')
  const [docTags, setDocTags] = useState<Tag[]>([])

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
    setAnnInitialNote('')
    setAnnVisible(true)
  }, [])

  // An AI answer the reader kept: it becomes a normal Annotation on the ORIGINAL
  // selection — same local-first path as any note, so it syncs and exports.
  const handleSaveAiNote = useCallback((sel: PendingSelection, answer: string) => {
    setPendingSelection(sel)
    setAnnMode('create')
    setExistingAnnotation(undefined)
    setAnnInitialNote(answer)
    setAnnVisible(true)
  }, [])

  // Offline fallback: the replica holds the FULL document set (markdown, highlights,
  // annotations, tags), so a cached article reads without the network. Rebuilds the
  // whole view from the DB layer; returns false when this document isn't cached.
  //
  // The joins come from the reactive hooks, read through a ref so `loadFromStore` keeps
  // a stable identity: it feeds `load`, and a callback that changed on every replica
  // write would re-fetch the document over the network on every star or annotation.
  // Only the BODY is a real query — it never enters the in-memory index.
  const storeDocs = db.useDocuments()
  const storeHighlights = db.useFeedHighlights()
  const storeAnnotations = db.useAnnotationsFor({ documentId: id })
  const storeTags = db.useTags()
  const storeDocTagIds = db.useTagLinks('doc', id)
  const storeRef = useRef({ storeDocs, storeHighlights, storeAnnotations, storeTags, storeDocTagIds })
  storeRef.current = { storeDocs, storeHighlights, storeAnnotations, storeTags, storeDocTagIds }

  const loadFromStore = useCallback(async (): Promise<boolean> => {
    const d = await db.getDocument(id)
    if (!d || d.deleted_at) return false
    const st = storeRef.current
    const docsByUrl: Record<string, string> = {}
    for (const doc of st.storeDocs) docsByUrl[doc.canonical_url] = doc.id
    const tagById = new Map(st.storeTags.map(t => [t.id, t]))
    const hls: HighlightWithDoc[] = st.storeHighlights
      .filter(h => h.document_id === id)
      // Synced rows have no server-rendered body_html — render it so the WebView
      // highlight cards show formatted markdown, not raw source.
      .map(h => ({ ...h, body_html: h.body_html ?? mdToHtml(h.body) }))
    setDoc(d)
    setDocTags(st.storeDocTagIds.map(tid => tagById.get(tid)).filter((t): t is Tag => !!t))
    applyHtml(d.media_type === 'video' ? null : buildDocumentHtml(d.markdown, d.title || d.canonical_url, docsByUrl, activeUrl ?? ''))
    setAnnotations(st.storeAnnotations)
    setHighlights(hls)
    setSourceFeed(null)
    return true
  }, [id, applyHtml, activeUrl])

  const load = useCallback(async (background = false) => {
    if (!activeUrl || !token) return
    // Background refresh (we already rendered the cached copy) → no full-screen spinner.
    if (!background) setLoading(true)
    setError(null)
    try {
      const docsByUrl: Record<string, string> = {}
      for (const d of storeRef.current.storeDocs) docsByUrl[d.canonical_url] = d.id
      const [d, progress, anns, hl, dtags] = await Promise.all([
        fetchDocument(activeUrl, token, id),
        fetchReadingProgress(activeUrl, token, id),
        fetchAnnotations(activeUrl, token, id),
        fetchDocumentHighlights(activeUrl, token, id),
        fetchDocumentTags(activeUrl, token, id),
      ])
      setDoc(d)
      setDocTags(dtags)
      // Video Documents render in a dedicated player screen (VideoDocument),
      // not the article WebView — skip the article HTML build. Only replace the HTML
      // when it actually changed, so the background refresh doesn't reload the WebView
      // (and wipe freshly-injected annotation marks) after a store-first render.
      applyHtml(d.media_type === 'video' ? null : buildDocumentHtml(d.markdown, d.title || d.canonical_url, docsByUrl, activeUrl ?? ''))
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
      // Network hiccup / offline — fall back to the cached copy before erroring.
      if (await loadFromStore()) setError(null)
      else if (!background) setError(e instanceof Error ? e.message : 'Failed to load document')
    } finally {
      setLoading(false)
    }
  }, [activeUrl, token, id, loadFromStore, applyHtml])

  useEffect(() => {
    // Store-first: render the cached copy instantly (snappy, offline-ready, and no flash
    // of the previously-open article), then refresh from the network in the background.
    // The cache read is a real query now, so the follow-up waits on it.
    let alive = true
    loadFromStore().then(cached => {
      if (!alive) return
      if (status === 'connected') {
        load(cached) // silent refresh when we already showed cache; spinner only if not cached
      } else if (status === 'disconnected') {
        setLoading(false)
        setError(cached ? null : 'Not connected — this document isn’t saved offline')
      }
    })
    return () => {
      alive = false
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [id, status, load, loadFromStore])

  const handleHeaderLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    headerHeightRef.current = e.nativeEvent.layout.height
  }, [])

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
      hasNote: notedIds.has(h.id),
      tags: (h.tags ?? []).map(t => ({ id: t.id, name: t.name, color: t.color })),
    })), [notedIds])

  // A note taken on a card must repaint that card. `setAnnotations` above only moves
  // marks; the card's dotted border lives in the highlight payload, so it needs its own
  // push — the note is created after the WebView already has its highlights.
  useEffect(() => {
    if (!isDocLoadedRef.current) return
    sendToWebView({ type: 'setHighlights', highlights: toHlData(highlightsRef.current), expanded: hlExpandedRef.current })
  }, [sendToWebView, toHlData])

  const handleParsedMessage = useCallback((msg: ParsedMsg) => {
    if (msg.type === 'debug') {
      // Diagnostic line forwarded from the document-viewer WebView (native selection
      // path). Flows through the logger sink to the device-log channel (just device-logs).
      log.log(msg.msg ?? '')
      return
    }
    if (msg.type === 'ready') {
      isDocLoadedRef.current = true
      sendToWebView({
        type: 'init',
        doc: { title: doc?.title ?? '' },
        highlights: toHlData(highlights),
        annotations,
        theme: { background: bg, text: fg, surface: su, border: bo, accent: ac, muted: mu },
        hlExpanded,
        readingMode,
        pageThreshold,
        scrollFraction: savedProgressRef.current,
        focusId: highlight,
      })
      savedProgressRef.current = 0
    } else if (msg.type === 'readingMode') {
      // What the viewer actually resolved the preference to for THIS document.
      setResolvedPaging({ paginated: !!msg.paginated, pages: msg.pages ?? 0 })
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
        db.saveProgress(id, frac)
      }, DEBOUNCE_MS)
    } else if (msg.type === 'selection' && msg.data) {
      setPendingSelection(msg.data)
      setAnnMode('create')
      setExistingAnnotation(undefined)
      setAnnInitialNote('')
      setAnnVisible(true)
    } else if (msg.type === 'selection_menu' && msg.data) {
      setMenuSelection(msg.data)
    } else if (msg.type === 'tap_annotation' && msg.id) {
      const ann = annotations.find(a => a.id === msg.id)
      if (ann) {
        setExistingAnnotation({ id: ann.id, exact: ann.exact, note: ann.note, color: ann.color })
        setAnnMode('edit')
        setPendingSelection(undefined)
        setAnnVisible(true)
      }
    } else if (msg.type === 'image_tap' && msg.src) {
      setLightbox({ src: msg.src, alt: msg.alt })
    } else if (msg.type === 'link_press' && msg.href) {
      if (msg.doc_id) {
        router.push(`/document/${encodeURIComponent(msg.doc_id)}`)
      } else {
        handleLinkPress(msg.href)
      }
    } else if (msg.type === 'hl_pin' && msg.id) {
      const hlItem = highlights.find(h => h.id === msg.id)
      if (!hlItem) return
      const next = hlItem.pinned !== 1
      db.pinHighlight(msg.id, next) // local-first: replica + outbox, no await
      setHighlights(prev => {
        const updated = prev.map(h => h.id === msg.id ? { ...h, pinned: (next ? 1 : 0) as 0 | 1 } : h)
        sendToWebView({ type: 'setHighlights', highlights: toHlData(updated), expanded: hlExpanded })
        return updated
      })
    } else if (msg.type === 'hl_delete' && msg.id) {
      db.deleteHighlight(msg.id)
      setHighlights(prev => {
        const updated = prev.filter(h => h.id !== msg.id)
        sendToWebView({ type: 'setHighlights', highlights: toHlData(updated), expanded: hlExpanded })
        return updated
      })
    } else if (msg.type === 'hl_annotate') {
      setPendingSelection({ exact: '', prefix: '', suffix: '', pos_start: 0, pos_end: 0 })
      setAnnMode('create')
      setExistingAnnotation(undefined)
      setAnnInitialNote('')
      setAnnVisible(true)
    } else if (msg.type === 'hl_tags' && msg.id) {
      setTagTargetId(msg.id)
      setTagTargetType('highlight')
      setTagModalVisible(true)
    } else if (msg.type === 'hl_toggle_section') {
      setHlExpanded(prev => {
        const next = !prev
        db.setSetting(`doc_hl_exp_${id}`, next ? '1' : '0').catch(() => {})
        sendToWebView({ type: 'setHighlights', highlights: toHlData(highlights), expanded: next })
        return next
      })
    }
  }, [id, headerAnim, annotations, highlights, hlExpanded, highlight, readingMode, pageThreshold,
    doc, bg, fg, su, bo, ac, mu, sendToWebView, toHlData, handleLinkPress, router])

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

  // Local-first: write to the replica + outbox (no network), patch the local marks list.
  const handleAnnSave = useCallback(async (data: { note: string; color: string }) => {
    setAnnVisible(false)
    if (annMode === 'create') {
      const sel = pendingSelection ?? { exact: '', prefix: '', suffix: '', pos_start: 0, pos_end: 0 }
      const ann = await db.createAnnotation({
        documentId: id, exact: sel.exact, prefix: sel.prefix, suffix: sel.suffix,
        posStart: sel.pos_start, posEnd: sel.pos_end, note: data.note, color: data.color,
      })
      setAnnotations(prev => [...prev, ann]) // marks re-sync via the annotations effect
    } else if (annMode === 'edit' && existingAnnotation) {
      db.updateAnnotation(existingAnnotation.id, data.note, data.color)
      setAnnotations(prev => prev.map(a =>
        a.id === existingAnnotation.id ? { ...a, note: data.note, color: data.color } : a))
    }
  }, [annMode, pendingSelection, existingAnnotation, id])

  const handleAnnDelete = useCallback(() => {
    if (!existingAnnotation) return
    setAnnVisible(false)
    db.deleteAnnotation(existingAnnotation.id)
    setAnnotations(prev => prev.filter(a => a.id !== existingAnnotation.id)) // effect removes the mark
  }, [existingAnnotation])

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
    openExternal(doc?.canonical_url)
  }, [doc])

  // A permanently-failed job on this Document (scrape/pipeline/asset fetch) is
  // invisible otherwise — surface its reason next to the Document's own flag.
  const { failed } = useFailedJobs()

  const handleReadLinkAsDocument = useCallback((href: string) => {
    let title = href
    try { title = new URL(href).hostname } catch { /* keep href */ }
    startScrape(href, title)
  }, [startScrape])

  const progressPct = Math.round(scrollProgress * 100)

  // {{article_summary}} for the context menu's AI actions: the pipeline's summary
  // Highlight when there is one, else the head of the body — a model asked about a
  // sentence reads very differently when it knows what the article is.
  const articleSummary = useMemo(() => {
    const summary = highlights.find(h => h.kind === 'summary')
    return (summary?.body ?? doc?.markdown ?? '').slice(0, 1200)
  }, [highlights, doc])

  // Video/podcast Documents get a dedicated player + transcript screen.
  // Only trust doc/htmlContent when they belong to the CURRENT id — otherwise the
  // previous article flashes for a frame during navigation before the effect reloads.
  const docForId = doc && doc.id === id ? doc : null

  const docErrorText = documentErrorText(docForId, failed)

  useWebPageTitle(docForId?.title || docForId?.canonical_url)

  if (docForId && docForId.media_type === 'video') {
    return <VideoDocument doc={docForId} from={from} />
  }

  return (
    <SafeAreaView style={s.screen}>
      <Animated.View style={[s.header, { paddingTop: theme.spacing.sm + insets.top, transform: [{ translateY: headerAnim }] }]} onLayout={handleHeaderLayout}>
        <Pressable onPress={() => router.navigate((from as string) ?? '/documents')} style={s.backBtn} hitSlop={12}>
          <Text style={s.backText}>←</Text>
        </Pressable>
        {docForId && (
          <Text style={s.headerTitle} numberOfLines={1}>{docForId.title || docForId.canonical_url}</Text>
        )}
        {docForId && isWebUrl(docForId.canonical_url) && (
          <Pressable onPress={openInWeb} style={s.openWebBtn} hitSlop={12}>
            <Ionicons name="open-outline" size={22} color={theme.colors.accent} />
          </Pressable>
        )}
        <Pressable onPress={openMetaPanel} style={s.menuBtn} hitSlop={12}>
          <Text style={s.menuText}>⋮</Text>
        </Pressable>
      </Animated.View>

      {docForId && htmlContent ? (
        <View style={[s.contentArea, { marginTop: 56 + insets.top }]}>
          {docErrorText ? (
            <View style={s.docErrorBanner}>
              <Text style={s.docErrorBannerText}>⚠ {docErrorText}</Text>
            </View>
          ) : null}
          <PendingPipelineBanner docId={id} />
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
              // Article images are absolute CDN URLs; allow them regardless of the
              // page's (baseUrl) scheme so they aren't blocked as mixed content on Android.
              mixedContentMode="always"
              scrollEnabled
              showsVerticalScrollIndicator={false}
              onShouldStartLoadWithRequest={(req) => req.navigationType !== 'click'}
            />
          )}
        </View>
      ) : loading ? (
        <View style={s.centered}><ActivityIndicator color={theme.colors.accent} size="large" /></View>
      ) : error ? (
        <View style={s.centered}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable onPress={() => load()} style={s.retryBtn}><Text style={s.retryText}>Retry</Text></Pressable>
        </View>
      ) : docErrorText ? (
        <View style={[s.centered, { marginTop: 56 + insets.top }]}>
          <View style={s.docErrorBanner}>
            <Text style={s.docErrorBannerText}>⚠ {docErrorText}</Text>
          </View>
        </View>
      ) : null}

      {docForId && (
        <View style={s.progressBar}>
          <View style={[s.progressFill, { width: `${progressPct}%` as `${number}%` }]} />
        </View>
      )}

      <AnnotationPanel
        visible={annVisible}
        mode={annMode}
        selection={pendingSelection}
        existing={existingAnnotation}
        initialNote={annInitialNote}
        onSave={handleAnnSave}
        onDelete={annMode === 'edit' ? handleAnnDelete : undefined}
        onCancel={() => setAnnVisible(false)}
        onTag={handleOpenTagModal}
      />

      <SelectionActions
        selection={menuSelection}
        documentTitle={docForId?.title ?? ''}
        articleSummary={articleSummary}
        onSaveNote={handleSaveAiNote}
        onClose={() => setMenuSelection(null)}
      />

      <TagSelectorModal
        visible={tagModalVisible}
        objectId={tagTargetId}
        objectType={tagTargetType}
        onChanged={(objId, tags) => {
          if (tagTargetType === 'document') {
            setDocTags(tags)
          } else if (tagTargetType === 'highlight') {
            setHighlights(prev => {
              const updated = prev.map(h => h.id === objId ? { ...h, tags } : h)
              sendToWebView({ type: 'setHighlights', highlights: toHlData(updated), expanded: hlExpanded })
              return updated
            })
          }
        }}
        onClose={() => setTagModalVisible(false)}
      />

      {lightbox && (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
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
            {docTags.length > 0 && (
              <View style={s.docTagRow}>
                {docTags.map(tag => (
                  <Pressable
                    key={tag.id}
                    style={[s.docTagChip, { borderColor: tagColor(tag.color) }]}
                    onPress={handleOpenDocTags}
                    hitSlop={4}
                  >
                    <Text style={[s.docTagText, { color: tagColor(tag.color) }]}>#{tag.name}</Text>
                  </Pressable>
                ))}
              </View>
            )}
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
            </View>
            <View style={s.metaDivider} />
            <View style={s.metaToggleRow}>
              <Ionicons name="book-outline" size={18} color={theme.colors.muted} />
              <Text style={[s.metaToggleLabel, { flex: 1 }]}>Reading</Text>
              <View style={s.segmented}>
                {READING_MODES.map(m => {
                  const active = readingMode === m.key
                  return (
                    <Pressable
                      key={m.key}
                      onPress={() => setReadingMode(m.key)}
                      style={[s.segment, active && s.segmentActive]}
                      hitSlop={4}
                    >
                      <Text style={[s.segmentText, active && s.segmentTextActive]}>{m.label}</Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>
            <Text style={s.metaToggleHint}>{readingModeInfo(readingMode, pageThreshold, resolvedPaging)}</Text>
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
            {!!doc.capture_ms && doc.capture_ms > 0 ? (
              <View style={s.metaRow}>
                <Text style={s.metaLabel}>Capture time</Text>
                <Text style={s.metaValue}>
                  {doc.capture_ms < 1000
                    ? `${doc.capture_ms}ms`
                    : doc.capture_ms < 60000
                      ? `${(doc.capture_ms / 1000).toFixed(1)}s`
                      : `${Math.floor(doc.capture_ms / 60000)}m${Math.round((doc.capture_ms % 60000) / 1000)}s`}
                </Text>
              </View>
            ) : null}
            <View style={s.metaRow}>
              <Text style={s.metaLabel}>Source</Text>
              {sourceFeed ? (
                <Text style={s.metaValue} numberOfLines={2}>
                  {sourceFeed.title || (() => { try { return new URL(sourceFeed.url).hostname } catch { return sourceFeed.url } })()}
                  {'\n'}<Text style={s.metaMuted}>{sourceFeed.kind} feed</Text>
                </Text>
              ) : doc.added_via?.kind === 'pipeline' ? (
                <>
                  <Text style={s.metaValue}>Pipeline</Text>
                  {doc.added_via.pipeline_name ? (
                    <Text style={s.metaMuted}>{doc.added_via.pipeline_name}</Text>
                  ) : null}
                  {doc.added_via.document_id ? (
                    <Pressable onPress={openLinkingDoc} hitSlop={4}>
                      <Text style={s.metaLink} numberOfLines={2}>
                        from {doc.added_via.document_title || 'another document'}
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              ) : doc.added_via?.kind === 'manual' ? (
                <>
                  <Text style={s.metaValue}>Manual</Text>
                  {doc.added_via.device_name ? (
                    <Text style={s.metaMuted}>added from {doc.added_via.device_name}</Text>
                  ) : null}
                </>
              ) : (
                // No scrape job on record (import, pruned job) — or the offline replica,
                // which carries the Document row without the server-derived provenance.
                <Text style={s.metaValue}>Unknown</Text>
              )}
            </View>
            {isWebUrl(docForId?.canonical_url) && (
              <>
                <View style={s.metaDivider} />
                <Pressable style={s.viewWebBtn} onPress={() => { closeMetaPanel(); openInWeb() }}>
                  <Ionicons name="open-outline" size={18} color={theme.colors.accent} />
                  <Text style={s.viewWebBtnText}>View on web</Text>
                </Pressable>
              </>
            )}
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
    centered: { flex: 1, marginTop: 56, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errorText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    contentArea: { flex: 1, marginTop: 56 },
    docErrorBanner: {
      backgroundColor: t.colors.error + '1f',
      borderBottomWidth: 1,
      borderBottomColor: t.colors.error + '55',
      borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
    },
    docErrorBannerText: { color: t.colors.error, fontSize: 13, fontWeight: '700', textAlign: 'center' },
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
    metaToggleRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    metaToggleLabel: { color: t.colors.text, fontSize: 14, fontWeight: '600' },
    metaToggleHint: { color: t.colors.muted, fontSize: 11, marginTop: 6 },
    // Flow / Auto / Page — same pill language as the transcript language selector.
    segmented: {
      flexDirection: 'row', borderRadius: 12, overflow: 'hidden',
      borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.background,
    },
    segment: { paddingHorizontal: 10, paddingVertical: 4 },
    segmentActive: { backgroundColor: t.colors.accent },
    segmentText: { color: t.colors.muted, fontSize: 11, fontWeight: '700' },
    segmentTextActive: { color: t.colors.background },
    metaLabel: { color: t.colors.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
    metaValue: { color: t.colors.text, fontSize: 14 },
    metaMuted: { color: t.colors.muted, fontSize: 12 },
    metaLink: { color: t.colors.accent, fontSize: 12, marginTop: 2 },
    metaDivider: { height: 1, backgroundColor: t.colors.border, marginVertical: t.spacing.md },
    viewWebBtn: {
      flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
      borderRadius: 8, borderWidth: 1, borderColor: t.colors.accent,
      paddingVertical: t.spacing.sm, paddingHorizontal: t.spacing.md,
    },
    viewWebBtnText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    btnDisabled: { opacity: 0.5 },
    docTagRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginBottom: t.spacing.sm,
    },
    docTagChip: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 10,
      borderWidth: 1,
    },
    docTagText: { fontSize: 11, fontWeight: '600' },
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
  })
}
