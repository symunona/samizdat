---
created: 2026-08-11
topic: Local LLM (xayah Ollama) as the default summary engine, after the xayah rebuild
excerpt: xayah was rebuilt — tailnet IP moved, Ollama gone, ssh key gone. Restore Ollama as the routing primary, address it by MagicDNS name so the next IP change is a non-event, and rebuild the Android build node on the same box.
status: done (LLM side) — local box is the routing primary again, verified end to end in the app; Android build node handled separately
---

# Local LLM default summarizer (post-xayah-rebuild)

## Why now

`just check-llm` reports the routing **primary** dead:

```
100.111.210.47:11434  primary    no  unknown  n/a  —  10001ms
    ! transport failure: context deadline exceeded
anthropic             fallback   yes ok       ok   10  393ms
localhost:11434       available  no  unknown  n/a  —   connection refused
```

Every summary has silently been served by the Anthropic fallback — which is exactly what
the fallback is for, but it means paid cloud tokens for a job that was meant to be free
and private, and it violates rule 5 (credentialed/paywalled content must route local).
The archived plan `plan/archive/2026-08-10-highlight-llm-provenance.md` already recorded
the same symptom ("the xayah Ollama box was unreachable").

Root cause: **xayah was rebuilt.** Three things broke at once:

1. Tailnet IP moved `100.111.210.47` → `100.81.125.107`, so the hardcoded `base_url` in
   `config.toml` points at nothing.
2. Ollama is not installed/running — port 11434 is *connection refused* at the new IP
   (the host itself is up; sshd answers on :22).
3. Our ssh public key is gone from `authorized_keys`, and xayah's sshd offers
   `publickey` only — no password fallback to bootstrap ourselves back in.

(3) also killed the Android build node, which is the same box (`config/build-node.env`
→ `BUILD_NODE_DEST=xayah`).

## Decisions

- **Address the box by MagicDNS name, not IP.** `http://xayah.tail7f475e.ts.net:11434/v1`.
  The IP has now changed once and took the primary provider down with it; the name is
  stable across rebuilds and re-auths.
- **Consequence that must not be missed:** `providerID` is `host:port`
  (`server/internal/llm/provider.go:134`), and the **Summarizer** pipeline step *pins*
  `"provider": "100.111.210.47:11434"`. A pin never falls back, so renaming the endpoint
  without updating that row turns the step into a hard error instead of a fallback. One
  `UPDATE` on `pipelines.steps` for the Summarizer row; old value recorded here:
  `100.111.210.47:11434`. No other pipeline pins a provider (checked: 1 occurrence total).
- **Model stays `qwen3:4b-instruct-ctx7k`** — a `FROM qwen3:4b-instruct` +
  `PARAMETER num_ctx 7168` variant. xayah still has the same 4GB VRAM ceiling (confirmed
  with the user), and 7168 is what was sized to stay on the GPU. The OpenAI-compatible
  endpoint has no `num_ctx`, so it must be baked into the model via `ollama create`.
- **Bind Ollama to the tailnet**, not just loopback: `OLLAMA_HOST=0.0.0.0:11434` in a
  systemd drop-in, so it survives reboot and is reachable from taskbot. The tailnet is the
  only network that reaches it.
- **Build node workspace goes under `~/dev`** (user symlinked it there after the rebuild);
  `/media/symunona/data` is not assumed to exist any more.

## Steps

1. [blocked] Get the ssh key back into `~/.ssh/authorized_keys` on xayah — needs console
   access, cannot be done from here.
2. Install Ollama; systemd drop-in with `OLLAMA_HOST=0.0.0.0:11434`; enable + start.
3. `ollama pull qwen3:4b-instruct`; `ollama create qwen3:4b-instruct-ctx7k` from a
   Modelfile with `PARAMETER num_ctx 7168`. Verify with `ollama ps` that it stays on GPU.
4. Repoint `config.toml` `[llm] base_url` at the MagicDNS name; `UPDATE` the Summarizer
   step's pinned provider to match.
5. `just check-llm` → primary reachable. Restart the server (`just dev` / `just restart`).
6. **E2E:** run the Summarizer pipeline on a real Document and assert the produced
   Highlight's provenance metadata names `qwen3:4b-instruct-ctx7k` @
   `xayah.tail7f475e.ts.net:11434` — not `anthropic`. Provenance is rendered in the
   highlight overlay (shipped by `e8f28a9`), so verify it in the app with agent-browser,
   not only via the API.
7. Android build node: SDK + JDK 17 + `GRADLE_USER_HOME` under `~/dev`, `build` remote,
   `secrets/debug.keystore` re-synced, then a real `just build-android` through
   `tools/verify-apk.sh`.

## What actually happened (differs from the plan above — kept for the record)

Ollama was **already installed and carefully tuned** on the rebuilt box (drop-in dated
2026-08-10): model store on the NVMe, `OLLAMA_CONTEXT_LENGTH=12288`,
`OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_MAX_LOADED_MODELS=1`. The
summarizer model is **`qwen3-sum:latest`**, not the old `qwen3:4b-instruct-ctx7k` — a
Modelfile on `qwen3:4b-instruct-2507-q4_K_M` with a summarizer SYSTEM prompt, `num_ctx
12288`, `num_gpu 37`, temp 0.3. The q8_0 KV cache is what buys 12288 ctx on 4GB where the
old note said 7168; `ollama ps` confirms **100% GPU, 3.5 of 4.0 GB**. So no model work was
needed and none was done.

The only thing actually missing was the **bind**: Ollama listens on `127.0.0.1` by default,
which is why the box answered `ollama list` over ssh while being *connection refused* from
taskbot. Added `/etc/systemd/system/ollama.service.d/tailnet.conf` with
`OLLAMA_HOST=0.0.0.0:11434` — a separate drop-in, so the user's `override.conf` stays theirs.
Note this is LAN-reachable too (Ollama has no auth, ufw inactive); flagged to the user.

`config.toml` now names the box by MagicDNS and defaults to `qwen3-sum:latest`, and the
Summarizer step's pin was retargeted `100.111.210.47:11434` → `xayah.tail7f475e.ts.net:11434`
(old row backed up before the write). `sam llm check` probes through the **running server**,
not the CLI's own config read, so the stale IP survived the config edit until `just restart`
— worth remembering.

## Results

```
PROVIDER                       ROLE       REACHABLE  MODELS  LATENCY
xayah.tail7f475e.ts.net:11434  primary    yes        2       588ms
anthropic                      fallback   yes        10      396ms
```

A real Summarizer run on `18d392ef` ("Unpacking ChatGPT Work") produced a Highlight whose
provenance is local, and the ledger agrees:

```json
{"model":"qwen3-sum:latest","provider":"xayah.tail7f475e.ts.net:11434",
 "step":"llm_summarize","tokens_in":3712,"tokens_out":175,"prompt_sha":"4735786a"}
```

`max_tokens` / `temperature` are absent by design — unset stays unset for a local box that
has its own Modelfile defaults. Rendered in the overlay (agent-browser, `tmp/local-llm-provenance.png`):

```
qwen3-sum:latest · xayah.tail7f475e.ts.net:11434 · 3.7k→175
```

`just lint` clean, `just build` clean, `just e2e` green.

**One trap worth knowing:** the first test run reported the job `done` in under a second and
produced nothing — pipelines are idempotent, and that document already had a summary from
2026-08-09. A green job status is not evidence the LLM was called; the `llm_usages` row and
the provenance metadata are.

## Test plan (written before the work)

- `just check-llm` — primary row `reachable yes`, latency sane, models list non-empty.
- A summarize job whose Highlight provenance says the local model/provider, proving the
  route actually took the local path rather than falling through to Anthropic.
- The overlay in the app shows that provenance line (visible result, not just a 200).
- `just e2e` green.
- `just build-android` produces an APK that passes `tools/verify-apk.sh` (signer identity
  vs `.prev`, monotonic versionCode, sidecar↔buildEpoch).
