import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import {
  fetchFeeds,
  fetchSubscriptions,
  createSubscription,
  createNewsletter,
  deleteNewsletterFeed,
  deleteSubscription,
  pollSubscriptionNow,
  patchSubscription,
} from '../../src/api'
import type { Feed, Subscription } from '../../src/api'
import { copyToClipboard } from '../../src/clipboard'
import { useConnection } from '../../src/ConnectionContext'
import { useToast } from '../../src/ToastContext'

// Newsletter feeds store their inbound address in config JSON.
function newsletterEmail(feed: Feed | undefined): string | null {
  if (!feed?.config) return null
  try { return (JSON.parse(feed.config) as { email?: string }).email ?? null } catch { return null }
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 2) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function formatFuture(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return 'due now'
  const m = Math.floor(diff / 60000)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}

type SubWithFeed = Subscription & { feed: Feed | undefined }

export default function SubscriptionsScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { status, activeUrl, token } = useConnection()
  const { toast } = useToast()

  const [subs, setSubs] = useState<SubWithFeed[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [urlInput, setUrlInput] = useState('')
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [nlTitle, setNlTitle] = useState('')
  const [nlState, setNlState] = useState<'idle' | 'submitting'>('idle')

  const [pollingId, setPollingId] = useState<string | null>(null)
  const [holdPollingId, setHoldPollingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const load = useCallback(async (isRefresh = false) => {
    if (!activeUrl || !token) return
    isRefresh ? setRefreshing(true) : setLoading(true)
    setError(null)
    try {
      const [rawSubs, feeds] = await Promise.all([
        fetchSubscriptions(activeUrl, token),
        fetchFeeds(activeUrl, token),
      ])
      const feedMap: Record<string, Feed> = {}
      for (const f of (feeds ?? [])) feedMap[f.id] = f
      setSubs((rawSubs ?? []).map(sub => ({ ...sub, feed: feedMap[sub.feed_id] })))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [activeUrl, token])

  useEffect(() => {
    if (status === 'connected') load()
  }, [status, load])

  async function handleAdd() {
    if (!activeUrl || !token) return
    const trimmed = urlInput.trim()
    if (!trimmed) return
    setSubmitState('submitting')
    setSubmitError(null)
    try {
      await createSubscription(activeUrl, token, trimmed)
      setUrlInput('')
      setSubmitState('done')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setSubmitState('idle'), 3000)
      await load()
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Failed')
      setSubmitState('error')
    }
  }

  async function handleAddNewsletter() {
    if (!activeUrl || !token) return
    const trimmed = nlTitle.trim()
    if (!trimmed || nlState === 'submitting') return
    setNlState('submitting')
    try {
      const { email } = await createNewsletter(activeUrl, token, trimmed)
      setNlTitle('')
      const copied = await copyToClipboard(email)
      toast(copied ? `Address copied: ${email}` : `Newsletter address: ${email}`, 'success')
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to create newsletter', 'error')
    } finally {
      setNlState('idle')
    }
  }

  async function handleCopyAddress(email: string) {
    const copied = await copyToClipboard(email)
    toast(copied ? 'Address copied' : email, copied ? 'success' : 'info')
  }

  async function handleDeleteNewsletter(item: SubWithFeed) {
    if (!activeUrl || !token || deletingId || !item.feed) return
    setDeletingId(item.id)
    try {
      const { unsubscribed } = await deleteNewsletterFeed(activeUrl, token, item.feed.id)
      setSubs(prev => prev.filter(s => s.id !== item.id))
      toast(unsubscribed ? 'Removed + unsubscribed' : 'Removed', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to remove', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  async function handlePoll(sub: SubWithFeed) {
    if (!activeUrl || !token || pollingId || holdPollingId) return
    setPollingId(sub.id)
    try {
      await pollSubscriptionNow(activeUrl, token, sub.id)
      setTimeout(() => load(), 1500)
    } catch { /* ignore */ }
    finally { setTimeout(() => setPollingId(null), 2000) }
  }

  async function handlePollHold(sub: SubWithFeed) {
    if (!activeUrl || !token || pollingId || holdPollingId) return
    setHoldPollingId(sub.id)
    try {
      await pollSubscriptionNow(activeUrl, token, sub.id, { hold: true })
      setTimeout(() => load(), 1500)
    } catch { /* ignore */ }
    finally { setTimeout(() => setHoldPollingId(null), 2000) }
  }

  async function handleTogglePaused(sub: SubWithFeed) {
    if (!activeUrl || !token || togglingId) return
    setTogglingId(sub.id)
    try {
      const updated = await patchSubscription(activeUrl, token, sub.id, { paused: sub.paused === 0 })
      setSubs(prev => prev.map(s => s.id === sub.id ? { ...s, paused: updated.paused } : s))
    } catch { /* ignore */ }
    finally { setTogglingId(null) }
  }

  async function handleDelete(sub: SubWithFeed) {
    if (!activeUrl || !token || deletingId) return
    setDeletingId(sub.id)
    try {
      await deleteSubscription(activeUrl, token, sub.id)
      setSubs(prev => prev.filter(s => s.id !== sub.id))
    } catch { /* ignore */ }
    finally { setDeletingId(null) }
  }

  function renderNewsletterItem(item: SubWithFeed) {
    const email = newsletterEmail(item.feed)
    const isDeleteBusy = deletingId === item.id
    return (
      <View style={s.card}>
        <View style={s.cardHeader}>
          <View style={s.cardMeta}>
            <Text style={s.cardDomain} numberOfLines={1}>{item.feed?.title || 'Newsletter'}</Text>
            <Text style={s.cardUrl} numberOfLines={1}>{email ?? 'no address'}</Text>
          </View>
          <View style={s.cardKind}>
            <Text style={s.kindBadge}>newsletter</Text>
          </View>
        </View>
        <View style={s.cardStats}>
          <Text style={s.statText}>
            Last received: <Text style={s.statValue}>{formatRelative(item.feed?.last_polled_at ?? null)}</Text>
          </Text>
        </View>
        <Text style={s.nlHint}>Subscribe to this newsletter using the address above.</Text>
        <View style={s.cardActions}>
          <Pressable
            style={({ pressed }) => [s.actionBtn, s.pollBtn, pressed && s.actionBtnPressed, !email && s.addBtnDisabled]}
            onPress={() => email && handleCopyAddress(email)}
            disabled={!email}
          >
            <Text style={s.pollBtnText}>Copy address</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [s.actionBtn, s.deleteBtn, (isDeleteBusy || pressed) && s.actionBtnPressed]}
            onPress={() => handleDeleteNewsletter(item)}
            disabled={!!deletingId}
          >
            {isDeleteBusy
              ? <ActivityIndicator size="small" color="#f87171" />
              : <Text style={s.deleteBtnText}>Remove</Text>
            }
          </Pressable>
        </View>
      </View>
    )
  }

  function renderItem({ item }: { item: SubWithFeed }) {
    if (item.feed?.kind === 'newsletter') return renderNewsletterItem(item)
    const url = item.feed?.url ?? item.feed_id
    const domain = (() => { try { return new URL(url).hostname } catch { return url } })()
    const isPollBusy = pollingId === item.id
    const isHoldPollBusy = holdPollingId === item.id
    const isDeleteBusy = deletingId === item.id
    const isToggleBusy = togglingId === item.id
    const isPaused = item.paused !== 0
    const anyPollBusy = !!pollingId || !!holdPollingId

    return (
      <View style={[s.card, isPaused && s.cardPaused]}>
        <View style={s.cardHeader}>
          <View style={s.cardMeta}>
            <Text style={[s.cardDomain, isPaused && s.cardDomainMuted]} numberOfLines={1}>{domain}</Text>
            <Text style={s.cardUrl} numberOfLines={1}>{url}</Text>
          </View>
          <View style={s.cardRight}>
            <View style={s.cardKind}>
              <Text style={s.kindBadge}>{item.feed?.kind ?? '?'}</Text>
            </View>
            <Switch
              value={!isPaused}
              onValueChange={() => handleTogglePaused(item)}
              disabled={isToggleBusy}
              trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
              thumbColor={isPaused ? theme.colors.muted : theme.colors.background}
            />
          </View>
        </View>
        <View style={s.cardStats}>
          <Text style={s.statText}>
            Polled: <Text style={s.statValue}>{formatRelative(item.feed?.last_polled_at ?? null)}</Text>
          </Text>
          <Text style={s.statText}>
            Next: <Text style={s.statValue}>{formatFuture(item.next_run_at)}</Text>
          </Text>
          <Text style={s.statText}>
            Every <Text style={s.statValue}>{item.interval_h}h</Text>
          </Text>
        </View>
        <View style={s.cardActions}>
          <Pressable
            style={({ pressed }) => [s.actionBtn, s.pollBtn, (isPollBusy || pressed) && s.actionBtnPressed]}
            onPress={() => handlePoll(item)}
            disabled={anyPollBusy}
          >
            {isPollBusy
              ? <ActivityIndicator size="small" color="#0b0b0c" />
              : <Text style={s.pollBtnText}>Poll & Process</Text>
            }
          </Pressable>
          <Pressable
            style={({ pressed }) => [s.actionBtn, s.holdBtn, (isHoldPollBusy || pressed) && s.actionBtnPressed]}
            onPress={() => handlePollHold(item)}
            disabled={anyPollBusy}
          >
            {isHoldPollBusy
              ? <ActivityIndicator size="small" color="#0b0b0c" />
              : <Text style={s.holdBtnText}>Poll & Hold</Text>
            }
          </Pressable>
          <Pressable
            style={({ pressed }) => [s.actionBtn, s.deleteBtn, (isDeleteBusy || pressed) && s.actionBtnPressed]}
            onPress={() => handleDelete(item)}
            disabled={!!deletingId}
          >
            {isDeleteBusy
              ? <ActivityIndicator size="small" color="#f87171" />
              : <Text style={s.deleteBtnText}>Remove</Text>
            }
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.wrapper}>
      {/* Add subscription row */}
      <View style={s.addRow}>
        <TextInput
          style={s.input}
          placeholder="https://site.com/author/name"
          placeholderTextColor={theme.colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={urlInput}
          onChangeText={setUrlInput}
          onSubmitEditing={handleAdd}
          returnKeyType="send"
        />
        <Pressable
          style={({ pressed }) => [s.addBtn, submitState === 'submitting' && s.addBtnDisabled, pressed && s.addBtnPressed]}
          onPress={handleAdd}
          disabled={submitState === 'submitting'}
        >
          {submitState === 'submitting'
            ? <ActivityIndicator size="small" color="#0b0b0c" />
            : <Text style={s.addBtnText}>Subscribe</Text>
          }
        </Pressable>
      </View>
      {submitState === 'done' && (
        <Text style={s.feedbackOk}>Subscribed! First poll queued.</Text>
      )}
      {submitState === 'error' && submitError && (
        <Text style={s.feedbackErr}>{submitError}</Text>
      )}

      {/* Add newsletter row — server mints an email address to subscribe with */}
      <View style={s.addRow}>
        <TextInput
          style={s.input}
          placeholder="Newsletter name (e.g. James Clear 3-2-1)"
          placeholderTextColor={theme.colors.placeholder}
          autoCorrect={false}
          value={nlTitle}
          onChangeText={setNlTitle}
          onSubmitEditing={handleAddNewsletter}
          returnKeyType="done"
        />
        <Pressable
          style={({ pressed }) => [s.addBtn, nlState === 'submitting' && s.addBtnDisabled, pressed && s.addBtnPressed]}
          onPress={handleAddNewsletter}
          disabled={nlState === 'submitting'}
        >
          {nlState === 'submitting'
            ? <ActivityIndicator size="small" color="#0b0b0c" />
            : <Text style={s.addBtnText}>Newsletter</Text>
          }
        </Pressable>
      </View>

      {loading && !refreshing
        ? <View style={s.centered}><ActivityIndicator color={theme.colors.accent} size="large" /></View>
        : error
          ? <View style={s.centered}>
              <Text style={s.errText}>{error}</Text>
              <Pressable onPress={() => load()} style={s.retryBtn}>
                <Text style={s.retryText}>Retry</Text>
              </Pressable>
            </View>
          : <FlatList
              data={subs}
              keyExtractor={item => item.id}
              renderItem={renderItem}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={theme.colors.accent} />}
              contentContainerStyle={subs.length === 0 ? s.emptyContainer : s.list}
              ItemSeparatorComponent={() => <View style={s.sep} />}
              ListEmptyComponent={
                <View style={s.emptyContainer}>
                  <Text style={s.emptyText}>No subscriptions yet.</Text>
                  <Text style={s.emptyHint}>Paste an author/tag page URL above.{'\n'}Make sure extractors/&lt;domain&gt;/feed.yaml exists.</Text>
                </View>
              }
            />
      }
      </View>
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    wrapper: { flex: 1, maxWidth: 800, alignSelf: 'center', width: '100%' },
    addRow: { flexDirection: 'row', padding: t.spacing.md, gap: t.spacing.sm, borderBottomWidth: 1, borderBottomColor: t.colors.border, backgroundColor: t.colors.surface },
    input: { flex: 1, backgroundColor: t.colors.background, color: t.colors.text, borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.colors.border, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, fontSize: 13 },
    addBtn: { backgroundColor: t.colors.accent, borderRadius: t.radius.sm, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, justifyContent: 'center', alignItems: 'center', minWidth: 90 },
    addBtnDisabled: { opacity: 0.6 },
    addBtnPressed: { opacity: 0.8 },
    addBtnText: { color: t.colors.background, fontSize: 13, fontWeight: '700' },
    feedbackOk: { color: t.colors.online, fontSize: 13, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.xs, backgroundColor: t.colors.surface },
    feedbackErr: { color: t.colors.error, fontSize: 13, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.xs, backgroundColor: t.colors.surface },
    list: { padding: t.spacing.sm, maxWidth: 800, alignSelf: 'center', width: '100%' },
    sep: { height: t.spacing.sm },
    card: { backgroundColor: t.colors.surface, borderRadius: t.radius.md, padding: t.spacing.md, borderWidth: 1, borderColor: t.colors.border },
    cardPaused: { opacity: 0.65 },
    cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.sm, marginBottom: t.spacing.sm },
    cardMeta: { flex: 1 },
    cardDomain: { color: t.colors.text, fontSize: 15, fontWeight: '700' },
    cardDomainMuted: { color: t.colors.muted },
    cardUrl: { color: t.colors.muted, fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
    cardRight: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    cardKind: { paddingHorizontal: 6, paddingVertical: 2, backgroundColor: t.colors.border, borderRadius: t.radius.sm },
    kindBadge: { color: t.colors.muted, fontSize: 11, fontFamily: 'monospace' },
    nlHint: { color: t.colors.muted, fontSize: 12, marginBottom: t.spacing.md },
    cardStats: { flexDirection: 'row', gap: t.spacing.md, marginBottom: t.spacing.md },
    statText: { color: t.colors.muted, fontSize: 12 },
    statValue: { color: t.colors.text, fontWeight: '600' },
    cardActions: { flexDirection: 'row', gap: t.spacing.sm },
    actionBtn: { borderRadius: t.radius.sm, paddingHorizontal: t.spacing.md, paddingVertical: 6, alignItems: 'center', justifyContent: 'center', minWidth: 80, minHeight: 30 },
    actionBtnPressed: { opacity: 0.7 },
    pollBtn: { backgroundColor: t.colors.accent },
    pollBtnText: { color: t.colors.background, fontSize: 13, fontWeight: '600' },
    holdBtn: { backgroundColor: '#a78bfa' },
    holdBtnText: { color: '#0b0b0c', fontSize: 13, fontWeight: '600' },
    deleteBtn: { borderWidth: 1, borderColor: t.colors.error },
    deleteBtnText: { color: t.colors.error, fontSize: 13 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl, maxWidth: 800, alignSelf: 'center', width: '100%' },
    emptyText: { color: t.colors.muted, fontSize: 16, fontWeight: '600', marginBottom: t.spacing.sm },
    emptyHint: { color: t.colors.placeholder, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  })
}
