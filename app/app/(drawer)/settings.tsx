import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { fetchDevices, revokeDevice, fetchSettings, updateSettings, updateDeviceName, mintExtensionToken, fetchLatestAndroidBuild, androidApkUrl, ApiError } from '../../src/api'
import type { DeviceInfo, AppSettings, AndroidBuild } from '../../src/api'
import { APP_VERSION, APP_VERSION_CODE } from '../../src/appVersion'
import { fetchYtdlpProxyStatus } from '../../src/proxyStatus'
import type { YtdlpProxyStatus } from '../../src/proxyStatus'
import { clearConnection, removeServerUrl, loadUrlLastUsedMap } from '../../src/storage'
import { useConnection } from '../../src/ConnectionContext'
import { useConfirm } from '../../src/ConfirmContext'
import { useToast } from '../../src/ToastContext'
import { useSyncStore } from '../../src/store/syncStore'

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
  const [proxyStatus, setProxyStatus] = useState<YtdlpProxyStatus | null>(null)
  const [proxyChecking, setProxyChecking] = useState(false)
  const [deviceNameInput, setDeviceNameInput] = useState('')
  const [deviceNameSaving, setDeviceNameSaving] = useState(false)
  const [deviceNameSaved, setDeviceNameSaved] = useState(false)
  const deviceNameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deviceNameInitialized = useRef(false)
  const isWeb = Platform.OS === 'web'
  const [extStatus, setExtStatus] = useState<'not_installed' | 'unpaired' | 'connected'>('not_installed')
  const [extConnecting, setExtConnecting] = useState(false)
  const [latestBuild, setLatestBuild] = useState<AndroidBuild | null>(null)
  const [checkingVersion, setCheckingVersion] = useState(false)

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

  const loadProxyStatus = useCallback(async () => {
    if (!activeUrl || !token) return
    setProxyChecking(true)
    try {
      setProxyStatus(await fetchYtdlpProxyStatus(activeUrl, token))
    } catch { /* best-effort; keep prior status */ } finally {
      setProxyChecking(false)
    }
  }, [activeUrl, token])

  useEffect(() => {
    loadUrlLastUsedMap().then(setUrlLastUsed)
  }, [])

  // Auto-recheck the proxy on connect + poll every 20s so it flips to green
  // automatically when the proxy host (e.g. fiona) comes back online.
  useEffect(() => {
    if (status !== 'connected') return
    loadProxyStatus()
    const id = setInterval(loadProxyStatus, 20000)
    return () => clearInterval(id)
  }, [status, loadProxyStatus])

  const loadLatestBuild = useCallback(async () => {
    if (!activeUrl || !token) return
    try {
      setLatestBuild(await fetchLatestAndroidBuild(activeUrl, token))
    } catch { /* best-effort; no APK hosted or offline */ }
  }, [activeUrl, token])

  // Tap the installed-version row to check for a newer hosted build on demand.
  const handleCheckVersion = useCallback(async () => {
    if (checkingVersion) return
    if (!activeUrl || !token) { toast('Connect to check for updates', 'info'); return }
    setCheckingVersion(true)
    try {
      const b = await fetchLatestAndroidBuild(activeUrl, token)
      setLatestBuild(b)
      if (b && b.version_code > APP_VERSION_CODE) toast(`Update available — v${b.version}`, 'info')
      else toast('Up to date', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Version check failed', 'error')
    } finally {
      setCheckingVersion(false)
    }
  }, [activeUrl, token, checkingVersion, toast])

  useEffect(() => {
    if (status === 'connected') {
      loadDevices()
      loadSettings()
      loadLatestBuild()
      loadUrlLastUsedMap().then(setUrlLastUsed)
    }
  }, [status, loadDevices, loadSettings, loadLatestBuild])

  // Extension install/pair status comes from a data-attr the content script
  // injects on this page (web only). Poll it and react to the pair ack.
  useEffect(() => {
    if (!isWeb) return
    const read = () => {
      const m = (document?.documentElement?.dataset as { samExt?: string })?.samExt
      setExtStatus(!m ? 'not_installed' : m.endsWith(':paired') ? 'connected' : 'unpaired')
    }
    read()
    const id = setInterval(read, 1500)
    const onMsg = (e: MessageEvent) => {
      if ((e?.data as { type?: string })?.type === 'samizdat-extension-paired') read()
    }
    window.addEventListener('message', onMsg)
    return () => { clearInterval(id); window.removeEventListener('message', onMsg) }
  }, [isWeb])

  useEffect(() => {
    if (serverInfo?.name && !deviceNameInitialized.current) {
      deviceNameInitialized.current = true
      setDeviceNameInput(serverInfo.name)
    }
  }, [serverInfo?.name])

  function handleDeviceNameChange(val: string) {
    setDeviceNameInput(val)
    setDeviceNameSaved(false)
    if (deviceNameTimer.current) clearTimeout(deviceNameTimer.current)
    deviceNameTimer.current = setTimeout(async () => {
      if (!activeUrl || !token || !val.trim()) return
      setDeviceNameSaving(true)
      try {
        await updateDeviceName(activeUrl, token, val.trim())
        setDeviceNameSaved(true)
        setTimeout(() => setDeviceNameSaved(false), 2000)
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Failed to update device name', 'error')
      } finally {
        setDeviceNameSaving(false)
      }
    }, 800)
  }

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

  const clearStore = useSyncStore((state) => state.clearStore)

  async function handleClearLocalCache() {
    const ok = await confirm({
      title: 'Clear local cache',
      message: 'Removes all locally cached documents, highlights, annotations, and tags. Data stays on the server. Next sync will re-download everything.',
      confirmLabel: 'Clear cache',
      destructive: true,
    })
    if (!ok) return
    clearStore()
    toast('Local cache cleared. Syncing from server…', 'success')
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

  function handleInstallExtension() {
    if (activeUrl) Linking.openURL(`${activeUrl}/extension/sam-chrome.zip`)
  }

  function handleDownloadApk() {
    if (activeUrl) Linking.openURL(androidApkUrl(activeUrl))
  }

  async function handleConnectExtension() {
    if (!activeUrl || !token) return
    setExtConnecting(true)
    try {
      const { device_token } = await mintExtensionToken(activeUrl, token)
      // Content script (isolated world, same origin) receives this and stores it.
      window.postMessage({ type: 'samizdat-extension-token', token: device_token }, window.location.origin)
      toast('Connecting extension…', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to connect extension', 'error')
    } finally {
      setTimeout(() => setExtConnecting(false), 1200)
    }
  }

  const dotColor = status === 'connected' ? theme.colors.online : status === 'disconnected' ? theme.colors.error : theme.colors.placeholder
  const extDotColor = extStatus === 'connected' ? theme.colors.online : extStatus === 'unpaired' ? theme.colors.accent : theme.colors.placeholder

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

      {/* App version + Android APK */}
      <View style={s.card}>
        <Text style={s.cardTitle}>App Version</Text>
        <Pressable
          onPress={handleCheckVersion}
          style={({ pressed }) => [s.infoRow, pressed && { opacity: 0.6 }]}
          hitSlop={6}
        >
          <Text style={s.infoLabel}>Installed{'  '}<Text style={{ color: theme.colors.muted, fontSize: 12 }}>(tap to check)</Text></Text>
          {checkingVersion
            ? <ActivityIndicator size="small" color={theme.colors.accent} />
            : <Text style={s.infoValue}>v{APP_VERSION}</Text>}
        </Pressable>
        {latestBuild && latestBuild.version_code > APP_VERSION_CODE ? (
          <>
            <View style={s.statusRow}>
              <View style={[s.dot, { backgroundColor: theme.colors.accent }]} />
              <Text style={[s.statusText, { fontSize: 14, color: theme.colors.accent }]}>
                Update available — v{latestBuild.version}
              </Text>
            </View>
            <Pressable
              onPress={handleDownloadApk}
              style={({ pressed }) => [s.disconnectBtn, { borderColor: theme.colors.accent }, pressed && s.disconnectBtnPressed]}
            >
              <Text style={[s.disconnectText, { color: theme.colors.accent }]}>Download update (.apk)</Text>
            </Pressable>
          </>
        ) : isWeb && latestBuild ? (
          // Desktop web: no update to force, but offer the APK for sideloading to a phone.
          <Pressable
            onPress={handleDownloadApk}
            style={({ pressed }) => [s.disconnectBtn, { borderColor: theme.colors.accent }, pressed && s.disconnectBtnPressed]}
          >
            <Text style={[s.disconnectText, { color: theme.colors.accent }]}>Download Android app (v{latestBuild.version})</Text>
          </Pressable>
        ) : latestBuild ? (
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: theme.colors.online }]} />
            <Text style={[s.statusText, { fontSize: 14, color: theme.colors.online }]}>Up to date</Text>
          </View>
        ) : null}
      </View>

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

      {/* YouTube proxy */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>YouTube Proxy</Text>
            <Text style={s.cardSubtitle}>yt-dlp routes through this for video ingestion</Text>
          </View>
          {proxyChecking
            ? <ActivityIndicator size="small" color={theme.colors.accent} />
            : <Pressable onPress={loadProxyStatus} style={({ pressed }) => [s.refreshBtn, pressed && s.refreshBtnPressed]}>
                <Text style={s.refreshBtnText}>Recheck</Text>
              </Pressable>
          }
        </View>

        {proxyStatus === null ? (
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: theme.colors.placeholder }]} />
            <Text style={[s.statusText, { color: theme.colors.placeholder }]}>Checking…</Text>
          </View>
        ) : !proxyStatus.configured ? (
          <Text style={s.connectionDetail}>
            No proxy configured — yt-dlp connects directly (datacenter IPs are usually blocked). See docs/youtube-ingest.md
          </Text>
        ) : (
          <>
            <View style={s.statusRow}>
              <View style={[s.dot, { backgroundColor: proxyChecking ? theme.colors.placeholder : proxyStatus.ok ? theme.colors.online : theme.colors.error }]} />
              <Text style={[s.statusText, { color: proxyChecking ? theme.colors.placeholder : proxyStatus.ok ? theme.colors.online : theme.colors.error }]}>
                {proxyChecking ? 'Checking…' : proxyStatus.ok ? `Online — exit IP ${proxyStatus.exit_ip}` : 'Offline'}
              </Text>
            </View>
            <Text style={s.connectionDetail} numberOfLines={2}>
              <Text style={s.connectionUrl}>{proxyStatus.proxy}</Text>
              {proxyStatus.last_ok_at ? ` — last online ${formatRelative(proxyStatus.last_ok_at)}` : ' — never online'}
            </Text>
            {!proxyStatus.ok && proxyStatus.error ? (
              <Text style={s.errorText} numberOfLines={3}>{proxyStatus.error}</Text>
            ) : null}
          </>
        )}
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

      {/* Browser Extension (web only) */}
      {isWeb && (
        <View style={s.card}>
          <Text style={s.cardTitle}>Browser Extension</Text>
          <Text style={s.cardSubtitle}>“Save to Sam” — save the current page from your Chrome toolbar</Text>
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: extDotColor }]} />
            <Text style={[s.statusText, { fontSize: 14, color: extDotColor }]}>
              {extStatus === 'connected' ? 'Installed & connected' : extStatus === 'unpaired' ? 'Installed — not connected' : 'Not installed'}
            </Text>
          </View>

          {extStatus === 'unpaired' && (
            <Pressable
              onPress={handleConnectExtension}
              disabled={extConnecting}
              style={({ pressed }) => [s.refreshBtn, { alignSelf: 'flex-start' }, pressed && s.refreshBtnPressed, extConnecting && s.refreshBtnDisabled]}
            >
              {extConnecting
                ? <ActivityIndicator size="small" color={theme.colors.accent} />
                : <Text style={s.refreshBtnText}>Connect extension</Text>}
            </Pressable>
          )}

          {extStatus !== 'connected' && (
            <>
              <Pressable
                onPress={handleInstallExtension}
                style={({ pressed }) => [s.disconnectBtn, { borderColor: theme.colors.accent }, pressed && s.disconnectBtnPressed]}
              >
                <Text style={[s.disconnectText, { color: theme.colors.accent }]}>Download extension (.zip)</Text>
              </Pressable>
              <Text style={s.extSteps}>
                1. Unzip the download.{'\n'}
                2. Open chrome://extensions and turn on Developer mode.{'\n'}
                3. “Load unpacked” → select the unzipped folder.{'\n'}
                4. Come back here and click “Connect extension”.
              </Text>
            </>
          )}
        </View>
      )}

      {/* This Device */}
      <View style={s.card}>
        <Text style={s.cardTitle}>This Device</Text>
        <View style={s.thisDeviceNameRow}>
          <Text style={s.infoLabel}>Device name</Text>
          <View style={s.deviceNameField}>
            <TextInput
              style={s.deviceNameInput}
              value={deviceNameInput}
              onChangeText={handleDeviceNameChange}
              placeholder="My device"
              placeholderTextColor={theme.colors.placeholder}
              autoCorrect={false}
              autoCapitalize="none"
            />
            {deviceNameSaving && <ActivityIndicator size="small" color={theme.colors.accent} style={s.deviceNameIndicator} />}
            {deviceNameSaved && <Text style={s.deviceNameSaved}>✓</Text>}
          </View>
        </View>
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

      {/* LLM Usage */}
      {settings?.llm_usage && (
        <View style={s.card}>
          <Text style={s.cardTitle}>LLM API Usage</Text>
          <Text style={s.cardSubtitle}>Cumulative — never reset</Text>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Total calls</Text>
            <Text style={s.infoValue}>{settings.llm_usage.total_calls.toLocaleString()}</Text>
          </View>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Input tokens</Text>
            <Text style={s.infoValue}>{settings.llm_usage.total_input_tokens.toLocaleString()}</Text>
          </View>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Output tokens</Text>
            <Text style={s.infoValue}>{settings.llm_usage.total_output_tokens.toLocaleString()}</Text>
          </View>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Est. cost</Text>
            <Text style={[s.infoValue, s.llmCostValue]}>
              ${settings.llm_usage.total_cost_usd.toFixed(4)}
            </Text>
          </View>
        </View>
      )}

      {/* Local data */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Local Data</Text>
        <Text style={s.cardSubtitle}>Cached on this device — server copy untouched</Text>
        <Pressable
          onPress={() => router.push('/offline-cache')}
          style={({ pressed }) => [s.navRow, pressed && s.navRowPressed]}
        >
          <Ionicons name="cloud-offline-outline" size={18} color={theme.colors.accent} />
          <Text style={s.navRowText}>Offline cache</Text>
          <Ionicons name="chevron-forward" size={18} color={theme.colors.muted} />
        </Pressable>
        <Pressable
          onPress={handleClearLocalCache}
          style={({ pressed }) => [s.disconnectBtn, pressed && s.disconnectBtnPressed]}
        >
          <Text style={s.disconnectText}>Clear local cache</Text>
        </Pressable>
      </View>

    </ScrollView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    content: { padding: t.spacing.md, gap: t.spacing.md, paddingBottom: t.spacing.xl, maxWidth: 800, alignSelf: 'center', width: '100%' },
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
    thisDeviceNameRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    deviceNameField: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
    deviceNameInput: {
      flex: 1,
      backgroundColor: t.colors.background,
      color: t.colors.text,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: 6,
      fontSize: 14,
    },
    deviceNameIndicator: { marginLeft: 4 },
    deviceNameSaved: { color: t.colors.online, fontSize: 14, fontWeight: '700', marginLeft: 4 },
    llmCostValue: { color: t.colors.accent, fontWeight: '700' },
    extSteps: { color: t.colors.muted, fontSize: 12, lineHeight: 18, marginTop: t.spacing.xs },
    navRow: {
      flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
      paddingVertical: t.spacing.sm, paddingHorizontal: t.spacing.sm,
      borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.colors.border,
      backgroundColor: t.colors.background,
    },
    navRowPressed: { opacity: 0.7 },
    navRowText: { flex: 1, color: t.colors.text, fontSize: 14, fontWeight: '600' },
  })
}
