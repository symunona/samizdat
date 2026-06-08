import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { fetchDevices } from '../../src/api'
import type { DeviceInfo } from '../../src/api'
import { clearConnection } from '../../src/storage'
import { useConnection } from '../../src/ConnectionContext'

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

export default function SettingsScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { status, activeUrl, serverUrls, token, deviceId, serverInfo, lastChecked, probe, reload } = useConnection()

  const [probing, setProbing] = useState(false)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null)
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesError, setDevicesError] = useState<string | null>(null)

  const loadDevices = useCallback(async () => {
    if (!activeUrl || !token) return
    setDevicesLoading(true)
    setDevicesError(null)
    try {
      const result = await fetchDevices(activeUrl, token)
      setDevices(result.devices)
      setCurrentDeviceId(result.current_device_id)
    } catch (e: unknown) {
      setDevicesError(e instanceof Error ? e.message : 'Failed to load devices')
    } finally {
      setDevicesLoading(false)
    }
  }, [activeUrl, token])

  useEffect(() => {
    if (status === 'connected') loadDevices()
  }, [status, loadDevices])

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

        {activeUrl && (
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Active URL</Text>
            <Text style={s.infoValue} numberOfLines={1}>{activeUrl}</Text>
          </View>
        )}

        {lastChecked && (
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Last checked</Text>
            <Text style={s.infoValue}>{formatTime(lastChecked)}</Text>
          </View>
        )}
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
                </View>
                {isActive && <Text style={s.activeBadge}>active</Text>}
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

      {/* Devices */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <Text style={s.cardTitle}>Connected Devices</Text>
          {status === 'connected' && (
            <Pressable onPress={loadDevices} style={({ pressed }) => [s.refreshBtn, pressed && s.refreshBtnPressed]}>
              <Text style={s.refreshBtnText}>Refresh</Text>
            </Pressable>
          )}
        </View>
        {devicesLoading ? (
          <ActivityIndicator color={theme.colors.accent} size="small" style={{ alignSelf: 'flex-start' }} />
        ) : devicesError ? (
          <Text style={s.errorText}>{devicesError}</Text>
        ) : devices.length === 0 ? (
          <Text style={s.emptyText}>{status === 'connected' ? 'No devices found' : 'Connect to see devices'}</Text>
        ) : (
          devices.map((d, i) => {
            const isCurrent = d.id === (currentDeviceId ?? deviceId)
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
                </View>
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
    activeBadge: { color: t.colors.online, fontSize: 11, fontWeight: '700', flexShrink: 0 },
    deviceRow: { paddingVertical: t.spacing.sm },
    deviceRowBorder: { borderBottomWidth: 1, borderBottomColor: t.colors.border },
    deviceMain: { gap: 2 },
    deviceNameRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    deviceName: { color: t.colors.text, fontSize: 14, fontWeight: '600' },
    deviceNameCurrent: { color: t.colors.accent },
    currentBadge: { color: t.colors.accent, fontSize: 11, fontWeight: '700' },
    deviceId: { color: t.colors.placeholder, fontSize: 10, fontFamily: 'monospace' },
    deviceDate: { color: t.colors.muted, fontSize: 11 },
    errorText: { color: t.colors.error, fontSize: 13 },
    emptyText: { color: t.colors.muted, fontSize: 13 },
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
