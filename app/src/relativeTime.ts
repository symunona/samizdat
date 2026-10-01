const WEEK_MS = 7 * 24 * 3600 * 1000

// formatRelative renders an ISO timestamp as "5m ago" / "3h ago" / "2d ago",
// falling back to a short date past a week.
export function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const secs = Math.floor((Date.now() - t) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  if (Date.now() - t < WEEK_MS) return `${Math.floor(hrs / 24)}d ago`
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// formatWhen is an absolute "Oct 1, 20:01" plus the relative age — for a moment
// the user needs to place exactly (when did this fail?), not just roughly. Past a
// week the age is already a date, so the absolute stands alone (with its year).
export function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const old = Date.now() - d.getTime() >= WEEK_MS
  const abs = d.toLocaleString(undefined, {
    year: old ? 'numeric' : undefined, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  return old ? abs : `${abs} (${formatRelative(iso)})`
}
