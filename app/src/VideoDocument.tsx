import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import WebView from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'
import { useAudio } from './useAudio'
import * as FileSystem from 'expo-file-system/legacy'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  fetchAnnotations,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  audioDocUrl,
  parseTranscript,
  parseMediaMetadata,
} from './api'
import type { Document, Annotation } from './api'
import { useConnection } from './ConnectionContext'
import { useToast } from './ToastContext'
import AnnotationPanel from './AnnotationPanel'
import type { PendingSelection, ExistingAnnotation } from './AnnotationPanel'
import { buildTranscriptHtml } from './markdownToHtml'
import { createLogger } from './logger'

const log = createLogger('video-document')

type Selection = PendingSelection & { media_ts_ms?: number }

type ParsedMsg = {
  type: string
  data?: PendingSelection
  id?: string
  ms?: number
}

// Max on-screen width of the video/thumbnail so a wide desktop window keeps the
// transcript + seeker visible (16:9 → ~405px tall at this width). Use the
// in-window fullscreen button to go bigger.
const PLAYER_MAX_W = 720

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VideoDocument({ doc, from }: { doc: Document; from?: string }) {
  const router = useRouter()
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { activeUrl, token, status } = useConnection()
  const { toast } = useToast()

  const segments = useMemo(() => parseTranscript(doc), [doc])
  const meta = useMemo(() => parseMediaMetadata(doc), [doc])

  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [showVideo, setShowVideo] = useState(false)
  const [localUri, setLocalUri] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [trackWidth, setTrackWidth] = useState(0)

  const htmlContent = useMemo(
    () => buildTranscriptHtml(segments, doc.title || doc.canonical_url),
    [segments, doc.title, doc.canonical_url],
  )

  // Audio — local file if synced, else stream from the server (public route).
  const remoteUrl = activeUrl ? audioDocUrl(activeUrl, doc.id) : ''
  const { playing, positionMs, durationMs: audioDurMs, play, pause, seek } = useAudio(localUri ?? remoteUrl)
  // Prefer the real audio duration; fall back to the metadata estimate.
  const durationMs = audioDurMs > 0 ? audioDurMs : (meta.duration_ms ?? 0)

  const webViewRef = useRef<WebView>(null)
  // Transcript and video are separate iframes (web) — must not share a ref, or
  // only one can mount and the transcript disappears in video mode.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transcriptIframeRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const videoIframeRef = useRef<any>(null)
  // Video container — used to request native fullscreen on web.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const videoBoxRef = useRef<any>(null)
  const pendingMediaTsRef = useRef(0)
  // Audio position frozen at the moment video opens (so the iframe seeks there
  // and live position ticks don't reload it).
  const videoStartRef = useRef(0)

  // ── WebView bridge ──
  const sendToWebView = useCallback((msg: object) => {
    const j = JSON.stringify(msg)
    if (Platform.OS === 'web') {
      transcriptIframeRef.current?.contentWindow?.postMessage(j, '*')
    } else {
      webViewRef.current?.injectJavaScript(`window.__handleMsg && window.__handleMsg(${j}); true;`)
    }
  }, [])

  // Load annotations.
  const load = useCallback(async () => {
    if (!activeUrl || !token) return
    try {
      const anns = await fetchAnnotations(activeUrl, token, doc.id)
      setAnnotations(anns)
    } catch (e) {
      log.error('load annotations failed', e)
    }
  }, [activeUrl, token, doc.id])

  useEffect(() => {
    if (status === 'connected') load()
  }, [status, load])

  // Restore a previously synced local file.
  useEffect(() => {
    AsyncStorage.getItem(`video_audio_${doc.id}`).then(uri => {
      if (uri) setLocalUri(uri)
    }).catch(() => {})
  }, [doc.id])

  // Push playback time into the transcript so it follows along.
  useEffect(() => {
    sendToWebView({ type: 'mediaTime', ms: positionMs })
  }, [positionMs, sendToWebView])

  const themeMsg = useMemo(() => ({
    background: theme.colors.background, text: theme.colors.text, surface: theme.colors.surface,
    border: theme.colors.border, accent: theme.colors.accent, muted: theme.colors.muted,
  }), [theme.colors])

  // Annotation panel state.
  const [annVisible, setAnnVisible] = useState(false)
  const [annMode, setAnnMode] = useState<'create' | 'edit'>('create')
  const [pendingSelection, setPendingSelection] = useState<Selection | undefined>()
  const [existingAnnotation, setExistingAnnotation] = useState<ExistingAnnotation | undefined>()

  const seekTo = useCallback((ms: number) => {
    try { seek(ms) } catch (e) { log.error('seek failed', e) }
  }, [seek])

  const handleParsedMessage = useCallback((msg: ParsedMsg) => {
    if (msg.type === 'ready') {
      sendToWebView({
        type: 'init',
        doc: { title: doc.title ?? '' },
        highlights: [],
        annotations,
        theme: themeMsg,
        hlExpanded: false,
        scrollFraction: 0,
      })
    } else if (msg.type === 'seek' && typeof msg.ms === 'number') {
      seekTo(msg.ms)
    } else if (msg.type === 'selection' && msg.data) {
      setPendingSelection({ ...msg.data, media_ts_ms: positionMs })
      setAnnMode('create')
      setExistingAnnotation(undefined)
      setAnnVisible(true)
    } else if (msg.type === 'segmentWindow' && msg.data) {
      setPendingSelection({ ...msg.data, media_ts_ms: pendingMediaTsRef.current })
      setAnnMode('create')
      setExistingAnnotation(undefined)
      setAnnVisible(true)
    } else if (msg.type === 'tap_annotation' && msg.id) {
      const ann = annotations.find(a => a.id === msg.id)
      if (ann) {
        if (ann.media_ts_ms > 0) seekTo(ann.media_ts_ms)
        setExistingAnnotation({ id: ann.id, exact: ann.exact, note: ann.note, color: ann.color })
        setAnnMode('edit')
        setPendingSelection(undefined)
        setAnnVisible(true)
      }
    }
  }, [doc.title, annotations, themeMsg, sendToWebView, seekTo, positionMs])

  const handleMessage = useCallback((e: WebViewMessageEvent) => {
    try { handleParsedMessage(JSON.parse(e.nativeEvent.data) as ParsedMsg) } catch { /* ignore */ }
  }, [handleParsedMessage])

  useEffect(() => {
    if (Platform.OS !== 'web') return
    const handler = (e: MessageEvent) => {
      if (e.source !== transcriptIframeRef.current?.contentWindow) return
      try {
        handleParsedMessage(JSON.parse(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) as ParsedMsg)
      } catch { /* ignore */ }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [handleParsedMessage])

  const injectAddMark = useCallback((ann: Annotation) => sendToWebView({ type: 'addMark', annotation: ann }), [sendToWebView])
  const injectRemoveMark = useCallback((id: string) => sendToWebView({ type: 'removeMark', id }), [sendToWebView])

  const handleAnnSave = useCallback(async (data: { note: string; color: string }) => {
    if (!activeUrl || !token) return
    setAnnVisible(false)
    try {
      if (annMode === 'create') {
        const sel: Selection = pendingSelection ?? { exact: '', prefix: '', suffix: '', pos_start: 0, pos_end: 0, media_ts_ms: positionMs }
        const ann = await createAnnotation(activeUrl, token, doc.id, { ...sel, media_ts_ms: sel.media_ts_ms ?? 0, ...data })
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
      toast('Failed to save note', 'error')
    }
  }, [annMode, pendingSelection, existingAnnotation, activeUrl, token, doc.id, positionMs, injectAddMark, injectRemoveMark, toast])

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

  // ── Controls ──
  // Bottom ▶ always drives AUDIO. If the video is open it takes over: collapse
  // (which stops the YouTube iframe) so the two never sound at once.
  const togglePlay = useCallback(() => {
    if (playing) { pause(); return }
    if (showVideo) setShowVideo(false)
    play()
  }, [playing, play, pause, showVideo])

  const handleAddNote = useCallback(() => {
    pendingMediaTsRef.current = positionMs
    sendToWebView({ type: 'requestSegmentWindow', ms: positionMs })
  }, [positionMs, sendToWebView])

  const handleTrackPress = useCallback((e: { nativeEvent: { locationX: number } }) => {
    if (trackWidth <= 0 || durationMs <= 0) return
    const frac = Math.max(0, Math.min(1, e.nativeEvent.locationX / trackWidth))
    seekTo(frac * durationMs)
  }, [trackWidth, durationMs, seekTo])

  // Tapping the video is the ONLY way to start in-window playback. Opening it
  // pauses the bottom audio and freezes the current position so the YouTube
  // iframe resumes exactly there.
  const toggleVideo = useCallback(() => {
    setShowVideo(prev => {
      const next = !prev
      if (next) {
        videoStartRef.current = positionMs
        if (playing) pause()
      }
      return next
    })
  }, [playing, pause, positionMs])

  // Web: request native fullscreen on the video container (the iframe fills it).
  // Native: the WebView's allowsFullscreenVideo enables the player's own control.
  const handleFullscreen = useCallback(() => {
    if (Platform.OS !== 'web') return
    const el = videoBoxRef.current as { requestFullscreen?: () => void } | null
    el?.requestFullscreen?.()
  }, [])

  const handleSync = useCallback(async () => {
    if (!remoteUrl || syncing) return
    setSyncing(true)
    try {
      const dest = `${FileSystem.documentDirectory}video-audio-${doc.id}.m4a`
      const res = await FileSystem.downloadAsync(remoteUrl, dest)
      setLocalUri(res.uri)
      await AsyncStorage.setItem(`video_audio_${doc.id}`, res.uri)
      toast('Synced to device', 'success')
    } catch (e) {
      log.error('sync failed', e)
      toast('Sync failed', 'error')
    } finally {
      setSyncing(false)
    }
  }, [remoteUrl, syncing, doc.id, toast])

  const progressPct = durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0
  const ytId = meta.external_id
  const videoSrc = ytId
    ? `https://www.youtube.com/embed/${ytId}?start=${Math.floor(videoStartRef.current / 1000)}&autoplay=1&enablejsapi=1`
    : ''

  return (
    <SafeAreaView style={s.screen}>
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={() => router.navigate((from as string) ?? '/documents')} style={s.backBtn} hitSlop={12}>
          <Ionicons name="arrow-back" size={22} color={theme.colors.accent} />
        </Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>{doc.title || doc.canonical_url}</Text>
      </View>

      {/* Player / thumbnail */}
      <View style={s.player}>
        {showVideo && ytId ? (
          <View ref={videoBoxRef} style={s.videoBox}>
            {Platform.OS === 'web' ? (
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              <iframe ref={videoIframeRef as any} src={videoSrc} allow="autoplay; encrypted-media; fullscreen" allowFullScreen
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                style={{ width: '100%', height: '100%', border: 'none' } as any} />
            ) : (
              <WebView source={{ uri: videoSrc }} style={s.fill} allowsInlineMediaPlayback allowsFullscreenVideo javaScriptEnabled />
            )}
            <View style={s.videoBtns}>
              {Platform.OS === 'web' ? (
                <Pressable onPress={handleFullscreen} style={s.videoBtn} hitSlop={10}>
                  <Ionicons name="expand" size={16} color="#fff" />
                </Pressable>
              ) : null}
              <Pressable onPress={toggleVideo} style={s.videoBtn} hitSlop={10}>
                <Ionicons name="chevron-up" size={16} color="#fff" />
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable onPress={ytId ? toggleVideo : undefined} style={s.thumbBox}>
            {doc.hero_image_url ? (
              <Image source={{ uri: doc.hero_image_url }} style={s.thumb} resizeMode="cover" />
            ) : <View style={[s.thumb, s.thumbPlaceholder]} />}
            {ytId ? (
              <View style={s.playOverlay}>
                <Ionicons name="logo-youtube" size={44} color="#fff" />
                <Text style={s.playOverlayText}>Watch video</Text>
              </View>
            ) : null}
          </Pressable>
        )}
      </View>

      {/* Transcript — always visible (audio AND video modes) */}
      <View style={s.transcript}>
        {Platform.OS === 'web' ? (
          <iframe
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ref={transcriptIframeRef as any}
            srcDoc={htmlContent}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            style={{ width: '100%', height: '100%', border: 'none' } as any}
          />
        ) : (
          <WebView
            ref={webViewRef}
            source={{ html: htmlContent, baseUrl: activeUrl ?? '' }}
            style={s.fill}
            onMessage={handleMessage}
            originWhitelist={['*']}
            allowsInlineMediaPlayback
            onShouldStartLoadWithRequest={(req) => req.navigationType !== 'click'}
          />
        )}
      </View>

      {/* Seeker bar */}
      <View style={s.seeker}>
        <Pressable onPress={togglePlay} style={s.playBtn} hitSlop={8}>
          <Ionicons name={playing ? 'pause' : 'play'} size={22} color={theme.colors.background} />
        </Pressable>
        <Text style={s.time}>{fmtTime(positionMs)}</Text>
        <Pressable style={s.track} onPress={handleTrackPress} onLayout={e => setTrackWidth(e.nativeEvent.layout.width)}>
          <View style={s.trackBg} />
          <View style={[s.trackFill, { width: `${progressPct}%` as `${number}%` }]} />
        </Pressable>
        <Text style={s.time}>{fmtTime(durationMs)}</Text>
        <Pressable onPress={handleAddNote} style={s.iconBtn} hitSlop={8}>
          <Ionicons name="create-outline" size={20} color={theme.colors.accent} />
        </Pressable>
        {Platform.OS !== 'web' ? (
          <Pressable onPress={handleSync} style={s.iconBtn} hitSlop={8} disabled={syncing}>
            {syncing ? <ActivityIndicator size="small" color={theme.colors.accent} />
              : <Ionicons name={localUri ? 'cloud-done-outline' : 'cloud-download-outline'} size={20} color={localUri ? theme.colors.accent : theme.colors.muted} />}
          </Pressable>
        ) : null}
      </View>

      <AnnotationPanel
        visible={annVisible}
        mode={annMode}
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
    fill: { flex: 1, backgroundColor: t.colors.background },
    header: {
      flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm,
      borderBottomWidth: 1, borderBottomColor: t.colors.border, backgroundColor: t.colors.surface,
    },
    backBtn: { flexShrink: 0, padding: t.spacing.sm },
    headerTitle: { flex: 1, color: t.colors.text, fontSize: 15, fontWeight: '600' },
    // Center + cap the player so a wide desktop window never pushes the
    // transcript/seeker off-screen; 16:9 is preserved within the cap.
    player: { backgroundColor: '#000', alignItems: 'center' },
    thumbBox: { width: '100%', maxWidth: PLAYER_MAX_W, aspectRatio: 16 / 9, justifyContent: 'center', alignItems: 'center' },
    thumb: { width: '100%', height: '100%' },
    thumbPlaceholder: { backgroundColor: t.colors.surface },
    playOverlay: { position: 'absolute', alignItems: 'center', gap: 4 },
    playOverlayText: { color: '#fff', fontSize: 13, fontWeight: '600' },
    videoBox: { width: '100%', maxWidth: PLAYER_MAX_W, aspectRatio: 16 / 9, backgroundColor: '#000' },
    videoBtns: { position: 'absolute', top: 6, right: 6, flexDirection: 'row', gap: 6 },
    videoBtn: { backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 14, padding: 5 },
    transcript: { flex: 1, backgroundColor: t.colors.background },
    seeker: {
      flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm,
      borderTopWidth: 1, borderTopColor: t.colors.border, backgroundColor: t.colors.surface,
    },
    playBtn: {
      width: 36, height: 36, borderRadius: 18, backgroundColor: t.colors.accent,
      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    time: { color: t.colors.muted, fontSize: 11, fontVariant: ['tabular-nums'], minWidth: 32, textAlign: 'center' },
    track: { flex: 1, height: 24, justifyContent: 'center' },
    trackBg: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2, backgroundColor: t.colors.border },
    trackFill: { position: 'absolute', left: 0, height: 4, borderRadius: 2, backgroundColor: t.colors.accent },
    iconBtn: { padding: 6, flexShrink: 0 },
  })
}
