---
created: 2026-08-31
topic: LLM provider health
excerpt: A Settings button that sends a real 1-token completion to every provider and clears a stale red dot.
status: shipped
---

# Manual LLM health check

## Why

The Settings dot is **sticky**: `llm_status.go` decides `status` by
`last_error_at.After(last_ok_at)`, and only a real completion writes that
(`llm.Record`, called from the two adapters' `Complete`). Nothing else can flip it
back — `Probe()` deliberately never records, so `just check-llm` can print
`REACHABLE yes` while the card stays red.

Concretely: xayah timed out once at 2026-08-30T17:11:39Z (90s
`llmRequestTimeout`, cold model load contending for 4GB VRAM). It has been
healthy ever since, but the dot cannot go green until a pipeline step happens to
route there and succeed. There is no way to say "check it now".

The `deep=1` probe already sends a real completion — but only for
`flavorAnthropic` / `flavorOpenAI` (`fillCloudCredits`), because its purpose was
credits, not health. A local box (`flavorLocal`, which is what xayah is) is never
pinged, so the one provider whose dot goes stale is the one deep probe skips.

## Change

**Server** — `llm/probe.go`: split the deep ping out of credit inference. On
`deep`, ping **every** reachable provider with `Params{MaxTokens: 1}`; the ping
goes through `Complete`, so it records health for free. Credit inference stays
cloud-only and unchanged. A local box reports `credits: n/a` as before, with a
note saying the completion was verified.

**App** — the Settings "Probe" button becomes "Check" and runs `deep=1`. Its old
comment ("never deep, it is one tap away from a render") reads the button as a
render cost; it is not — it is an explicit tap, and one token is the honest price
of a real answer. On success, invalidate the `llmStatus` query so the dot
re-renders from the health row the ping just wrote.

**CLI** — unchanged: `sam llm check` is already deep by default.

## How I will know it works

1. `probe_test.go`: deep probe against a stub LOCAL box records `LastOKAt` in
   `Snapshot()`, after a recorded failure — the exact red→green transition.
   Shallow probe must NOT record (that guarantee is the reason health.go is passive).
2. `e2e/integration.js`: drive the real button. Make the stub LLM fail one call so
   the row is genuinely red, expand LLM Services, tap Check, assert the row's
   status text flips to "Working". Stub gains a `/fail` toggle for that.
