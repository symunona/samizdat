#!/usr/bin/env bash
set -euo pipefail

DOMAIN="sam.tmpx.space"
UPSTREAM="127.0.0.1:8765"
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"
NGINX_LINK="/etc/nginx/sites-enabled/${DOMAIN}"

echo "==> Writing nginx config for ${DOMAIN} -> ${UPSTREAM}"
cat > "$NGINX_CONF" << EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://${UPSTREAM};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_buffering off;
    }
}
EOF

echo "==> Enabling site"
ln -sf "$NGINX_CONF" "$NGINX_LINK"

echo "==> Testing nginx config"
nginx -t

echo "==> Reloading nginx"
systemctl reload nginx

echo "==> Running certbot"
certbot --nginx -d "$DOMAIN"

echo "==> Done. https://${DOMAIN} should be live."
