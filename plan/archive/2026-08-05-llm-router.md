---
created: 2026-08-05
topic: Centralize the LLM router — provider discovery, real probes, model catalog, model picker UI
excerpt: One Router owns every LLM endpoint (LAN Ollama, local Ollama, Anthropic, OpenRouter); `just check-llm` actually probes auth + credits; `GET /api/v1/llm/models` feeds a searchable, provider-grouped model selector in the pipeline step editor
status: built + verified (unit + e2e-int + live probe), awaiting user check before squash-merge to main
---

## Why

Three problems, one root cause: **there is no single owner of "which LLM endpoints exist".**

1. **The router is copy-pasted four times.** Each `step_llm_*.go` carries the same
   `provider` / `base_url` / `api_key` / `model` config keys and the same
   `llm.New(config.LLMSection{...})` block. A step therefore re-declares an endpoint
   (and a credential) that config.toml already declares. Four call sites, four chances
   to drift, and a credential in a DB row that `RedactSecrets` then has to defend.

2. **Nothing knows what is reachable.** `internal/llm/health.go` is deliberately
   probe-free — status is the outcome of the *last real call*, which is right for a
   Settings render. But it means a provider that has never been called reads `unknown`
   forever, a wrong API key is invisible until a pipeline dies, and "am I out of
   Anthropic credits?" is answerable only by burning a pipeline run to find out.

3. **A model is a free-text field.** The step editor renders `model` as a bare
   `TextInput`. Typing `claude-haiku-4-5-20251001` into a step pinned at a local Ollama
   box is a 404 → a 4xx → no fallback → the pipeline dies hard (the exact trap
   `server/CLAUDE.md` documents). The user cannot see what models each provider
   actually serves.

## What

### 1. `llm.Router` — the single owner (`server/internal/llm/router.go`)

```go
type Provider struct {
    ID        string // stable, human-typeable: "anthropic" | "openrouter" | "openai" |
                     // "ollama-local" | "<host:port>" for any other openai_compat box
    Label     string // "Anthropic" | "Ollama (100.111.210.47:11434)"
    Transport string // "anthropic" | "openai_compat"  — which client speaks it
    BaseURL   string
    Source    string // "config" | "fallback" | "env" | "well-known"
    Role      string // "primary" | "fallback" | "available"
    HasKey    bool
    // apiKey is unexported and never serialized.
}

type Route struct{ Provider, Model string } // both optional

func NewRouter(cfg config.LLMSection) *Router
func (r *Router) Providers() []Provider
func (r *Router) Complete(ctx, route Route, msgs []Message) (string, Usage, error)
```

`Router` also satisfies `llm.Client` (`Complete(ctx, model, msgs)` = the default chain),
so every existing caller keeps working while the wiring is switched over.

- **Empty Route** → the configured chain: primary, then each fallback on `ErrTransport`.
  Identical to today's `fallbackClient`, which the Router now owns.
- **`Route.Provider` set** → that provider only, **no fallback**. Pinning is pinning: a
  step pinned at the local box must never silently spend cloud money. (This matches
  today's per-step override semantics — `llm.New` with no `Fallback` builds a single
  client — so it is not a behavior change, only a documented one.)
- **Provider identity stays `ProviderKey(transport, baseURL)`** internally so the
  existing health rows and `llm_usages` keep lining up. `Provider.ID` is a friendly
  alias on top; `Router.byID` resolves both, so a stored `provider: "anthropic"`
  (what the live DB has today) keeps resolving.

### 2. Discovery (`server/internal/llm/discover.go`)

Candidates, deduped by `ProviderKey`, in this order:

| Source | Becomes |
|---|---|
| `[llm]` | role `primary` |
| `[[llm.fallback]]` | role `fallback`, in order |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` in env | role `available` (if not already present) |
| well-known `http://localhost:11434/v1` | role `available` (if not already present) |

**No LAN scanning.** The LAN Ollama box is whatever `base_url` config names — probing a
subnet is slow and rude, and the box is already declared.

Flavor is derived from the base URL host, and only drives *probing*, never transport:
`openrouter.ai` → OpenRouter, `api.openai.com` → OpenAI, everything else openai_compat →
Ollama-ish.

### 3. Probe (`server/internal/llm/probe.go`) — the part that actually asks

```go
type ProbeResult struct {
    ID, Label, Transport, BaseURL string
    Reachable  bool
    Auth       string // ok | missing_key | bad_key | unknown
    Credits    string // ok | exhausted | unknown
    CreditsNote string // OpenRouter: "$3.21 used of $10"
    Models     int
    LatencyMs  int64
    Error, ErrorKind string
}
```

Per flavor, cheapest honest check first:

- **Ollama / openai_compat** — `GET {base}/models`. Reachability + model count in one
  call, no tokens, no money. `credits: ok` (a local box has none to run out of).
- **OpenRouter** — `GET /api/v1/key` returns `{limit, usage, limit_remaining}` →
  a **real** credits answer, plus `GET /api/v1/models` for the count.
- **Anthropic** — `GET /v1/models` with `x-api-key` + `anthropic-version`. 200 = key
  good, 401/403 = `bad_key`. Anthropic exposes **no balance endpoint**, so credits come
  from two places: the health registry's last recorded `quota` error (free, and it is
  exactly the signal that matters — "my key ran out mid-pipeline"), and, only with
  `--deep`, a 1-token `max_tokens=1` completion that settles it definitively for
  ~$0.000001. A deep ping goes through the normal client, so it also **updates** the
  health registry — the probe and the passive status agree by construction.

**The no-probe rule for Settings still holds.** Probing is never automatic: it happens
only on an explicit `POST /api/v1/llm/probe` (i.e. `just check-llm`, or the new Probe
button on the Settings LLM card). Nothing on a render path calls it.

### 4. Model catalog (`server/internal/llm/models.go`)

`GET /api/v1/llm/models` → `[{provider_id, provider_label, models: [{id, label, context_length?}]}]`

- Ollama/OpenAI-compat: `GET {base}/models`.
- OpenRouter: `GET /api/v1/models` (public, no key needed — so the picker is populated
  even before a key is set).
- Anthropic: `GET /v1/models` when keyed; otherwise a small static fallback list of the
  three tiers named in `CLAUDE.md`, so the picker is never empty.
- Cached in-process for 5 minutes (`?refresh=1` busts it). An unreachable provider
  contributes an empty group with an `error` field rather than failing the whole call.

### 5. Server wiring

`llm.Client` is threaded api.Router → worker → `pipeline.Dispatch` → `Handler`. That
whole thread becomes `*llm.Router`:

```go
type Handler func(ctx, q, run store.PipelineRun, cfg json.RawMessage, router *llm.Router) (StepResult, error)
```

Each of the four LLM steps loses its `llm.New` block and becomes one call:

```go
reply, usage, err := router.Complete(ctx, llm.Route{Provider: c.Provider, Model: c.Model}, msgs)
```

**Catalog change:** `base_url` and `api_key` are **removed** from the four LLM step
specs. The Router owns endpoints and credentials; a credential in a pipeline row was
always the weakest link (design rule 5), and `RedactSecrets`/`PreserveSecrets` exist
only to defend it. The live DB carries neither key on any step (verified), so no data
migration is needed — a stray one is logged and ignored, not silently honored.
`RedactSecrets`/`PreserveSecrets` stay: they are generic over `Secret: true` fields and
still cover any future one.

`provider` stays a step config key; its value is now a Router provider ID.
`model` gets `Type: "model"` in the FieldSpec so the app knows to render a picker.

### 6. `just check-llm`

`sam llm check [--deep]` → `POST /api/v1/llm/probe` (bearer, reusing the CLI's cached
local-trust token like `sam yt`) → prints one row per provider:

```
PROVIDER          ROLE      REACHABLE  AUTH         CREDITS     MODELS  LATENCY
anthropic         fallback  yes        ok           ok          8       412ms
100.111.210.47    primary   yes        ok (no key)  n/a         6       23ms
ollama-local      available no         —            —           —       —        connection refused
openrouter        available yes        missing_key  —           318     180ms
```

`sam llm models [--provider <id>]` lists the catalog for eyeballing.

### 7. App — model picker (`app/src/ModelPicker.tsx`)

A modal: search box on top, results grouped under provider section headers, current
value checked. Selecting a model writes **both** `model` and `provider` on the step
draft — the two can never disagree, which is the whole point.

- `app/src/llmModels.ts` — `fetchLLMModels`, sibling of `llmStatus.ts`.
- `pipelines.tsx`: `row.type === 'model'` renders a picker trigger (current value or
  "provider default") instead of a `TextInput`. Everything else in the editor is
  unchanged.
- Settings LLM card gets a **Probe** button → `POST /api/v1/llm/probe` → per-row
  reachable/auth/credits, on demand only.

## Tests (written first)

**Go unit** (`internal/llm`):
- `TestDiscoverDedupesConfigAndEnv` — a config Anthropic + `ANTHROPIC_API_KEY` is ONE
  provider, role `primary`, not two.
- `TestRouterPinnedProviderDoesNotFallBack` — `Route{Provider: "x"}` failing does not
  reach the fallback chain; empty Route does.
- `TestRouterResolvesLegacyProviderName` — `provider: "anthropic"` from a stored step
  config resolves to the discovered Anthropic provider.
- `TestProbeClassifies` — httptest servers returning 200 / 401 / refused / an OpenRouter
  key payload map to the right `Auth`/`Credits`/`ErrorKind`.
- `TestDefaultPromptsComposeLegacyMessage` must stay green — the message bytes a
  default-config pipeline sends do not change.

**E2E** (`e2e/integration.js`, `just e2e-int`):
- The harness starts a **stub openai_compat server** on a fixed port serving
  `/v1/models`; `config/config-test.toml` points `[llm]` at it. This gives the model
  catalog real rows to assert on without any network or spend.
- `runLLMProbeUi` — Settings → LLM Services → Probe → assert a row renders reachable
  with a model count, and a second (dead-port) provider renders unreachable.
- `runModelPickerUi` — the interaction, not the API: Pipelines → expand a step → tap the
  **model** field → picker opens → type a substring → the grouped list filters → tap a
  result → the field shows it → **Save** → reload the screen → the value persisted AND
  `provider` was written alongside it. Run via `just robot-browser` (single robot
  device, never a fresh pairing).
- `just check-llm` against the test server prints a row for each configured provider and
  exits 0.

## Order of work

1. Tests + harness stub (they define the contract).
2. `llm.Router` + discovery; make it satisfy `Client`; keep `llm.New` as a thin shim
   until step 4 lands, then delete it.
3. Probe + model catalog + the two API endpoints.
4. Thread `*llm.Router` through worker → Dispatch → Handler; collapse the four steps;
   drop `base_url`/`api_key` from the catalog.
5. `sam llm check` / `sam llm models` + `just check-llm`.
6. App: `llmModels.ts`, `ModelPicker`, step editor `model` field, Settings Probe button.
7. `just lint`, `just build`, `just e2e`, `just e2e-int`, `just tooling-diff-review`,
   update `server/CLAUDE.md` + `app/CLAUDE.md`.

## Decision: `check-llm` probes credits for real by default

Anthropic has no balance API, so the only definitive credits answer is a 1-token
completion. `just check-llm` is a **manual** command and the ping costs ~$0.000001, so
it runs deep **by default** — otherwise "handle if out of credits" degrades to "report
whatever a real call already happened to discover", which is what the passive health
registry does today. `sam llm check --shallow` skips it (no tokens, credits read from
the last recorded error).

The automatic paths are untouched: nothing on a render path probes, deep or otherwise.
The Settings Probe button is shallow — it is one tap away from a render.

## What changed while building it

Three things landed differently from the design above. Each is a decision, not a slip:

1. **Provider ids are `host:port` for self-hosted boxes, not `ollama-local`.** The plan
   assumed the well-known local candidate is Ollama; nothing proves that (LM Studio on
   `localhost:1234` would read as "ollama-local" and lie). `localhost:11434` /
   `100.111.210.47:11434` is unambiguous, and it is the only thing that tells two boxes
   apart. Cloud endpoints still get their brand (`anthropic`, `openrouter`, `openai`).

2. **`RedactSecrets`/`PreserveSecrets` did not stay — they were replaced by one
   `StripCredentials`.** With `api_key` gone from every step spec, `Secret: true` had no
   live field, so both functions plus `FieldSpec.Secret` were dead code by the repo's own
   rule. `StripCredentials` keys on the credential *name* instead of the catalog, which
   covers strictly more: a legacy row AND a hand-added key no kind declares. There is no
   write-side counterpart because nothing reads those keys any more. Guarded by
   `TestStepCatalogDeclaresNoCredential` (a credential field reappearing fails the build)
   and `TestPipelineStripsLegacyCredential`.

3. **`Router.Complete` kept the `Client` signature; the routed call is `CompleteRoute`.**
   Go cannot have two methods named `Complete`, and the Router has to remain a `Client` so
   every pre-Router caller is untouched.

Two things the work surfaced that were not in the plan:

- **The drawer alert dot was scoped to the routing chain.** It flagged any non-`retired`
  provider whose last call failed — but discovery introduces `available` providers
  (an env key, the well-known local box) that nothing routes through. A dead
  `localhost:11434` nobody uses must not paint an alert, so `useServiceAlert` now flags
  only `primary`/`fallback`.
- **The e2e server now runs with the cloud env keys stripped.** Discovery reads the
  environment, so on this box the suite was probing the live internet and the
  "retired provider" fixture stopped being retired (Anthropic got discovered). The
  harness clears `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` for the
  test server: config only, hermetic.

## Verified

- `just test-go` — unit tests incl. discovery dedup, pinned-no-fallback, legacy provider
  names, probe classification (reachable vs refused, OpenRouter credits, a deep ping on a
  spent balance), model grouping.
- `just lint` — 0 issues (server, cli, app, tooling), parity clean.
- `just e2e` — green. `just e2e-int` — green, including the model picker interaction
  (grouped list → search → pick → save writes model AND provider → survives reload) and
  the Settings Probe row.
- **Live**: `just check-llm` against the real config discovered all four providers —
  LAN Ollama (primary, 5 models), Anthropic (fallback, credits verified by 1-token ping),
  OpenRouter (discovered from env, `$6.30 used, no limit set`, 338 models), and the local
  Ollama that is not running (unreachable).
