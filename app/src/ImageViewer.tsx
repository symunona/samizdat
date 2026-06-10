import { useState } from 'react'
import { Dimensions, Image, Modal, Platform, Pressable, ScrollView, StyleSheet } from 'react-native'

type Props = {
  src: string
  alt?: string
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window')

export default function ImageViewer({ src, alt }: Props) {
  const [open, setOpen] = useState(false)
  if (!src) return null

  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={s.thumbWrap}>
        <Image
          source={{ uri: src }}
          style={s.thumb}
          resizeMode="contain"
          accessibilityLabel={alt}
        />
      </Pressable>
      {open && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setOpen(false)}
          statusBarTranslucent
        >
          <Pressable style={s.backdrop} onPress={() => setOpen(false)}>
            {Platform.OS === 'web' ? (
              <Pressable style={s.fullContainer} onPress={() => {}}>
                <Image
                  source={{ uri: src }}
                  style={s.fullImage}
                  resizeMode="contain"
                  accessibilityLabel={alt}
                />
              </Pressable>
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
                  source={{ uri: src }}
                  style={s.fullImage}
                  resizeMode="contain"
                  accessibilityLabel={alt}
                />
              </ScrollView>
            )}
          </Pressable>
        </Modal>
      )}
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
  fullContainer: {
    width: SCREEN_W,
    height: SCREEN_H,
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
})
