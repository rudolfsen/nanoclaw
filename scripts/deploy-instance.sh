#!/usr/bin/env bash
# scripts/deploy-instance.sh
# Deploy a new NanoClaw instance to the VPS
#
# Usage: ./scripts/deploy-instance.sh <instance-name> <vps-host>
# Example: ./scripts/deploy-instance.sh nanoclaw-ats root@204.168.178.32

set -euo pipefail

INSTANCE_NAME="${1:?Usage: deploy-instance.sh <instance-name> <vps-host>}"
VPS_HOST="${2:?Usage: deploy-instance.sh <instance-name> <vps-host>}"
INSTALL_DIR="/opt/${INSTANCE_NAME}"
SERVICE_NAME="${INSTANCE_NAME}"
REPO_URL="$(git remote get-url origin)"

echo "=== Deploying ${INSTANCE_NAME} to ${VPS_HOST}:${INSTALL_DIR} ==="

ssh "${VPS_HOST}" bash <<REMOTE
set -euo pipefail

# Clone if not exists
if [ ! -d "${INSTALL_DIR}" ]; then
  echo "Cloning repo..."
  git clone "${REPO_URL}" "${INSTALL_DIR}"
else
  echo "Directory exists, pulling latest..."
  cd "${INSTALL_DIR}" && git pull
fi

cd "${INSTALL_DIR}"

# Install deps and build
npm install --production=false
npm run build

# Create data directories
mkdir -p data/sessions data/ipc

# Create .env template if not exists
if [ ! -f .env ]; then
  cat > .env <<'ENV'
# === Required ===
ANTHROPIC_API_KEY=
ASSISTANT_NAME=ATS-Assistent

# === Outlook (Graph API) ===
OUTLOOK_TENANT_ID=
OUTLOOK_CLIENT_ID=
OUTLOOK_CLIENT_SECRET=
OUTLOOK_REFRESH_TOKEN=
OUTLOOK_EMAIL=
OUTLOOK_SHARED_MAILBOX=

# === Slack ===
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=

# === Instance isolation ===
CREDENTIAL_PROXY_PORT=3002
ENV
  echo "Created .env template — fill in credentials before starting"
fi

# Create systemd service
cat > /etc/systemd/system/${SERVICE_NAME}.service <<SERVICE
[Unit]
Description=NanoClaw ${INSTANCE_NAME}
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node ${INSTALL_DIR}/dist/index.js
WorkingDirectory=${INSTALL_DIR}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}

echo ""
echo "=== Deployment complete ==="
echo "Next steps:"
echo "  1. Fill in credentials: ssh ${VPS_HOST} 'nano ${INSTALL_DIR}/.env'"
echo "  2. Build container:     ssh ${VPS_HOST} 'cd ${INSTALL_DIR} && ./container/build.sh'"
echo "  3. Start service:       ssh ${VPS_HOST} 'systemctl start ${SERVICE_NAME}'"
echo "  4. Check status:        ssh ${VPS_HOST} 'systemctl status ${SERVICE_NAME}'"
echo "  5. View logs:           ssh ${VPS_HOST} 'journalctl -u ${SERVICE_NAME} -f'"
REMOTE
