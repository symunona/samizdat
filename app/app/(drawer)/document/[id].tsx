import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
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
} from '../../../src/api'
import type { Document, Annotation } from '../../../src/api'
import { useConnection } from '../../../src/ConnectionContext'
import AnnotationPanel from '../../../src/AnnotationPanel'
import type { PendingSelection, ExistingAnnotation } from '../../../src/AnnotationPanel'

const DEBOUNCE_MS = 1000

// Injected before content loads — posts scroll fraction + exposes __scrollTo
const SCROLL_JS = `(function(){
  var lastFrac = -1;
  window.addEventListener('scroll', function() {
    var max = document.body.scrollHeight - window.innerHeight;
    if (max <= 0) return;
    var frac = Math.min(1, Math.max(0, window.scrollY / max));
    if (Math.abs(frac - lastFrac) > 0.01) {
      lastFrac = frac;
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'scroll', fraction: frac }));
    }
  }, { passive: true });
  window.__scrollTo = function(frac) {
    var max = document.body.scrollHeight - window.innerHeight;
    if (max > 0) window.scrollTo(0, frac * max);
  };
})(); true;`

export default function DocumentViewer() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>()
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
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedProgressRef = useRef(0)
  const headerAnim = useRef(new Animated.Value(0)).current
  const headerHeightRef = useRef(56)
  const headerVisibleRef = useRef(true)
  const lastScrollFracRef = useRef(0)

  // Annotation panel state
  const [annVisible, setAnnVisible] = useState(false)
  const [annMode, setAnnMode] = useState<'create' | 'edit'>('create')
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | undefined>()
  const [existingAnnotation, setExistingAnnotation] = useState<ExistingAnnotation | undefined>()

  const load = useCallback(async () => {
    if (!activeUrl || !token) return
    setLoading(true)
    setError(null)
    try {
      const [d, progress, html, anns] = await Promise.all([
        fetchDocument(activeUrl, token, id),
        fetchReadingProgress(activeUrl, token, id),
        fetchDocumentHtml(activeUrl, token, id),
        fetchAnnotations(activeUrl, token, id),
      ])
      setDoc(d)
      setHtmlContent(html)
      setAnnotations(anns)
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
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [id, status, load])

  const handleHeaderLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    headerHeightRef.current = e.nativeEvent.layout.height
  }, [])

  const handleWebViewLoad = useCallback(() => {
    if (savedProgressRef.current > 0) {
      const frac = savedProgressRef.current
      setTimeout(() => {
        webViewRef.current?.injectJavaScript(`window.__scrollTo && window.__scrollTo(${frac}); true;`)
        savedProgressRef.current = 0
      }, 300)
    }
  }, [])

  const handleMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as { type: string; fraction?: number; data?: PendingSelection; id?: string }
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
      }
    } catch { /* ignore parse errors */ }
  }, [id, activeUrl, token, headerAnim, annotations])

  const handleAnnSave = useCallback(async (data: { note: string; color: string }) => {
    if (!activeUrl || !token) return
    setAnnVisible(false)
    try {
      if (annMode === 'create' && pendingSelection) {
        const ann = await createAnnotation(activeUrl, token, id, { ...pendingSelection, ...data })
        setAnnotations(prev => [...prev, ann])
        webViewRef.current?.injectJavaScript(`window.addMark && window.addMark(${JSON.stringify(ann)}); true;`)
      } else if (annMode === 'edit' && existingAnnotation) {
        const ann = await updateAnnotation(activeUrl, token, existingAnnotation.id, data)
        setAnnotations(prev => prev.map(a => a.id === ann.id ? ann : a))
        webViewRef.current?.injectJavaScript(`window.removeMark && window.removeMark(${JSON.stringify(ann.id)}); window.addMark && window.addMark(${JSON.stringify(ann)}); true;`)
      }
    } catch (e) {
      console.error('annotation save failed', e)
    }
  }, [annMode, pendingSelection, existingAnnotation, activeUrl, token, id])

  const handleAnnDelete = useCallback(async () => {
    if (!activeUrl || !token || !existingAnnotation) return
    setAnnVisible(false)
    try {
      await deleteAnnotation(activeUrl, token, existingAnnotation.id)
      setAnnotations(prev => prev.filter(a => a.id !== existingAnnotation.id))
      webViewRef.current?.injectJavaScript(`window.removeMark && window.removeMark(${JSON.stringify(existingAnnotation.id)}); true;`)
    } catch (e) {
      console.error('annotation delete failed', e)
    }
  }, [existingAnnotation, activeUrl, token])

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
      </Animated.View>

      {loading ? (
        <View style={s.centered}><ActivityIndicator color={theme.colors.accent} size="large" /></View>
      ) : error ? (
        <View style={s.centered}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable onPress={load} style={s.retryBtn}><Text style={s.retryText}>Retry</Text></Pressable>
        </View>
      ) : htmlContent ? (
        <WebView
          ref={webViewRef}
          source={{ html: htmlContent, baseUrl: activeUrl ?? '' }}
          style={s.webView}
          injectedJavaScriptBeforeContentLoaded={SCROLL_JS}
          onMessage={handleMessage}
          onLoad={handleWebViewLoad}
          originWhitelist={['*']}
          allowsInlineMediaPlayback
          scrollEnabled
          showsVerticalScrollIndicator={false}
        />
      ) : null}

      {doc && (
        <View style={s.progressBar}>
          <View style={[s.progressFill, { width: `${progressPct}%` as `${number}%` }]} />
        </View>
      )}

      <AnnotationPanel
        visible={annVisible}
        mode={annMode}
        pending={pendingSelection}
        existing={existingAnnotation}
        onSave={handleAnnSave}
        onDelete={annMode === 'edit' ? handleAnnDelete : undefined}
        onCancel={() => setAnnVisible(false)}
      />
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
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errorText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    webView: { flex: 1, marginTop: 56, backgroundColor: t.colors.background },
    progressBar: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 4, overflow: 'hidden' },
    progressFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: t.colors.accent, opacity: 0.6 },
  })
}
