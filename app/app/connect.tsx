import { useMemo, useState } from 'react'
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
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { findReachable, health, pair } from '../src/api'
import { clearConnection, loadConnection, saveConnection } from '../src/storage'

function defaultServerUrl(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin
  }
  return 'http://localhost:8765'
}

function deviceName(): string {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined') {
    const ua = navigator.userAgent
    const browser = /Edg/.test(ua) ? 'Edge'
      : /Chrome/.test(ua) ? 'Chrome'
      : /Firefox/.test(ua) ? 'Firefox'
      : /Safari/.test(ua) ? 'Safari'
      : 'Browser'
    const os = /Windows/.test(ua) ? 'Windows'
      : /Mac OS/.test(ua) ? 'Mac'
      : /Linux/.test(ua) ? 'Linux'
      : /Android/.test(ua) ? 'Android'
      : /iPhone|iPad/.test(ua) ? 'iOS'
      : 'Unknown'
    const host = typeof window !== 'undefined' ? window.location.hostname : ''
    return host && host !== 'localhost' ? `${browser} @ ${host}` : `${browser} on ${os}`
  }
  const plat = Platform.OS === 'ios' ? 'iPhone'
    : Platform.OS === 'android' ? 'Android'
    : Platform.OS
  return `Samizdat ${plat}`
}

type Status =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'error'; message: string }

export default function ConnectScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()

  const [url, setUrl] = useState(defaultServerUrl)
  const [code, setCode] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  async function connect() {
    setStatus({ kind: 'connecting' })
    try {
      const saved = await loadConnection()
      let t = saved?.token ?? null
      let urls = saved && saved.serverUrls.length > 0 ? saved.serverUrls : [url]

      if (!t) {
        if (!code.trim()) throw new Error('Enter the pairing code from `sam connect`.')
        const result = await pair(url, code.trim(), deviceName())
        t = result.device_token
        urls = result.server_urls && result.server_urls.length > 0 ? result.server_urls : [url]
        await saveConnection({ token: t, deviceId: result.device_id, serverUrls: urls })
      }

      const found = await findReachable(urls, t)
      if (!found) throw new Error('No server reachable on any known address.')

      router.replace('/')
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
  }

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style="light" />
      <View style={s.card}>
        <Text style={s.brand}>samizdat</Text>
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
        {status.kind === 'idle' && (
          <Text style={s.hint}>Run the above on your server to get a pairing code.</Text>
        )}

        <Pressable style={s.ghost} onPress={disconnect}>
          <Text style={s.ghostText}>Clear saved connection</Text>
        </Pressable>
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
    buttonPressed: { opacity: 0.85 },
    buttonText: { color: t.colors.background, fontSize: 16, fontWeight: '700' },
    ghost: { alignItems: 'center', paddingVertical: 12 },
    ghostText: { color: t.colors.placeholder, fontSize: 14 },
    hint: { color: t.colors.muted, fontSize: 13, marginTop: 8 },
    code: { color: t.colors.accent, fontSize: 13, fontFamily: 'monospace', textAlign: 'center', marginTop: 4 },
    errorText: { color: t.colors.error, fontSize: 14, lineHeight: 20, marginTop: 8 },
  })
}
