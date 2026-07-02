import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  AppState,
  Image,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import WebView from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'
import { useMediaTimeline } from './useMediaTimeline'
import YtPlayer from './YtPlayer'
import * as FileSystem from 'expo-file-system/legacy'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  fetchAnnotations,
  fetchDocumentHighlights,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  audioDocUrl,
  parseTranscript,
  parseMediaMetadata,
} from './api'
import type { Document, Annotation, HighlightWithDoc } from './api'
import { useConnection } from './ConnectionContext'
import { useToast } from './ToastContext'
import AnnotationPanel from './AnnotationPanel'
import IconButton from './IconButton'
import type { PendingSelection, ExistingAnnotation } from './AnnotationPanel'
import { buildTranscriptHtml } from './markdownToHtml'
import PendingPipelineBanner from './PendingPipelineBanner'
import { createLogger } from './logger'

const log = createLogger('video-document')

type Selection = PendingSelection & { media_ts_ms?: number }

type ParsedMsg = {
  type: string
  data?: PendingSelection & { media_ts_ms?: number }
  id?: string
  ms?: number
}

// Max on-screen width of the video/thumbnail so a wide desktop window keeps the
// transcript + seeker visible (16:9 → ~405px tall at this width). Use the
// in-window fullscreen button to go bigger.
const PLAYER_MAX_W = 720

// Podcast playback-speed lever: a continuous 0.8×–2× range at 0.01 steps.
const RATE_MIN = 0.8
const RATE_MAX = 2
const RATE_RANGE = RATE_MAX - RATE_MIN
const RATE_STEP = 0.01 // ± buttons fine-tune by this increment
const LEVER_H = 132 // px throw of the vertical lever
const LEVER_THUMB_H = 12

function fmtRate(r: number): string {
  return `${parseFloat(r.toFixed(2))}×`
}
function clampRate(r: number): number {
  return Math.max(RATE_MIN, Math.min(RATE_MAX, Math.round(r * 100) / 100))
}

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Lightweight markdown → plain text for the Excerpt list (highlight bodies are
// markdown; we render a plain summary here, not the full interactive card).
function plainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')      // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')    // links → label
    .replace(/^#{1,6}\s+/gm, '')                 // heading markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')           // bold
    .replace(/`([^`]+)`/g, '$1')                 // inline code
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// NewPipe-style tabs below the player. Transcript is the default.
type Tab = 'transcript' | 'details' | 'excerpt' | 'annotations'
const TABS: { key: Tab; label: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { key: 'transcript', label: 'Transcript', icon: 'list-outline' },
  { key: 'details', label: 'Details', icon: 'information-circle-outline' },
  { key: 'excerpt', label: 'Excerpt', icon: 'sparkles-outline' },
  { key: 'annotations', label: 'Notes', icon: 'create-outline' },
]

// ± skip steps (ms). Each skip counts as a "jump" (drops a jump-from flag).
const SKIPS = [
  { delta: -10000, label: '10', icon: 'play-back' as const },
  { delta: -1000, label: '1', icon: 'play-back' as const },
  { delta: 1000, label: '1', icon: 'play-forward' as const },
  { delta: 10000, label: '10', icon: 'play-forward' as const },
]

// Distinct scrub-track marker colors (see plan). Resume = green, jump-from =
// amber, annotation = purple — never the accent (that's the progress fill).
const MARK_RESUME = '#4ade80'
const MARK_JUMP = '#f5b301'
const MARK_ANN = '#a78bfa'
// Resume tracking pauses for this much *forward playback* after any jump.
const JUMP_GRACE_MS = 10000

export default function VideoDocument({ doc, from }: { doc: Document; from?: string }) {
  const router = useRouter()
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { activeUrl, token, status } = useConnection()
  const { toast } = useToast()

  const segments = useMemo(() => parseTranscript(doc), [doc])
  const meta = useMemo(() => parseMediaMetadata(doc), [doc])

  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [highlights, setHighlights] = useState<HighlightWithDoc[]>([])
  const [tab, setTab] = useState<Tab>('transcript')
  const [showVideo, setShowVideo] = useState(false)
  const [localUri, setLocalUri] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [trackWidth, setTrackWidth] = useState(0)
  // Playback position captured when the video view opens, so the YouTube player
  // starts exactly where the audio was.
  const [videoStartMs, setVideoStartMs] = useState(0)
  // Where the user left off last time (from AsyncStorage) — drives the resume seek
  // and the "where I was" marker on the scrub track. null until read/known.
  const [savedPosMs, setSavedPosMs] = useState<number | null>(null)
  // Position the user most recently jumped FROM — drives the amber "last jumped
  // from" flag. null when there's been no jump this session.
  const [jumpFromMs, setJumpFromMs] = useState<number | null>(null)
  // While non-null, resume tracking is paused: holds the position we jumped TO;
  // cleared once playback advances JUMP_GRACE_MS past it (≈10s of forward play).
  const graceAnchorRef = useRef<number | null>(null)

  const htmlContent = useMemo(
    () => buildTranscriptHtml(segments, doc.title || doc.canonical_url),
    [segments, doc.title, doc.canonical_url],
  )

  const ytId = meta.external_id

  // Now-playing card for the lock screen when audio takes over on background/lock.
  const nowPlaying = useMemo(() => ({
    title: doc.title || doc.canonical_url,
    artist: doc.author || meta.provider || undefined,
    artworkUrl: doc.hero_image_url || undefined,
  }), [doc.title, doc.canonical_url, doc.author, doc.hero_image_url, meta.provider])

  // One shared timeline for the bottom bar + transcript. The active backend is the
  // <audio> element (offline local file if synced, else the server stream) OR the
  // YouTube player while the video view is open — same interface either way.
  const remoteUrl = activeUrl ? audioDocUrl(activeUrl, doc.id) : ''
  const {
    playing, positionMs, durationMs: mediaDurMs, rate,
    play, pause, seek, setRate, videoActive, ytRef, onYtStatus,
  } = useMediaTimeline({ audioUrl: localUri ?? remoteUrl, ytId, showVideo, meta: nowPlaying })
  // Prefer the real media duration; fall back to the metadata estimate.
  const durationMs = mediaDurMs > 0 ? mediaDurMs : (meta.duration_ms ?? 0)

  const webViewRef = useRef<WebView>(null)
  // Transcript and video are separate iframes (web) — must not share a ref, or
  // only one can mount and the transcript disappears in video mode.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transcriptIframeRef = useRef<any>(null)
  // Video container — used to request native fullscreen on web.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const videoBoxRef = useRef<any>(null)
  const pendingMediaTsRef = useRef(0)
  // The transcript WebView is up (sent 'ready'). Annotations fetch asynchronously,
  // so they can land after 'ready' — this gates the re-sync effect below.
  const webviewReadyRef = useRef(false)

  // ── WebView bridge ──
  const sendToWebView = useCallback((msg: object) => {
    const j = JSON.stringify(msg)
    if (Platform.OS === 'web') {
      transcriptIframeRef.current?.contentWindow?.postMessage(j, '*')
    } else {
      webViewRef.current?.injectJavaScript(`window.__handleMsg && window.__handleMsg(${j}); true;`)
    }
  }, [])

  // Load annotations + summary highlights (the Excerpt tab).
  const load = useCallback(async () => {
    if (!activeUrl || !token) return
    try {
      const [anns, hls] = await Promise.all([
        fetchAnnotations(activeUrl, token, doc.id),
        fetchDocumentHighlights(activeUrl, token, doc.id).catch(() => [] as HighlightWithDoc[]),
      ])
      setAnnotations(anns)
      setHighlights(hls)
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

  // ── Resume playback position ──
  // Persist the last position under `video_pos_<docId>` (mirrors the `video_audio_`
  // pattern) and, on return, resume 10s before where they left off. Read the freshest
  // position via a ref so the throttled/unmount saves never capture a stale closure.
  const positionRef = useRef(positionMs)
  positionRef.current = positionMs
  const resumedRef = useRef(false)

  const savePosition = useCallback(() => {
    const ms = Math.floor(positionRef.current)
    // Grace window after a jump: don't persist the resume point until playback has
    // moved JUMP_GRACE_MS forward past where we jumped to — so a reopen during the
    // window lands back where the user was, not where they skipped to.
    const anchor = graceAnchorRef.current
    if (anchor != null) {
      if (ms - anchor >= JUMP_GRACE_MS) graceAnchorRef.current = null
      else return
    }
    if (ms > 0) AsyncStorage.setItem(`video_pos_${doc.id}`, String(ms)).catch(() => {})
  }, [doc.id])

  // Read the saved point once on mount (feeds both the resume seek and the marker).
  useEffect(() => {
    AsyncStorage.getItem(`video_pos_${doc.id}`).then(v => {
      const ms = v ? parseInt(v, 10) : NaN
      if (Number.isFinite(ms) && ms > 0) setSavedPosMs(ms)
    }).catch(() => {})
  }, [doc.id])

  // Auto-resume ONCE, 10s before the saved point, and only once the backend can
  // actually accept a seek — a real media duration (`mediaDurMs > 0`) means the
  // <audio>/YT metadata is loaded (a 0-duration seek is silently dropped). Guarded
  // by a ref so it never yanks the position back while the user scrubs.
  useEffect(() => {
    if (resumedRef.current || savedPosMs == null) return
    if (savedPosMs <= 10000 || mediaDurMs <= 0) return
    resumedRef.current = true
    seek(Math.max(0, savedPosMs - 10000))
  }, [savedPosMs, mediaDurMs, seek])

  // Throttled save every 5s while playing + a final save on pause/stop; keeps a
  // fresh resume point without thrashing AsyncStorage or losing it on a crash.
  useEffect(() => {
    if (!playing) return
    const id = setInterval(savePosition, 5000)
    return () => { clearInterval(id); savePosition() }
  }, [playing, savePosition])

  // Final save when the screen unmounts (navigate away / close).
  useEffect(() => () => savePosition(), [savePosition])

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

  // Every USER-initiated seek (track tap, ±skip, transcript/annotation tap) goes
  // through here: it seeks, drops the amber "last jumped from" flag at the origin,
  // and opens the 10s resume-tracking grace window (see savePosition).
  const userSeek = useCallback((toMs: number) => {
    const clamped = Math.max(0, durationMs > 0 ? Math.min(durationMs, toMs) : toMs)
    const fromMs = Math.floor(positionRef.current)
    seekTo(clamped)
    if (Math.abs(clamped - fromMs) >= 500) {
      setJumpFromMs(fromMs)
      graceAnchorRef.current = clamped
    }
  }, [seekTo, durationMs])

  // Open the annotation editor sheet for an existing note, optionally seeking to
  // its timestamp first. Shared by the transcript, the scrub markers and the list.
  const openAnnotation = useCallback((ann: Annotation, doSeek: boolean) => {
    if (doSeek && ann.media_ts_ms > 0) userSeek(ann.media_ts_ms)
    setExistingAnnotation({ id: ann.id, exact: ann.exact, note: ann.note, color: ann.color })
    setAnnMode('edit')
    setPendingSelection(undefined)
    setAnnVisible(true)
  }, [userSeek])

  const handleParsedMessage = useCallback((msg: ParsedMsg) => {
    if (msg.type === 'ready') {
      webviewReadyRef.current = true
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
      userSeek(msg.ms)
    } else if (msg.type === 'selection' && msg.data) {
      // Prefer the anchored transcript segment's time; fall back to live playback.
      setPendingSelection({ ...msg.data, media_ts_ms: msg.data.media_ts_ms ?? positionMs })
      setAnnMode('create')
      setExistingAnnotation(undefined)
      setAnnVisible(true)
    } else if (msg.type === 'segmentWindow' && msg.data) {
      setPendingSelection({ ...msg.data, media_ts_ms: msg.data.media_ts_ms ?? pendingMediaTsRef.current })
      setAnnMode('create')
      setExistingAnnotation(undefined)
      setAnnVisible(true)
    } else if (msg.type === 'tap_annotation' && msg.id) {
      const ann = annotations.find(a => a.id === msg.id)
      if (ann) openAnnotation(ann, true)
    }
  }, [doc.title, annotations, themeMsg, sendToWebView, userSeek, openAnnotation, positionMs])

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

  // Keep the transcript's marks + ✏ badges in sync with the annotation set.
  // Covers the async-load race (annotations arrive after the WebView is 'ready')
  // and every create/edit/delete — the WebView clears + re-applies from scratch.
  useEffect(() => {
    if (!webviewReadyRef.current) return
    sendToWebView({ type: 'setAnnotations', annotations })
  }, [annotations, sendToWebView])

  const handleAnnSave = useCallback(async (data: { note: string; color: string }) => {
    if (!activeUrl || !token) return
    setAnnVisible(false)
    try {
      if (annMode === 'create') {
        const sel: Selection = pendingSelection ?? { exact: '', prefix: '', suffix: '', pos_start: 0, pos_end: 0, media_ts_ms: positionMs }
        const ann = await createAnnotation(activeUrl, token, doc.id, { ...sel, media_ts_ms: sel.media_ts_ms ?? 0, ...data })
        setAnnotations(prev => [...prev, ann])
      } else if (annMode === 'edit' && existingAnnotation) {
        const ann = await updateAnnotation(activeUrl, token, existingAnnotation.id, data)
        setAnnotations(prev => prev.map(a => a.id === ann.id ? ann : a))
      }
      // The setAnnotations effect re-syncs the transcript marks/badges.
    } catch (e) {
      log.error('annotation save failed', e)
      toast('Failed to save note', 'error')
    }
  }, [annMode, pendingSelection, existingAnnotation, activeUrl, token, doc.id, positionMs, toast])

  const handleAnnDelete = useCallback(async () => {
    if (!activeUrl || !token || !existingAnnotation) return
    setAnnVisible(false)
    try {
      await deleteAnnotation(activeUrl, token, existingAnnotation.id)
      setAnnotations(prev => prev.filter(a => a.id !== existingAnnotation.id))
      // The setAnnotations effect removes the transcript mark/badge.
    } catch (e) {
      log.error('annotation delete failed', e)
    }
  }, [existingAnnotation, activeUrl, token])

  // ── Controls ──
  // Bottom ▶ governs the ACTIVE backend — audio when collapsed, the YouTube player
  // when the video view is open. Same play/pause either way (one timeline).
  const togglePlay = useCallback(() => {
    if (playing) pause(); else play()
  }, [playing, play, pause])

  // Speed dropup + lever. rateRef always holds the latest rate so the pan
  // handlers (created once) read a fresh value at grant without re-binding.
  const [speedOpen, setSpeedOpen] = useState(false)
  const rateRef = useRef(rate)
  rateRef.current = rate
  const dragStartRate = useRef(rate)
  const leverPan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { dragStartRate.current = rateRef.current },
    // Drag up = faster; a full lever throw spans the whole 0.8×–2× range.
    onPanResponderMove: (_e, g) => setRate(clampRate(dragStartRate.current - (g.dy / LEVER_H) * RATE_RANGE)),
  }), [setRate])
  // ± buttons nudge the same rate by 0.01, clamped to the lever range.
  const stepRate = useCallback((delta: number) => setRate(clampRate(rateRef.current + delta)), [setRate])

  const handleAddNote = useCallback(() => {
    pendingMediaTsRef.current = positionMs
    sendToWebView({ type: 'requestSegmentWindow', ms: positionMs })
  }, [positionMs, sendToWebView])

  const handleTrackPress = useCallback((e: { nativeEvent: { locationX: number } }) => {
    if (trackWidth <= 0 || durationMs <= 0) return
    const frac = Math.max(0, Math.min(1, e.nativeEvent.locationX / trackWidth))
    userSeek(frac * durationMs)
  }, [trackWidth, durationMs, userSeek])

  // ± skip buttons — each is a jump (drops the flag + opens the grace window).
  const handleSkip = useCallback((delta: number) => {
    userSeek(positionRef.current + delta)
  }, [userSeek])

  // Show the video view as an alternate VIEW of the same timeline. Capture the
  // current position so the YouTube player starts exactly there; the timeline hook
  // handles the audio↔video handoff (pause the <audio>, resume it on collapse).
  const toggleVideo = useCallback(() => {
    if (!showVideo) setVideoStartMs(positionMs)
    setShowVideo(v => !v)
  }, [showVideo, positionMs])

  // Collapse back to audio-only, continuing from the video's position.
  const switchToAudio = useCallback(() => setShowVideo(false), [])

  // ── Lock/unlock playback state machine (see docs/media-playback-lockscreen.md) ──
  // The YouTube WebView is suspended by the OS on background/lock, which kills its
  // playback. On 'background' while the video is the sounding backend we REMEMBER that
  // and collapse to audio-only: the useMediaTimeline handoff seeks the native expo-audio
  // backend to the video's position, resumes, and claims the OS media session, so sound
  // survives the lock with lock-screen controls. On 'active' (unlock) we RESTORE the
  // video view exactly as it was, continuing from wherever audio advanced to while
  // locked. Audio-only sessions need no handoff (expo-audio already survives the lock),
  // so there's nothing to remember or restore for them.
  // Refs keep the once-registered listener reading fresh values without re-subscribing.
  const showVideoRef = useRef(showVideo); showVideoRef.current = showVideo
  const playingRef = useRef(playing); playingRef.current = playing
  const restoreVideoRef = useRef(false)
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'background') {
        if (showVideoRef.current && !!ytId && playingRef.current) {
          restoreVideoRef.current = true // remember: was showing video → restore on unlock
          switchToAudio()
        }
      } else if (next === 'active' && restoreVideoRef.current) {
        restoreVideoRef.current = false
        setVideoStartMs(Math.floor(positionRef.current)) // continue from where audio got to
        setShowVideo(true)
      }
    })
    return () => sub.remove()
  }, [switchToAudio, ytId])

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
  // Fraction (0–100) of a playback ms along the scrub track, for marker placement.
  const pct = useCallback((ms: number) => (durationMs > 0 ? Math.min(100, Math.max(0, (ms / durationMs) * 100)) : 0), [durationMs])

  return (
    <SafeAreaView style={s.screen}>
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={() => router.navigate((from as string) ?? '/documents')} style={s.backBtn} hitSlop={12}>
          <Ionicons name="arrow-back" size={22} color={theme.colors.accent} />
        </Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>{doc.title || doc.canonical_url}</Text>
      </View>

      <PendingPipelineBanner docId={doc.id} isVideo />

      {/* Player / thumbnail */}
      <View style={s.player}>
        {videoActive && ytId ? (
          <View ref={videoBoxRef} style={s.videoBox}>
            <YtPlayer ref={ytRef} videoId={ytId} startMs={videoStartMs} rate={rate} onStatus={onYtStatus} />
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

      {/* Collapse the video back to audio-only, continuing from the same position. */}
      {videoActive ? (
        <Pressable onPress={switchToAudio} style={s.audioOnlyBtn} hitSlop={8}>
          <Ionicons name="headset-outline" size={16} color={theme.colors.accent} />
          <Text style={s.audioOnlyText}>Audio only</Text>
        </Pressable>
      ) : null}

      {/* Backdrop closes the speed dropup on an outside tap (full-screen). */}
      {speedOpen ? <Pressable style={s.speedBackdrop} onPress={() => setSpeedOpen(false)} /> : null}

      {/* ± skip row — its own row above the seeker; each skip is a "jump". */}
      <View style={s.skipRow}>
        {SKIPS.map(sk => (
          <Pressable key={`${sk.icon}${sk.delta}`} onPress={() => handleSkip(sk.delta)} style={s.skipBtn} hitSlop={6}>
            <Ionicons name={sk.icon} size={13} color={theme.colors.accent} />
            <Text style={s.skipText}>{sk.delta < 0 ? '−' : '+'}{sk.label}s</Text>
          </Pressable>
        ))}
      </View>

      {/* Seeker bar (always visible, above the tabs) */}
      <View style={s.seeker}>
        <Pressable onPress={togglePlay} style={s.playBtn} hitSlop={8}>
          <Ionicons name={playing ? 'pause' : 'play'} size={22} color={theme.colors.background} />
        </Pressable>
        <Text style={s.time}>{fmtTime(positionMs)}</Text>
        <View style={s.scrub}>
          {/* Flag labels above the track (resume = green, jump-from = amber). */}
          <View style={s.flagStrip} pointerEvents="none">
            {savedPosMs != null && durationMs > 0 ? (
              <Text style={[s.flagLabel, s.flagResume, { left: `${pct(savedPosMs)}%` as `${number}%` }]} numberOfLines={1}>where I was</Text>
            ) : null}
            {jumpFromMs != null && durationMs > 0 ? (
              <Text style={[s.flagLabel, s.flagJump, { left: `${pct(jumpFromMs)}%` as `${number}%` }]} numberOfLines={1}>last jumped from</Text>
            ) : null}
          </View>
          <View style={s.track} onLayout={e => setTrackWidth(e.nativeEvent.layout.width)}>
            {/* Seek layer sits at the bottom; decorations above are pointerEvents:none
                so a tap anywhere reaches it. A responder View (not Pressable) is used
                because Pressable's onPress omits locationX on RN-Web — the old tap-seek
                bug; onResponderRelease gives a reliable per-view offset on both runtimes. */}
            <View
              style={s.trackHit}
              onStartShouldSetResponder={() => true}
              onResponderRelease={handleTrackPress}
            />
            <View style={s.trackBg} pointerEvents="none" />
            <View style={[s.trackFill, { width: `${progressPct}%` as `${number}%` }]} pointerEvents="none" />
            {savedPosMs != null && durationMs > 0 ? (
              <View pointerEvents="none" style={[s.markResume, { left: `${pct(savedPosMs)}%` as `${number}%` }]} />
            ) : null}
            {jumpFromMs != null && durationMs > 0 ? (
              <View pointerEvents="none" style={[s.markJump, { left: `${pct(jumpFromMs)}%` as `${number}%` }]} />
            ) : null}
            {durationMs > 0 ? annotations.filter(a => a.media_ts_ms > 0).map(a => (
              <Pressable
                key={a.id}
                style={[s.markAnn, { left: `${pct(a.media_ts_ms)}%` as `${number}%` }]}
                hitSlop={6}
                onPress={() => openAnnotation(a, true)}
              />
            )) : null}
          </View>
        </View>
        <Text style={s.time}>{fmtTime(durationMs)}</Text>
        <View style={s.speedWrap}>
          {speedOpen ? (
            <View style={s.speedPanel}>
              <Text style={s.speedPanelLabel} selectable={false}>{fmtRate(rate)}</Text>
              <View style={s.speedStepRow}>
                <IconButton name="remove" onPress={() => stepRate(-RATE_STEP)} color={theme.colors.accent} />
                <IconButton name="add" onPress={() => stepRate(RATE_STEP)} color={theme.colors.accent} />
              </View>
              <View style={s.leverTrack} {...leverPan.panHandlers}>
                <View style={[s.leverFill, { height: ((rate - RATE_MIN) / RATE_RANGE) * LEVER_H }]} />
                <View style={[s.leverThumb, { bottom: ((rate - RATE_MIN) / RATE_RANGE) * (LEVER_H - LEVER_THUMB_H) }]} />
              </View>
            </View>
          ) : null}
          <Pressable onPress={() => setSpeedOpen(o => !o)} style={s.speedPill} hitSlop={8}>
            <Text style={s.speedText} selectable={false}>{fmtRate(rate)}</Text>
          </Pressable>
        </View>
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

      {/* Tab bar (NewPipe-style) — only the content below switches. */}
      <View style={s.tabBar}>
        {TABS.map(t => {
          const active = tab === t.key
          const count = t.key === 'annotations' ? annotations.length : t.key === 'excerpt' ? highlights.length : 0
          return (
            <Pressable key={t.key} onPress={() => setTab(t.key)} style={[s.tabItem, active && s.tabItemActive]} hitSlop={4}>
              <Ionicons name={t.icon} size={15} color={active ? theme.colors.accent : theme.colors.muted} />
              <Text style={[s.tabLabel, active && s.tabLabelActive]} numberOfLines={1}>
                {t.label}{count > 0 ? ` ${count}` : ''}
              </Text>
            </Pressable>
          )
        })}
      </View>

      {/* Tab content. Transcript stays mounted (hidden) so it keeps auto-following. */}
      <View style={s.tabContent}>
        <View style={[s.tabPanel, tab !== 'transcript' && s.tabPanelHidden]}>
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

        {tab === 'details' ? (
          <ScrollView style={s.tabPanel} contentContainerStyle={s.panelPad}>
            <Text style={s.detailTitle}>{doc.title || doc.canonical_url}</Text>
            <View style={s.detailMetaRow}>
              {doc.author ? <Text style={s.detailChip}>{doc.author}</Text> : null}
              {meta.provider ? <Text style={s.detailChip}>{meta.provider}</Text> : null}
              {durationMs > 0 ? <Text style={s.detailChip}>{fmtTime(durationMs)}</Text> : null}
              {doc.fetched_at ? <Text style={s.detailChip}>{new Date(doc.fetched_at).toLocaleDateString()}</Text> : null}
            </View>
            <Pressable style={s.detailLink} onPress={() => doc.canonical_url && Linking.openURL(doc.canonical_url)}>
              <Ionicons name="open-outline" size={15} color={theme.colors.accent} />
              <Text style={s.detailLinkText} numberOfLines={1}>{doc.canonical_url}</Text>
            </Pressable>
            {(meta.description || doc.excerpt) ? (
              <Text style={s.detailBody}>{meta.description || doc.excerpt}</Text>
            ) : (
              <Text style={s.emptyText}>No description.</Text>
            )}
          </ScrollView>
        ) : null}

        {tab === 'excerpt' ? (
          <ScrollView style={s.tabPanel} contentContainerStyle={s.panelPad}>
            {highlights.length === 0 ? (
              <Text style={s.emptyText}>No summary yet</Text>
            ) : highlights.map(h => (
              <View key={h.id} style={s.hlItem}>
                <View style={s.hlItemHead}>
                  <Text style={s.hlKind}>{h.kind}</Text>
                  {h.title ? <Text style={s.hlTitle} numberOfLines={2}>{h.title}</Text> : null}
                </View>
                {h.body ? <Text style={s.hlBody}>{plainText(h.body)}</Text> : null}
              </View>
            ))}
          </ScrollView>
        ) : null}

        {tab === 'annotations' ? (
          <ScrollView style={s.tabPanel} contentContainerStyle={s.panelPad}>
            {annotations.length === 0 ? (
              <Text style={s.emptyText}>No notes yet</Text>
            ) : [...annotations].sort((a, b) => a.media_ts_ms - b.media_ts_ms).map(a => (
              <Pressable key={a.id} style={s.annItem} onPress={() => openAnnotation(a, true)}>
                <View style={s.annHead}>
                  <Ionicons name="create-outline" size={13} color={MARK_ANN} />
                  {a.media_ts_ms > 0 ? <Text style={s.annTime}>{fmtTime(a.media_ts_ms)}</Text> : null}
                </View>
                {a.exact ? <Text style={s.annQuote} numberOfLines={2}>“{a.exact}”</Text> : null}
                {a.note ? <Text style={s.annNote}>{a.note}</Text> : null}
              </Pressable>
            ))}
          </ScrollView>
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
    audioOnlyBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      paddingVertical: t.spacing.sm, backgroundColor: t.colors.surface,
      borderBottomWidth: 1, borderBottomColor: t.colors.border,
    },
    audioOnlyText: { color: t.colors.accent, fontSize: 13, fontWeight: '600' },
    // ± skip row — own row above the seeker.
    skipRow: {
      flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md, paddingTop: t.spacing.sm, backgroundColor: t.colors.surface,
    },
    skipBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 3,
      paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8,
      borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.background,
    },
    skipText: { color: t.colors.accent, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
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
    // Scrub column: a flag-label strip above the 24px track.
    scrub: { flex: 1, justifyContent: 'flex-end' },
    flagStrip: { height: 13, position: 'relative' },
    flagLabel: {
      position: 'absolute', bottom: 0, marginLeft: -1, maxWidth: 90,
      fontSize: 8, fontWeight: '700', paddingHorizontal: 3, borderRadius: 3,
      overflow: 'hidden',
    },
    flagResume: { color: '#052e16', backgroundColor: MARK_RESUME },
    flagJump: { color: '#3a2a00', backgroundColor: MARK_JUMP },
    track: { height: 24, justifyContent: 'center', position: 'relative' },
    trackHit: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
    trackBg: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2, backgroundColor: t.colors.border },
    trackFill: { position: 'absolute', left: 0, height: 4, borderRadius: 2, backgroundColor: t.colors.accent },
    // Resume (green) + jump-from (amber) flag poles; annotation ticks (purple).
    markResume: { position: 'absolute', width: 2, height: 14, top: 5, marginLeft: -1, borderRadius: 1, backgroundColor: MARK_RESUME },
    markJump: { position: 'absolute', width: 2, height: 14, top: 5, marginLeft: -1, borderRadius: 1, backgroundColor: MARK_JUMP },
    markAnn: { position: 'absolute', width: 3, height: 10, top: 7, marginLeft: -1.5, borderRadius: 1.5, backgroundColor: MARK_ANN },
    iconBtn: { padding: 6, flexShrink: 0 },
    speedWrap: { flexShrink: 0, position: 'relative' },
    // Fixed width so the pill never reflows as the value changes width
    // ("2×" vs "1.25×"); tabular-nums keeps the digits aligned inside it.
    speedPill: {
      width: 46, paddingVertical: 3, borderRadius: 10, alignItems: 'center',
      borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.background,
      userSelect: 'none',
    },
    speedText: { color: t.colors.accent, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'], userSelect: 'none' },
    speedBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    // Dropup floats above the pill (bottom-anchored to the seeker row).
    // Fixed width keeps the panel stable regardless of the value string.
    speedPanel: {
      position: 'absolute', bottom: 34, right: 0, width: 96, alignItems: 'center', gap: 8,
      paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12,
      backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
      shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 8,
      userSelect: 'none',
    },
    speedPanelLabel: { color: t.colors.accent, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'], userSelect: 'none' },
    speedStepRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    leverTrack: {
      width: 28, height: LEVER_H, borderRadius: 14, overflow: 'hidden',
      backgroundColor: t.colors.background, borderWidth: 1, borderColor: t.colors.border,
      userSelect: 'none',
    },
    leverFill: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(232,116,59,0.18)' },
    leverThumb: { position: 'absolute', left: 2, right: 2, height: LEVER_THUMB_H, borderRadius: 5, backgroundColor: t.colors.accent },

    // ── Tabs ──
    tabBar: {
      flexDirection: 'row', backgroundColor: t.colors.surface,
      borderTopWidth: 1, borderTopColor: t.colors.border,
    },
    tabItem: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
      paddingVertical: t.spacing.sm, borderBottomWidth: 2, borderBottomColor: 'transparent',
    },
    tabItemActive: { borderBottomColor: t.colors.accent },
    tabLabel: { color: t.colors.muted, fontSize: 12, fontWeight: '600' },
    tabLabelActive: { color: t.colors.accent },
    tabContent: { flex: 1, backgroundColor: t.colors.background },
    tabPanel: { flex: 1, backgroundColor: t.colors.background },
    tabPanelHidden: { display: 'none' },
    panelPad: { padding: t.spacing.lg, gap: t.spacing.md },

    // Details tab
    detailTitle: { color: t.colors.text, fontSize: 18, fontWeight: '700', lineHeight: 24 },
    detailMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    detailChip: {
      color: t.colors.muted, fontSize: 11, fontWeight: '600',
      paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
      borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.surface,
    },
    detailLink: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    detailLinkText: { color: t.colors.accent, fontSize: 12, flex: 1 },
    detailBody: { color: t.colors.text, fontSize: 14, lineHeight: 21 },
    emptyText: { color: t.colors.muted, fontSize: 14, textAlign: 'center', paddingVertical: t.spacing.xl },

    // Excerpt tab (lightweight highlight list — not the interactive card)
    hlItem: {
      borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.sm,
      backgroundColor: t.colors.surface, padding: t.spacing.md, gap: 6,
    },
    hlItemHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    hlKind: {
      color: t.colors.accent, fontSize: 10, fontWeight: '700', textTransform: 'uppercase',
      letterSpacing: 0.5, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
      backgroundColor: 'rgba(232,116,59,0.15)',
    },
    hlTitle: { flex: 1, color: t.colors.text, fontSize: 13, fontWeight: '600' },
    hlBody: { color: t.colors.text, fontSize: 14, lineHeight: 21 },

    // Annotations tab
    annItem: {
      borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.sm,
      backgroundColor: t.colors.surface, padding: t.spacing.md, gap: 4,
    },
    annHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    annTime: { color: MARK_ANN, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
    annQuote: { color: t.colors.muted, fontSize: 13, fontStyle: 'italic' },
    annNote: { color: t.colors.text, fontSize: 14, lineHeight: 20 },
  })
}
