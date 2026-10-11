import { useMemo, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useUnistyles } from 'react-native-unistyles'
import { formatBytes } from './offlineCache'
import type { OfflineKind } from './offlineCache'
import type { OfflineState } from './useOfflineMedia'

type IconName = React.ComponentProps<typeof Ionicons>['name']

// The one visual language for "where does this play from". A cloud means the phone
// needs the server; a green tick means it plays with no internet, and the glyph
// beside the tick says how much of it is here. Nothing else on the player is green.
const STATES: { key: OfflineState; icon: IconName; label: string; detail: string }[] = [
  { key: 'server', icon: 'cloud-outline', label: 'On the server', detail: 'Streams — needs internet' },
  { key: 'audio', icon: 'headset', label: 'Audio on this phone', detail: 'Plays with no internet' },
  { key: 'video', icon: 'videocam', label: 'Audio + video on this phone', detail: 'Plays with no internet' },
]

interface Props {
  state: OfflineState
  busy: OfflineKind | null
  percent: number
  sizeBytes: number
  // Move to another state: download what is missing, or remove what is extra.
  onPick: (target: OfflineState) => void
}

// The player's offline control: a face that shows the current state at a glance, and
// a sheet listing all three so the icons explain themselves. Tapping the face never
// starts a download — the old button re-fetched the whole file on every tap.
export default function OfflineMediaButton({ state, busy, percent, sizeBytes, onPick }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const [open, setOpen] = useState(false)
  const order = STATES.findIndex(x => x.key === state)

  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={s.face} hitSlop={8} testID="offline-media-button" accessibilityLabel={STATES[order].label}>
        {busy ? (
          <>
            <ActivityIndicator size="small" color={theme.colors.accent} />
            <Text style={s.percent}>{percent}%</Text>
          </>
        ) : state === 'server' ? (
          <Ionicons name="cloud-outline" size={22} color={theme.colors.muted} />
        ) : (
          <>
            <Ionicons name="checkmark-circle" size={18} color={theme.colors.online} />
            <Ionicons name={STATES[order].icon} size={16} color={theme.colors.online} />
          </>
        )}
      </Pressable>

      {open ? (
        <Modal transparent animationType="fade" onRequestClose={() => setOpen(false)}>
          <Pressable style={s.overlay} onPress={() => setOpen(false)}>
            <Pressable style={s.sheet} onPress={e => e.stopPropagation()}>
              <Text style={s.title}>
                {busy ? `Downloading ${busy}… ${percent}%` : state === 'server' ? 'Not on this phone' : `On this phone · ${formatBytes(sizeBytes)}`}
              </Text>
              {STATES.map((x, i) => {
                const current = x.key === state
                const tint = current ? (x.key === 'server' ? theme.colors.text : theme.colors.online) : theme.colors.muted
                return (
                  <Pressable
                    key={x.key}
                    style={[s.row, current && s.rowCurrent]}
                    disabled={current || !!busy}
                    onPress={() => { setOpen(false); onPick(x.key) }}
                    testID={`offline-media-${x.key}`}
                  >
                    <View style={s.rowIcons}>
                      {x.key !== 'server' ? <Ionicons name="checkmark-circle" size={16} color={tint} /> : null}
                      <Ionicons name={x.icon} size={18} color={tint} />
                    </View>
                    <View style={s.rowText}>
                      <Text style={[s.rowLabel, current && s.rowLabelCurrent]}>{x.label}</Text>
                      <Text style={s.rowDetail}>{x.detail}</Text>
                    </View>
                    <Text style={[s.rowAction, i < order && s.rowActionRemove, current && s.rowActionNow]}>
                      {current ? 'now' : i > order ? 'Download' : 'Remove'}
                    </Text>
                  </Pressable>
                )
              })}
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    face: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: 6, flexShrink: 0 },
    percent: { color: t.colors.accent, fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'] },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: t.colors.surface,
      borderTopLeftRadius: 14, borderTopRightRadius: 14,
      borderTopWidth: 1, borderTopColor: t.colors.border,
      padding: t.spacing.lg, paddingBottom: t.spacing.xl + 8, gap: t.spacing.sm,
    },
    title: { color: t.colors.text, fontSize: 15, fontWeight: '700', marginBottom: t.spacing.xs },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: t.spacing.md,
      borderWidth: 1, borderColor: t.colors.border, borderRadius: 10,
      paddingVertical: t.spacing.md, paddingHorizontal: t.spacing.md,
    },
    rowCurrent: { backgroundColor: t.colors.background },
    rowIcons: { flexDirection: 'row', alignItems: 'center', gap: 2, width: 40 },
    rowText: { flex: 1 },
    rowLabel: { color: t.colors.text, fontSize: 14, fontWeight: '500' },
    rowLabelCurrent: { fontWeight: '700' },
    rowDetail: { color: t.colors.muted, fontSize: 12 },
    rowAction: { color: t.colors.accent, fontSize: 12, fontWeight: '700' },
    rowActionRemove: { color: t.colors.error },
    rowActionNow: { color: t.colors.muted },
  })
}
