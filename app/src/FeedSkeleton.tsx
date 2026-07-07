import { useEffect, useMemo } from 'react'
import { View, StyleSheet } from 'react-native'
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from 'react-native-reanimated'
import { useUnistyles } from 'react-native-unistyles'

// Placeholder feed shown while the first load / sync is still in flight, so the
// empty state doesn't flash before data arrives. Pulsing card silhouettes that
// mirror the HighlightCard layout.
export default function FeedSkeleton() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])

  const pulse = useSharedValue(0.4)
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }), -1, true)
  }, [pulse])

  const animStyle = useAnimatedStyle(() => ({ opacity: pulse.value }))

  return (
    <View style={s.list}>
      {[0, 1, 2, 3].map((i) => (
        <Animated.View key={i} style={[s.card, animStyle]}>
          <View style={s.metaRow}>
            <View style={s.badge} />
            <View style={s.title} />
          </View>
          <View style={s.line} />
          <View style={s.line} />
          <View style={[s.line, s.lineShort]} />
        </Animated.View>
      ))}
    </View>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    list: { flex: 1, backgroundColor: t.colors.background, padding: 12, gap: 12, maxWidth: 800, alignSelf: 'center', width: '100%' },
    card: {
      backgroundColor: t.colors.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.colors.border,
      padding: 14,
      gap: 10,
    },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    badge: { width: 20, height: 20, borderRadius: 6, backgroundColor: t.colors.border },
    title: { flex: 1, height: 14, borderRadius: 4, backgroundColor: t.colors.border },
    line: { height: 11, borderRadius: 4, backgroundColor: t.colors.border },
    lineShort: { width: '55%' },
  })
}
