import { useMemo } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { tagColor } from './tagColor'

type Props = {
  colors: string[]   // palette names, see tagColor.ts
  value: string
  onChange: (color: string) => void
  label: string      // what is being coloured — each swatch reads "<label> <name>"
}

// The one colour picker: a fixed row of palette swatches, never free hex, so a
// colour stays consistent wherever its owner is named.
export default function ColorSwatches({ colors, value, onChange, label }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  return (
    <View style={s.row}>
      {colors.map(c => (
        <Pressable
          key={c}
          style={[s.swatch, { backgroundColor: tagColor(c) }, value === c && s.selected]}
          onPress={() => onChange(c)}
          accessibilityLabel={`${label} ${c}`}
          aria-selected={value === c}
        />
      ))}
    </View>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    row: { flexDirection: 'row', gap: t.spacing.sm, flexWrap: 'wrap' },
    swatch: { width: 24, height: 24, borderRadius: 12 },
    selected: { borderWidth: 2, borderColor: t.colors.text },
  })
}
