// Bare host/path typed without a scheme is the common paste-slip; assume https
// rather than rejecting. Returns null when the result still isn't an http(s) URL.
export function normalizeScrapeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  try {
    const u = new URL(hasScheme ? trimmed : `https://${trimmed}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    // A guessed scheme means the user typed a bare host: require a dot so free text
    // ("not a url") is caught here instead of queueing a doomed scrape. An explicit
    // scheme is taken at face value (http://localhost:8765 is legitimate).
    if (!hasScheme && !u.hostname.includes('.')) return null
    return u.toString()
  } catch {
    return null
  }
}
