#!/usr/bin/env bash
# Milestone 1 · step 1 — configure public HTTPS reachability.
# CertMagic fetches the Let's Encrypt cert at first boot; you only need a
# hostname that resolves to this machine and ports 80/443 open.
set -euo pipefail

CONF="${CONF:-config.toml}"
ip="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
echo "Detected public IP: ${ip:-<unknown>}"
echo
echo "Pick a hostname:"
echo "  1) your own domain — add an A record pointing at ${ip:-<this-ip>}"
echo "  2) free: ${ip:+${ip}.sslip.io} — resolves to your IP automatically, no DNS setup"
echo
default_host="${ip:+${ip}.sslip.io}"
read -rp "Hostname [${default_host}]: " host
host="${host:-$default_host}"
[[ -n "$host" ]] || { echo "✗ No hostname; aborting." >&2; exit 1; }

echo
echo "→ Use this hostname in $CONF:"
echo "    host = \"$host\""
echo "    dev  = false"
echo
echo "CertMagic will obtain a TLS cert for '$host' on first boot."
echo "Ensure inbound 80 and 443 are open. Then: just install-service"
# TODO: write 'host' into $CONF automatically once the server fixes the format.
