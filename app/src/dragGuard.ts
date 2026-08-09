import { useRef } from 'react'
import type { GestureResponderEvent } from 'react-native'

// A feed card is wrapped in RNGH's ReanimatedSwipeable, which runs its pan OUTSIDE the
// RN responder system on web — so dragging a card left/right (or selecting text across
// it) still ends as a press on whatever Pressable the pointer went down on, and the
// popout opened on every swipe. Compare press-in/press-out coords and swallow the press
// once the pointer travelled. Harmless on native (a real pan terminates the responder
// there, so the guard never sees a moved press).
const DRAG_SLOP = 8

export function useDragGuard() {
  const start = useRef({ x: 0, y: 0 })
  return function guard(fn?: () => void) {
    return {
      onPressIn: (e: GestureResponderEvent) => {
        start.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }
      },
      onPress: (e: GestureResponderEvent) => {
        const dx = e.nativeEvent.pageX - start.current.x
        const dy = e.nativeEvent.pageY - start.current.y
        if (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP) return
        fn?.()
      },
    }
  }
}
