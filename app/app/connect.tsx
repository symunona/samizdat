import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
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
import { health, pair } from '../src/api'
import { clearConnection, saveConnection } from '../src/storage'
import { useConnection } from '../src/ConnectionContext'

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

function splitUrls(raw: string): string[] {
  return raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
}

type Status =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'error'; message: string }

type ParseResult =
  | { ok: true; code: string; urls: string[] }
  | { ok: false; reason: string }

function parseConnectString(raw: string): ParseResult {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: '' }
  try {
    const json = atob(trimmed)
    const obj = JSON.parse(json)
    if (obj.v !== 1 || typeof obj.code !== 'string' || !Array.isArray(obj.urls)) {
      return { ok: false, reason: 'Unrecognised format' }
    }
    return { ok: true, code: obj.code as string, urls: obj.urls as string[] }
  } catch {
    return { ok: false, reason: 'Invalid connect string' }
  }
}

export default function ConnectScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { reload } = useConnection()

  const [url, setUrl] = useState(defaultServerUrl)
  const [code, setCode] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [connectString, setConnectString] = useState('')
  const [connectStringHint, setConnectStringHint] = useState<string | null>(null)

  // Auto-connect from ?c= URL param (e.g. clicking a link from `sam connect` output)
  const urlParamHandled = useRef(false)
  useEffect(() => {
    if (urlParamHandled.current) return
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    const c = new URLSearchParams(window.location.search).get('c')
    if (!c) return
    urlParamHandled.current = true
    const parsed = parseConnectString(c)
    if (!parsed.ok) return
    const primaryUrl = parsed.urls[0] ?? defaultServerUrl()
    setConnectString(c)
    setCode(parsed.code)
    setUrl(parsed.urls.join('\n'))
    setConnectStringHint('Connecting…')
    setStatus({ kind: 'connecting' })
    pair(primaryUrl, parsed.code, deviceName())
      .then(async (paired) => {
        const serverUrls = paired.server_urls?.length ? paired.server_urls : parsed.urls
        await saveConnection({ token: paired.device_token, deviceId: paired.device_id, serverUrls })
        await reload()
        router.replace('/')
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'Connection failed'
        setConnectStringHint(msg)
        setStatus({ kind: 'error', message: msg })
      })
  }, [reload, router])

  async function handleConnectString(val: string) {
    setConnectString(val)
    if (!val.trim()) { setConnectStringHint(null); return }
    const result = parseConnectString(val)
    if (result.ok) {
      const primaryUrl = result.urls[0] ?? url
      setCode(result.code)
      setUrl(result.urls.join('\n'))
      setConnectStringHint('Connecting…')
      setStatus({ kind: 'connecting' })
      try {
        const paired = await pair(primaryUrl, result.code, deviceName())
        const serverUrls = paired.server_urls?.length ? paired.server_urls : result.urls
        await saveConnection({ token: paired.device_token, deviceId: paired.device_id, serverUrls })
        await reload()
        router.replace('/')
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Connection failed'
        setConnectStringHint(msg)
        setStatus({ kind: 'error', message: msg })
      }
    } else {
      setConnectStringHint(result.reason || null)
    }
  }

  async function connect() {
    setStatus({ kind: 'connecting' })
    try {
      if (!code.trim()) throw new Error('Enter the pairing code from `sam connect`.')
      const urlList = splitUrls(url)
      const primaryUrl = urlList[0]
      if (!primaryUrl) throw new Error('Enter a server URL.')
      const result = await pair(primaryUrl, code.trim(), deviceName())
      const serverUrls = result.server_urls?.length ? result.server_urls : urlList
      await saveConnection({ token: result.device_token, deviceId: result.device_id, serverUrls })
      await reload()
      router.replace('/')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Connection failed'
      try {
        const primaryUrl = splitUrls(url)[0] ?? url
        const h = await health(primaryUrl)
        setStatus({ kind: 'error', message: `Server reachable (${h.status}) but not paired — ${msg}` })
      } catch {
        setStatus({ kind: 'error', message: msg })
      }
    }
  }

  async function disconnect() {
    await clearConnection()
    await reload()
  }

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style="light" />
      <View style={s.card}>
        <Image
          source={Platform.OS === 'web'
            ? { uri: '/favicon.svg' }
            : require('../assets/favicon.png')}
          style={s.logo}
          resizeMode="contain"
        />
        <Text style={s.brand}>samizdat</Text>
        <Text style={s.sub}>Connect to your server</Text>

        <Text style={s.label}>Connect string</Text>
        <TextInput
          style={s.input}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          placeholder="Paste base64 string from `just sam connect`"
          placeholderTextColor={theme.colors.placeholder}
          value={connectString}
          onChangeText={handleConnectString}
        />
        {connectStringHint !== null && (
          <Text style={connectString && parseConnectString(connectString).ok ? s.hintOk : s.hintWarn}>
            {connectStringHint}
          </Text>
        )}

        <View style={s.divider} />

        <Text style={s.label}>Server URL</Text>
        <TextInput
          style={[s.input, s.inputMultiline]}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          numberOfLines={3}
          placeholder={'https://samizdat.example.com\nhttps://100.x.x.x:8765'}
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
    logo: { width: 80, height: 80, marginBottom: 8, alignSelf: 'center' },
    brand: { color: t.colors.text, fontSize: 34, fontWeight: '800', letterSpacing: -1, marginBottom: 4, textAlign: 'center' },
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
    inputMultiline: {
      height: 80,
      textAlignVertical: 'top',
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
    hintOk: { color: t.colors.online, fontSize: 12, marginTop: 4 },
    hintWarn: { color: t.colors.error, fontSize: 12, marginTop: 4 },
    divider: { height: 1, backgroundColor: t.colors.border, marginVertical: t.spacing.md },
    code: { color: t.colors.accent, fontSize: 13, fontFamily: 'monospace', textAlign: 'center', marginTop: 4 },
    errorText: { color: t.colors.error, fontSize: 14, lineHeight: 20, marginTop: 8 },
  })
}
