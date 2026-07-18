#!/usr/bin/env bash
# One-shot Linux setup for durbin.
#
# Run this FROM YOUR PROJECT'S ROOT (the repo you want Claude to work on):
#
#   cd ~/my-project
#   bash /path/to/durbin/setup.sh
#
# It installs a systemd user service that runs durbin for this project
# (survives reboots), enables Tailscale Funnel on the bridge port, and prints
# the phone URL with the access token baked in.
set -euo pipefail

DURBIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
NAME="durbin-$(basename "$PROJECT_DIR")"
PORT="${DURBIN_PORT:-8787}"
NODE_BIN="$(command -v node)"

if [ "$DURBIN_DIR" = "$PROJECT_DIR" ]; then
  echo "Run this from your project's root, not from inside the durbin repo:"
  echo "  cd ~/my-project && bash $DURBIN_DIR/setup.sh"
  exit 1
fi

if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH (durbin needs Node 20+)"; exit 1
fi

# durbin's own dependency (the Claude Agent SDK)
if [ ! -d "$DURBIN_DIR/node_modules" ]; then
  echo "Installing durbin dependencies..."
  (cd "$DURBIN_DIR" && npm install --no-fund --no-audit)
fi

# 1. Install + start the bridge as a systemd user service
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/"$NAME".service <<EOF
[Unit]
Description=durbin bridge for $(basename "$PROJECT_DIR")
After=network.target

[Service]
ExecStart=$NODE_BIN $DURBIN_DIR/bin/durbin.mjs
WorkingDirectory=$PROJECT_DIR
Environment=PATH=$PATH
Environment=DURBIN_PORT=$PORT
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$NAME".service

# Keep user services running even when you're not logged in
loginctl enable-linger "$USER" || true

# 2. Expose the bridge to the internet via Tailscale Funnel (stable HTTPS URL).
#    First run may print a link to enable Funnel for your tailnet: open it once.
if command -v tailscale >/dev/null; then
  tailscale funnel --bg "$PORT"
else
  echo "tailscale not found: install it from https://tailscale.com/download,"
  echo "log in, then run: tailscale funnel --bg $PORT"
fi

# 3. Print the access URL with the token baked in
TOKEN_FILE="$PROJECT_DIR/.durbin/token"
for _ in $(seq 1 20); do [ -f "$TOKEN_FILE" ] && break; sleep 0.5; done
if [ ! -f "$TOKEN_FILE" ]; then
  echo "Bridge did not start; check: journalctl --user -u $NAME -n 20"; exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"
HOST=""
if command -v tailscale >/dev/null; then
  HOST="$(tailscale status --json | grep -m1 '"DNSName"' | sed 's/.*"DNSName": "\(.*\)\.",*/\1/')"
fi

echo
echo "==============================================================="
echo " Service:  $NAME  (systemctl --user status $NAME)"
if [ -n "$HOST" ]; then
  echo
  echo " Open this on your phone (bookmark it, token logs you in once):"
  echo
  echo "   https://${HOST}/__agent?token=${TOKEN}"
  echo
  echo " Live preview of the site (same login):"
  echo
  echo "   https://${HOST}/"
else
  echo " Token:    $TOKEN"
  echo " Agent UI: http://127.0.0.1:$PORT/__agent?token=$TOKEN"
fi
echo "==============================================================="
