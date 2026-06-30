// Shared instance store for "Save to Sam".
// An instance = one connected Samizdat server, keyed by its origin (scheme +
// host + port). `hostname` (host:port) is the human label and stable id.
// Loaded by the service worker via importScripts and by the popup/options pages
// via <script>. Wrapped in an IIFE so only `globalThis.SamInstances` leaks —
// classic scripts share one global lexical scope, so a bare top-level `const`
// here would collide with the same name destructured by consumers.

;(function () {
  const API = '/api/v1'

  function hostOf(origin) {
    try {
      return new URL(origin).host
    } catch {
      return origin
    }
  }

  // Read instances, migrating the v1 single-instance shape on the fly.
  async function getInstances() {
    const s = await chrome.storage.local.get(['instances', 'serverBase', 'deviceToken'])
    if (Array.isArray(s.instances)) {
      if (s.serverBase || s.deviceToken) {
        await chrome.storage.local.remove(['serverBase', 'deviceToken'])
      }
      return s.instances
    }
    // v1 → v2 migration: fold serverBase+deviceToken into one instance.
    const migrated = []
    if (s.serverBase && s.deviceToken) {
      migrated.push({ origin: s.serverBase, hostname: hostOf(s.serverBase), token: s.deviceToken })
    }
    await chrome.storage.local.set({ instances: migrated })
    await chrome.storage.local.remove(['serverBase', 'deviceToken'])
    return migrated
  }

  async function setInstances(list) {
    await chrome.storage.local.set({ instances: list })
  }

  // Add or update an instance by origin (dedup). Returns the new list.
  async function addInstance(origin, token) {
    const list = await getInstances()
    const i = list.findIndex((x) => x.origin === origin)
    const inst = { origin, hostname: hostOf(origin), token }
    if (i >= 0) list[i] = inst
    else list.push(inst)
    await setInstances(list)
    return list
  }

  async function removeInstance(origin) {
    const list = (await getInstances()).filter((x) => x.origin !== origin)
    await setInstances(list)
    return list
  }

  // Compare dotted numeric versions. >0 if a>b, <0 if a<b, 0 if equal.
  function cmpVersion(a, b) {
    const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0)
    const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0)
      if (d) return d
    }
    return 0
  }

  globalThis.SamInstances = {
    API,
    hostOf,
    getInstances,
    setInstances,
    addInstance,
    removeInstance,
    cmpVersion,
  }
})()
