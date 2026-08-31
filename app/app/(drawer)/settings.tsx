import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { fetchDevices, revokeDevice, fetchSettings, updateSettings, updateDeviceName, mintExtensionToken, androidApkUrl, ApiError } from '../../src/api'
import type { DeviceInfo, AppSettings, LanguagePrefs, ContextMenuPrefs } from '../../src/api'
import ContextMenuEditor from '../../src/ContextMenuEditor'
import { cacheContextMenu, defaultContextMenu, normalizeContextMenu } from '../../src/contextMenu'
import { displayLang, parseLangInput } from '../../src/langNames'
import { APP_VERSION, APP_VERSION_CODE, isUpdateAvailable } from '../../src/appVersion'
import { useLatestBuild } from '../../src/useUpdate'
import { useProxyStatus, useExportStats, useLLMStatus } from '../../src/useServices'
import { proxyLabel, type YtdlpProxyEntry } from '../../src/proxyStatus'
import { llmErrorLabel, llmProviderLabel } from '../../src/llmStatus'
import type { LLMProvider } from '../../src/llmStatus'
import { probeLLMProviders, probeSummary } from '../../src/llmModels'
import type { LLMProbeResult } from '../../src/llmModels'
import Accordion from '../../src/Accordion'
import { clearConnection, removeServerUrl } from '../../src/storage'
import { loadUrlLastUsedMap } from '../../src/prefs'
import { useConnection } from '../../src/ConnectionContext'
import { useConfirm } from '../../src/ConfirmContext'
import { useToast } from '../../src/ToastContext'
import * as db from '../../src/db'
import { usePersistHealth } from '../../src/store/persistHealth'
import { useDebugLogStore } from '../../src/store/debugLogStore'
import { useReadingModeStore } from '../../src/store/readingModeStore'

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

// browserLangs derives base language codes from the platform locale (navigator on
// web/RN-Web; empty on native, where the user seeds the list manually).
function browserLangs(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav: any = (globalThis as any).navigator
    const list: string[] = nav?.languages || (nav?.language ? [nav.language] : [])
    const base = list.map((l) => String(l).toLowerCase().split(/[-_]/)[0]).filter(Boolean)
    return [...new Set(base)]
  } catch { return [] }
}

// addLang parses a typed name-or-code and appends its base code to a list (no
// dups); returns the same reference unchanged when nothing was added.
function addLang(list: string[], raw: string): string[] {
  const l = parseLangInput(raw)
  if (!l || list.includes(l)) return list
  return [...list, l]
}

export default function SettingsScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { status, activeUrl, serverUrls, token, deviceId, serverInfo, lastChecked, probe, reload, logout } = useConnection()

  const { toast } = useToast()
  const { confirm } = useConfirm()
  const debugLogEnabled = useDebugLogStore((st) => st.enabled)
  const setDebugLogEnabled = useDebugLogStore((st) => st.setEnabled)
  // One reading preference, shared with the document viewer's Flow/Auto/Page control.
  const readingMode = useReadingModeStore((st) => st.mode)
  const pageThreshold = useReadingModeStore((st) => st.threshold)
  const setReadingMode = useReadingModeStore((st) => st.setMode)
  const setPageThreshold = useReadingModeStore((st) => st.setThreshold)
  const hydrateReadingMode = useReadingModeStore((st) => st.hydrate)
  const [thresholdInput, setThresholdInput] = useState(String(pageThreshold))

  const [probing, setProbing] = useState(false)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null)
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesRefreshing, setDevicesRefreshing] = useState(false)
  const [devicesError, setDevicesError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<Set<string>>(new Set())
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [langSaving, setLangSaving] = useState(false)
  const [langInput, setLangInput] = useState('')
  const langSeededRef = useRef(false)
  const [urlLastUsed, setUrlLastUsed] = useState<Record<string, string>>({})
  // Service health (proxy / export / LLM) is one shared React Query cache — the
  // drawer's degraded dot reads the same data (src/useServices.ts).
  const { data: proxyStatus, refetch: refetchProxy, isFetching: proxyFetching } = useProxyStatus()
  const { data: exportStats, refetch: refetchExport, isFetching: exportFetching } = useExportStats()
  const { data: llmStatus, refetch: refetchLLM } = useLLMStatus()
  // The one client-side service: the local database's write path (src/store/persistHealth.ts).
  const persistFailure = usePersistHealth((st) => st.failure)
  // The LLM card is passive by default (status = the last real call's outcome, see
  // server/CLAUDE.md), which also makes the dot STICKY: nothing but a real call
  // can clear one that went red on a blip. This is the one place that ACTIVELY
  // asks, and it asks deep — a real 1-token completion per provider — so the tap
  // both reports and repairs. On a tap, never on a render: that is what makes
  // spending a token from a screen honest.
  const [llmProbing, setLlmProbing] = useState(false)
  const [llmProbe, setLlmProbe] = useState<LLMProbeResult[] | null>(null)
  const [llmProbeError, setLlmProbeError] = useState<string | null>(null)
  const [proxyRechecking, setProxyRechecking] = useState(false)
  // Only flash "Checking…" on first load, on an explicit recheck, or while the
  // last known status was broken. A healthy background poll stays green instead
  // of blinking the dot to grey every interval.
  const proxyChecking = !proxyStatus || proxyRechecking || (proxyFetching && !proxyStatus.ok)
  const proxyOnlineCount = proxyStatus?.proxies.filter((p) => p.ok).length ?? 0
  const ytdlpVersion = proxyStatus?.ytdlp
  // Distinct EXIT IPs, not entries: that is how many addresses YouTube can ban.
  const proxyExitIPCount = new Set((proxyStatus?.proxies ?? []).filter((p) => p.ok && p.exit_ip).map((p) => p.exit_ip)).size
  const [deviceNameInput, setDeviceNameInput] = useState('')
  const [deviceNameSaving, setDeviceNameSaving] = useState(false)
  const [deviceNameSaved, setDeviceNameSaved] = useState(false)
  const deviceNameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deviceNameInitialized = useRef(false)
  const isWeb = Platform.OS === 'web'
  const [extStatus, setExtStatus] = useState<'not_installed' | 'unpaired' | 'connected'>('not_installed')
  const [extConnecting, setExtConnecting] = useState(false)
  // Shared with the drawer badge (one React Query, no double-fetch).
  const { data: latestBuild, refetch: refetchBuild, isFetching: checkingVersion } = useLatestBuild()

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

  const handleRecheckProxy = useCallback(async () => {
    setProxyRechecking(true)
    try { await refetchProxy() } finally { setProxyRechecking(false) }
  }, [refetchProxy])

  useEffect(() => {
    loadUrlLastUsedMap().then(setUrlLastUsed)
  }, [])

  useEffect(() => { void hydrateReadingMode() }, [hydrateReadingMode])
  // Follow the store (hydration, or the reader's own control) — not the keystrokes,
  // which only land here once they parse (see handleThresholdChange).
  useEffect(() => { setThresholdInput(String(pageThreshold)) }, [pageThreshold])

  // Tap the installed-version row to check for a newer hosted build on demand.
  const handleCheckVersion = useCallback(async () => {
    if (checkingVersion) return
    if (!activeUrl || !token) { toast('Connect to check for updates', 'info'); return }
    try {
      const { data: b } = await refetchBuild()
      if (b && isUpdateAvailable(b)) toast(`Update available — v${b.version} (build ${b.version_code})`, 'info')
      else toast('Up to date', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Version check failed', 'error')
    }
  }, [activeUrl, token, checkingVersion, toast, refetchBuild])

  useEffect(() => {
    if (status === 'connected') {
      loadDevices()
      loadSettings()
      loadUrlLastUsedMap().then(setUrlLastUsed)
    }
  }, [status, loadDevices, loadSettings])

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

  // Digits only while typing, committed on blur/submit — a half-typed "2" on its way
  // to "200" must not become the setting, and junk must restore the last good value
  // rather than leave the reader on a threshold that resolves to nothing.
  const handleThresholdChange = useCallback((raw: string) => {
    setThresholdInput(raw.replace(/[^0-9]/g, '').slice(0, 3))
  }, [])

  const handleThresholdCommit = useCallback(() => {
    const n = Number(thresholdInput)
    if (thresholdInput && n > 0) setPageThreshold(n)
    else setThresholdInput(String(pageThreshold))
  }, [thresholdInput, pageThreshold, setPageThreshold])

  // One patch path for every server-side boolean preference — the endpoint merges
  // only the keys present, so a partial patch is the whole update.
  const patchSetting = useCallback(async (patch: Partial<AppSettings>) => {
    if (!activeUrl || !token) return
    setSettingsLoading(true)
    try {
      setSettings(await updateSettings(activeUrl, token, patch))
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to update setting', 'error')
    } finally {
      setSettingsLoading(false)
    }
  }, [activeUrl, token, toast])

  const handleTogglePolling = useCallback((enabled: boolean) => patchSetting({ polling_enabled: enabled }), [patchSetting])
  const handleToggleAutoArchive = useCallback((enabled: boolean) => patchSetting({ auto_archive_enabled: enabled }), [patchSetting])

  const saveLangPrefs = useCallback(async (next: LanguagePrefs) => {
    if (!activeUrl || !token) return
    setLangSaving(true)
    setSettings((prev) => (prev ? { ...prev, language_prefs: next } : prev)) // optimistic
    try {
      const r = await updateSettings(activeUrl, token, { language_prefs: next })
      setSettings(r)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to update languages', 'error')
      loadSettings()
    } finally {
      setLangSaving(false)
    }
  }, [activeUrl, token, toast, loadSettings])

  // The selection context menu (the reader's "···"). Server-held so it is the same
  // on every device; the replica cache is refreshed here too, or an edit made on
  // the desktop would not reach a phone that is offline next time it selects text.
  const saveContextMenu = useCallback(async (next: ContextMenuPrefs) => {
    if (!activeUrl || !token) return
    setSettings((prev) => (prev ? { ...prev, context_menu: next } : prev)) // optimistic
    try {
      const r = await updateSettings(activeUrl, token, { context_menu: next })
      setSettings(r)
      await cacheContextMenu(r.context_menu ?? next)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to update context menu', 'error')
      loadSettings()
    }
  }, [activeUrl, token, toast, loadSettings])

  // Seed the preserved-language list from the platform locale the first time we
  // see an empty policy, so a fresh install defaults to "keep the languages I
  // read in their original language".
  useEffect(() => {
    if (!settings || langSeededRef.current) return
    langSeededRef.current = true
    const lp = settings.language_prefs
    if (lp && (lp.preserved_langs ?? []).length === 0) {
      const seed = browserLangs()
      if (seed.length) saveLangPrefs({ preserved_langs: seed })
    }
  }, [settings, saveLangPrefs])

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

  async function handleClearLocalCache() {
    const ok = await confirm({
      title: 'Clear local cache',
      message: 'Removes all locally cached documents, highlights, annotations, and tags. Data stays on the server. Next sync will re-download everything.',
      confirmLabel: 'Clear cache',
      destructive: true,
    })
    if (!ok) return
    await db.wipe()
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

  // A broken routing-chain provider leads the list AND is what the collapsed card
  // says — that is the row you have to act on. Otherwise the primary leads: the
  // one thing worth knowing without opening the card is where jobs go by default.
  const llmProviders = useMemo(() => {
    const rank = (p: LLMProvider) => {
      const routed = p.role === 'primary' || p.role === 'fallback'
      if (routed && p.status === 'error') return 0
      if (p.role === 'primary') return 1
      if (p.role === 'fallback') return 2
      if (p.role === 'retired') return 4
      return 3
    }
    return [...(llmStatus?.providers ?? [])].sort((a, b) => rank(a) - rank(b))
  }, [llmStatus])
  const llmLead = llmProviders[0]

  // A pre-context-menu server answers without the key; the editor still needs a
  // menu to render, and the defaults are what that server will store on first save.
  const contextMenu = useMemo(
    () => (settings?.context_menu ? normalizeContextMenu(settings.context_menu) : defaultContextMenu()),
    [settings],
  )

  const dotColor = status === 'connected' ? theme.colors.online : status === 'disconnected' ? theme.colors.error : theme.colors.placeholder
  const extDotColor = extStatus === 'connected' ? theme.colors.online : extStatus === 'unpaired' ? theme.colors.accent : theme.colors.placeholder

  // Editor for the single "keep original" language list: chips of friendly names
  // plus a name-or-code add field.
  const renderLangEditor = () => {
    const lp = settings?.language_prefs
    if (!lp) return null
    const list = lp.preserved_langs ?? []
    const commit = () => {
      const next = addLang(list, langInput)
      setLangInput('')
      if (next !== list) saveLangPrefs({ preserved_langs: next })
    }
    return (
      <>
        <View style={s.langChips}>
          {list.map((l) => (
            <View key={l} style={s.langChip}>
              <Text style={s.langChipText}>{displayLang(l)}</Text>
              <Pressable onPress={() => saveLangPrefs({ preserved_langs: list.filter((x) => x !== l) })} hitSlop={6}>
                <Ionicons name="close" size={13} color={theme.colors.muted} />
              </Pressable>
            </View>
          ))}
          {list.length === 0 ? <Text style={s.langEmpty}>none — every video will be translated to English</Text> : null}
        </View>
        <View style={s.langAddRow}>
          <TextInput
            value={langInput}
            onChangeText={setLangInput}
            placeholder="add a language…"
            placeholderTextColor={theme.colors.muted}
            style={s.langInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={commit}
          />
          <Pressable onPress={commit} style={({ pressed }) => [s.refreshBtn, pressed && s.refreshBtnPressed]}>
            <Text style={s.refreshBtnText}>Add</Text>
          </Pressable>
        </View>
      </>
    )
  }

  async function handleProbeLLM() {
    if (!activeUrl || !token || llmProbing) return
    setLlmProbing(true)
    setLlmProbeError(null)
    try {
      setLlmProbe(await probeLLMProviders(activeUrl, token, true))
      // The ping went through the normal client, so the server's health rows are
      // now newer than the ones this screen is painted from — refetch or the dot
      // keeps the colour the check just disproved.
      await refetchLLM()
    } catch (e) {
      setLlmProbeError(e instanceof Error ? e.message : 'Check failed')
    } finally {
      setLlmProbing(false)
    }
  }

  // Spend is keyed by provider NAME (all llm_usages records), so every
  // openai_compat row would otherwise claim the same calls — including a
  // discovered box nothing has ever routed to. Only a row that is (or was) in the
  // routing chain can own that history.
  const providerUsage = (p: LLMProvider) =>
    p.role === 'available' ? undefined : llmStatus?.usage.find((u) => u.provider === p.provider)

  const providerColor = (p: LLMProvider) =>
    p.status === 'ok' ? theme.colors.online : p.status === 'error' ? theme.colors.error : theme.colors.placeholder

  // The one line a row (and the collapsed card's summary) says about a provider.
  const providerStatusText = (p: LLMProvider) =>
    p.status === 'error'
      ? llmErrorLabel(p)
      : p.status === 'ok'
        ? `Working${p.last_ok_at ? ` — last call ${formatRelative(p.last_ok_at)}` : ''}`
        : !p.has_key
          ? 'No API key configured'
          // Health tracking started later than the usage log, so a provider
          // with spend but no recorded outcome is "unknown", not "unused".
          : providerUsage(p)?.last_call_at
            ? `No status yet — last call ${formatRelative(providerUsage(p)!.last_call_at!)}`
            : 'No calls yet'

  // One row per configured LLM endpoint: what it is, whether the LAST real call
  // worked, and what went wrong if it didn't. Nothing here probes — a health-check
  // completion would cost money on every render; the Check button is the one path
  // that asks.
  const renderLLMProvider = (p: LLMProvider, last: boolean) => {
    const color = providerColor(p)
    const usage = providerUsage(p)
    const probe = llmProbe?.find((r) => r.id === p.id)
    return (
      <View key={p.key} style={[s.providerRow, !last && s.providerRowBorder]}>
        <View style={s.providerHeadRow}>
          <View style={[s.dot, { backgroundColor: color }]} />
          <Text style={s.providerName} numberOfLines={1}>{llmProviderLabel(p)}</Text>
          <Text style={s.providerRole}>{p.role}</Text>
          {p.model ? <Text style={s.providerModel} numberOfLines={1}>{p.model}</Text> : null}
        </View>
        <Text style={[s.providerStatus, { color }]}>{providerStatusText(p)}</Text>
        {p.status === 'error' && p.last_error ? (
          <Text style={s.providerError} numberOfLines={3}>{p.last_error}</Text>
        ) : null}
        {probe ? (
          <Text style={[s.providerProbe, !probe.reachable && { color: theme.colors.error }]} numberOfLines={2}>
            {`Checked: ${probeSummary(probe)}${probe.latency_ms ? ` · ${probe.latency_ms}ms` : ''}`}
          </Text>
        ) : null}
        {p.calls > 0 || usage ? (
          <Text style={s.providerUsage}>
            {/* Routing is per ENDPOINT (health registry); spend is per provider name
                (all the usage log records), so a local box shows its share and no cost. */}
            {p.calls > 0 ? (
              <>
                {p.calls.toLocaleString()} calls · <Text style={s.providerShare}>{Math.round(p.routed_share * 100)}% routed here</Text>
                {usage && usage.cost_usd > 0 ? ` · $${usage.cost_usd.toFixed(4)} spent on ${p.provider}` : ''}
              </>
            ) : (
              `${usage!.calls.toLocaleString()} calls before health tracking · $${usage!.cost_usd.toFixed(4)}`
            )}
          </Text>
        ) : null}
      </View>
    )
  }

  // Exit IPs shared by more than one node. Two boxes in the same household come
  // out of one public address, so they are availability backups, not a second
  // egress — failing over to one after YouTube blocks the other buys nothing,
  // and the card has to say so.
  const sharedExitIPs = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of proxyStatus?.proxies ?? []) {
      if (p.exit_ip) counts.set(p.exit_ip, (counts.get(p.exit_ip) ?? 0) + 1)
    }
    return new Set([...counts].filter(([, n]) => n > 1).map(([ip]) => ip))
  }, [proxyStatus])

  // The card's headline, rendered BOTH as the collapsed summary and at the top of
  // the open body — collapsing must never hide the fact worth a glance, and a
  // stale binary is exactly that (it breaks every ingest on every node), so it
  // gets a one-liner here as well as the full warning box inside.
  const proxySummary = !proxyStatus ? (
    <View style={s.statusRow}>
      <View style={[s.dot, { backgroundColor: theme.colors.placeholder }]} />
      <Text style={[s.statusText, { color: theme.colors.placeholder }]}>Checking…</Text>
    </View>
  ) : !proxyStatus.configured ? (
    <Text style={s.connectionDetail}>
      No proxy configured — yt-dlp connects directly (datacenter IPs are usually blocked). Set [ytdlp].proxies; see docs/youtube-ingest.md
    </Text>
  ) : (
    <>
      <View style={s.statusRow}>
        <View style={[s.dot, { backgroundColor: proxyChecking ? theme.colors.placeholder : proxyStatus.ok ? theme.colors.online : theme.colors.error }]} />
        <Text style={[s.statusText, { color: proxyChecking ? theme.colors.placeholder : proxyStatus.ok ? theme.colors.online : theme.colors.error }]}>
          {proxyChecking
            ? 'Checking…'
            : proxyStatus.ok
              ? `${proxyLabel(proxyStatus.proxy)} — exit IP ${proxyStatus.exit_ip}`
              : 'No proxy reachable — video ingest will hit the bot wall'}
        </Text>
      </View>
      <Text style={s.connectionDetail}>
        {`${proxyOnlineCount} of ${proxyStatus.proxies.length} online · ${proxyExitIPCount} distinct exit ${proxyExitIPCount === 1 ? 'IP' : 'IPs'}`}
        {ytdlpVersion?.installed ? ` · yt-dlp ${ytdlpVersion.installed}` : ''}
      </Text>
      {ytdlpVersion?.stale ? (
        <Text style={s.proxyWarnTitle}>yt-dlp is out of date — run `yt-dlp -U`</Text>
      ) : null}
    </>
  )

  // One row per configured egress proxy: which node, whether the last probe got
  // through, and the public IP it came out of.
  const renderProxy = (p: YtdlpProxyEntry, last: boolean) => {
    const color = p.ok ? theme.colors.online : theme.colors.error
    return (
      <View key={p.proxy} style={[s.providerRow, !last && s.providerRowBorder]}>
        <View style={s.providerHeadRow}>
          <View style={[s.dot, { backgroundColor: color }]} />
          <Text style={s.providerName} numberOfLines={1}>{p.label}</Text>
          {p.active ? <Text style={s.proxyActive}>active</Text> : null}
          {p.exit_ip ? <Text style={s.providerModel} numberOfLines={1}>{p.exit_ip}</Text> : null}
          {p.exit_ip && sharedExitIPs.has(p.exit_ip) ? <Text style={s.proxyShared}>shared IP</Text> : null}
        </View>
        <Text style={[s.providerStatus, { color }]}>
          {p.ok
            ? 'Online'
            : p.last_ok_at ? `Offline — last online ${formatRelative(p.last_ok_at)}` : 'Offline — never online'}
        </Text>
        {!p.ok && p.error ? (
          <Text style={s.providerError} numberOfLines={2}>{p.error}</Text>
        ) : null}
      </View>
    )
  }

  // Installed build + the APK + the server's own version: the whole "what am I
  // running" answer in one card, at the very top of the screen.
  const renderVersionCard = () => (
    <View style={s.card}>
      <Text style={s.cardTitle}>Version</Text>
      <Pressable
        onPress={handleCheckVersion}
        style={({ pressed }) => [s.infoRow, pressed && { opacity: 0.6 }]}
        hitSlop={6}
      >
        <Text style={s.infoLabel}>Installed{'  '}<Text style={s.hint}>(tap to check)</Text></Text>
        {checkingVersion
          ? <ActivityIndicator size="small" color={theme.colors.accent} />
          : <Text style={s.infoValue}>v{APP_VERSION} <Text style={s.hint}>(build {APP_VERSION_CODE})</Text></Text>}
      </Pressable>
      {serverInfo?.server_version ? (
        <View style={s.infoRow}>
          <Text style={s.infoLabel}>Server</Text>
          <Text style={s.infoValue}>{serverInfo.server_version}</Text>
        </View>
      ) : null}
      {latestBuild && !isWeb && isUpdateAvailable(latestBuild) ? (
        <>
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: theme.colors.accent }]} />
            <Text style={[s.statusText, { fontSize: 14, color: theme.colors.accent }]}>
              Update available — v{latestBuild.version} <Text style={s.hint}>(build {latestBuild.version_code})</Text>
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
  )

  const renderLLMCard = () => (
    <Accordion
      title="LLM Services"
      subtitle="Status of the last call to each provider — pipelines route through these. Check sends a 1-token test call."
      testID="llm-services"
      summary={llmLead
        ? (
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: providerColor(llmLead) }]} />
            <Text style={[s.summaryText, { color: providerColor(llmLead) }]} numberOfLines={2}>
              {llmProviderLabel(llmLead)} — {providerStatusText(llmLead)}
            </Text>
          </View>
        )
        : <Text style={s.cardSubtitle}>{llmStatus ? 'No LLM configured' : 'Checking…'}</Text>}
      action={
        <Pressable
          onPress={handleProbeLLM}
          disabled={llmProbing}
          style={({ pressed }) => [s.refreshBtn, pressed && s.refreshBtnPressed, llmProbing && s.refreshBtnDisabled]}
          accessibilityLabel="check llm providers"
        >
          {llmProbing
            ? <ActivityIndicator size="small" color={theme.colors.accent} />
            : <Text style={s.refreshBtnText}>Check</Text>
          }
        </Pressable>
      }
    >
      {llmProbeError ? <Text style={s.providerError}>{llmProbeError}</Text> : null}
      {!llmStatus ? (
        <ActivityIndicator size="small" color={theme.colors.accent} style={{ alignSelf: 'flex-start' }} />
      ) : llmProviders.length === 0 ? (
        <Text style={s.emptyText}>No LLM configured — set [llm] in config.toml</Text>
      ) : (
        llmProviders.map((p, i) => renderLLMProvider(p, i === llmProviders.length - 1))
      )}
      {llmStatus && llmStatus.totals.total_calls > 0 ? (
        <>
          <Text style={s.subHeading}>Cumulative usage — never reset</Text>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Total calls</Text>
            <Text style={s.infoValue}>{llmStatus.totals.total_calls.toLocaleString()}</Text>
          </View>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Input tokens</Text>
            <Text style={s.infoValue}>{llmStatus.totals.total_input_tokens.toLocaleString()}</Text>
          </View>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Output tokens</Text>
            <Text style={s.infoValue}>{llmStatus.totals.total_output_tokens.toLocaleString()}</Text>
          </View>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Est. cost</Text>
            <Text style={[s.infoValue, s.llmCostValue]}>${llmStatus.totals.total_cost_usd.toFixed(4)}</Text>
          </View>
        </>
      ) : null}
    </Accordion>
  )

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>

      {/* App version + Android APK — first: which build am I on, and where is the
          newer one? It is the most-read card on the screen. */}
      {renderVersionCard()}

      {/* Connection status */}
      <Accordion
        title="Server Connection"
        testID="server-connection"
        summary={
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: dotColor }]} />
            <Text style={[s.summaryText, { color: dotColor }]} numberOfLines={1}>
              {status === 'connected'
                ? `Connected — ${activeUrl ? hostname(activeUrl) : ''}`
                : status === 'disconnected' ? 'Offline' : 'Checking…'}
            </Text>
          </View>
        }
        action={
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
        }
      >
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

        {/* The URL list belongs to the connection, not beside it: it is the answer
            to "why am I connected there / why am I not". */}
        {serverUrls.length > 0 && (
          <>
            <Text style={s.subHeading}>Server URLs — tried in order until one responds</Text>
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
          </>
        )}
      </Accordion>

      <Text style={s.sectionTitle}>Services</Text>

      {/* The local database's write path — shown only while broken. A device that can
          no longer save keeps reading an ever-staler copy, and before this card said so
          the only symptom was a feed that quietly stopped moving. */}
      {persistFailure && (
        <View style={s.card} testID="persist-failure-card">
          <View style={s.titleGroup}>
            <Text style={s.cardTitle}>Device Storage</Text>
            <Text style={s.cardSubtitle}>Where the offline copy of your library is saved</Text>
          </View>
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: theme.colors.error }]} />
            <Text style={[s.statusText, { fontSize: 14, color: theme.colors.error }]}>
              {persistFailure.full ? 'Full — offline data is stale' : 'Cannot save locally — offline data is stale'}
            </Text>
          </View>
          <Text style={s.connectionDetail}>
            {persistFailure.full
              ? 'This device has no room left, so the offline copy stopped updating '
              : 'Writing to the local database failed, so the offline copy stopped updating '}
            {formatRelative(persistFailure.firstAt)}. Your own changes (notes, tags, stars) still
            sync to the server, but anything you read offline may be out of date. Free up space on
            the device, or clear the local cache under Device below.
          </Text>
          <Text style={s.errorText} numberOfLines={3}>{persistFailure.message}</Text>
        </View>
      )}

      {/* YouTube proxy */}
      <Accordion
        title="YouTube Proxies"
        subtitle="yt-dlp routes video ingestion through the first healthy node"
        testID="youtube-proxies"
        summary={proxySummary}
        action={
          proxyChecking
            ? <ActivityIndicator size="small" color={theme.colors.accent} />
            : <Pressable onPress={handleRecheckProxy} style={({ pressed }) => [s.refreshBtn, pressed && s.refreshBtnPressed]}>
                <Text style={s.refreshBtnText}>Recheck</Text>
              </Pressable>
        }
      >
        {proxySummary}
        {!proxyStatus || !proxyStatus.configured ? null : (
          <>
            {ytdlpVersion?.stale ? (
              // Its own warning, not a red proxy dot: swapping nodes cannot fix
              // a signature-scheme change, and every proxy fails identically.
              <View style={s.proxyWarn}>
                <Text style={s.proxyWarnTitle}>
                  {ytdlpVersion.latest
                    ? `yt-dlp is out of date — ${ytdlpVersion.installed} installed, ${ytdlpVersion.latest} available`
                    : `yt-dlp is ${ytdlpVersion.age_days} days old`}
                </Text>
                <Text style={s.proxyWarnBody}>
                  YouTube changes its player scheme every few weeks. A stale binary 403s on every
                  proxy — that is not a proxy fault. Run `yt-dlp -U` on the server.
                </Text>
              </View>
            ) : null}
            <View style={s.proxyList}>
              {proxyStatus.proxies.map((p, i) => renderProxy(p, i === proxyStatus.proxies.length - 1))}
            </View>
          </>
        )}
      </Accordion>

      {/* Auto-export vault */}
      {exportStats && (
        <View style={s.card}>
          <View style={s.cardHeader}>
            <View style={s.titleGroup}>
              <Text style={s.cardTitle}>Export Vault</Text>
              <Text style={s.cardSubtitle}>
                {exportStats.enabled
                  ? 'One-way mirror → Obsidian markdown'
                  : 'Off — set [export] in config.toml'}
              </Text>
            </View>
            {exportStats.enabled && (
              exportFetching
                ? <ActivityIndicator size="small" color={theme.colors.accent} />
                : <Pressable onPress={() => refetchExport()} style={({ pressed }) => [s.refreshBtn, pressed && s.refreshBtnPressed]}>
                    <Text style={s.refreshBtnText}>Refresh</Text>
                  </Pressable>
            )}
          </View>
          {exportStats.enabled && (
            <>
              <View style={s.statusRow}>
                <View style={[s.dot, { backgroundColor: exportStats.last_error ? theme.colors.error : theme.colors.online }]} />
                <Text style={[s.statusText, { fontSize: 14, color: exportStats.last_error ? theme.colors.error : theme.colors.online }]}>
                  {exportStats.last_error ? 'Error' : 'Active'}
                </Text>
              </View>
              <View style={s.infoRow}>
                <Text style={s.infoLabel}>Documents</Text>
                <Text style={s.infoValue}>{exportStats.doc_count.toLocaleString()}</Text>
              </View>
              <View style={s.infoRow}>
                <Text style={s.infoLabel}>Annotations</Text>
                <Text style={s.infoValue}>{exportStats.annotation_count.toLocaleString()}</Text>
              </View>
              <View style={s.infoRow}>
                <Text style={s.infoLabel}>Last export</Text>
                <Text style={s.infoValue}>{exportStats.last_export_at ? formatRelative(exportStats.last_export_at) : '—'}</Text>
              </View>
              <Text style={s.connectionDetail} numberOfLines={1}>
                <Text style={s.connectionUrl}>{exportStats.dir}</Text>
              </Text>
              {exportStats.last_error ? (
                <Text style={s.errorText} numberOfLines={3}>{exportStats.last_error}</Text>
              ) : null}
            </>
          )}
        </View>
      )}

      {/* Browser Extension (web only) */}
      {isWeb && (
        <View style={s.card}>
          <View style={s.titleGroup}>
            <Text style={s.cardTitle}>Browser Extension</Text>
            <Text style={s.cardSubtitle}>“Save to Sam” — save the current page from your Chrome toolbar</Text>
          </View>
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

      {renderLLMCard()}

      <Text style={s.sectionTitle}>Preferences</Text>

      {/* Polling */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <View style={s.titleGroup}>
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

      {/* Auto-archive — a server-side sweep, so it runs whether or not a phone is
          open. Pinned highlights are never swept. */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <View style={s.titleGroup}>
            <Text style={s.cardTitle}>Auto Archive</Text>
            <Text style={s.cardSubtitle}>
              {settings?.auto_archive_enabled
                ? 'On — highlights older than 1 month are archived (pinned ones are kept)'
                : 'Off — highlights stay in the feed until you triage them'}
            </Text>
          </View>
          {settings === null
            ? <ActivityIndicator size="small" color={theme.colors.accent} />
            : <Switch
                value={settings.auto_archive_enabled}
                onValueChange={handleToggleAutoArchive}
                disabled={settingsLoading}
                accessibilityLabel="Auto archive older than 1 month"
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={theme.colors.background}
              />
          }
        </View>
      </View>

      {/* Transcript languages */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <View style={s.titleGroup}>
            <Text style={s.cardTitle}>Transcript Languages</Text>
            <Text style={s.cardSubtitle}>Keep videos in these languages in their original language. Everything else is translated to English.</Text>
          </View>
          {langSaving ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
        </View>
        {settings === null ? (
          <ActivityIndicator size="small" color={theme.colors.accent} />
        ) : (
          renderLangEditor()
        )}
      </View>

      {/* Selection context menu — the "···" next to Annotate in the reader. */}
      <Accordion
        title="Context Menu"
        subtitle="Actions offered on a text selection in the reader"
        testID="context-menu"
        summary={
          <Text style={s.cardSubtitle}>
            {settings === null
              ? 'Loading…'
              : `${(settings.context_menu?.items ?? []).filter((i) => i.enabled).length} action(s) enabled`}
          </Text>
        }
      >
        {settings === null ? (
          <ActivityIndicator size="small" color={theme.colors.accent} />
        ) : (
          <ContextMenuEditor
            menu={contextMenu}
            onChange={saveContextMenu}
          />
        )}
      </Accordion>

      {/* Reading mode (document viewer) — the SAME preference the reader's 3-way
          Flow/Auto/Page control writes, never a second flag. */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <View style={s.titleGroup}>
            <Text style={s.cardTitle}>Auto Page Mode</Text>
            <Text style={s.cardSubtitle}>
              {readingMode === 'auto'
                ? `On — documents longer than ${pageThreshold} pages open paginated`
                : readingMode === 'page'
                  ? 'Off — page mode is forced on for every document (set in the reader)'
                  : 'Off — every document opens in continuous scroll'}
            </Text>
          </View>
          <Switch
            value={readingMode === 'auto'}
            onValueChange={(on) => setReadingMode(on ? 'auto' : 'flow')}
            accessibilityLabel="Auto page mode"
            trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
            thumbColor={theme.colors.background}
          />
        </View>
        <View style={s.thresholdRow}>
          <Text style={s.infoLabel}>Paginate documents longer than</Text>
          <TextInput
            style={s.thresholdInput}
            value={thresholdInput}
            onChangeText={handleThresholdChange}
            onBlur={handleThresholdCommit}
            onSubmitEditing={handleThresholdCommit}
            returnKeyType="done"
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={3}
            // No selectTextOnFocus: RNW re-runs the select on every re-render of a
            // controlled field, so each keystroke replaced the previous one.
            accessibilityLabel="Page threshold"
          />
          <Text style={s.infoLabel}>pages</Text>
        </View>
      </View>

      {/* Debug log streaming */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <View style={s.titleGroup}>
            <Text style={s.cardTitle}>Debug Log Streaming</Text>
            <Text style={s.cardSubtitle}>
              {debugLogEnabled
                ? 'On — this device streams its logs to the server for debugging'
                : 'Off — logs stay on this device'}
            </Text>
          </View>
          <Switch
            value={debugLogEnabled}
            onValueChange={setDebugLogEnabled}
            trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
            thumbColor={theme.colors.background}
          />
        </View>
      </View>

      <Text style={s.sectionTitle}>Device</Text>

      {/* Devices */}
      <Accordion
        title="Connected Devices"
        testID="connected-devices"
        summary={
          <Text style={s.summaryText} numberOfLines={1}>
            {status !== 'connected'
              ? 'Connect to see devices'
              : devicesLoading && devices.length === 0
                ? 'Loading…'
                : devicesError
                  ? devicesError
                  : `${devices.length} ${devices.length === 1 ? 'device' : 'devices'}`}
          </Text>
        }
        action={status === 'connected' ? (
          devicesRefreshing
            ? <ActivityIndicator size="small" color={theme.colors.accent} />
            : <Pressable onPress={() => loadDevices()} style={({ pressed }) => [s.refreshBtn, pressed && s.refreshBtnPressed]}>
                <Text style={s.refreshBtnText}>Refresh</Text>
              </Pressable>
        ) : undefined}
      >
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
      </Accordion>

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

      {/* Local data */}
      <View style={s.card}>
        <View style={s.titleGroup}>
          <Text style={s.cardTitle}>Local Data</Text>
          <Text style={s.cardSubtitle}>Cached on this device — server copy untouched</Text>
        </View>
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
    // Group label above a run of cards (Services / Preferences / Device).
    sectionTitle: {
      color: t.colors.placeholder, fontSize: 11, fontWeight: '700',
      textTransform: 'uppercase', letterSpacing: 0.5,
      marginTop: t.spacing.sm, marginLeft: t.spacing.xs,
    },
    cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: t.spacing.sm },
    // Title + subtitle always live in this group, never as bare siblings: the card's
    // own `gap` is too wide between them, and cancelling it with a negative margin
    // collapsed them ONTO each other wherever the pair sat inside a header column.
    titleGroup: { flex: 1, gap: 2 },
    cardTitle: { color: t.colors.text, fontSize: 15, fontWeight: '700', lineHeight: 20 },
    cardSubtitle: { color: t.colors.muted, fontSize: 12, lineHeight: 17 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    dot: { width: 10, height: 10, borderRadius: 5 },
    statusText: { fontSize: 15, fontWeight: '600' },
    // The one line a collapsed accordion shows in place of its body.
    summaryText: { color: t.colors.muted, fontSize: 13, fontWeight: '600', flexShrink: 1 },
    hint: { color: t.colors.muted, fontSize: 12 },
    infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: t.spacing.sm, paddingVertical: 2 },
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
    // Transcript-language editor
    langChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: t.spacing.xs },
    langChip: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingLeft: 10, paddingRight: 6, paddingVertical: 3, borderRadius: 12,
      borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.background,
    },
    langChipText: { color: t.colors.text, fontSize: 12, fontWeight: '700' },
    langEmpty: { color: t.colors.muted, fontSize: 12, fontStyle: 'italic' },
    langAddRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginTop: t.spacing.xs },
    // Auto-page-mode threshold field
    thresholdRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, flexWrap: 'wrap' },
    thresholdInput: {
      width: 56, textAlign: 'center',
      color: t.colors.text, fontSize: 13, fontWeight: '700',
      paddingHorizontal: t.spacing.xs, paddingVertical: t.spacing.xs,
      borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.background,
    },
    langInput: {
      flex: 1, color: t.colors.text, fontSize: 13,
      paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.xs,
      borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.background,
    },
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
    // Proxy pool rows (reuse the provider row chrome — same shape of fact)
    proxyList: { marginTop: t.spacing.xs },
    proxyActive: { color: t.colors.online, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
    proxyShared: { color: t.colors.muted, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
    proxyWarn: {
      marginTop: t.spacing.xs,
      padding: t.spacing.sm,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: t.colors.error,
      gap: 3,
    },
    proxyWarnTitle: { color: t.colors.error, fontSize: 13, fontWeight: '700', lineHeight: 18 },
    proxyWarnBody: { color: t.colors.muted, fontSize: 11, lineHeight: 16 },
    // LLM provider rows
    providerRow: { paddingVertical: t.spacing.sm, gap: 5 },
    providerRowBorder: { borderBottomWidth: 1, borderBottomColor: t.colors.border },
    // Wraps: a self-hosted endpoint's host + model are long, and a second line
    // beats three labels squeezed onto one.
    providerHeadRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: t.spacing.sm, rowGap: 3 },
    providerName: { color: t.colors.text, fontSize: 14, fontWeight: '700', lineHeight: 19, flexShrink: 1 },
    providerRole: { color: t.colors.muted, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
    providerModel: { color: t.colors.placeholder, fontSize: 11, fontFamily: 'monospace', flexShrink: 1 },
    providerStatus: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
    providerError: { color: t.colors.muted, fontSize: 11, fontFamily: 'monospace', lineHeight: 15 },
    providerProbe: { color: t.colors.muted, fontSize: 11, marginTop: 2 },
    providerUsage: { color: t.colors.muted, fontSize: 11, lineHeight: 16 },
    providerShare: { color: t.colors.accent, fontWeight: '700' },
    subHeading: { color: t.colors.muted, fontSize: 12, fontWeight: '700', marginTop: t.spacing.sm },
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
