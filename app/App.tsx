import './src/theme'
import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { useUnistyles } from 'react-native-unistyles'
import { findReachable, health, pair } from './src/api'
import { clearConnection, loadConnection, saveConnection } from './src/storage'

function defaultServerUrl(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin
  }
  return 'http://localhost:8765'
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }        // restoring saved session
  | { kind: 'connecting' }
  | { kind: 'online'; detail: string; activeUrl: string }
  | { kind: 'error'; message: string }

export default function App() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const [url, setUrl] = useState(defaultServerUrl)
  const [code, setCode] = useState('')
  const [serverUrls, setServerUrls] = useState<string[]>([])
  const [token, setToken] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  // Restore saved connection on mount and auto-reconnect.
  useEffect(() => {
    loadConnection().then(async (saved) => {
      if (!saved) {
        setStatus({ kind: 'idle' })
        return
      }
      setToken(saved.token)
      setServerUrls(saved.serverUrls)
      if (saved.serverUrls[0]) setUrl(saved.serverUrls[0])

      const found = await findReachable(saved.serverUrls, saved.token)
      if (found) {
        setStatus({
          kind: 'online',
          detail: `${found.info.device_id} · server ${found.info.server_version ?? '?'}`,
          activeUrl: found.url,
        })
      } else {
        setStatus({ kind: 'idle' })
      }
    })
  }, [])

  async function connect() {
    setStatus({ kind: 'connecting' })
    try {
      let t = token
      let urls = serverUrls.length > 0 ? serverUrls : [url]

      if (!t) {
        if (!code.trim()) throw new Error('Enter the pairing code from `sam connect`.')
        const result = await pair(url, code.trim())
        t = result.device_token
        urls = result.server_urls && result.server_urls.length > 0 ? result.server_urls : [url]
        setToken(t)
        setServerUrls(urls)
        await saveConnection({ token: t, deviceId: result.device_id, serverUrls: urls })
      }

      // Try all known URLs in order, use whichever responds first.
      const found = await findReachable(urls, t)
      if (!found) throw new Error('No server reachable on any known address.')

      setStatus({
        kind: 'online',
        detail: `${found.info.device_id} · server ${found.info.server_version ?? '?'}`,
        activeUrl: found.url,
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Connection failed'
      try {
        const h = await health(url)
        setStatus({ kind: 'error', message: `Server reachable (${h.status}) but not paired — ${msg}` })
      } catch {
        setStatus({ kind: 'error', message: msg })
      }
    }
  }

  async function disconnect() {
    await clearConnection()
    setToken(null)
    setServerUrls([])
    setStatus({ kind: 'idle' })
  }

  if (status.kind === 'loading') {
    return (
      <SafeAreaView style={s.screen}>
        <ActivityIndicator color={theme.colors.accent} size="large" />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style="light" />
      <View style={s.card}>
        <Text style={s.brand}>samizdat</Text>

        {status.kind === 'online' ? (
          <>
            <Text style={s.online}>Yaaay, we're online.</Text>
            <Text style={s.detail}>{status.detail}</Text>
            <Text style={s.urlBadge}>{status.activeUrl}</Text>
            {serverUrls.length > 1 && (
              <Text style={s.urlList}>
                Also knows: {serverUrls.filter((u) => u !== status.activeUrl).join(', ')}
              </Text>
            )}
            <Pressable style={[s.button, s.buttonSecondary]} onPress={connect}>
              <Text style={s.buttonTextSecondary}>Re-check</Text>
            </Pressable>
            <Pressable style={s.ghost} onPress={disconnect}>
              <Text style={s.ghostText}>Disconnect</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={s.sub}>Connect to your server</Text>

            <Text style={s.label}>Server URL</Text>
            <TextInput
              style={s.input}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://samizdat.example.com"
              placeholderTextColor={theme.colors.placeholder}
              value={url}
              onChangeText={setUrl}
            />

            <Text style={s.label}>Pairing code</Text>
            <TextInput
              style={s.input}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="XXXX-XXXX"
              placeholderTextColor={theme.colors.placeholder}
              value={code}
              onChangeText={setCode}
            />

            <Pressable
              style={({ pressed }) => [s.button, pressed && s.buttonPressed]}
              onPress={connect}
              disabled={status.kind === 'connecting'}
            >
              {status.kind === 'connecting' ? (
                <ActivityIndicator color={theme.colors.background} />
              ) : (
                <Text style={s.buttonText}>Connect</Text>
              )}
            </Pressable>

            <Pressable style={s.ghost} disabled>
              <Text style={s.ghostText}>Scan QR — coming soon</Text>
            </Pressable>
            <Text style={s.code}>just sam connect</Text>

            {status.kind === 'error' && <Text style={s.errorText}>{status.message}</Text>}
            {status.kind === 'idle' && <Text style={s.hint}>Run the above on your server to get a pairing code.</Text>}
          </>
        )}
      </View>
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background, justifyContent: 'center' },
    card: { paddingHorizontal: t.spacing.xl, gap: t.spacing.sm },
    brand: { color: t.colors.text, fontSize: 34, fontWeight: '800', letterSpacing: -1, marginBottom: 4 },
    sub: { color: t.colors.muted, fontSize: 15, marginBottom: 20 },
    label: { color: t.colors.muted, fontSize: 13, marginTop: 12, marginBottom: 6 },
    input: {
      backgroundColor: t.colors.surface,
      color: t.colors.text,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.colors.border,
      paddingHorizontal: t.spacing.md,
      paddingVertical: 12,
      fontSize: 16,
    },
    button: {
      backgroundColor: t.colors.accent,
      borderRadius: t.radius.md,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: t.spacing.lg,
    },
    buttonSecondary: { backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border },
    buttonPressed: { opacity: 0.85 },
    buttonText: { color: t.colors.background, fontSize: 16, fontWeight: '700' },
    buttonTextSecondary: { color: t.colors.muted, fontSize: 15, fontWeight: '600' },
    ghost: { alignItems: 'center', paddingVertical: 12 },
    ghostText: { color: t.colors.placeholder, fontSize: 14 },
    online: { color: t.colors.online, fontSize: 22, fontWeight: '800', marginTop: 8 },
    detail: { color: t.colors.muted, fontSize: 13 },
    urlBadge: { color: t.colors.accent, fontSize: 12, fontFamily: 'monospace', marginTop: 4 },
    urlList: { color: t.colors.placeholder, fontSize: 11, fontFamily: 'monospace' },
    hint: { color: t.colors.muted, fontSize: 13, marginTop: 8 },
    code: { color: t.colors.accent, fontSize: 13, fontFamily: 'monospace', textAlign: 'center', marginTop: 4 },
    errorText: { color: t.colors.error, fontSize: 14, lineHeight: 20, marginTop: 8 },
  })
}
