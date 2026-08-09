import { useEffect, useMemo, useRef } from 'react'
import { Platform, Pressable, StyleSheet, Text } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useToast } from './ToastContext'

// The feed is ordered by the INGEST date (highlights.created_at DESC — server
// queries.sql ListHighlights, replica db/hooks.ts selectHighlights). So that is the
// date the stamp shows: a list sorted by one date and labelled with another reads as
// unsorted. The article's own publication date stays one reveal away.
//
// Reveal branches on pointer capability, not Platform.OS (app/CLAUDE.md): a fine
// pointer gets a real hover tooltip, a coarse one gets the detail on long-press.

type Props = {
  ingestedAt?: string | null
  publishedAt?: string | null
}

const DAY: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
const MINUTE: Intl.DateTimeFormatOptions = { ...DAY, hour: '2-digit', minute: '2-digit' }

function fmt(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d.toLocaleString(undefined, opts)
}

export default function DateStamp({ ingestedAt, publishedAt }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { toast } = useToast()

  const label = fmt(ingestedAt, DAY) ?? fmt(publishedAt, DAY)
  const detail = useMemo(() => {
    const lines: string[] = []
    const ingested = fmt(ingestedAt, MINUTE)
    const published = fmt(publishedAt, DAY)
    if (ingested) lines.push(`Ingested ${ingested}`)
    if (published) lines.push(`Article created ${published}`)
    return lines.join('\n')
  }, [ingestedAt, publishedAt])

  // react-native-web drops an unknown `title` prop, so the tooltip is written onto the
  // host node itself. Native has no such attribute and ignores this.
  const ref = useRef<Text>(null)
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const el = ref.current as unknown as HTMLElement | null
    if (el?.setAttribute) el.setAttribute('title', detail)
  }, [detail])

  if (!label) return null
  return (
    <Pressable onLongPress={() => { if (detail) toast(detail) }} delayLongPress={350} hitSlop={6}>
      <Text ref={ref} style={s.text} accessibilityLabel={detail}>{label}</Text>
    </Pressable>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    text: { color: t.colors.muted, fontSize: 11, opacity: 0.8 },
  })
}
