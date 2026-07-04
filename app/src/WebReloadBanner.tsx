import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useMemo } from 'react'
import { useUnistyles } from 'react-native-unistyles'
import { useWebReloadAvailable } from './useUpdate'

// Web-only reload prompt. The web build has no APK to update; instead, when the
// server starts serving a newer bundle (its /health commit no longer matches the
// commit baked into this tab), we surface a one-tap reload. Native returns null —
// the drawer's APK badge covers updates there.
export default function WebReloadBanner() {
  const reloadAvailable = useWebReloadAvailable()
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  if (Platform.OS !== 'web' || !reloadAvailable) return null
  return (
    <View style={s.wrap} pointerEvents="box-none">
      <View style={s.banner}>
        <Text style={s.text}>A new version is available.</Text>
        <Pressable
          onPress={() => { if (typeof window !== 'undefined') window.location.reload() }}
          style={({ pressed }) => [s.btn, pressed && s.btnPressed]}
        >
          <Text style={s.btnText}>Reload</Text>
        </Pressable>
      </View>
    </View>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    wrap: { position: 'absolute', bottom: 24, left: 0, right: 0, alignItems: 'center', zIndex: 9999 },
    banner: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      paddingLeft: t.spacing.md, paddingRight: t.spacing.sm, paddingVertical: t.spacing.sm,
      borderRadius: t.radius.md, backgroundColor: t.colors.surface,
      borderWidth: 1, borderColor: t.colors.accent,
      shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 10,
    },
    text: { color: t.colors.text, fontSize: 14, fontWeight: '600' },
    btn: { paddingHorizontal: t.spacing.md, paddingVertical: 6, borderRadius: t.radius.sm, backgroundColor: t.colors.accent },
    btnPressed: { opacity: 0.8 },
    btnText: { color: t.colors.background, fontSize: 14, fontWeight: '700' },
  })
}
