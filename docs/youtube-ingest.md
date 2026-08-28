# YouTube / podcast ingestion

Add a YouTube URL and Samizdat creates a **video Document**: audio is downloaded
with `yt-dlp` (audio-only, cheap on disk), the transcript is pulled from
subtitles, and the result flows through the normal `Document` → `Pipeline` →
`Highlight` path. Time-anchored annotations and an in-app player come from the
transcript + audio.

## How to add a video

- App / clipper: paste the YouTube URL into Add (it enqueues a `scrape_url` job).
- CLI: `sam yt <url>` (alias `sam youtube <url>`).

All paths run server-side: the worker detects the YouTube host, canonicalizes to
`https://www.youtube.com/watch?v=<id>` (scrape-once dedup), and runs `yt-dlp`.

## The datacenter-IP problem (read this if ingest fails)

YouTube blocks requests from datacenter IPs with **"Sign in to confirm you're not
a bot."** A VPS hits this for *every* request, even with a JS runtime installed —
it is purely IP reputation, not a missing dependency. So a bare VPS cannot fetch
YouTube. You must route `yt-dlp` through a residential IP **or** authenticate with
cookies.

The ingest job surfaces this as an actionable error in the Jobs screen and points
back to this file.

### Option A — residential proxies (recommended)

Route `yt-dlp` through SOCKS/HTTP proxies that exit via residential
connections. A clean self-hosted way is any home machine (here a Pi, **meet-2-cam**) on your
Tailscale tailnet running `microsocks`:

**On the proxy node:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4                      # note its tailnet IP, e.g. 100.x.y.z

sudo apt-get install -y microsocks   # or build from rofl0r/microsocks

sudo tee /etc/systemd/system/microsocks.service >/dev/null <<'EOF'
[Unit]
Description=microsocks SOCKS5 for samizdat yt-dlp
After=tailscaled.service
Wants=tailscaled.service
[Service]
ExecStart=/usr/bin/microsocks -i 100.x.y.z -p 1080
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now microsocks
```

Binding to the **tailnet IP** (not `0.0.0.0`) means only tailnet peers can reach
it — no LAN/public exposure, no auth needed.

**Verify from the server:**
```bash
curl -x socks5h://100.x.y.z:1080 -s https://api.ipify.org   # prints the node's HOME ip
```

**Server `config.toml`:**
```toml
[ytdlp]
proxies = [
  "socks5h://node-a.tailnet.ts.net:1080",
  "socks5h://node-b.tailnet.ts.net:1080",
]
```

> Do **not** use a Tailscale *exit node* for this — that would reroute the whole
> VPS's traffic. The per-app SOCKS proxy only affects `yt-dlp`.

Name nodes by their MagicDNS name, not their tailnet IP: rebuilding a box moves
the IP.

### The pool

`proxies` is an **ordered pool**, not a preference hint:

- Every entry is probed once a minute (`https://api.ipify.org` through it,
  concurrently, so a sweep costs one timeout rather than one per node).
- Jobs route through the **first healthy** entry, and that choice is **sticky** —
  it only moves when the node stops answering, so a probe never reshuffles which
  IP YouTube sees mid-session.
- A run that trips the bot wall **demotes that entry and retries on the next**
  proxy inside the same job. Any other yt-dlp failure returns immediately: a
  private video would otherwise cost one wait per proxy for the same error.
- An entry nothing has probed yet is still tried. A stale probe must never take
  the whole pool out of service.

**Two nodes in one household share one public IP.** That is an availability
backup, not a second egress — YouTube blocking the address takes out both. The
Settings › YouTube Proxies card shows each entry's exit IP, counts the
**distinct** ones, and tags the duplicates `SHARED IP`. Check it before counting
a node as added ban-resistance.

Single-valued `proxy` still works and is appended to the pool, so an existing
config needs no edit.

**Checking the pool:**
```bash
# health as the server sees it (bearer-authed; the GET re-probes every entry)
curl -H "Authorization: Bearer $TOKEN" localhost:8765/api/v1/ytdlp/status
# candidate nodes: is microsocks even listening, and where does it exit?
curl -x socks5h://<peer>:1080 -s https://api.ipify.org
```

Any tailnet peer on a residential line works — cheap hardware is fine,
audio-only downloads are light.

### A stale `yt-dlp` is NOT a proxy problem

The server checks this for you. A binary that is behind fails with
`unable to download video data: HTTP Error 403: Forbidden` on *every* proxy —
YouTube changes its player/signature scheme every few weeks — and that looks
exactly like an IP ban. It is not, and swapping nodes cannot fix it.

- `GET /api/v1/ytdlp/status` carries a `ytdlp` block: installed version, the
  latest published release (checked at most every 6h), age in days, and `stale`.
  Offline, it falls back to age — a build older than 30 days is called stale,
  and a current one is never reported as a problem just because the check failed.
- Settings › YouTube Proxies shows the installed version inline and, when stale,
  a **separate warning** above the node list. The proxy dots stay green, because
  the proxies are fine.
- The job error is its own class, not the bot-block message:
  `yt-dlp is out of date: yt-dlp 2026.06.09 is out of date (latest 2026.08.19) —
  run \`yt-dlp -U\`. YouTube changed its player/signature scheme — this fails on
  EVERY proxy, so it is not a proxy problem`
- The pool **does not rotate** on it. Retrying a signature failure across seven
  nodes costs seven waits for one answer.

Fix: `yt-dlp -U` on the server, then restart (`just restart`). If the binary is
already current, the extractor fix has not shipped yet — cookies (Option B) are
the workaround.

### Option B — cookies (fallback / auth)

Export your logged-in YouTube cookies (e.g. a "Get cookies.txt" browser
extension, or `yt-dlp --cookies-from-browser` on your laptop) to a Netscape
`cookies.txt`, copy it to the server, and point config at it:

```toml
[ytdlp]
cookies = "/var/lib/samizdat/yt-cookies.txt"
```

Cookies authenticate past the bot wall even from a datacenter IP, but they expire
(weeks) and must be re-exported. Proxy + cookies can be combined.

## Config reference

```toml
[ytdlp]
path    = "yt-dlp"                   # binary; default looks it up on PATH
proxies = [                          # ordered pool; first healthy entry carries jobs
  "socks5h://node-a.tailnet.ts.net:1080",
  "socks5h://node-b.tailnet.ts.net:1080",
]
proxy   = "socks5h://100.x.y.z:1080" # legacy single-valued key; appended to `proxies`
cookies = ""                         # optional Netscape cookies.txt path
```

After editing config, restart the server (`just dev`).

## Transcripts

- Manual subtitles are preferred; YouTube auto-captions are the fallback
  (`transcript_status`: `subs` / `auto` / `none`).
- Auto-captions are noisy (rolling duplicates, inline timing tags) — the parser
  strips tags and dedups, but expect lower quality than manual subs.
- No transcript → the Document is still created (description as body); the player
  works, the transcript pane is empty.

## Dependencies

- `yt-dlp` — install from https://github.com/yt-dlp/yt-dlp#installation
  (the server reports a clear error if the binary is missing).
- `ffmpeg` — required by `yt-dlp` for audio extraction.
