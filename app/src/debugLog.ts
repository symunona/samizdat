// Device debug-log shipper. Buffers log lines and POSTs them as NDJSON to the
// server's /api/v1/debug/logs channel, where they're appended to
// tmp/device-logs/<device>.ndjson (tail with `just device-logs`). This is the
// live window into a physical device from the dev machine — see app/CLAUDE.md.
//
// Wiring: src/logger.ts forwards every log/warn/error here via setLogSink; the
// DebugLogBridge in app/_layout.tsx supplies the connection target and pipes
// uncaught JS errors in. This module NEVER calls the app logger (it would loop
// back through the sink) — it uses console directly for its own diagnostics.
import { Platform } from 'react-native'
import { setLogSink } from './logger'
import { APP_VERSION } from './appVersion'

type Level = 'log' | 'warn' | 'error'

interface Entry {
  ts: string
  level: Level
  module: string
  msg: string
}

const MAX_QUEUE = 2000       // drop oldest beyond this if offline (bound memory)
const FLUSH_MS = 1000        // batch cadence
const MAX_BATCH = 500        // lines per POST

let queue: Entry[] = []
let target: { url: string; token: string; deviceId: string | null } | null = null
// Two separate conditions, deliberately: `allowed` is the Settings toggle (may this
// device stream at all), `target` is where to. Buffering while allowed-but-targetless
// is what lets a BOOT failure survive — the persisted replica fails to save during
// hydration, long before DebugLogBridge knows the connection, and conflating the two
// dropped exactly the error worth having (see src/store/persistHealth.ts).
let allowed = true
let timer: ReturnType<typeof setTimeout> | null = null
let flushing = false

// Turn arbitrary console args into one flat string. Errors keep their stack;
// objects are JSON-encoded (circular-safe); everything else is String()-ed.
function fmt(args: unknown[]): string {
  return args.map((a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch { return String(a) }
  }).join(' ')
}

function now(): string {
  return new Date().toISOString()
}

function push(level: Level, module: string, args: unknown[]): void {
  if (!allowed) return
  queue.push({ ts: now(), level, module, msg: fmt(args) })
  if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE)
  if (level === 'error') { void flush() }        // errors go out immediately
  else scheduleFlush()
}

// Listen from bundle load, not from the first connection: anything logged before
// DebugLogBridge resolves the target is queued and goes out with the first flush.
setLogSink(push)

function scheduleFlush(): void {
  if (timer || !allowed) return
  timer = setTimeout(() => { timer = null; void flush() }, FLUSH_MS)
}

async function flush(): Promise<void> {
  if (flushing || !allowed || !target || queue.length === 0) return
  flushing = true
  const batch = queue.slice(0, MAX_BATCH)
  const body = batch.map((e) => JSON.stringify(e)).join('\n') + '\n'
  try {
    const res = await fetch(`${target.url}/api/v1/debug/logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${target.token}`,
      },
      body,
      // Beacon semantics: let a small batch finish even if the page navigates
      // away (web full-reload) instead of aborting mid-flight. Ignored on native.
      keepalive: true,
    })
    if (res.ok) {
      queue = queue.slice(batch.length)
    }
    // On non-OK we keep the batch queued for the next tick (server may be down).
  } catch {
    // Network error — keep the batch; retry next tick. Use console (NOT the app
    // logger) so a persistent failure can't feed itself back into the queue.
    // eslint-disable-next-line no-console
    if (__DEV__) console.warn('[debugLog] flush failed, will retry')
  } finally {
    flushing = false
    if (queue.length > 0) scheduleFlush()      // drain remainder
  }
}

// Called by DebugLogBridge on connection/toggle changes. Points the shipper at a
// server (or silences the device) and, when a target first appears, emits a session
// marker so each run is delimited. Anything already buffered goes out with it.
export function setDebugLogTarget(
  url: string | null,
  token: string | null,
  deviceId: string | null,
  on: boolean,
): void {
  const hadTarget = !!target
  allowed = on
  target = on && url && token ? { url, token, deviceId } : null
  if (!on) {
    // Toggled off: stop listening and drop what's buffered — the point of the
    // switch is that this device says nothing.
    setLogSink(null)
    queue = []
    if (timer) { clearTimeout(timer); timer = null }
    return
  }
  setLogSink(push)
  if (target && !hadTarget) {
    push('log', 'debugLog', [`── session start · v${APP_VERSION} · ${Platform.OS} · ${now()} ──`])
  }
  void flush()
}

// Direct entry point for uncaught errors / WebView-forwarded errors that don't
// come through a createLogger instance.
export function logToServer(level: Level, module: string, ...args: unknown[]): void {
  push(level, module, args)
}
