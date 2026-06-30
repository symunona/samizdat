// Save to Sam — content script (runs on <all_urls>).
// Two jobs:
//   1. On ANY page: render a transient toast when the background asks (after a
//      successful save).
//   2. On a Samizdat origin: expose a pair marker the Settings page reads, and
//      receive + store the device token it posts (appending this origin as a
//      connected instance — many instances may be connected at once).

(function () {
  const { getInstances, addInstance } = globalThis.SamInstances

  // ── 1. toast (any page) ─────────────────────────────────────────────────────
  let toastEl = null
  function showToast(text) {
    if (!toastEl) {
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;z-index:2147483647;bottom:20px;right:20px;'
      const shadow = host.attachShadow({ mode: 'open' })
      const el = document.createElement('div')
      el.style.cssText = [
        'font:14px/1.4 system-ui,sans-serif',
        'background:#222',
        'color:#fff',
        'padding:10px 14px',
        'border-radius:8px',
        'box-shadow:0 4px 16px rgba(0,0,0,0.3)',
        'border-left:3px solid #d64541',
        'opacity:0',
        'transform:translateY(8px)',
        'transition:opacity .18s ease,transform .18s ease',
      ].join(';')
      shadow.appendChild(el)
      document.documentElement.appendChild(host)
      toastEl = { host, el }
    }
    const { el } = toastEl
    el.textContent = text
    requestAnimationFrame(() => {
      el.style.opacity = '1'
      el.style.transform = 'translateY(0)'
    })
    clearTimeout(showToast._t)
    showToast._t = setTimeout(() => {
      el.style.opacity = '0'
      el.style.transform = 'translateY(8px)'
    }, 2500)
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'sam-toast') showToast(msg.text || 'Saved to Sam')
  })

  // ── 2. pairing (Samizdat origins only) ──────────────────────────────────────
  const origin = location.origin
  if (!origin.startsWith('http')) return

  ;(async function () {
    let health
    try {
      const res = await fetch(`${origin}/api/v1/health`, { credentials: 'omit' })
      if (!res.ok) return
      health = await res.json()
    } catch {
      return
    }
    if (!health || health.app !== 'samizdat') return

    const version = chrome.runtime.getManifest().version
    const mark = async () => {
      const list = await getInstances()
      const paired = list.some((x) => x.origin === origin) ? 'paired' : 'unpaired'
      document.documentElement.dataset.samExt = `${version}:${paired}`
    }
    mark()

    // Settings page → extension: receive the freshly minted device token and
    // append this origin as a connected instance.
    window.addEventListener('message', async (event) => {
      if (event.source !== window || event.origin !== origin) return
      const d = event.data
      if (!d || d.type !== 'samizdat-extension-token' || !d.token) return
      await addInstance(origin, d.token)
      mark()
      window.postMessage({ type: 'samizdat-extension-paired' }, origin)
    })

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.instances) mark()
    })
  })()
})()
