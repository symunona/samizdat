import { Pressable, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useUnistyles } from 'react-native-unistyles'
import { useMemo } from 'react'

interface Props {
  onPress: () => void
  hitSlop?: number
  size?: number
}

export default function NoteEditButton({ onPress, hitSlop = 8, size = 14 }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  return (
    <Pressable onPress={onPress} style={s.btn} hitSlop={hitSlop}>
      <Ionicons name="create-outline" size={size} color={theme.colors.muted} />
    </Pressable>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    btn: {
      paddingHorizontal: 8,
      paddingVertical: 5,
      borderRadius: 6,
      backgroundColor: 'transparent',
    },
  })
}
