import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { fetchDevices, revokeDevice, fetchSettings, updateSettings, ApiError } from '../../src/api'
import type { DeviceInfo, AppSettings } from '../../src/api'
import { clearConnection, removeServerUrl, loadUrlLastUsedMap } from '../../src/storage'
import { useConnection } from '../../src/ConnectionContext'
import { useConfirm } from '../../src/ConfirmContext'
import { useToast } from '../../src/ToastContext'

function hostname(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch { return iso }
}

function formatTime(d: Date | null): string {
  if (!d) return '—'
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime()
    const secs = Math.floor(diff / 1000)
    if (secs < 60) return 'just now'
    const mins = Math.floor(secs / 60)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    if (days < 7) return `${days}d ago`
    return formatDate(iso)
  } catch { return iso }
}

export default function SettingsScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { status, activeUrl, serverUrls, token, deviceId, serverInfo, lastChecked, probe, reload, logout } = useConnection()

  const { toast } = useToast()
  const { confirm } = useConfirm()

  const [probing, setProbing] = useState(false)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null)
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesRefreshing, setDevicesRefreshing] = useState(false)
  const [devicesError, setDevicesError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<Set<string>>(new Set())
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [urlLastUsed, setUrlLastUsed] = useState<Record<string, string>>({})

  const handleUnauthorized = useCallback(async () => {
    await logout()
    toast('Device access was revoked. Please relink.', 'error')
    router.replace('/connect')
  }, [logout, toast, router])

  const loadDevices = useCallback(async (silent = false) => {
    if (!activeUrl || !token) return
    if (silent) {
      setDevicesRefreshing(true)
    } else {
      setDevicesLoading(true)
    }
    setDevicesError(null)
    try {
      const result = await fetchDevices(activeUrl, token)
      setDevices(result.devices)
      setCurrentDeviceId(result.current_device_id)
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 401) {
        handleUnauthorized()
        return
      }
      setDevicesError(e instanceof Error ? e.message : 'Failed to load devices')
    } finally {
      setDevicesLoading(false)
      setDevicesRefreshing(false)
    }
  }, [activeUrl, token, handleUnauthorized])

  const loadSettings = useCallback(async () => {
    if (!activeUrl || !token) return
    try {
      const s = await fetchSettings(activeUrl, token)
      setSettings(s)
    } catch { /* best-effort */ }
  }, [activeUrl, token])

  useEffect(() => {
    loadUrlLastUsedMap().then(setUrlLastUsed)
  }, [])

  useEffect(() => {
    if (status === 'connected') {
      loadDevices()
      loadSettings()
      loadUrlLastUsedMap().then(setUrlLastUsed)
    }
  }, [status, loadDevices, loadSettings])

  async function handleTogglePolling(enabled: boolean) {
    if (!activeUrl || !token) return
    setSettingsLoading(true)
    try {
      const s = await updateSettings(activeUrl, token, { polling_enabled: enabled })
      setSettings(s)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to update setting', 'error')
    } finally {
      setSettingsLoading(false)
    }
  }

  function handleProbe() {
    setProbing(true)
    probe()
    setTimeout(() => setProbing(false), 2000)
  }

  async function handleDisconnect() {
    await clearConnection()
    reload()
    router.replace('/connect')
  }

  async function handleDeleteUrl(url: string) {
    const ok = await confirm({
      title: 'Remove server URL',
      message: `Remove "${url}" from the list?`,
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (!ok) return
    await removeServerUrl(url)
    await reload()
  }

  async function handleRevokeDevice(id: string, name: string) {
    const ok = await confirm({
      title: 'Revoke device',
      message: `Remove "${name || 'Unnamed device'}"? It will be disconnected immediately.`,
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return
    if (!activeUrl || !token) return
    setRevoking(prev => new Set(prev).add(id))
    try {
      await revokeDevice(activeUrl, token, id)
      await loadDevices(true)
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 401) {
        handleUnauthorized()
        return
      }
      toast(e instanceof Error ? e.message : 'Failed to revoke device', 'error')
    } finally {
      setRevoking(prev => { const s = new Set(prev); s.delete(id); return s })
    }
  }

  const dotColor = status === 'connected' ? theme.colors.online : status === 'disconnected' ? theme.colors.error : theme.colors.placeholder

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>

      {/* Connection status */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <Text style={s.cardTitle}>Server Connection</Text>
          <Pressable
            onPress={handleProbe}
            disabled={probing}
            style={({ pressed }) => [s.refreshBtn, pressed && s.refreshBtnPressed, probing && s.refreshBtnDisabled]}
          >
            {probing
              ? <ActivityIndicator size="small" color={theme.colors.accent} />
              : <Text style={s.refreshBtnText}>Test</Text>
            }
          </Pressable>
        </View>

        <View style={s.statusRow}>
          <View style={[s.dot, { backgroundColor: dotColor }]} />
          <Text style={[s.statusText, { color: dotColor }]}>
            {status === 'connected' ? 'Connected' : status === 'disconnected' ? 'Offline' : 'Checking…'}
          </Text>
        </View>

        {status === 'connected' && activeUrl ? (
          <Text style={s.connectionDetail}>
            Connected to <Text style={s.connectionUrl}>{activeUrl}</Text>
            {lastChecked ? ` — last checked ${formatTime(lastChecked)}` : ''}
          </Text>
        ) : status === 'disconnected' ? (
          <Text style={s.connectionDetail}>
            {serverUrls.length > 0
              ? `Trying ${serverUrls.map(hostname).join(', ')}${lastChecked ? ` — last connected ${formatTime(lastChecked)}` : ''}`
              : 'No server URLs configured'}
          </Text>
        ) : null}
      </View>

      {/* Server URLs */}
      {serverUrls.length > 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>Server URLs</Text>
          <Text style={s.cardSubtitle}>Tried in order until one responds</Text>
          {serverUrls.map((url, i) => {
            const isActive = url === activeUrl
            return (
              <View key={url} style={[s.urlRow, i < serverUrls.length - 1 && s.urlRowBorder]}>
                <View style={[s.urlDot, { backgroundColor: isActive ? theme.colors.online : theme.colors.border }]} />
                <View style={s.urlTextGroup}>
                  <Text style={[s.urlHost, isActive && s.urlHostActive]}>{hostname(url)}</Text>
                  <Text style={s.urlFull} numberOfLines={1}>{url}</Text>
                  {urlLastUsed[url] && (
                    <Text style={s.urlLastUsed}>Last used {formatRelative(urlLastUsed[url])}</Text>
                  )}
                </View>
                {isActive
                  ? <Text style={s.activeBadge}>active</Text>
                  : (
                    <Pressable
                      onPress={() => handleDeleteUrl(url)}
                      style={({ pressed }) => [s.deleteUrlBtn, pressed && s.deleteUrlBtnPressed]}
                    >
                      <Text style={s.deleteUrlText}>✕</Text>
                    </Pressable>
                  )
                }
              </View>
            )
          })}
        </View>
      )}

      {/* Server info */}
      {serverInfo?.server_version && (
        <View style={s.card}>
          <Text style={s.cardTitle}>Server Info</Text>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Version</Text>
            <Text style={s.infoValue}>{serverInfo.server_version}</Text>
          </View>
        </View>
      )}

      {/* Polling */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>Background Polling</Text>
            <Text style={s.cardSubtitle}>
              {settings?.polling_enabled === false
                ? 'Off — only manual job adding active'
                : 'On — feeds poll automatically on schedule'}
            </Text>
          </View>
          {settings === null
            ? <ActivityIndicator size="small" color={theme.colors.accent} />
            : <Switch
                value={settings.polling_enabled}
                onValueChange={handleTogglePolling}
                disabled={settingsLoading}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={theme.colors.background}
              />
          }
        </View>
      </View>

      {/* Devices */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <Text style={s.cardTitle}>Connected Devices</Text>
          {status === 'connected' && (
            devicesRefreshing
              ? <ActivityIndicator size="small" color={theme.colors.accent} />
              : <Pressable onPress={() => loadDevices()} style={({ pressed }) => [s.refreshBtn, pressed && s.refreshBtnPressed]}>
                  <Text style={s.refreshBtnText}>Refresh</Text>
                </Pressable>
          )}
        </View>
        {devicesLoading && devices.length === 0 ? (
          <ActivityIndicator color={theme.colors.accent} size="small" style={{ alignSelf: 'flex-start' }} />
        ) : devicesError ? (
          <Text style={s.errorText}>{devicesError}</Text>
        ) : devices.length === 0 ? (
          <Text style={s.emptyText}>{status === 'connected' ? 'No devices found' : 'Connect to see devices'}</Text>
        ) : (
          devices.map((d, i) => {
            const isCurrent = d.id === (currentDeviceId ?? deviceId)
            const isRevoking = revoking.has(d.id)
            return (
              <View key={d.id} style={[s.deviceRow, i < devices.length - 1 && s.deviceRowBorder]}>
                <View style={s.deviceMain}>
                  <View style={s.deviceNameRow}>
                    <Text style={[s.deviceName, isCurrent && s.deviceNameCurrent]}>
                      {d.name || 'Unnamed device'}
                    </Text>
                    {isCurrent && <Text style={s.currentBadge}>this device</Text>}
                  </View>
                  <Text style={s.deviceId} numberOfLines={1}>{d.id}</Text>
                  <Text style={s.deviceDate}>Paired {formatDate(d.created_at)}</Text>
                  {d.last_seen_at && (
                    <Text style={s.deviceLastSeen}>Last seen {formatRelative(d.last_seen_at)}</Text>
                  )}
                </View>
                {!isCurrent && (
                  <Pressable
                    onPress={() => handleRevokeDevice(d.id, d.name)}
                    disabled={isRevoking}
                    style={({ pressed }) => [s.revokeBtn, (pressed || isRevoking) && s.revokeBtnPressed]}
                  >
                    {isRevoking
                      ? <ActivityIndicator size="small" color={theme.colors.error} />
                      : <Text style={s.revokeBtnText}>Revoke</Text>
                    }
                  </Pressable>
                )}
              </View>
            )
          })
        )}
      </View>

      {/* Disconnect */}
      <View style={s.card}>
        <Text style={s.cardTitle}>This Device</Text>
        {deviceId && (
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Device ID</Text>
            <Text style={[s.infoValue, s.mono]} numberOfLines={1}>{deviceId}</Text>
          </View>
        )}
        <Pressable
          onPress={handleDisconnect}
          style={({ pressed }) => [s.disconnectBtn, pressed && s.disconnectBtnPressed]}
        >
          <Text style={s.disconnectText}>Disconnect this device</Text>
        </Pressable>
      </View>

    </ScrollView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    content: { padding: t.spacing.md, gap: t.spacing.md, paddingBottom: t.spacing.xl },
    card: {
      backgroundColor: t.colors.surface,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.colors.border,
      padding: t.spacing.md,
      gap: t.spacing.sm,
    },
    cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    cardTitle: { color: t.colors.text, fontSize: 15, fontWeight: '700' },
    cardSubtitle: { color: t.colors.muted, fontSize: 12, marginTop: -t.spacing.xs },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    dot: { width: 10, height: 10, borderRadius: 5 },
    statusText: { fontSize: 15, fontWeight: '600' },
    infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: t.spacing.sm },
    infoLabel: { color: t.colors.muted, fontSize: 13, flexShrink: 0 },
    infoValue: { color: t.colors.text, fontSize: 13, flexShrink: 1, textAlign: 'right' },
    mono: { fontFamily: 'monospace', fontSize: 11 },
    urlRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: t.spacing.sm, gap: t.spacing.sm },
    urlRowBorder: { borderBottomWidth: 1, borderBottomColor: t.colors.border },
    urlDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
    urlTextGroup: { flex: 1 },
    urlHost: { color: t.colors.muted, fontSize: 13, fontWeight: '500' },
    urlHostActive: { color: t.colors.text, fontWeight: '700' },
    urlFull: { color: t.colors.placeholder, fontSize: 11, fontFamily: 'monospace' },
    urlLastUsed: { color: t.colors.muted, fontSize: 11, marginTop: 1 },
    activeBadge: { color: t.colors.online, fontSize: 11, fontWeight: '700', flexShrink: 0 },
    connectionDetail: { color: t.colors.muted, fontSize: 12, lineHeight: 16 },
    connectionUrl: { color: t.colors.text, fontWeight: '600' },
    deleteUrlBtn: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: t.colors.error,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    deleteUrlBtnPressed: { opacity: 0.5 },
    deleteUrlText: { color: t.colors.error, fontSize: 12, fontWeight: '700', lineHeight: 14 },
    deviceRow: { paddingVertical: t.spacing.sm, flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    deviceRowBorder: { borderBottomWidth: 1, borderBottomColor: t.colors.border },
    deviceMain: { flex: 1, gap: 2 },
    deviceNameRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    deviceName: { color: t.colors.text, fontSize: 14, fontWeight: '600' },
    deviceNameCurrent: { color: t.colors.accent },
    currentBadge: { color: t.colors.accent, fontSize: 11, fontWeight: '700' },
    deviceId: { color: t.colors.placeholder, fontSize: 10, fontFamily: 'monospace' },
    deviceDate: { color: t.colors.muted, fontSize: 11 },
    deviceLastSeen: { color: t.colors.accent, fontSize: 11 },
    errorText: { color: t.colors.error, fontSize: 13 },
    emptyText: { color: t.colors.muted, fontSize: 13 },
    revokeBtn: {
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xs,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.error,
      minWidth: 60,
      alignItems: 'center',
    },
    revokeBtnPressed: { opacity: 0.6 },
    revokeBtnText: { color: t.colors.error, fontSize: 12, fontWeight: '600' },
    refreshBtn: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.xs,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.accent,
      minWidth: 52,
      alignItems: 'center',
    },
    refreshBtnPressed: { opacity: 0.7 },
    refreshBtnDisabled: { borderColor: t.colors.border },
    refreshBtnText: { color: t.colors.accent, fontSize: 13, fontWeight: '600' },
    disconnectBtn: {
      marginTop: t.spacing.xs,
      paddingVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.error,
      alignItems: 'center',
    },
    disconnectBtnPressed: { opacity: 0.7 },
    disconnectText: { color: t.colors.error, fontSize: 14, fontWeight: '600' },
  })
}
