import { useCallback, useState } from 'react'
import { Dimensions, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { GestureResponderEvent, NativeSyntheticEvent, ImageErrorEventData } from 'react-native'
import { createLogger } from './logger'
import { useConnection } from './ConnectionContext'

const log = createLogger('image')

type Props = {
  src: string
  alt?: string
}

type LightboxProps = Props & {
  onClose: () => void
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window')

// Media is served as a RELATIVE URL (/api/v1/media/<id>, rewritten from the original
// CDN by the extract-images step). RN <Image> needs an ABSOLUTE uri on native — a
// relative path has no origin to resolve against (it works on web via the page origin),
// so it fails and reports a degenerate 1×1. Prefix the server base URL.
function absolutize(src: string, activeUrl: string | null | undefined): string {
  return src && src.startsWith('/') && activeUrl ? `${activeUrl.replace(/\/+$/, '')}${src}` : src
}

/**
 * The full-screen zoomable overlay, CONTROLLED — visible while mounted, gone when the
 * caller stops rendering it. Two callers: `ImageViewer` (a tapped thumb in an RN markdown
 * body) and the document screen (an `image_tap` posted out of the document-viewer WebView,
 * whose raw-DOM <img> has no RN component of its own). Keep it the only lightbox.
 */
export function ImageLightbox({ src, alt, onClose }: LightboxProps) {
  const { activeUrl } = useConnection()
  const resolvedSrc = absolutize(src, activeUrl)

  if (!src) return null

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={s.backdrop}>
        {Platform.OS === 'web' ? (
          <Image
            source={{ uri: resolvedSrc }}
            style={s.fullImage}
            resizeMode="contain"
            accessibilityLabel={alt}
          />
        ) : (
          <ScrollView
            style={s.nativeScroll}
            contentContainerStyle={s.nativeContent}
            maximumZoomScale={5}
            minimumZoomScale={1}
            centerContent
            showsVerticalScrollIndicator={false}
            showsHorizontalScrollIndicator={false}
          >
            <Image
              source={{ uri: resolvedSrc }}
              style={s.fullImage}
              resizeMode="contain"
              accessibilityLabel={alt}
            />
          </ScrollView>
        )}
        <Pressable style={s.closeBtn} onPress={onClose} hitSlop={12} testID="image-lightbox-close">
          <Text style={s.closeBtnText}>✕</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

export default function ImageViewer({ src, alt }: Props) {
  const [open, setOpen] = useState(false)
  const { activeUrl } = useConnection()

  const resolvedSrc = absolutize(src, activeUrl)

  const handleThumbPress = useCallback((e: GestureResponderEvent) => {
    e.stopPropagation()
    setOpen(true)
  }, [])

  const handleClose = useCallback(() => setOpen(false), [])

  // Safety net: report a genuine image load failure (src + native error) to the device
  // channel. Fires only on error, so no per-image noise.
  const handleError = useCallback((e: NativeSyntheticEvent<ImageErrorEventData>) => {
    log.warn('image load failed', { src: resolvedSrc.slice(0, 140), error: e?.nativeEvent?.error })
  }, [resolvedSrc])

  if (!src) return null

  return (
    <>
      <Pressable onPress={handleThumbPress} style={s.thumbWrap}>
        <Image
          source={{ uri: resolvedSrc }}
          style={s.thumb}
          resizeMode="contain"
          accessibilityLabel={alt}
          onError={handleError}
        />
      </Pressable>
      {open && <ImageLightbox src={src} alt={alt} onClose={handleClose} />}
    </>
  )
}

const s = StyleSheet.create({
  thumbWrap: {
    width: '100%',
    alignSelf: 'stretch',
  },
  thumb: {
    width: '100%',
    height: 220,
    borderRadius: 6,
    marginBottom: 8,
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  nativeScroll: {
    width: SCREEN_W,
    height: SCREEN_H,
  },
  nativeContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullImage: {
    width: SCREEN_W,
    height: SCREEN_H,
  },
  closeBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    color: '#fff',
    fontSize: 18,
    lineHeight: 20,
  },
})
