import { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useUnistyles } from 'react-native-unistyles'
import { createDigest, deleteDigest, patchDigest, runDigest } from './api'
import type { Digest, DigestConfig, DigestPeriod, DigestQuestion, DigestRunQueued, Feed } from './api'
import ColorSwatches from './ColorSwatches'
import { useConfirm } from './ConfirmContext'
import { useConnection } from './ConnectionContext'
import IconButton from './IconButton'
import ModelField from './ModelField'
import { PALETTE } from './tagColor'
import { useToast } from './ToastContext'
import { uuidv4 } from './store/uuid'

// Monday first, as a week is read; the values are the server's time.Weekday numbers.
const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
]

// "Weekly · Tue, Fri · 07:00" — the one line a Digest's schedule reads as.
export function periodSummary(d: Pick<DigestConfig, 'period' | 'weekdays' | 'hour'>): string {
  const at = `${String(d.hour).padStart(2, '0')}:00`
  if (d.period !== 'weekly') return `Daily · ${at}`
  const days = WEEKDAYS.filter(w => d.weekdays.includes(w.value)).map(w => w.label)
  return `Weekly · ${days.join(', ')} · ${at}`
}

// A question as the editor holds it. `key` is local (a new question has no id until
// the server mints one); the numbers are text so a half-typed field is not coerced.
type QuestionDraft = Omit<DigestQuestion, 'top_n'> & { key: string; topN: string }

type Draft = Omit<DigestConfig, 'hour' | 'questions'> & { hour: string; questions: QuestionDraft[] }

const toQuestionDraft = (q: DigestQuestion): QuestionDraft => ({
  key: uuidv4(), id: q.id, title: q.title, prompt: q.prompt, enabled: q.enabled, history: !!q.history,
  topN: String(q.top_n),
})

// A new Digest starts empty: no name, no question, no newsletter picked.
function toDraft(digest: Digest | null): Draft {
  return {
    name: digest?.name ?? '',
    enabled: digest?.enabled ?? true,
    period: digest?.period ?? 'daily',
    weekdays: digest?.weekdays ?? [],
    hour: String(digest?.hour ?? 7),
    source_feed_ids: digest?.source_feed_ids ?? [],
    questions: (digest?.questions ?? []).map(toQuestionDraft),
    provider: digest?.provider ?? '',
    model: digest?.model ?? '',
    color: digest?.color ?? '',
  }
}

// Throws with a readable reason for what the number fields hold; everything else
// is the server's to validate, and its message is shown as it comes.
function toConfig(draft: Draft): DigestConfig {
  const hour = Number(draft.hour)
  if (draft.hour.trim() === '' || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error('Hour must be a whole number from 0 to 23')
  }
  const questions = draft.questions.map((q, i) => {
    // Blank = 0, which the server reads as "its default".
    const topN = Number(q.topN || 0)
    if (!Number.isInteger(topN) || topN < 0) throw new Error(`Question ${i + 1}: top N must be a whole number`)
    return { id: q.id, title: q.title, prompt: q.prompt, enabled: q.enabled, history: !!q.history, top_n: topN }
  })
  return { ...draft, hour, questions }
}

const PROMPT_LINE_H = 18
const PROMPT_LINES = 4

type Props = {
  digest: Digest | null   // null = a new one
  feeds: Feed[]           // the subscribed Feeds, plus any this Digest already names
  feedsWithHighlights: Set<string>
  onSaved: (digest: Digest) => void
  onDeleted: (id: string) => void
  onRan: (digest: Digest, queued: DigestRunQueued) => void
  onCancel: () => void
}

// Online-only, like the pipeline step editor: a Digest is server config, so every
// button here is a direct API call and none of it is queued.
export default function DigestEditor({
  digest, feeds, feedsWithHighlights, onSaved, onDeleted, onRan, onCancel,
}: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { activeUrl, token } = useConnection()
  const { toast } = useToast()
  const { confirm } = useConfirm()

  const [draft, setDraft] = useState<Draft>(() => toDraft(digest))
  const [busy, setBusy] = useState<'save' | 'run' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Every edit goes through here: a refusal printed above Save describes the draft as
  // it was, so it goes as soon as the draft changes.
  const edit = (fn: (prev: Draft) => Draft) => { setError(null); setDraft(fn) }
  const set = (patch: Partial<Draft>) => edit(prev => ({ ...prev, ...patch }))
  const toggleIn = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])

  const setQuestion = (key: string, patch: Partial<QuestionDraft>) =>
    edit(prev => ({ ...prev, questions: prev.questions.map(q => (q.key === key ? { ...q, ...patch } : q)) }))

  function moveQuestion(index: number, by: -1 | 1) {
    edit(prev => {
      const to = index + by
      if (to < 0 || to >= prev.questions.length) return prev
      const questions = [...prev.questions]
      ;[questions[index], questions[to]] = [questions[to], questions[index]]
      return { ...prev, questions }
    })
  }

  // One wrapper for the three buttons: busy state, the server's reason on the
  // editor AND in a toast.
  async function act(kind: 'save' | 'run' | 'delete', fn: (url: string, tok: string) => Promise<void>) {
    if (!activeUrl || !token || busy) return
    setBusy(kind)
    setError(null)
    try {
      await fn(activeUrl, token)
    } catch (e) {
      const msg = e instanceof Error ? e.message : `Failed to ${kind} the digest`
      setError(msg)
      toast(msg, 'error')
    } finally {
      setBusy(null)
    }
  }

  const save = () => act('save', async (url, tok) => {
    const config = toConfig(draft)
    const saved = digest ? await patchDigest(url, tok, digest.id, config) : await createDigest(url, tok, config)
    setDraft(toDraft(saved))
    toast('Digest saved', 'success')
    onSaved(saved)
  })

  const run = (saved: Digest) => act('run', async (url, tok) => {
    onRan(saved, await runDigest(url, tok, saved.id))
  })

  const remove = (saved: Digest) => act('delete', async (url, tok) => {
    const yes = await confirm({
      title: 'Delete digest',
      message: `Delete "${saved.name}" and every issue it produced?`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!yes) return
    await deleteDigest(url, tok, saved.id)
    onDeleted(saved.id)
  })

  const switchColors = { trackColor: { false: theme.colors.border, true: theme.colors.accent }, thumbColor: theme.colors.background }

  return (
    <View style={s.editor}>
      <Text style={s.label}>Name</Text>
      <TextInput
        style={s.input}
        value={draft.name}
        onChangeText={name => set({ name })}
        accessibilityLabel="Digest name"
        placeholder="AI weekly"
        placeholderTextColor={theme.colors.placeholder}
      />

      <Text style={s.label}>Color</Text>
      <ColorSwatches colors={PALETTE} value={draft.color} onChange={color => set({ color })} label="Digest color" />
      {draft.color === '' ? <Text style={s.hint}>None picked: saving takes the first color no other digest uses.</Text> : null}

      <Text style={s.label}>Schedule</Text>
      <View style={s.chips}>
        {(['daily', 'weekly'] as DigestPeriod[]).map(period => (
          <Pressable
            key={period}
            style={[s.chip, draft.period === period && s.chipOn]}
            onPress={() => set({ period })}
            accessibilityLabel={`Period ${period}`}
          >
            <Text style={[s.chipText, draft.period === period && s.chipTextOn]}>{period}</Text>
          </Pressable>
        ))}
        <Text style={s.inlineLabel}>at hour</Text>
        <TextInput
          style={[s.input, s.numberInput]}
          value={draft.hour}
          onChangeText={hour => set({ hour })}
          accessibilityLabel="Hour"
          inputMode="numeric"
          maxLength={2}
        />
        <Text style={s.hint}>server time</Text>
      </View>
      {draft.period === 'weekly' ? (
        <View style={s.chips}>
          {WEEKDAYS.map(w => {
            const on = draft.weekdays.includes(w.value)
            return (
              <Pressable
                key={w.value}
                style={[s.chip, on && s.chipOn]}
                onPress={() => set({ weekdays: toggleIn(draft.weekdays, w.value) })}
                accessibilityLabel={`Weekday ${w.label}`}
                aria-selected={on}
              >
                <Text style={[s.chipText, on && s.chipTextOn]}>{w.label}</Text>
              </Pressable>
            )
          })}
        </View>
      ) : null}

      <Text style={s.label}>Newsletters</Text>
      {/* Hold is the pick: an enabled Digest keeps its picked newsletters' Highlights
          out of the feed. Reading every Feed holds none — that would empty the feed. */}
      <Text style={s.hint} testID="digest-scope-note">
        {draft.source_feed_ids.length === 0
          ? 'None picked: reads every Feed. Pick newsletters to keep their Highlights out of the feed.'
          : `${draft.source_feed_ids.length} picked. Their new Highlights skip the feed and wait for the next issue; pinned ones stay.`}
      </Text>
      {feeds.length === 0 ? <Text style={s.hint}>No subscriptions yet.</Text> : null}
      {feeds.map(feed => {
        const on = draft.source_feed_ids.includes(feed.id)
        const title = feed.title || feed.url
        return (
          <Pressable
            key={feed.id}
            style={s.feedRow}
            onPress={() => set({ source_feed_ids: toggleIn(draft.source_feed_ids, feed.id) })}
            role="checkbox"
            aria-checked={on}
            accessibilityLabel={`Newsletter ${title}`}
          >
            <Ionicons
              name={on ? 'checkbox' : 'square-outline'}
              size={18}
              color={on ? theme.colors.accent : theme.colors.muted}
            />
            <Text style={s.feedTitle} numberOfLines={1}>{title}</Text>
            {/* A Digest reads Highlights, never Documents: a Feed no Pipeline has
                turned into Highlights contributes nothing, and says so here. */}
            {feedsWithHighlights.has(feed.id) ? null : <Text style={s.feedMarker}>no Highlights yet</Text>}
          </Pressable>
        )
      })}

      <Text style={s.label}>Questions</Text>
      {draft.questions.length === 0 ? <Text style={[s.hint, s.hintAbove]}>No questions yet — a digest needs at least one.</Text> : null}
      {draft.questions.map((q, i) => {
        const n = i + 1
        return (
          <View key={q.key} style={s.question}>
            <View style={s.questionHead}>
              <Switch
                value={q.enabled}
                onValueChange={enabled => setQuestion(q.key, { enabled })}
                accessibilityLabel={`Question ${n} enabled`}
                {...switchColors}
              />
              <TextInput
                style={[s.input, s.grow]}
                value={q.title}
                onChangeText={title => setQuestion(q.key, { title })}
                accessibilityLabel={`Question ${n} title`}
                placeholder="Title"
                placeholderTextColor={theme.colors.placeholder}
              />
              <IconButton name="chevron-up" size={16} onPress={() => moveQuestion(i, -1)} accessibilityLabel={`Move question ${n} up`} />
              <IconButton name="chevron-down" size={16} onPress={() => moveQuestion(i, 1)} accessibilityLabel={`Move question ${n} down`} />
              <IconButton
                name="trash-outline"
                size={16}
                onPress={() => set({ questions: draft.questions.filter(x => x.key !== q.key) })}
                accessibilityLabel={`Remove question ${n}`}
              />
            </View>
            <TextInput
              style={[s.input, s.prompt]}
              value={q.prompt}
              onChangeText={prompt => setQuestion(q.key, { prompt })}
              accessibilityLabel={`Question ${n} prompt`}
              placeholder="What should this question find?"
              placeholderTextColor={theme.colors.placeholder}
              multiline
              numberOfLines={PROMPT_LINES}
            />
            <View style={s.chips}>
              <Text style={s.inlineLabel}>top</Text>
              <TextInput
                style={[s.input, s.numberInput]}
                value={q.topN}
                onChangeText={topN => setQuestion(q.key, { topN })}
                accessibilityLabel={`Question ${n} top N`}
                inputMode="numeric"
                maxLength={2}
              />
              <Text style={s.hint}>topics</Text>
            </View>
            {/* A second pass per topic: what changed since the release before it. */}
            <View style={s.chips}>
              <Switch
                value={!!q.history}
                onValueChange={history => setQuestion(q.key, { history })}
                accessibilityLabel={`Question ${n} compare with earlier Highlights`}
                {...switchColors}
              />
              <Text style={s.hint}>Compare each topic with earlier Highlights</Text>
            </View>
          </View>
        )
      })}
      <Pressable
        style={s.button}
        onPress={() => set({
          questions: [...draft.questions, { key: uuidv4(), id: '', title: '', prompt: '', enabled: true, topN: '' }],
        })}
        accessibilityLabel="Add question"
      >
        <Text style={s.buttonText}>+ Add question</Text>
      </Pressable>

      <Text style={s.label}>Model</Text>
      <ModelField
        model={draft.model}
        provider={draft.provider}
        onSelect={choice => set({ model: choice.model, provider: choice.provider })}
        accessibilityLabel="Digest model"
        showProvider
      />

      {error ? <Text style={s.error} role="alert" testID="digest-editor-error">{error}</Text> : null}
      <View style={s.actions}>
        <Pressable
          style={[s.button, s.primary, busy === 'save' && s.busy, !!error && s.primaryError]}
          onPress={save}
          disabled={busy !== null}
          accessibilityLabel="Save digest"
        >
          {busy === 'save'
            ? <ActivityIndicator size="small" color={theme.colors.accent} />
            : <Text style={[s.primaryText, !!error && s.errorText]}>Save</Text>}
        </Pressable>
        {digest ? (
          <Pressable
            style={[s.button, busy === 'run' && s.busy]}
            onPress={() => run(digest)}
            disabled={busy !== null}
            accessibilityLabel="Run digest now"
          >
            {busy === 'run'
              ? <ActivityIndicator size="small" color={theme.colors.accent} />
              : <Text style={s.buttonText}>Run now</Text>}
          </Pressable>
        ) : (
          <Pressable style={s.button} onPress={onCancel} accessibilityLabel="Cancel new digest">
            <Text style={s.buttonText}>Cancel</Text>
          </Pressable>
        )}
        <View style={s.grow} />
        {digest ? (
          busy === 'delete'
            ? <ActivityIndicator size="small" color={theme.colors.error} />
            : <IconButton name="trash-outline" onPress={() => remove(digest)} accessibilityLabel="Delete digest" />
        ) : null}
      </View>
    </View>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    editor: { marginTop: t.spacing.sm, borderTopWidth: 1, borderTopColor: t.colors.border, paddingTop: t.spacing.xs },
    label: { color: t.colors.text, fontSize: 13, fontWeight: '700', marginTop: t.spacing.md, marginBottom: t.spacing.xs },
    inlineLabel: { color: t.colors.muted, fontSize: 12 },
    hint: { color: t.colors.placeholder, fontSize: 11 },
    hintAbove: { marginBottom: t.spacing.sm },
    grow: { flex: 1 },
    input: {
      color: t.colors.text,
      fontSize: 13,
      backgroundColor: t.colors.background,
      borderWidth: 1,
      borderColor: t.colors.border,
      borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: 6,
    },
    numberInput: { width: 48, textAlign: 'center' },
    prompt: { minHeight: PROMPT_LINES * PROMPT_LINE_H, textAlignVertical: 'top', marginTop: t.spacing.xs },
    chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.spacing.sm, marginTop: t.spacing.xs },
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
    feedRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, paddingVertical: 5 },
    feedTitle: { flex: 1, color: t.colors.text, fontSize: 13 },
    feedMarker: { color: t.colors.error, fontSize: 11, fontStyle: 'italic' },
    question: {
      borderWidth: 1,
      borderColor: t.colors.border,
      borderRadius: t.radius.sm,
      padding: t.spacing.sm,
      marginBottom: t.spacing.sm,
    },
    questionHead: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
    actions: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginTop: t.spacing.md },
    button: {
      minWidth: 72,
      alignItems: 'center',
      alignSelf: 'flex-start',
      paddingHorizontal: t.spacing.md,
      paddingVertical: 5,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    buttonText: { color: t.colors.muted, fontSize: 13, fontWeight: '600' },
    primary: { borderColor: t.colors.accent, backgroundColor: t.colors.accent + '22' },
    primaryText: { color: t.colors.accent, fontSize: 13, fontWeight: '700' },
    primaryError: { borderColor: t.colors.error, backgroundColor: t.colors.error + '18' },
    busy: { opacity: 0.6 },
    error: { color: t.colors.error, fontSize: 12, marginTop: t.spacing.sm },
    errorText: { color: t.colors.error },
  })
}
