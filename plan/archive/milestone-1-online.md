# Milestone 1 — "We're Online"

> From a fresh VPS: stand up the server, pair the app, see a health message. Proves the spine — reachability + TLS + install + auth/pairing + a live API. Build target: `docs/server-auth-pairing.md`. Lists ≤10.

## Definition of done (the 4 steps)
1. **Public connection via scripts** — `just setup-public` configures the hostname (your domain or `sslip.io`) + CertMagic; the server is reachable over HTTPS.
2. **Install & run the service** — `just install-service` installs a systemd unit; `systemctl --user status samizdat` (or system) shows it running.
3. **Pair with QR** — `sam qr` (server side) mints a one-time pairing code and prints a QR; the app scans/pastes it (`sam connect` is the conceptual device side) → receives a device token.
4. **Health** — the app calls authed `GET /health` (or `/me`) → shows **"Yaaay, we're online."** Public `GET /health` also returns status + version.

## Server surface (minimal)
- `GET /health` → `{status:"ok", version, time}` (public).
- `POST /pair {code}` → `{device_token, device_id}` (code single-use, short TTL) | 401.
- `GET /me` (authed, Bearer) → `{device_id, name, server_version}` — drives the online check.
- Owner passphrase set at `sam init` (Argon2id). TLS via CertMagic; `--dev` = plain HTTP on localhost.

## CLI surface (minimal)
`sam init` (passphrase, host, data dir, write config) · `sam install-service` · `sam qr` / `sam pair new` · `sam serve` · `sam device list/revoke`.

## App (step-1 screen)
**Connect screen:** enter server URL + pairing code (or scan QR) → `POST /pair` → store token → call `/health` → show online/offline. Camera QR scan = refinement; paste works for M1.

## Out of scope for M1
No ingest, scrapers, pipeline, feed, sync, digest, providers. Only: reachable + installable + pairable + health.

## Acceptance walkthrough
Fresh VPS → `sam init` → `just setup-public` → `just install-service` → `sam qr` → open app → enter code → **"Yaaay, we're online."**
