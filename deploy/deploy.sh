#!/usr/bin/env bash
# deploy.sh — runs on the VPS after rsync delivers dist-incoming/
# Invoked by: ssh user@host 'bash /var/www/odeaworks.com/deploy.sh'
set -euo pipefail

APP_DIR="/var/www/odeaworks.com"
INCOMING="${APP_DIR}/dist-incoming"
WEBROOT="${APP_DIR}/html"

echo "[deploy] Starting deployment of odeaworks.com"
echo "[deploy] Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Validate incoming directory exists and has content
if [[ ! -d "${INCOMING}" ]]; then
  echo "[deploy] ERROR: ${INCOMING} does not exist. rsync step may have failed." >&2
  exit 1
fi

FILE_COUNT=$(find "${INCOMING}" -type f | wc -l)
if [[ "${FILE_COUNT}" -lt 1 ]]; then
  echo "[deploy] ERROR: ${INCOMING} is empty. Build artifact missing." >&2
  exit 1
fi
echo "[deploy] Incoming files: ${FILE_COUNT}"

# Atomic swap: move incoming into place
# rsync incoming → html (delete files removed from build)
rsync -a --delete "${INCOMING}/" "${WEBROOT}/"

echo "[deploy] Files synced to ${WEBROOT}"

# Test nginx config before reload
nginx -t

# Reload nginx (graceful, zero-downtime)
systemctl reload nginx

echo "[deploy] nginx reloaded"
echo "[deploy] Deployment complete."
