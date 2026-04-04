#!/usr/bin/env bash
# vps-bootstrap.sh — One-time VPS setup for odeaworks.com
# Run as root on hetznerCO: bash vps-bootstrap.sh
# This script is idempotent — safe to re-run.
set -euo pipefail

VPS_IP="5.161.239.237"
APP_DIR="/var/www/odeaworks.com"
NGINX_SITES_AVAILABLE="/etc/nginx/sites-available"
NGINX_SITES_ENABLED="/etc/nginx/sites-enabled"

echo "[bootstrap] Setting up odeaworks.com on $(hostname)"

# 1. Create directory structure
mkdir -p "${APP_DIR}/html"
mkdir -p "${APP_DIR}/dist-incoming"
echo "[bootstrap] Created ${APP_DIR}/{html,dist-incoming}"

# 2. Set permissions so deploy user (root on this VPS) can write
chmod 755 "${APP_DIR}"
chmod 755 "${APP_DIR}/html"
chmod 755 "${APP_DIR}/dist-incoming"

# 3. Install nginx config for main site
cp /tmp/nginx-odeaworks.com.conf "${NGINX_SITES_AVAILABLE}/odeaworks.com"
ln -sf "${NGINX_SITES_AVAILABLE}/odeaworks.com" "${NGINX_SITES_ENABLED}/odeaworks.com"
echo "[bootstrap] nginx config for odeaworks.com installed"

# 4. Install nginx config for redirect domains
cp /tmp/nginx-redirects.conf "${NGINX_SITES_AVAILABLE}/odea-redirects"
ln -sf "${NGINX_SITES_AVAILABLE}/odea-redirects" "${NGINX_SITES_ENABLED}/odea-redirects"
echo "[bootstrap] nginx config for redirect domains installed"

# 5. Copy deploy script to app dir
cp /tmp/deploy.sh "${APP_DIR}/deploy.sh"
chmod +x "${APP_DIR}/deploy.sh"
echo "[bootstrap] deploy.sh installed at ${APP_DIR}/deploy.sh"

# 6. Create a placeholder index.html so nginx starts cleanly before first deploy
if [[ ! -f "${APP_DIR}/html/index.html" ]]; then
    echo '<html><body><h1>odeaworks.com — deploying</h1></body></html>' > "${APP_DIR}/html/index.html"
    echo "[bootstrap] Placeholder index.html created"
fi

# 7. Test nginx config
nginx -t
echo "[bootstrap] nginx config test passed"

# 8. Reload nginx
systemctl reload nginx
echo "[bootstrap] nginx reloaded"

echo ""
echo "[bootstrap] NEXT STEPS:"
echo "  1. Run certbot for SSL (after DNS is pointing to ${VPS_IP}):"
echo "     certbot --nginx -d odeaworks.com -d www.odeaworks.com --redirect --agree-tos -m ssl@odeaworks.com --non-interactive"
echo "     certbot --nginx -d odeaenterprises.com -d www.odeaenterprises.com --redirect --agree-tos -m ssl@odeaworks.com --non-interactive"
echo "     certbot --nginx -d odeaengineering.com -d www.odeaengineering.com --redirect --agree-tos -m ssl@odeaworks.com --non-interactive"
echo "     certbot --nginx -d odeaco.com -d www.odeaco.com --redirect --agree-tos -m ssl@odeaworks.com --non-interactive"
echo "  2. Add GitHub Secrets (HETZNER_CO_HOST, HETZNER_CO_USER, HETZNER_CO_SSH_KEY)"
echo "  3. Push to main branch to trigger first deploy"
echo ""
echo "[bootstrap] Bootstrap complete."
