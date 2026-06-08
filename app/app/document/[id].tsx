import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  ActivityIndicator,
  Image,
  Linking,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import Markdown from 'react-native-markdown-display'
import { fetchDocument, fetchReadingProgress, fetchDocumentMedia, saveReadingProgress } from '../../src/api'
import type { Document, MediaAsset } from '../../src/api'
import { useConnection } from '../../src/ConnectionContext'

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

const DEBOUNCE_MS = 1000

function readingMinutes(markdown: string): number {
  const words = markdown.trim().split(/\s+/).length
  return Math.max(1, Math.ceil(words / 200))
}

export default function DocumentViewer() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const mdStyle = useMemo(() => buildMarkdownStyles(theme), [theme])

  const [doc, setDoc] = useState<Document | null>(null)
  const [media, setMedia] = useState<MediaAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const { activeUrl, token, status } = useConnection()

  // Map from original_url → /api/v1/media/<id> for markdown image rewriting.
  const mediaMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of media) {
      map[a.original_url] = `/api/v1/media/${a.id}`
    }
    return map
  }, [media])

  const scrollRef = useRef<ScrollView>(null)
  const contentHeightRef = useRef(0)
  const viewHeightRef = useRef(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const headerAnim = useRef(new Animated.Value(0)).current
  const headerHeightRef = useRef(56)
  const headerVisibleRef = useRef(true)
  const lastScrollYRef = useRef(0)
  const [scrollProgress, setScrollProgress] = useState(0)

  const load = useCallback(async () => {
    if (!activeUrl || !token) return
    setLoading(true)
    setError(null)
    try {
      const [d, progress, assets] = await Promise.all([
        fetchDocument(activeUrl, token, id),
        fetchReadingProgress(activeUrl, token, id),
        fetchDocumentMedia(activeUrl, token, id),
      ])
      setDoc(d)
      setMedia(assets)
      if (progress && progress.scroll_y > 0) {
        savedProgressRef.current = progress.scroll_y
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load document')
    } finally {
      setLoading(false)
    }
  }, [activeUrl, token, id])

  const savedProgressRef = useRef(0)

  const handleContentSizeChange = useCallback((_w: number, h: number) => {
    contentHeightRef.current = h
    if (savedProgressRef.current > 0 && viewHeightRef.current > 0) {
      const maxScroll = h - viewHeightRef.current
      if (maxScroll > 0) {
        scrollRef.current?.scrollTo({ y: savedProgressRef.current * maxScroll, animated: false })
      }
      savedProgressRef.current = 0
    }
  }, [])

  const handleLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    viewHeightRef.current = e.nativeEvent.layout.height
  }, [])

  const handleHeaderLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    headerHeightRef.current = e.nativeEvent.layout.height
  }, [])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    const y = contentOffset.y
    const maxScroll = contentSize.height - layoutMeasurement.height
    if (maxScroll <= 0) return

    const fraction = Math.min(1, Math.max(0, y / maxScroll))
    setScrollProgress(fraction)

    const dy = y - lastScrollYRef.current
    lastScrollYRef.current = y

    if (dy > 8 && headerVisibleRef.current) {
      headerVisibleRef.current = false
      Animated.timing(headerAnim, {
        toValue: -headerHeightRef.current,
        duration: 180,
        useNativeDriver: true,
      }).start()
    } else if (dy < -8 && !headerVisibleRef.current) {
      headerVisibleRef.current = true
      Animated.timing(headerAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }).start()
    }

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      if (activeUrl && token) saveReadingProgress(activeUrl, token, id, fraction)
    }, DEBOUNCE_MS)
  }, [id, activeUrl, token, headerAnim])

  useEffect(() => {
    if (status === 'connected') {
      load()
    } else if (status === 'disconnected') {
      setError('Not connected')
      setLoading(false)
    }
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [id, status, load])

  const progressPct = Math.round(scrollProgress * 100)

  return (
    <SafeAreaView style={s.screen}>
      {/* Header — slides up/down on scroll direction change */}
      <Animated.View
        style={[s.header, { transform: [{ translateY: headerAnim }] }]}
        onLayout={handleHeaderLayout}
      >
        <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={s.backBtn} hitSlop={12}>
          <Text style={s.backText}>←</Text>
        </Pressable>
        {doc && (
          <Text style={s.headerTitle} numberOfLines={1}>
            {doc.title || doc.canonical_url}
          </Text>
        )}
      </Animated.View>

      {loading ? (
        <View style={s.centered}>
          <ActivityIndicator color={theme.colors.accent} size="large" />
        </View>
      ) : error ? (
        <View style={s.centered}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable onPress={load} style={s.retryBtn}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : doc ? (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={s.content}
          onScroll={handleScroll}
          onContentSizeChange={handleContentSizeChange}
          onLayout={handleLayout}
          scrollEventThrottle={16}
        >
          <Text style={s.title}>{doc.title || doc.canonical_url}</Text>
          <Pressable onPress={() => Linking.openURL(doc.canonical_url)}>
            <Text style={s.url} numberOfLines={2}>
              {doc.canonical_url}
            </Text>
          </Pressable>
          <Text style={s.meta}>
            Fetched {formatDate(doc.fetched_at)}
            {doc.markdown ? `  ·  ${readingMinutes(doc.markdown)} min read` : ''}
          </Text>
          {doc.author ? <Text style={s.author}>By {doc.author}</Text> : null}
          {doc.hero_image_url ? (
            <Image
              source={{ uri: mediaMap[doc.hero_image_url]
                ? `${activeUrl}${mediaMap[doc.hero_image_url]}`
                : doc.hero_image_url }}
              style={s.heroImage}
              resizeMode="cover"
            />
          ) : null}
          {doc.excerpt ? <Text style={s.excerpt}>{doc.excerpt}</Text> : null}
          <View style={s.divider} />
          {doc.markdown ? (
            <Markdown
              style={mdStyle}
              rules={{
                image: (node) => {
                  const src: string = node.attributes?.src ?? ''
                  const localPath = mediaMap[src]
                  const uri = localPath ? `${activeUrl}${localPath}` : src
                  return (
                    <Image
                      key={node.key}
                      source={{ uri }}
                      style={s.mdImage}
                      resizeMode="contain"
                    />
                  )
                },
              }}
            >{doc.markdown}</Markdown>
          ) : (
            <Text style={s.empty}>No content extracted.</Text>
          )}
        </ScrollView>
      ) : null}

      {/* Bottom progress indicator */}
      {doc && (
        <View style={s.progressBar}>
          <View style={[s.progressFill, { width: `${progressPct}%` }]} />
        </View>
      )}
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    header: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
      backgroundColor: t.colors.surface,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
    },
    backBtn: { flexShrink: 0, padding: t.spacing.sm },
    backText: { color: t.colors.accent, fontSize: 20, fontWeight: '400' },
    headerTitle: { flex: 1, color: t.colors.text, fontSize: 15, fontWeight: '600' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errorText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    content: { paddingTop: 56, padding: t.spacing.md, paddingBottom: t.spacing.xl * 2 + 24 },
    title: { color: t.colors.text, fontSize: 20, fontWeight: '700', lineHeight: 28, marginBottom: t.spacing.sm },
    url: { color: t.colors.accent, fontSize: 13, fontFamily: 'monospace', marginBottom: t.spacing.xs },
    meta: { color: t.colors.placeholder, fontSize: 12, marginBottom: t.spacing.xs },
    author: { color: t.colors.muted, fontSize: 13, marginBottom: t.spacing.sm },
    heroImage: { width: '100%', height: 200, borderRadius: t.radius.sm, marginBottom: t.spacing.sm },
    excerpt: { color: t.colors.text, fontSize: 15, fontStyle: 'italic', lineHeight: 22, marginBottom: t.spacing.md },
    mdImage: { width: '100%', height: 200, marginBottom: t.spacing.md },
    divider: { height: 1, backgroundColor: t.colors.border, marginBottom: t.spacing.md },
    empty: { color: t.colors.muted, fontSize: 15, fontStyle: 'italic' },
    progressBar: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: 4,
      overflow: 'hidden',
    },
    progressFill: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      backgroundColor: t.colors.accent,
      opacity: 0.6,
    },
    progressText: {
      display: 'none',
    },
  })
}

function buildMarkdownStyles(t: Theme) {
  return StyleSheet.create({
    body: { color: t.colors.text, fontSize: 15, lineHeight: 24, backgroundColor: t.colors.background },
    heading1: { color: t.colors.text, fontSize: 22, fontWeight: '700', marginTop: t.spacing.lg, marginBottom: t.spacing.sm },
    heading2: { color: t.colors.text, fontSize: 19, fontWeight: '700', marginTop: t.spacing.md, marginBottom: t.spacing.sm },
    heading3: { color: t.colors.text, fontSize: 17, fontWeight: '600', marginTop: t.spacing.md, marginBottom: t.spacing.xs },
    paragraph: { marginBottom: t.spacing.md, color: t.colors.text },
    link: { color: t.colors.accent, textDecorationLine: 'underline' },
    blockquote: { backgroundColor: t.colors.surface, borderLeftWidth: 3, borderLeftColor: t.colors.accent, paddingLeft: t.spacing.md, paddingVertical: t.spacing.xs, marginBottom: t.spacing.md },
    code_inline: { backgroundColor: t.colors.surface, color: t.colors.accent, fontFamily: 'monospace', paddingHorizontal: 4, borderRadius: 3 },
    fence: { backgroundColor: t.colors.surface, padding: t.spacing.md, borderRadius: t.radius.sm, marginBottom: t.spacing.md },
    code_block: { backgroundColor: t.colors.surface, padding: t.spacing.md, borderRadius: t.radius.sm, marginBottom: t.spacing.md, fontFamily: 'monospace', color: t.colors.text },
    bullet_list: { marginBottom: t.spacing.sm },
    ordered_list: { marginBottom: t.spacing.sm },
    list_item: { marginBottom: 4, color: t.colors.text },
    hr: { backgroundColor: t.colors.border, height: 1, marginVertical: t.spacing.md },
    strong: { fontWeight: '700', color: t.colors.text },
    em: { fontStyle: 'italic', color: t.colors.text },
    image: { marginBottom: t.spacing.md },
  })
}
