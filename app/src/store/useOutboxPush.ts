import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { useConnection } from '../ConnectionContext'
import { useSyncStore } from './syncStore'
import { requestPush } from './pushEngine'

const POLL_INTERVAL_MS = 30_000

// Drives the outbox pusher: drains whenever there's pending work AND we're connected —
// on a new mutation (outbox length changes), on reconnect, on app foreground, and on a
// periodic fallback. The outbox is persisted, so pending intents from a previous
// (offline) session are flushed the moment this mounts while connected.
export function useOutboxPush() {
  const { status, activeUrl, token } = useConnection()
  const pending = useSyncStore((s) => s.outbox.length)
  const ref = useRef({ status, activeUrl, token })
  ref.current = { status, activeUrl, token }

  function push() {
    const { status: st, activeUrl: url, token: tok } = ref.current
    if (st === 'connected' && url && tok) requestPush(url, tok)
  }

  // On mutation (pending count changes) + on reconnect.
  useEffect(() => {
    if (pending > 0) push()
  }, [pending, status, activeUrl, token])

  // On app foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => { if (next === 'active') push() })
    return () => sub.remove()
  }, [])

  // Periodic fallback (also retries intents that failed transiently).
  useEffect(() => {
    if (status !== 'connected') return
    const id = setInterval(push, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [status, activeUrl, token])
}
