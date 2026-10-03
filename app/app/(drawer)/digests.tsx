import { useCallback, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { fetchDigests, fetchFeeds, fetchSubscriptions, patchDigest } from '../../src/api'
import type { Digest, DigestRunQueued, Feed } from '../../src/api'
import { useConnection } from '../../src/ConnectionContext'
import * as db from '../../src/db'
import DigestChip, { digestHref } from '../../src/DigestChip'
import DigestEditor, { periodSummary } from '../../src/DigestEditor'
import { formatRelative, formatWhen } from '../../src/relativeTime'
import { useToast } from '../../src/ToastContext'

// What the editor needs beside the Digest itself, loaded once per visit.
type EditorData = { feeds: Feed[]; subscribed: Set<string> }

const NEW = 'new'

export default function DigestsScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { status, activeUrl, token } = useConnection()
  const { toast } = useToast()

  // The replica is what an offline visit reads; the server's list replaces it while
  // connected, because an edit made here is not in the replica until the next pull.
  const stored = db.useDigests()
  const feedsWithHighlights = db.useFeedIdsWithHighlights()
  const [fetched, setFetched] = useState<Digest[] | null>(null)
  const [editorData, setEditorData] = useState<EditorData | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [editing, setEditing] = useState<string | null>(null) // a Digest id, or NEW
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const online = status === 'connected' && !!activeUrl && !!token
  const digests = online && fetched ? fetched : stored

  const load = useCallback(async () => {
    if (!activeUrl || !token) return
    try {
      const [list, feeds, subscriptions] = await Promise.all([
        fetchDigests(activeUrl, token),
        fetchFeeds(activeUrl, token),
        fetchSubscriptions(activeUrl, token),
      ])
      setFetched(list ?? [])
      setEditorData({
        feeds: feeds ?? [],
        subscribed: new Set((subscriptions ?? []).map(sub => sub.feed_id)),
      })
    } catch {
      // The replica's list stays on screen; editing stays off until a load lands.
      setFetched(null)
    }
  }, [activeUrl, token])

  useFocusEffect(
    useCallback(() => {
      if (status === 'connected') void load()
    }, [status, load]),
  )

  const canEdit = online && editorData !== null

  async function toggleEnabled(digest: Digest) {
    if (!activeUrl || !token || togglingId) return
    setTogglingId(digest.id)
    try {
      const updated = await patchDigest(activeUrl, token, digest.id, { enabled: !digest.enabled })
      upsert(updated)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to update', 'error')
    } finally {
      setTogglingId(null)
    }
  }

  function upsert(digest: Digest) {
    setFetched(prev => {
      const rest = (prev ?? []).filter(d => d.id !== digest.id)
      return [...rest, digest].sort((a, b) => a.name.localeCompare(b.name))
    })
  }

  const openIssue = (digest: Digest, queued?: DigestRunQueued) =>
    router.push(digestHref(digest.id, queued?.issue_id))

  function editorFor(digest: Digest | null) {
    if (!editorData) return null
    const picked = new Set(digest?.source_feed_ids ?? [])
    return (
      <DigestEditor
        digest={digest}
        // A Feed this Digest names stays listed after its subscription is gone, so
        // it can still be unpicked.
        feeds={editorData.feeds.filter(f => editorData.subscribed.has(f.id) || picked.has(f.id))}
        feedsWithHighlights={feedsWithHighlights}
        onSaved={saved => { upsert(saved); setEditing(saved.id) }}
        onDeleted={id => { setFetched(prev => (prev ?? []).filter(d => d.id !== id)); setEditing(null) }}
        onRan={openIssue}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <SafeAreaView style={s.screen}>
      <ScrollView
        contentContainerStyle={s.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }}
            tintColor={theme.colors.accent}
          />
        }
      >
        <View style={s.topBar}>
          <Text style={s.intro}>
            A digest asks its questions over the Highlights of the newsletters it reads, on a schedule.
          </Text>
          {canEdit && editing !== NEW ? (
            <Pressable style={s.addBtn} onPress={() => setEditing(NEW)} accessibilityLabel="Add digest">
              <Text style={s.addBtnText}>+ Add digest</Text>
            </Pressable>
          ) : null}
        </View>
        {!online ? <Text style={s.offline}>Offline — digests can be read, not edited.</Text> : null}
        {online && !canEdit ? <ActivityIndicator color={theme.colors.accent} style={s.spinner} /> : null}

        {editing === NEW ? (
          <View style={s.card}>
            <Text style={s.name}>New digest</Text>
            {editorFor(null)}
          </View>
        ) : null}

        {digests.length === 0 && editing !== NEW ? (
          <Text style={s.empty}>No digests yet.</Text>
        ) : null}

        {digests.map(digest => (
          <View key={digest.id} style={s.card} testID={`digest-card-${digest.id}`}>
            <View style={s.cardHeader}>
              <View style={s.cardMeta}>
                <DigestChip name={digest.name} color={digest.color} size="md" testID={`digest-name-${digest.id}`} />
                <Text style={s.period}>{periodSummary(digest)}</Text>
              </View>
              <Switch
                value={digest.enabled}
                onValueChange={() => toggleEnabled(digest)}
                disabled={!online || togglingId === digest.id}
                accessibilityLabel={`Digest enabled ${digest.name}`}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={digest.enabled ? theme.colors.background : theme.colors.muted}
              />
            </View>
            <Text style={s.meta}>
              <Text style={s.metaLabel}>last issue: </Text>
              {digest.last_run_at ? formatRelative(digest.last_run_at) : 'none yet'}
            </Text>
            <Text style={s.meta}>
              <Text style={s.metaLabel}>next run: </Text>
              {digest.enabled ? formatWhen(digest.next_run_at) : 'off'}
            </Text>
            <View style={s.toggles}>
              <Pressable style={s.sectionBtn} onPress={() => openIssue(digest)} accessibilityLabel={`Open digest ${digest.name}`}>
                <Text style={s.sectionBtnText}>Issues →</Text>
              </Pressable>
              {canEdit ? (
                <Pressable
                  style={[s.sectionBtn, editing === digest.id && s.sectionBtnActive]}
                  onPress={() => setEditing(editing === digest.id ? null : digest.id)}
                  accessibilityLabel={`Edit digest ${digest.name}`}
                >
                  <Text style={[s.sectionBtnText, editing === digest.id && s.sectionBtnTextActive]}>
                    {editing === digest.id ? '▼' : '▶'} Edit
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {editing === digest.id ? editorFor(digest) : null}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    list: { padding: t.spacing.sm, gap: t.spacing.sm, maxWidth: 800, alignSelf: 'center', width: '100%' },
    topBar: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    intro: { flex: 1, color: t.colors.placeholder, fontSize: 12, lineHeight: 17 },
    addBtn: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: 5,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.accent,
      backgroundColor: t.colors.accent + '22',
    },
    addBtnText: { color: t.colors.accent, fontSize: 13, fontWeight: '700' },
    offline: { color: t.colors.muted, fontSize: 12, fontStyle: 'italic' },
    spinner: { alignSelf: 'flex-start' },
    empty: { color: t.colors.muted, fontSize: 15, textAlign: 'center', padding: t.spacing.xl },
    card: {
      backgroundColor: t.colors.surface,
      borderRadius: t.radius.md,
      padding: t.spacing.md,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: t.spacing.sm, gap: t.spacing.sm },
    cardMeta: { flex: 1, gap: t.spacing.xs },
    name: { color: t.colors.text, fontSize: 16, fontWeight: '700', marginBottom: 2 },
    period: { color: t.colors.accent, fontSize: 11, fontFamily: 'monospace' },
    meta: { color: t.colors.muted, fontSize: 12, marginBottom: 2 },
    metaLabel: { color: t.colors.placeholder, fontWeight: '600' },
    toggles: { flexDirection: 'row', gap: t.spacing.sm, flexWrap: 'wrap', marginTop: t.spacing.xs },
    sectionBtn: {
      paddingHorizontal: t.spacing.sm,
      paddingVertical: 4,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    sectionBtnActive: { backgroundColor: t.colors.accent + '22', borderColor: t.colors.accent },
    sectionBtnText: { color: t.colors.muted, fontSize: 12, fontFamily: 'monospace' },
    sectionBtnTextActive: { color: t.colors.accent, fontWeight: '700' },
  })
}
