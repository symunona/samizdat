import { ComponentProps, useMemo, useState } from 'react'
import { Pressable, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useUnistyles } from 'react-native-unistyles'

type IoniconName = ComponentProps<typeof Ionicons>['name']

interface Props {
  name: IoniconName
  onPress: () => void
  hitSlop?: number
  size?: number
  color?: string
  hoverColor?: string
}

// Styled icon button with desktop hover (non-touch): scales up + shifts color.
// onHoverIn/onHoverOut only fire for a fine pointer, so touch is unaffected.
// Geometry comes from the shared iconButtonSpec (theme.iconButton) so the
// WebView highlight card can mirror it — see src/iconButtonSpec.ts.
export default function IconButton({ name, onPress, hitSlop = 8, size, color, hoverColor }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const [hover, setHover] = useState(false)
  const base = color ?? theme.colors.muted
  const active = hoverColor ?? theme.colors.text
  const glyph = size ?? theme.iconButton.size
  return (
    <Pressable
      onPress={onPress}
      hitSlop={hitSlop}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={[s.btn, hover && s.btnHover]}
    >
      <Ionicons name={name} size={glyph} color={hover ? active : base} />
    </Pressable>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    btn: {
      paddingHorizontal: t.iconButton.padX,
      paddingVertical: t.iconButton.padY,
      borderRadius: t.iconButton.radius,
      backgroundColor: 'transparent',
    },
    btnHover: {
      backgroundColor: t.colors.background,
      transform: [{ scale: t.iconButton.hoverScale }],
    },
  })
}
