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

### Option A — residential proxy (recommended)

Route `yt-dlp` through a SOCKS/HTTP proxy that exits via a residential
connection. A clean self-hosted way is a home machine (here: **fiona**) on your
Tailscale tailnet running `microsocks`:

**On fiona:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4                      # note fiona's tailnet IP, e.g. 100.x.y.z

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
curl -x socks5h://100.x.y.z:1080 -s https://api.ipify.org   # prints fiona's HOME ip
```

**Server `config.toml`:**
```toml
[ytdlp]
proxy = "socks5h://100.x.y.z:1080"
```

> Do **not** use a Tailscale *exit node* for this — that would reroute the whole
> VPS's traffic. The per-app SOCKS proxy only affects `yt-dlp`.

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
proxy   = "socks5h://100.x.y.z:1080" # residential SOCKS/HTTP proxy; empty = direct
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
