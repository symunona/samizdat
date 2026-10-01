---
created: 2026-10-01
topic: yt-dlp sandbox + verified auto-update
excerpt: Run yt-dlp confined (Landlock + seccomp), keep a server-managed copy fresh with signature-verified, cooled-down updates checked at most once a day before an invocation.
status: done
---

# yt-dlp: sandbox + verified auto-update

## Why

yt-dlp is third-party code that must update often (YouTube breaks it every few
weeks) and runs as the server's user — the user that owns the SSH key, the API
keys in `.env`, and the vault. Auto-updating it unconfined means: upstream
release compromised → attacker code runs with all of that, with no human delay.

## What

All of it lives in `server/internal/ytdlp`; the worker asks for a command and
gets one. Nothing else in the server knows a sandbox or an updater exists.

1. **Sandbox** (`sandbox_linux.go`). The server re-executes itself as the hidden
   `samizdat ytdlp-sandbox` subcommand, which confines its own thread and then
   `exec`s yt-dlp:
   - Landlock: read-only system dirs, read-write only the media dir and a
     private scratch home. No `$HOME`, no vault, no repo.
   - seccomp: no `AF_UNIX` sockets and no io_uring — Landlock on this kernel
     does not cover unix sockets, and the systemd user bus would be a way out.
   - Environment rebuilt from scratch: no API keys inherited.
   No sudo, no bwrap (unprivileged userns is blocked by AppArmor here), still
   one binary.
2. **Verified update** (`update.go`). The server keeps its own copy under
   `<data_dir>/ytdlp/bin/`. An update is installed only if `SHA2-256SUMS` carries
   a valid signature from the pinned yt-dlp release key, the download matches
   the sum, and the new binary answers `--version` with the expected tag inside
   the sandbox.
3. **Cooldown.** A release younger than 3 days is not installed.
4. **Check on invocation.** Before a run: if the last update attempt is older
   than a day, attempt one first. The attempt time is persisted
   (`server_settings.ytdlp_update`) before any network I/O, so a failing check
   costs one try per day, not one per job. A failed update never fails the job —
   the previous binary runs.

Config (`[ytdlp]`): `auto_update` (default true), `channel` (`stable` |
`nightly`), `sandbox` (default true). `path` stays: it is the binary used until
the first managed copy exists, and always when `auto_update = false`.

## Self-test (decided up front)

- Unit: updater against an httptest release signed with a throwaway key —
  installs a good release; refuses bad signature, bad sum, release inside the
  cooldown, wrong `--version`; second call inside a day does no network I/O.
- Real, on this box: through the sandbox, `cat ~/.ssh/id_*` and
  `cat /proc/<server pid>/environ` fail, an `AF_UNIX` socket fails, writing
  outside the media dir fails; the real yt-dlp `--version` and one real probe
  through the proxy pool succeed.
- Real update: managed copy bootstraps from GitHub with the real signature.
- `just build`, `just lint`, server tests green.

## Not covered

- Network is not restricted: a compromised yt-dlp can still reach the internet
  and the tailnet. It can exfiltrate only what it can read (system dirs, media
  cache).
- It can signal same-user processes (Landlock signal scoping needs kernel 6.12).
