// Save to Sam — options page. Manual server URL fallback + connection status.

const serverInput = document.getElementById('server')
const statusEl = document.getElementById('status')

function normalize(url) {
  return url.trim().replace(/\/+$/, '')
}

async function render() {
  const { serverBase, deviceToken } = await chrome.storage.local.get(['serverBase', 'deviceToken'])
  if (serverBase && !serverInput.value) serverInput.value = serverBase

  if (!serverBase) {
    statusEl.textContent = 'No server set. Open your Sam, or enter its URL above.'
    return
  }
  if (!deviceToken) {
    statusEl.innerHTML = `Server set, not paired. Open <code>${serverBase}</code> and click “Connect extension” in Settings.`
    return
  }
  try {
    const res = await fetch(`${serverBase}/api/v1/me`, { headers: { Authorization: `Bearer ${deviceToken}` } })
    if (res.ok) {
      statusEl.innerHTML = `<span class="ok">Connected</span> to <code>${serverBase}</code>.`
    } else {
      statusEl.textContent = `Paired but token rejected (HTTP ${res.status}). Re-connect from Sam Settings.`
    }
  } catch {
    statusEl.textContent = `Server unreachable at ${serverBase}.`
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const url = normalize(serverInput.value)
  if (!url) return
  await chrome.storage.local.set({ serverBase: url })
  render()
})

render()
