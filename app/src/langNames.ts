// Human-friendly language names for the transcript-language settings. The user
// types a name ("English") or a code ("en"); we store the base code and display
// the name. Uses the built-in Intl.DisplayNames (no data bundle needed).

// A modest set of languages we can resolve a typed NAME back to a code for.
// (Codes typed directly work regardless of this list.)
const COMMON = [
  'en', 'hu', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'ro',
  'cs', 'sk', 'sl', 'hr', 'sr', 'bg', 'tr', 'el', 'ar', 'he', 'fa', 'hi',
  'zh', 'ja', 'ko', 'vi', 'th', 'id', 'sv', 'no', 'da', 'fi', 'is', 'ca',
]

let namer: Intl.DisplayNames | null = null
function displayNames(): Intl.DisplayNames | null {
  if (namer) return namer
  try {
    namer = new Intl.DisplayNames(['en'], { type: 'language' })
  } catch { namer = null }
  return namer
}

// displayLang turns a base code into a readable name ("hu" → "Hungarian").
// Falls back to the uppercased code when the platform can't resolve it.
export function displayLang(code: string): string {
  const n = displayNames()
  if (n) {
    try {
      const name = n.of(code)
      if (name && name.toLowerCase() !== code.toLowerCase()) return name
    } catch { /* fall through */ }
  }
  return code.toUpperCase()
}

// parseLangInput accepts a language name ("English", "hungarian") or a code
// ("en", "hu", "pt-BR") and returns the base code, or null if unrecognized.
export function parseLangInput(raw: string): string | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null
  const base = s.split(/[-_ ]/)[0]
  // A short token is treated as a code.
  if (/^[a-z]{2,3}$/.test(s)) return base
  // Otherwise match against known language names.
  const hit = COMMON.find(c => displayLang(c).toLowerCase() === s)
  if (hit) return hit
  return /^[a-z]{2,3}$/.test(base) ? base : null
}
