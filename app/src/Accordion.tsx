import { useMemo, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useUnistyles } from 'react-native-unistyles'

type Props = {
  title: string
  subtitle?: string
  /** One line shown INSTEAD of the body while collapsed — the reason not to open it. */
  summary?: ReactNode
  /** Header accessory (Test / Refresh / Probe): rendered only while open, so it is never tapped blind. */
  action?: ReactNode
  defaultOpen?: boolean
  testID?: string
  children: ReactNode
}

// A settings card that opens on a tap. Collapsed it shows title + a one-line
// summary; open it shows its children (and its action button). Card chrome is
// the same as a plain settings card, so a screen can mix the two freely.
export default function Accordion({ title, subtitle, summary, action, defaultOpen = false, testID, children }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const [open, setOpen] = useState(defaultOpen)
  return (
    <View style={s.card} testID={testID}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [s.header, pressed && s.headerPressed]}
        accessibilityRole="button"
        // Both spellings: RN-Web renders accessibilityState.expanded as nothing at
        // all (no aria-expanded on the node), so a screen reader — and any test
        // reading the DOM — could not tell an open card from a shut one.
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={title}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <View style={s.titleGroup}>
          <Text style={s.title}>{title}</Text>
          {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
          {!open && summary ? <View style={s.summary}>{summary}</View> : null}
        </View>
        {open && action ? action : null}
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={theme.colors.muted} />
      </Pressable>
      {open ? <View style={s.body}>{children}</View> : null}
    </View>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    card: {
      backgroundColor: t.colors.surface,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.colors.border,
      padding: t.spacing.md,
      gap: t.spacing.sm,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    headerPressed: { opacity: 0.7 },
    titleGroup: { flex: 1, gap: 2 },
    title: { color: t.colors.text, fontSize: 15, fontWeight: '700', lineHeight: 20 },
    subtitle: { color: t.colors.muted, fontSize: 12, lineHeight: 17 },
    summary: { marginTop: 2 },
    body: { gap: t.spacing.sm },
  })
}
