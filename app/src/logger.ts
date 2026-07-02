const MODULE_COLORS = [
  '#e57373', '#f06292', '#ba68c8', '#7986cb',
  '#64b5f6', '#4db6ac', '#81c784', '#ffd54f',
  '#ff8a65', '#a1887f', '#90a4ae',
]

function hashColor(module: string): string {
  let h = 0
  for (let i = 0; i < module.length; i++) {
    h = (h * 31 + module.charCodeAt(i)) & 0x7fffffff
  }
  return MODULE_COLORS[h % MODULE_COLORS.length]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function ts(): string {
  const t = new Date()
  return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
}

// Optional sink: when set (by src/debugLog.ts), every log line is also forwarded
// here so it can be streamed to the server's device-log channel. Kept as a plain
// setter to avoid a static import cycle (debugLog imports the API layer).
export type LogSink = (level: 'log' | 'warn' | 'error', module: string, args: unknown[]) => void
let sink: LogSink | null = null

export function setLogSink(fn: LogSink | null): void {
  sink = fn
}

export interface Logger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export function createLogger(module: string): Logger {
  const color = hashColor(module)
  const tag = `color:${color};font-weight:bold`
  const label = (level: string) => `%c[${ts()}] [${module}] ${level}`
  const forward = (level: 'log' | 'warn' | 'error', args: unknown[]) => {
    // Never let the sink throw into the caller (or recurse if it logs on failure).
    try { sink?.(level, module, args) } catch { /* ignore */ }
  }

  return {
    log(...args: unknown[]) {
      forward('log', args)
      // eslint-disable-next-line no-console
      console.log(label(''), tag, ...args)
    },
    warn(...args: unknown[]) {
      forward('warn', args)
      // eslint-disable-next-line no-console
      console.warn(label('WARN'), tag, ...args)
    },
    error(...args: unknown[]) {
      forward('error', args)
      // eslint-disable-next-line no-console
      console.error(label('ERROR'), tag, ...args)
    },
  }
}
