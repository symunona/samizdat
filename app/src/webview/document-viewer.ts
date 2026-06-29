// document-viewer.ts — compiled to IIFE by `just webview-build`
// Runs inside the WebView/iframe. Communicates with RN via postMessage.
// Only dependency-free imports allowed (esbuild --bundle inlines them); never
// pull in react-native-unistyles here — keep the WebView bundle lean.
import { iconButtonSpec as IB } from '../iconButtonSpec'

// ── Types ────────────────────────────────────────────────────────────────────

type HlData = {
  id: string
  kind: string
  title: string
  bodyHtml: string
  pinned: 0 | 1
}

type ThemeData = {
  background: string
  text: string
  surface: string
  border: string
  accent: string
  muted: string
}

type AnnData = {
  id: string
  exact: string
  prefix: string
  suffix: string
  color: string
  note: string
  pos_start: number
  pos_end: number
}

type SelectionData = {
  exact: string
  prefix: string
  suffix: string
  pos_start: number
  pos_end: number
}

// ── Platform-aware postMessage ────────────────────────────────────────────────

function sendMsg(data: object): void {
  const msg = JSON.stringify(data)
  if ((window as unknown as { ReactNativeWebView?: { postMessage: (s: string) => void } }).ReactNativeWebView) {
    (window as unknown as { ReactNativeWebView: { postMessage: (s: string) => void } }).ReactNativeWebView.postMessage(msg)
  } else if (window.parent && window.parent !== window) {
    window.parent.postMessage(msg, '*')
  }
}

// ── State ────────────────────────────────────────────────────────────────────

let _highlights: HlData[] = []
let _hlExpanded = true
let _initialized = false

// ── CSS injection ─────────────────────────────────────────────────────────────

const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html{--bg:#0b0b0c;--fg:#f4f1ea;--su:#161618;--bo:#26262a;--ac:#e8743b;--mu:#9ca3af}
body{background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.7;padding:16px 20px 80px;max-width:720px;margin:0 auto}
h1,h2,h3,h4{color:var(--fg);margin:1.4em 0 0.5em;line-height:1.3}
h1{font-size:1.6em}h2{font-size:1.35em}h3{font-size:1.15em}
p{margin-bottom:1em}
a{color:var(--ac);text-decoration:none;margin:0 0.15em}a:hover{text-decoration:underline}
a.has-doc::after{content:" 📄";font-size:0.75em;opacity:0.7;margin-left:0.1em}
code{background:var(--su);border-radius:4px;padding:2px 5px;font-family:monospace;font-size:0.9em;color:var(--ac)}
pre{background:var(--su);border-radius:6px;padding:14px;overflow-x:auto;margin-bottom:1em}
pre code{background:none;padding:0;color:var(--fg)}
blockquote{border-left:3px solid var(--ac);padding-left:14px;color:var(--mu);margin-bottom:1em}
img{max-width:100%;border-radius:6px;margin-bottom:1em}
ul,ol{padding-left:1.5em;margin-bottom:1em}
li{margin-bottom:0.3em}
hr{border:none;border-top:1px solid var(--bo);margin:1.5em 0}
mark{background-color:rgba(232,116,59,0.35);color:inherit;border-radius:3px;padding:1px 0;cursor:pointer}
mark.color-yellow{background-color:rgba(250,204,21,0.3)}
mark.color-green{background-color:rgba(74,222,128,0.3)}
mark.color-blue{background-color:rgba(96,165,250,0.3)}
mark.color-pink{background-color:rgba(244,114,182,0.3)}
mark.focused{outline:2px solid rgba(232,116,59,0.8);filter:brightness(1.5);transition:filter 0.3s}
#ann-btn{position:fixed;bottom:80px;right:24px;background:var(--ac);color:var(--bg);border:none;border-radius:20px;padding:8px 16px;font-weight:700;font-size:14px;cursor:pointer;display:none;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,0.4)}
#ann-gutter{position:fixed;top:0;right:0;width:6px;height:100%;pointer-events:none;z-index:90}
#doc-title{font-size:1.6em;font-weight:700;color:var(--fg);margin:0 0 1em;line-height:1.3}

/* Transcript segments (video/podcast documents) */
.seg{cursor:pointer;border-radius:4px;padding:2px 6px;margin:0 -6px 0.35em;transition:background 0.2s,color 0.2s;color:var(--mu)}
.seg:hover{background:var(--su);color:var(--fg)}
.seg.active{background:rgba(232,116,59,0.16);color:var(--fg)}

/* Highlight section */
#hl-section{border:1px solid var(--bo);border-radius:8px;margin-bottom:1.5em;overflow:hidden;background:var(--su)}
#hl-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--su);border:none;border-bottom:1px solid var(--bo);cursor:pointer;color:var(--mu);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px}
#hl-toggle:hover{background:var(--bg)}
#hl-toggle-arrow{font-size:11px;color:var(--mu)}
#hl-list{padding:8px}
#hl-list.collapsed{display:none}

/* Highlight cards */
.hl-card{border:1px solid var(--bo);border-radius:6px;margin-bottom:8px;overflow:hidden;background:var(--bg)}
.hl-card:last-child{margin-bottom:0}
.hl-card.focused{outline:2px solid var(--ac);box-shadow:0 0 10px rgba(232,116,59,0.45);transition:box-shadow 0.3s}
.hl-header{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--bo);background:var(--su)}
.hl-kind{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:2px 6px;border-radius:4px;flex-shrink:0}
.hl-kind-summary{background:rgba(232,116,59,0.15);color:var(--ac)}
.hl-kind-link{background:rgba(96,165,250,0.15);color:#60a5fa}
.hl-kind-note{background:rgba(74,222,128,0.15);color:#4ade80}
.hl-kind-item{background:rgba(250,204,21,0.15);color:#facc15}
.hl-title{flex:1;font-size:13px;font-weight:600;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hl-pin-btn{background:none;border:none;cursor:pointer;font-size:16px;padding:0 4px;color:var(--mu);line-height:1;flex-shrink:0}
.hl-pin-btn.pinned{color:var(--ac)}
.hl-body{padding:8px 10px;font-size:14px;line-height:1.6;color:var(--fg)}
.hl-body p{margin-bottom:0.5em}
.hl-body p:last-child{margin-bottom:0}
.hl-body a{color:var(--ac)}
.hl-footer{display:flex;align-items:center;gap:6px;padding:6px 10px;border-top:1px solid var(--bo);background:var(--su)}
/* Flat icon buttons — mirror RN IconButton (src/IconButton.tsx). Borderless,
   transparent; hover fills the background + scales. Geometry from the shared
   iconButtonSpec so both renderers stay in lockstep — see src/iconButtonSpec.ts. */
.hl-icon-btn{background:transparent;border:none;cursor:pointer;color:var(--mu);line-height:0;flex-shrink:0;display:flex;align-items:center;justify-content:center;padding:${IB.padY}px ${IB.padX}px;border-radius:${IB.radius}px;transition:background 0.12s,transform 0.12s}
.hl-icon-btn:hover{background:var(--bg);color:var(--fg);transform:scale(${IB.hoverScale})}
.hl-icon-btn svg{width:${IB.size}px;height:${IB.size}px;display:block}
.hl-delete-btn:hover{color:#b91c1c}
.hl-spacer{flex:1}
`

function injectBaseStyles(): void {
  const style = document.createElement('style')
  style.id = 'dv-base'
  style.textContent = BASE_CSS
  document.head.appendChild(style)
}

function setTheme(theme: ThemeData): void {
  const root = document.documentElement
  root.style.setProperty('--bg', theme.background)
  root.style.setProperty('--fg', theme.text)
  root.style.setProperty('--su', theme.surface)
  root.style.setProperty('--bo', theme.border)
  root.style.setProperty('--ac', theme.accent)
  root.style.setProperty('--mu', theme.muted)
}

// ── Highlight rendering ───────────────────────────────────────────────────────

function renderHighlightCard(hl: HlData): HTMLElement {
  const card = document.createElement('div')
  card.className = 'hl-card'
  card.dataset.id = hl.id

  const header = document.createElement('div')
  header.className = 'hl-header'

  const kindSpan = document.createElement('span')
  kindSpan.className = `hl-kind hl-kind-${hl.kind}`
  kindSpan.textContent = hl.kind

  const titleSpan = document.createElement('span')
  titleSpan.className = 'hl-title'
  titleSpan.title = hl.title
  titleSpan.textContent = hl.title

  const pinBtn = document.createElement('button')
  pinBtn.className = 'hl-pin-btn' + (hl.pinned === 1 ? ' pinned' : '')
  pinBtn.dataset.id = hl.id
  pinBtn.dataset.action = 'pin'
  pinBtn.textContent = hl.pinned === 1 ? '★' : '☆'
  pinBtn.title = hl.pinned === 1 ? 'Unpin' : 'Pin'

  header.appendChild(kindSpan)
  header.appendChild(titleSpan)
  header.appendChild(pinBtn)

  const body = document.createElement('div')
  body.className = 'hl-body'
  body.innerHTML = hl.bodyHtml

  const footer = document.createElement('div')
  footer.className = 'hl-footer'

  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'hl-icon-btn hl-delete-btn'
  deleteBtn.dataset.id = hl.id
  deleteBtn.dataset.action = 'delete'
  // Ionicons trash-outline — mirrors IconButton "trash-outline" in HighlightCard.tsx (parity).
  deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 512 512" aria-hidden="true"><path d="M112 112l20 320c.95 18.49 14.4 32 32 32h184c17.67 0 30.87-13.51 32-32l20-320" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32"/><path stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32" d="M80 112h352"/><path d="M192 112V72h0a23.93 23.93 0 0124-24h80a23.93 23.93 0 0124 24h0v40M256 176v224M184 176l8 224M328 176l-8 224" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32"/></svg>'
  deleteBtn.title = 'Delete highlight'

  const spacer = document.createElement('div')
  spacer.className = 'hl-spacer'

  const tagsBtn = document.createElement('button')
  tagsBtn.className = 'hl-icon-btn'
  tagsBtn.dataset.id = hl.id
  tagsBtn.dataset.action = 'tags'
  // Ionicons pricetag-outline — mirrors IconButton "pricetag-outline" in HighlightCard.tsx (parity).
  tagsBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 512 512" aria-hidden="true"><path d="M435.25 48h-122.9a14.46 14.46 0 00-10.2 4.2L56.45 297.9a28.85 28.85 0 000 40.7l117 117a28.85 28.85 0 0040.7 0L459.75 210a14.46 14.46 0 004.2-10.2v-123a28.66 28.66 0 00-28.7-28.8z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32"/><path d="M384 160a32 32 0 1132-32 32 32 0 01-32 32z"/></svg>'
  tagsBtn.title = 'Tags'

  const annotateBtn = document.createElement('button')
  annotateBtn.className = 'hl-icon-btn'
  annotateBtn.dataset.id = hl.id
  annotateBtn.dataset.action = 'annotate'
  annotateBtn.title = 'Add note'
  annotateBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 512 512" aria-hidden="true"><path d="M384 224v184a40 40 0 01-40 40H104a40 40 0 01-40-40V168a40 40 0 0140-40h167.48" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/><path d="M459.94 53.25a16.06 16.06 0 00-23.22-.56L424 65l89 89 12.74-12.68a16.06 16.06 0 00-.56-23.22zM399.34 90L218.82 270.2a9 9 0 00-2.31 4.38l-8.4 45.23a5.13 5.13 0 006 6l45.23-8.4a9 9 0 004.38-2.31L483 134.66z" fill="currentColor"/></svg>'

  footer.appendChild(deleteBtn)
  footer.appendChild(spacer)
  footer.appendChild(tagsBtn)
  footer.appendChild(annotateBtn)

  card.appendChild(header)
  card.appendChild(body)
  card.appendChild(footer)
  return card
}

function renderHighlights(): void {
  const section = document.getElementById('hl-section')
  if (!section) return

  const toggle = section.querySelector<HTMLButtonElement>('#hl-toggle')
  if (toggle) {
    const counter = toggle.querySelector<HTMLSpanElement>('#hl-counter')
    if (counter) counter.textContent = `Highlights (${_highlights.length})`
    const arrow = toggle.querySelector<HTMLSpanElement>('#hl-toggle-arrow')
    if (arrow) arrow.textContent = _hlExpanded ? '▲' : '▼'
  }

  const list = document.getElementById('hl-list')
  if (!list) return
  list.innerHTML = ''
  list.className = _hlExpanded ? 'expanded' : 'collapsed'
  for (const hl of _highlights) {
    list.appendChild(renderHighlightCard(hl))
  }
}

function createHighlightsSection(): HTMLElement {
  const section = document.createElement('div')
  section.id = 'hl-section'

  const toggle = document.createElement('button')
  toggle.id = 'hl-toggle'
  toggle.dataset.action = 'toggle'

  const counter = document.createElement('span')
  counter.id = 'hl-counter'
  counter.textContent = `Highlights (${_highlights.length})`

  const arrow = document.createElement('span')
  arrow.id = 'hl-toggle-arrow'
  arrow.textContent = _hlExpanded ? '▲' : '▼'

  toggle.appendChild(counter)
  toggle.appendChild(arrow)

  const list = document.createElement('div')
  list.id = 'hl-list'
  list.className = _hlExpanded ? 'expanded' : 'collapsed'

  section.appendChild(toggle)
  section.appendChild(list)
  return section
}

// ── Annotation marking ────────────────────────────────────────────────────────

function visibleWalker(): TreeWalker {
  return document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Node): number {
        let p = node.parentNode
        while (p && p !== document.body) {
          const t = (p as Element).nodeName.toUpperCase()
          if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT
          p = p.parentNode
        }
        return NodeFilter.FILTER_ACCEPT
      },
    },
  )
}

function getBodyText(): string {
  const w = visibleWalker()
  const parts: string[] = []
  while (w.nextNode()) parts.push((w.currentNode as Text).nodeValue ?? '')
  return parts.join('')
}

function getCharOffset(range: Range): number {
  const w = visibleWalker()
  let offset = 0
  while (w.nextNode()) {
    const node = w.currentNode as Text
    if (node === range.startContainer) return offset + range.startOffset
    offset += node.nodeValue?.length ?? 0
  }
  return 0
}

function getContext(range: Range, n: number): { prefix: string; suffix: string } {
  const body = getBodyText()
  const start = getCharOffset(range)
  return {
    prefix: body.substring(Math.max(0, start - n), start),
    suffix: body.substring(start + range.toString().length, start + range.toString().length + n),
  }
}

function colorForClass(cls: string): string {
  if (cls === 'color-yellow') return 'rgba(250,204,21,0.8)'
  if (cls === 'color-green') return 'rgba(74,222,128,0.8)'
  if (cls === 'color-blue') return 'rgba(96,165,250,0.8)'
  if (cls === 'color-pink') return 'rgba(244,114,182,0.8)'
  return 'rgba(232,116,59,0.8)'
}

function updateGutter(): void {
  const gutter = document.getElementById('ann-gutter')
  if (!gutter) return
  gutter.innerHTML = ''
  const total = document.body.scrollHeight
  if (total <= 0) return
  document.querySelectorAll<HTMLElement>('mark[data-ann-id]').forEach(m => {
    const top = m.getBoundingClientRect().top + window.scrollY
    const pct = Math.min(98, (top / total) * 100)
    const dot = document.createElement('div')
    dot.style.cssText = 'position:absolute;right:0;left:0;height:14px;border-radius:2px 0 0 2px;cursor:pointer;pointer-events:auto;transition:left 0.12s;'
    dot.style.top = pct + '%'
    dot.style.backgroundColor = colorForClass(m.className)
    dot.dataset.annId = m.dataset.annId
    dot.addEventListener('mouseenter', function (this: HTMLElement) { this.style.left = '-2px' })
    dot.addEventListener('mouseleave', function (this: HTMLElement) { this.style.left = '0' })
    dot.addEventListener('click', (e: Event) => {
      e.stopPropagation()
      m.scrollIntoView({ behavior: 'smooth', block: 'center' })
      sendMsg({ type: 'tap_annotation', id: m.dataset.annId })
    })
    gutter.appendChild(dot)
  })
}

function highlightTextNode(exact: string, charIdx: number, annId: string, color: string): void {
  const w = visibleWalker()
  let offset = 0
  while (w.nextNode()) {
    const node = w.currentNode as Text
    const len = node.nodeValue?.length ?? 0
    if (offset + len > charIdx) {
      const start = charIdx - offset
      if (start + exact.length > len) { offset += len; continue }
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + exact.length)
      const mark = document.createElement('mark')
      mark.className = 'color-' + color
      mark.dataset.annId = annId
      range.surroundContents(mark)
      return
    }
    offset += len
  }
}

function applyMark(a: AnnData): void {
  const text = getBodyText()
  let idx = -1
  if (a.pos_start > 0 && a.pos_end > a.pos_start) {
    if (text.substring(a.pos_start, a.pos_end) === a.exact) idx = a.pos_start
  }
  if (idx < 0) idx = text.indexOf(a.exact)
  if (idx < 0) return
  highlightTextNode(a.exact, idx, a.id, a.color || 'yellow')
}

function addMark(a: AnnData): void {
  applyMark(a)
  setTimeout(updateGutter, 50)
}

function removeMark(id: string): void {
  document.querySelectorAll<HTMLElement>(`mark[data-ann-id="${id}"]`).forEach(m => {
    const p = m.parentNode
    if (!p) return
    while (m.firstChild) p.insertBefore(m.firstChild, m)
    p.removeChild(m)
  })
  updateGutter()
}

// ── Transcript (video documents) ───────────────────────────────────────────────
// Real user scrolls suppress auto-follow for a short window so playback doesn't
// yank the view while the user is reading elsewhere.
let _lastUserScroll = 0
window.addEventListener('wheel', () => { _lastUserScroll = Date.now() }, { passive: true })
window.addEventListener('touchmove', () => { _lastUserScroll = Date.now() }, { passive: true })

function segEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.seg[data-start-ms]'))
}

function activeSegIndex(els: HTMLElement[], ms: number): number {
  let idx = -1
  for (let i = 0; i < els.length; i++) {
    if (Number(els[i].dataset.startMs) <= ms) idx = i
    else break
  }
  return idx
}

function setActiveSeg(ms: number): void {
  const els = segEls()
  const idx = activeSegIndex(els, ms)
  els.forEach((el, i) => el.classList.toggle('active', i === idx))
  if (idx >= 0 && Date.now() - _lastUserScroll > 2500) {
    els[idx].scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

function segCharOffset(el: HTMLElement): number {
  const tn = el.firstChild
  if (!tn || tn.nodeType !== Node.TEXT_NODE) return 0
  const r = document.createRange()
  r.setStart(tn, 0)
  return getCharOffset(r)
}

// Build a {exact,prefix,suffix,pos_start,pos_end} anchor around the active
// segment (exact = active line, ±2 segments of context) for a timestamped note.
function segmentWindow(ms: number): SelectionData | null {
  const els = segEls()
  const idx = activeSegIndex(els, ms)
  if (idx < 0) return null
  const texts = els.map(e => e.textContent ?? '')
  const exact = texts[idx]
  const prefix = texts.slice(Math.max(0, idx - 2), idx).join(' ')
  const suffix = texts.slice(idx + 1, idx + 3).join(' ')
  const start = segCharOffset(els[idx])
  return { exact, prefix, suffix, pos_start: start, pos_end: start + exact.length }
}

// ── Init ──────────────────────────────────────────────────────────────────────

interface InitMsg {
  type: 'init'
  doc: { title: string; articleHtml?: string }
  highlights: HlData[]
  annotations: AnnData[]
  theme: ThemeData
  hlExpanded: boolean
  scrollFraction: number
  focusId?: string
}

function handleInit(msg: InitMsg): void {
  if (_initialized) return
  _initialized = true

  setTheme(msg.theme)
  _highlights = msg.highlights ?? []
  _hlExpanded = msg.hlExpanded ?? true

  // Insert title h1 before #sam-article
  const article = document.getElementById('sam-article')

  const h1 = document.createElement('h1')
  h1.id = 'doc-title'
  h1.textContent = msg.doc.title || ''

  if (article) {
    document.body.insertBefore(h1, article)
  } else {
    document.body.prepend(h1)
  }

  // Insert highlights section before h1 (if there are highlights)
  if (_highlights.length > 0) {
    const hlSection = createHighlightsSection()
    h1.parentNode?.insertBefore(hlSection, h1)
    renderHighlights()
  }

  // Apply annotations
  for (const ann of msg.annotations ?? []) {
    applyMark(ann)
  }
  setTimeout(updateGutter, 80)

  // Restore scroll position
  if (msg.scrollFraction && msg.scrollFraction > 0) {
    setTimeout(() => {
      const max = document.body.scrollHeight - window.innerHeight
      if (max > 0) window.scrollTo(0, msg.scrollFraction * max)
    }, 100)
  }

  // Focus deep-link — matches an annotation mark or a highlight card
  if (msg.focusId) {
    const id = msg.focusId
    setTimeout(() => {
      const m = document.querySelector<HTMLElement>(`mark[data-ann-id="${id}"]`)
      if (m) {
        m.classList.add('focused')
        m.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
      const card = document.querySelector<HTMLElement>(`.hl-card[data-id="${id}"]`)
      if (card) {
        // ensure the highlights section is expanded so the card is visible
        const list = document.getElementById('hl-list')
        if (list?.classList.contains('collapsed')) {
          _hlExpanded = true
          list.className = 'expanded'
          const arrow = document.getElementById('hl-toggle-arrow')
          if (arrow) arrow.textContent = '▲'
        }
        card.classList.add('focused')
        card.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }, 400)
  }
}

// ── Event delegation for highlight buttons ────────────────────────────────────

document.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement

  // Ann-btn
  const annBtn = target.closest && target.closest('#ann-btn')
  if (annBtn) {
    if (!_pendingSel) return
    ;(document.getElementById('ann-btn') as HTMLButtonElement).style.display = 'none'
    sendMsg({ type: 'selection', data: _pendingSel })
    _pendingSel = null
    window.getSelection()?.removeAllRanges()
    return
  }

  // Highlight action buttons
  const btn = target.closest && target.closest<HTMLElement>('[data-action]')
  if (btn && btn.dataset.action) {
    const action = btn.dataset.action
    const id = btn.dataset.id

    if (action === 'toggle') {
      _hlExpanded = !_hlExpanded
      const arrow = document.getElementById('hl-toggle-arrow')
      if (arrow) arrow.textContent = _hlExpanded ? '▲' : '▼'
      const list = document.getElementById('hl-list')
      if (list) list.className = _hlExpanded ? 'expanded' : 'collapsed'
      sendMsg({ type: 'hl_toggle_section' })
      return
    }

    if (!id) return

    if (action === 'pin') {
      sendMsg({ type: 'hl_pin', id })
      return
    }
    if (action === 'delete') {
      sendMsg({ type: 'hl_delete', id })
      return
    }
    if (action === 'tags') {
      sendMsg({ type: 'hl_tags', id })
      return
    }
    if (action === 'annotate') {
      sendMsg({ type: 'hl_annotate', id })
      return
    }
    return
  }

  // Annotation marks
  const mark = target.closest && target.closest<HTMLElement>('mark[data-ann-id]')
  if (mark) {
    sendMsg({ type: 'tap_annotation', id: mark.dataset.annId })
    return
  }

  // Transcript segment — tap (not a text selection) seeks playback to its time
  const seg = target.closest && target.closest<HTMLElement>('.seg[data-start-ms]')
  if (seg) {
    const seln = window.getSelection()
    if (!seln || seln.isCollapsed) {
      sendMsg({ type: 'seek', ms: Number(seg.dataset.startMs) })
    }
    return
  }

  // Links
  const a = target.closest && target.closest<HTMLAnchorElement>('a[href]')
  if (a) {
    e.preventDefault()
    if (a.href && (a.href.startsWith('http://') || a.href.startsWith('https://'))) {
      const msg: { type: string; href: string; doc_id?: string } = { type: 'link_press', href: a.href }
      if (a.dataset.docId) msg.doc_id = a.dataset.docId
      sendMsg(msg)
    }
  }
})

// ── Scroll tracking ───────────────────────────────────────────────────────────

let _lastFrac = -1
window.addEventListener('scroll', () => {
  const max = document.body.scrollHeight - window.innerHeight
  if (max <= 0) return
  const frac = Math.min(1, Math.max(0, window.scrollY / max))
  if (Math.abs(frac - _lastFrac) > 0.01) {
    _lastFrac = frac
    sendMsg({ type: 'scroll', fraction: frac })
  }
}, { passive: true })

// ── Text selection ────────────────────────────────────────────────────────────

let _pendingSel: SelectionData | null = null

function handleSelection(): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    const annBtn = document.getElementById('ann-btn')
    if (annBtn) annBtn.style.display = 'none'
    _pendingSel = null
    return
  }
  const exact = sel.toString().trim()
  const range = sel.getRangeAt(0)
  const start = getCharOffset(range)
  const ctx = getContext(range, 64)
  _pendingSel = { exact, prefix: ctx.prefix, suffix: ctx.suffix, pos_start: start, pos_end: start + exact.length }
  const annBtn = document.getElementById('ann-btn')
  if (annBtn) annBtn.style.display = 'block'
}

document.addEventListener('touchend', () => {
  setTimeout(handleSelection, 100)
})

document.addEventListener('mouseup', handleSelection)

// ── Resize ────────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => { setTimeout(updateGutter, 100) })

// ── Message handler ───────────────────────────────────────────────────────────

function handleMessage(event: MessageEvent): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(typeof event.data === 'string' ? event.data : JSON.stringify(event.data)) as Record<string, unknown>
  } catch {
    return
  }

  switch (msg.type) {
    case 'init':
      handleInit(msg as unknown as InitMsg)
      break

    case 'setHighlights':
      _highlights = (msg.highlights as HlData[]) ?? []
      _hlExpanded = (msg.expanded as boolean) ?? true
      // Ensure section exists if we now have highlights
      if (_highlights.length > 0 && !document.getElementById('hl-section')) {
        const h1 = document.getElementById('doc-title')
        const hlSection = createHighlightsSection()
        if (h1) {
          h1.parentNode?.insertBefore(hlSection, h1)
        } else {
          document.body.prepend(hlSection)
        }
      }
      renderHighlights()
      break

    case 'setTheme':
      setTheme(msg.theme as ThemeData)
      break

    case 'scrollTo': {
      const frac = msg.fraction as number
      const max = document.body.scrollHeight - window.innerHeight
      if (max > 0) window.scrollTo(0, frac * max)
      break
    }

    case 'addMark':
      addMark(msg.annotation as AnnData)
      break

    case 'removeMark':
      removeMark(msg.id as string)
      break

    case 'highlightAnnotation': {
      const annId = msg.id as string
      const m = document.querySelector<HTMLElement>(`mark[data-ann-id="${annId}"]`)
      if (m) {
        m.classList.add('focused')
        m.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      break
    }

    case 'mediaTime':
      setActiveSeg(msg.ms as number)
      break

    case 'requestSegmentWindow': {
      const win = segmentWindow(msg.ms as number)
      if (win) sendMsg({ type: 'segmentWindow', data: win })
      break
    }
  }
}

window.addEventListener('message', handleMessage)

// Expose for native injectJavaScript path
;(window as unknown as Record<string, unknown>).__handleMsg = (msg: object) =>
  handleMessage({ data: JSON.stringify(msg) } as MessageEvent)

// ── Bootstrap ─────────────────────────────────────────────────────────────────

injectBaseStyles()
sendMsg({ type: 'ready' })
