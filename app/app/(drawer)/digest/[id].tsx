import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { fetchDigestIssue, fetchDigestIssues } from '../../../src/api'
import type { DigestIssue, DigestQuestionMeta, DigestRef, DigestTopic } from '../../../src/api'
import { useConnection } from '../../../src/ConnectionContext'
import * as db from '../../../src/db'
import DigestChip from '../../../src/DigestChip'
import MarkdownBody from '../../../src/MarkdownBody'
import { formatWhen } from '../../../src/relativeTime'

// How often a run that has not finished is re-read.
const POLL_MS = 2000

type QuestionGroup = { id: string; title: string; meta?: DigestQuestionMeta; topics: DigestTopic[] }

// `topics` is flat: group by question, rank order inside each. Questions keep the
// order they were asked in (the order their metadata was written); one that found
// nothing still gets its heading, so "no topics" is said rather than implied.
function groupTopics(issue: DigestIssue, titles: Record<string, string>): QuestionGroup[] {
  const groups = new Map<string, QuestionGroup>()
  for (const meta of issue.metadata.questions) {
    groups.set(meta.question_id, { id: meta.question_id, title: titles[meta.question_id] ?? '', meta, topics: [] })
  }
  for (const topic of issue.topics) {
    const group = groups.get(topic.question_id) ?? { id: topic.question_id, title: '', topics: [] }
    group.title = topic.question_title
    group.topics.push(topic)
    groups.set(topic.question_id, group)
  }
  for (const group of groups.values()) group.topics.sort((a, b) => a.rank - b.rank)
  return [...groups.values()]
}

function issueDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function DigestIssueScreen() {
  const { id, issue: issueParam } = useLocalSearchParams<{ id: string; issue?: string }>()
  const router = useRouter()
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { status, activeUrl, token } = useConnection()

  // The replica: what an offline visit reads, and what covers a failed fetch.
  const digest = db.useDigests().find(d => d.id === id)
  const storedIssues = db.useDigestIssues(id)

  // Both carry what they belong to: the drawer keeps this screen mounted, so a visit
  // to another Digest starts with the previous one's answers still in state.
  const [fetchedIssues, setFetchedIssues] = useState<{ digestId: string; list: DigestIssue[] } | null>(null)
  const [fetchedIssue, setFetchedIssue] = useState<DigestIssue | null>(null)

  const online = status === 'connected' && !!activeUrl && !!token
  const issues = online && fetchedIssues?.digestId === id ? fetchedIssues.list : storedIssues
  // The picker writes the route param, so the selection is the URL's. "Run now" lands
  // here naming an issue whose row only appears once the Job starts.
  const selectedId = issueParam ?? issues[0]?.id ?? null
  const listed = issues.find(i => i.id === selectedId)
  const storedIssue = db.useDigestIssue(selectedId)
  const awaited = !!selectedId && !listed
  const unfinished = awaited || listed?.status === 'running'

  // The issue list: once, then again while the selected run has not finished.
  useEffect(() => {
    if (!online || !activeUrl || !token) return
    let live = true
    const pull = () => fetchDigestIssues(activeUrl, token, id)
      .then(list => { if (live) setFetchedIssues({ digestId: id, list: list ?? [] }) })
      .catch(() => { if (live) setFetchedIssues(null) })
    void pull()
    if (!unfinished) return () => { live = false }
    const timer = setInterval(pull, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [online, activeUrl, token, id, unfinished])

  // The selected issue with its refs resolved — only once the list holds it (asking
  // earlier is a 404), and again whenever its row moves.
  const listedId = listed?.id
  const listedRev = listed?.rev
  useEffect(() => {
    if (!online || !activeUrl || !token || !listedId) return
    let live = true
    fetchDigestIssue(activeUrl, token, listedId)
      .then(issue => { if (live) setFetchedIssue(issue) })
      .catch(() => { /* the replica's copy below covers it */ })
    return () => { live = false }
  }, [online, activeUrl, token, listedId, listedRev])

  const issue = online && fetchedIssue?.id === selectedId ? fetchedIssue : storedIssue
  const groups = useMemo(() => {
    const titles = Object.fromEntries((digest?.questions ?? []).map(q => [q.id, q.title]))
    return issue ? groupTopics(issue, titles) : []
  }, [issue, digest])

  function renderRef(ref: DigestRef, key: string) {
    if (ref.missing || !ref.document_id) {
      return <Text key={key} style={s.refMissing}>• The Highlight this pointed at is no longer available.</Text>
    }
    const documentId = ref.document_id
    const open = () => router.push(`/document/${documentId}`)
    return (
      <Pressable
        key={key}
        style={s.ref}
        onPress={open}
        accessibilityRole="link"
        accessibilityLabel={`Open ${ref.history ? 'earlier source' : 'source'}: ${ref.document_title ?? ''}`}
      >
        {/* The stored Highlight text is markdown. A link inside it takes the press, so
            it goes where the rest of the bullet does: the source Document. */}
        <MarkdownBody onLinkAction={open} onDocumentPress={open}>{ref.text ?? ''}</MarkdownBody>
        {/* Offline there is no Feed title to show — the replica has no Feeds. */}
        <Text style={s.refFrom} numberOfLines={1}>
          {[ref.history ? `Earlier · ${ref.date ?? ''}` : '', ref.feed_title, ref.document_title].filter(Boolean).join(' · ')} →
        </Text>
      </Pressable>
    )
  }

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.headerBar}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/digests'))}
          style={s.backBtn}
          hitSlop={12}
          accessibilityLabel="Back to digests"
        >
          <Text style={s.backText}>←</Text>
        </Pressable>
        {digest
          ? <DigestChip name={digest.name} color={digest.color} size="md" testID="digest-issue-name" />
          : <Text style={s.headerTitle} numberOfLines={1}>Digest</Text>}
      </View>

      {issues.length > 0 ? (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.picker}>
            {issues.map(i => (
              <Pressable
                key={i.id}
                style={[s.chip, i.id === selectedId && s.chipOn]}
                onPress={() => router.setParams({ issue: i.id })}
                accessibilityLabel={`Issue ${issueDate(i.window_end)}`}
              >
                <Text style={[s.chipText, i.id === selectedId && s.chipTextOn]}>
                  {issueDate(i.window_end)}{i.status === 'done' ? '' : ` · ${i.status}`}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={s.body}>
        {awaited ? (
          <View style={s.notice}>
            {online ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
            <Text style={s.noticeText}>
              {online ? 'Queued — waiting for the run to start…' : 'This issue has not reached this device yet.'}
            </Text>
          </View>
        ) : null}
        {!selectedId ? (
          <Text style={s.empty}>No issues yet. Run the digest from its editor, or wait for its schedule.</Text>
        ) : null}

        {issue ? (
          <>
            <Text style={s.window}>
              Highlights from {formatWhen(issue.window_start)} to {formatWhen(issue.window_end)}
            </Text>
            {issue.status === 'running' ? (
              <View style={s.notice}>
                <ActivityIndicator size="small" color={theme.colors.accent} />
                <Text style={s.noticeText}>Running — asking the questions…</Text>
              </View>
            ) : null}
            {issue.status === 'empty' ? (
              <View style={s.notice}>
                <Text style={s.noticeText}>
                  Empty: these newsletters produced no new Highlights in this window, so nothing was asked.
                </Text>
              </View>
            ) : null}
            {issue.status === 'failed' ? (
              <View style={[s.notice, s.noticeError]}>
                <Text style={s.errorText}>
                  This run failed{issue.metadata.error ? `: ${issue.metadata.error}` : '.'}
                </Text>
              </View>
            ) : null}

            {groups.map(group => (
              <View key={group.id} style={s.group}>
                <Text style={s.question}>{group.title || 'Question'}</Text>
                {group.meta?.truncated ? (
                  <Text style={s.truncated}>
                    Truncated: only the newest {group.meta.candidates_sent} of {group.meta.candidates} items
                    fit the model — older ones were not read.
                  </Text>
                ) : null}
                {group.topics.length === 0 ? <Text style={s.noTopics}>Nothing answered this question.</Text> : null}
                {group.topics.map(topic => (
                  <View key={topic.rank} style={s.topic}>
                    <Text style={s.topicTitle}>{topic.rank}. {topic.title}</Text>
                    {topic.why ? <Text style={s.why}>{topic.why}</Text> : null}
                    {topic.diff ? (
                      <Text style={s.diff} testID={`digest-topic-diff-${topic.rank}`}>
                        <Text style={s.diffVs}>vs {topic.previous}: </Text>{topic.diff}
                      </Text>
                    ) : null}
                    {topic.refs.map((ref, i) => renderRef(ref, `${ref.highlight_id}:${ref.bullet}:${i}`))}
                  </View>
                ))}
              </View>
            ))}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    headerBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
      backgroundColor: t.colors.surface,
    },
    backBtn: { flexShrink: 0, padding: t.spacing.sm },
    backText: { color: t.colors.accent, fontSize: 20, fontWeight: '400' },
    headerTitle: { flex: 1, color: t.colors.text, fontSize: 16, fontWeight: '700' },
    picker: { flexDirection: 'row', gap: t.spacing.sm, padding: t.spacing.sm },
    chip: {
      paddingHorizontal: t.spacing.sm,
      paddingVertical: 4,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    chipOn: { backgroundColor: t.colors.accent + '22', borderColor: t.colors.accent },
    chipText: { color: t.colors.muted, fontSize: 12 },
    chipTextOn: { color: t.colors.accent, fontWeight: '700' },
    body: { padding: t.spacing.md, maxWidth: 800, alignSelf: 'center', width: '100%' },
    empty: { color: t.colors.muted, fontSize: 14, textAlign: 'center', padding: t.spacing.xl },
    window: { color: t.colors.placeholder, fontSize: 11, marginBottom: t.spacing.sm },
    notice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      padding: t.spacing.sm,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
      marginBottom: t.spacing.sm,
    },
    noticeError: { borderColor: t.colors.error, backgroundColor: t.colors.error + '18' },
    noticeText: { flex: 1, color: t.colors.muted, fontSize: 13 },
    errorText: { flex: 1, color: t.colors.error, fontSize: 13 },
    group: { marginTop: t.spacing.md },
    question: { color: t.colors.accent, fontSize: 17, fontWeight: '800', marginBottom: t.spacing.xs },
    truncated: { color: t.colors.error, fontSize: 12, marginBottom: t.spacing.xs },
    noTopics: { color: t.colors.placeholder, fontSize: 13, fontStyle: 'italic' },
    topic: {
      backgroundColor: t.colors.surface,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.colors.border,
      padding: t.spacing.md,
      marginTop: t.spacing.sm,
    },
    topicTitle: { color: t.colors.text, fontSize: 15, fontWeight: '700' },
    why: { color: t.colors.muted, fontSize: 13, marginTop: 2, marginBottom: t.spacing.xs },
    diff: { color: t.colors.text, fontSize: 13, marginBottom: t.spacing.xs },
    diffVs: { fontWeight: '700' },
    ref: { paddingTop: t.spacing.xs, paddingBottom: t.spacing.sm, borderTopWidth: 1, borderTopColor: t.colors.border + '55' },
    refFrom: { color: t.colors.accent, fontSize: 11, marginTop: 2 },
    refMissing: { color: t.colors.placeholder, fontSize: 12, fontStyle: 'italic', paddingVertical: t.spacing.xs },
  })
}
