import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import ModelPicker from './ModelPicker'
import type { ModelChoice } from './ModelPicker'

type Props = {
  model: string      // '' = the provider's default
  provider: string   // '' = the routing chain
  // One callback for both halves (see ModelPicker): the caller writes model AND
  // provider in a single update, so the two can never name different endpoints.
  onSelect: (choice: ModelChoice) => void
  accessibilityLabel: string
  // Name the provider beside the model — for an editor with no provider row of its own.
  showProvider?: boolean
}

// The closed state of the model picker: a field showing the current choice that
// opens ModelPicker. Used wherever a config names a model.
export default function ModelField({ model, provider, onSelect, accessibilityLabel, showProvider }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const [picking, setPicking] = useState(false)

  return (
    <>
      <Pressable style={s.field} onPress={() => setPicking(true)} accessibilityLabel={accessibilityLabel}>
        <Text style={[s.text, !model && s.placeholder]} numberOfLines={1}>
          {model || 'Provider default'}
          {showProvider && provider ? ` · ${provider}` : ''}
        </Text>
        <Text style={s.caret}>▾</Text>
      </Pressable>
      <ModelPicker
        visible={picking}
        value={model}
        provider={provider}
        onSelect={choice => { onSelect(choice); setPicking(false) }}
        onClose={() => setPicking(false)}
      />
    </>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    field: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
      borderRadius: 6,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: 7,
      backgroundColor: t.colors.background,
    },
    text: { flex: 1, fontSize: 12, color: t.colors.text },
    placeholder: { color: t.colors.placeholder },
    caret: { fontSize: 11, color: t.colors.muted },
  })
}
