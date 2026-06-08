import { useMemo } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'

export default function FeedScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])

  return (
    <View style={s.container}>
      <Text style={s.placeholder}>Feed — coming soon</Text>
    </View>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background, justifyContent: 'center', alignItems: 'center' },
    placeholder: { color: t.colors.muted, fontSize: 16 },
  })
}
