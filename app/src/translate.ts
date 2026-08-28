// Translation for the selection context menu. Two engines behind one call, so
// the popout never feature-detects:
//   - `llm`     — a normal ad-hoc completion through the Router.
//   - `browser` — Chrome's built-in on-device Translator API (web only, and only
//     where the model is available). Absence is NORMAL, not an error: it falls
//     back to the LLM engine and reports which engine actually ran.
import { askLLM } from './llmAsk'
import { displayLang } from './langNames'

export type TranslateEngine = 'llm' | 'browser'

export type TranslateResult = {
  text: string
  engine: TranslateEngine
  /** Model that served an `llm` translation; empty for the browser engine. */
  model: string
}

// The Chrome built-in surface, typed to what is used here. `self.Translator`
// exists only in recent Chrome; everything else falls back.
type BrowserTranslator = {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>
  create(o: { sourceLanguage: string; targetLanguage: string }): Promise<{
    translate(text: string): Promise<string>
    destroy?: () => void
  }>
}

function browserTranslator(): BrowserTranslator | null {
  const g = globalThis as unknown as { Translator?: BrowserTranslator }
  return typeof g.Translator?.create === 'function' ? g.Translator : null
}

export function hasBrowserTranslator(): boolean {
  return browserTranslator() !== null
}

export function translatePrompt(text: string, lang: string): string {
  return `Translate the following text into ${displayLang(lang)}. `
    + 'Reply with the translation only — no preamble, no notes.\n\n'
    + text
}

export async function translateText(opts: {
  text: string
  lang: string
  engine: TranslateEngine
  sourceLang?: string
  serverUrl: string | null
  token: string | null
  system?: string
  provider?: string
  model?: string
  signal?: AbortSignal
}): Promise<TranslateResult> {
  if (opts.engine === 'browser') {
    const api = browserTranslator()
    if (api) {
      const pair = { sourceLanguage: opts.sourceLang || 'en', targetLanguage: opts.lang || 'en' }
      const available = await api.availability(pair).catch(() => 'unavailable')
      if (available !== 'unavailable') {
        const t = await api.create(pair)
        try {
          return { text: await t.translate(opts.text), engine: 'browser', model: '' }
        } finally {
          t.destroy?.()
        }
      }
    }
    // No built-in translator here (native, or a browser without it) — the LLM is
    // the fallback, and the caller tells the user which engine answered.
  }
  if (!opts.serverUrl || !opts.token) throw new Error('Not connected')
  const res = await askLLM(opts.serverUrl, opts.token, {
    prompt: translatePrompt(opts.text, opts.lang),
    system: opts.system,
    provider: opts.provider,
    model: opts.model,
  }, opts.signal)
  return { text: res.reply, engine: 'llm', model: res.model }
}
