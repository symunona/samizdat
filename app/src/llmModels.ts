// Client for the LLM Router's catalog + probe endpoints. Kept beside llmStatus.ts
// (which reads the passive health registry) because these two are the opposite
// thing: an ACTIVE question, asked only when a human asks it.
import { ApiError } from './api'

export interface LLMModel {
  id: string
  label?: string
  context_length?: number
}

export interface LLMModelGroup {
  provider_id: string
  provider_label: string
  role: 'primary' | 'fallback' | 'available'
  models: LLMModel[]
  // An unreachable provider contributes an error, never an empty picker for the
  // others.
  error?: string
}

export type LLMAuthState = 'ok' | 'missing_key' | 'bad_key' | 'unknown'
export type LLMCreditState = 'ok' | 'exhausted' | 'unknown' | 'n/a'

export interface LLMProbeResult {
  id: string
  label: string
  role: 'primary' | 'fallback' | 'available'
  base_url?: string
  reachable: boolean
  auth: LLMAuthState
  credits: LLMCreditState
  credits_note?: string
  models: number
  latency_ms: number
  error?: string
  error_kind?: string
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}` }
}

function apiBase(serverUrl: string) {
  return serverUrl.trim().replace(/\/+$/, '')
}

export async function fetchLLMModels(
  serverUrl: string, token: string, refresh = false,
): Promise<LLMModelGroup[]> {
  const url = `${apiBase(serverUrl)}/api/v1/llm/models${refresh ? '?refresh=1' : ''}`
  const res = await fetch(url, { headers: headers(token) })
  if (!res.ok) throw new ApiError(res.status, `/api/v1/llm/models failed: HTTP ${res.status}`)
  const data = (await res.json()) as { groups?: LLMModelGroup[] | null }
  // Go marshals an empty slice as null (see the nil-slice rule) — normalize so
  // the picker can map() without a guard on every field.
  return (data.groups ?? []).map(g => ({ ...g, models: g.models ?? [] }))
}

// probeLLMProviders is the one path that actively contacts providers. `deep`
// additionally spends a 1-token completion where no balance endpoint exists; the
// Settings button never does, because it is one tap away from a render.
export async function probeLLMProviders(
  serverUrl: string, token: string, deep = false,
): Promise<LLMProbeResult[]> {
  const url = `${apiBase(serverUrl)}/api/v1/llm/probe${deep ? '?deep=1' : ''}`
  const res = await fetch(url, { method: 'POST', headers: headers(token) })
  if (!res.ok) throw new ApiError(res.status, `/api/v1/llm/probe failed: HTTP ${res.status}`)
  const data = (await res.json()) as { results?: LLMProbeResult[] | null }
  return data.results ?? []
}

// probeSummary is the one line a human acts on, in the same spirit as
// llmErrorLabel: name the fix, not the symptom.
export function probeSummary(p: LLMProbeResult): string {
  if (!p.reachable) return p.auth === 'missing_key' ? 'No API key configured' : 'Unreachable'
  if (p.auth === 'bad_key') return 'Bad API key'
  if (p.credits === 'exhausted') return 'Out of credits'
  const models = `${p.models} model${p.models === 1 ? '' : 's'}`
  return p.credits_note ? `${models} · ${p.credits_note}` : models
}
