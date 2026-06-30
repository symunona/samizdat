// Save to Sam — options page. Manage connected instances + manual connect.

const { getInstances, removeInstance } = globalThis.SamInstances
const listEl = document.getElementById('list')
const serverInput = document.getElementById('server')

function normalize(url) {
  return url.trim().replace(/\/+$/, '')
}

async function probe(inst) {
  try {
    const res = await fetch(`${inst.origin}/api/v1/me`, { headers: { Authorization: `Bearer ${inst.token}` } })
    if (res.ok) return { cls: 'ok', text: 'Connected' }
    return { cls: 'bad', text: `Token rejected (HTTP ${res.status})` }
  } catch {
    return { cls: 'bad', text: 'Unreachable' }
  }
}

async function render() {
  const instances = await getInstances()
  listEl.replaceChildren()
  if (instances.length === 0) {
    const p = document.createElement('p')
    p.className = 'muted'
    p.textContent = 'None yet.'
    listEl.appendChild(p)
    return
  }
  for (const inst of instances) {
    const row = document.createElement('div')
    row.className = 'row'

    const meta = document.createElement('div')
    meta.className = 'meta'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = inst.hostname
    const st = document.createElement('div')
    st.className = 'st'
    st.textContent = 'Checking…'
    meta.append(name, st)

    const btn = document.createElement('button')
    btn.className = 'ghost'
    btn.textContent = 'Disconnect'
    btn.addEventListener('click', async () => { await removeInstance(inst.origin); render() })

    row.append(meta, btn)
    listEl.appendChild(row)

    probe(inst).then((r) => { st.className = `st ${r.cls}`; st.textContent = r.text })
  }
}

document.getElementById('open').addEventListener('click', () => {
  const url = normalize(serverInput.value)
  if (!url) return
  chrome.tabs.create({ url })
})

render()
