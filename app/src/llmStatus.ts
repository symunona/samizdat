// Client for the LLM provider health endpoint (GET /api/v1/llm/status).
// Kept separate from api.ts like proxyStatus.ts / exportStats.ts.
import { ApiError } from './api'

export type LLMProviderStatus = 'ok' | 'error' | 'unknown'
export type LLMErrorKind = 'quota' | 'auth' | 'transport' | 'api'

export interface LLMProvider {
  key: string
  provider: string
  base_url?: string
  model?: string
  role: 'primary' | 'fallback' | 'retired'
  status: LLMProviderStatus
  has_key: boolean
  calls: number
  errors: number
  last_ok_at?: string
  last_error_at?: string
  last_error?: string
  last_error_kind?: LLMErrorKind
}

export interface LLMProviderUsage {
  provider: string
  calls: number
  input_tokens: number
  output_tokens: number
  cost_usd: number
  last_call_at?: string
}

export interface LLMStatus {
  configured: boolean
  providers: LLMProvider[]
  usage: LLMProviderUsage[]
  totals: {
    total_calls: number
    total_input_tokens: number
    total_output_tokens: number
    total_cost_usd: number
  }
}

export async function fetchLLMStatus(serverUrl: string, token: string): Promise<LLMStatus> {
  const url = serverUrl.trim().replace(/\/+$/, '')
  const res = await fetch(`${url}/api/v1/llm/status`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `/api/v1/llm/status failed: HTTP ${res.status}`)
  const data = (await res.json()) as LLMStatus
  // Go marshals an empty slice as null (see the nil-slice rule) — normalize so
  // the screen can map() without a guard on every field.
  return { ...data, providers: data.providers ?? [], usage: data.usage ?? [] }
}

// llmErrorLabel turns a provider error into the one line a human acts on. The
// kind is what matters ("out of credits" → top up; "unreachable" → the box is
// down); the raw provider body is shown separately, small.
export function llmErrorLabel(p: LLMProvider): string {
  switch (p.last_error_kind) {
    case 'quota': return 'Out of credits / rate limited'
    case 'auth': return 'Bad or missing API key'
    case 'transport': return 'Unreachable'
    default: return 'Last call failed'
  }
}

// llmProviderLabel names the endpoint: the provider for cloud APIs, the host for
// a self-hosted openai_compat box (two Ollama nodes must read differently).
export function llmProviderLabel(p: LLMProvider): string {
  if (p.provider !== 'openai_compat' || !p.base_url) return p.provider
  try { return new URL(p.base_url).host } catch { return p.base_url }
}
