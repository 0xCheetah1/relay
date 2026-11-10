#!/usr/bin/env bash
set -euo pipefail

# RELAY installer
#   curl -fsSL https://raw.githubusercontent.com/0xCheetah1/relay/main/install.sh | bash
# or:
#   ./install.sh --profile velo --url wss://ws.example.com --harness hermes-gateway --hermes
#
# Flags:
#   --profile <name>     RELAY profile (default: $RELAY_PROFILE or "default")
#   --url <ws(s)://...>  relay server URL (default: $RELAY_URL)
#   --harness <name>     hermes-gateway | openclaw (optional; installs a user bridge service)
#   --openclaw           copy the OpenClaw Telegram approval plugin
#   --hermes             copy the Hermes Telegram approval plugin
#   --dir <path>         install directory (default: ~/.local/share/relay)
#
# The script never edits your harness config. It prints the exact keys to add.

REPO_URL="${RELAY_REPO_URL:-https://github.com/0xCheetah1/relay.git}"
PROFILE="${RELAY_PROFILE:-default}"
URL="${RELAY_URL:-}"
HARNESS=""
INSTALL_DIR="${RELAY_INSTALL_DIR:-$HOME/.local/share/relay}"
COPY_OPENCLAW=0
COPY_HERMES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift 2 ;;
    --url) URL="${2:?}"; shift 2 ;;
    --harness) HARNESS="${2:?}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:?}"; shift 2 ;;
    --openclaw) COPY_OPENCLAW=1; shift ;;
    --hermes) COPY_HERMES=1; shift ;;
    -h|--help) sed -n '3,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node 22+ is required." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node 22+ is required (found $(node --version))." >&2
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "Installing to $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
npm ci --omit=dev --silent

mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/bin/relay.js" "$HOME/.local/bin/relay"
chmod +x "$INSTALL_DIR/bin/relay.js"

export RELAY_PROFILE="$PROFILE"
if [ ! -f "$HOME/.config/relay/$PROFILE.json" ]; then
  "$HOME/.local/bin/relay" init
fi
if [ -n "$URL" ]; then
  "$HOME/.local/bin/relay" config set-url "$URL"
fi
echo "RELAY ID: $("$HOME/.local/bin/relay" id)"

if [ "$COPY_OPENCLAW" -eq 1 ]; then
  mkdir -p "$HOME/.openclaw/extensions/relay-telegram"
  cp -R "$INSTALL_DIR/adapters/openclaw/telegram-plugin/." "$HOME/.openclaw/extensions/relay-telegram/"
  cat <<EOF

OpenClaw plugin copied. Add to ~/.openclaw/openclaw.json:
  plugins.allow:       include "relay-telegram"
  plugins.entries:     "relay-telegram": { "enabled": true }
  channels.telegram.capabilities.inlineButtons: "all"
Gateway environment:
  RELAY_PROFILE=$PROFILE
  RELAY_OPENCLAW_TELEGRAM_OWNER=<your telegram numeric id>
  RELAY_OPENCLAW_APPROVAL_SOCKET=\$HOME/.config/relay/$PROFILE.sock
Then restart the Gateway.
EOF
fi

if [ "$COPY_HERMES" -eq 1 ]; then
  mkdir -p "$HOME/.hermes/plugins/relay-telegram"
  cp -R "$INSTALL_DIR/adapters/hermes/telegram-plugin/." "$HOME/.hermes/plugins/relay-telegram/"
  cat <<EOF

Hermes plugin copied. Enable it in ~/.hermes/config.yaml, and set in the Hermes Gateway environment:
  RELAY_PROFILE=$PROFILE
  RELAY_APPROVAL_SOCKET=\$HOME/.config/relay/$PROFILE.sock
Then restart the Gateway.
EOF
fi

if [ -n "$HARNESS" ]; then
  case "$HARNESS" in
    hermes-gateway|openclaw) ;;
    *) echo "Unknown harness: $HARNESS (use hermes-gateway or openclaw)" >&2; exit 2 ;;
  esac
  UNIT="$HOME/.config/systemd/user/relay-$PROFILE.service"
  mkdir -p "$(dirname "$UNIT")"
  cat >"$UNIT" <<EOF
[Unit]
Description=RELAY bridge ($PROFILE, $HARNESS)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
Environment=RELAY_PROFILE=$PROFILE
Environment=RELAY_URL=${URL:-ws://127.0.0.1:8901}
Environment=RELAY_HEADLESS=1
ExecStart=$HOME/.local/bin/relay bridge $HARNESS
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "relay-$PROFILE.service"
  echo "Bridge service: relay-$PROFILE.service ($(systemctl --user is-active "relay-$PROFILE.service"))"
fi

cat <<EOF

Done.
  relay id
  relay contacts add <alias> <relay-id>
  relay ask <alias> "<question>"      # owner-initiated, no approval tap
  relay call <alias> "<intent>" "<task>"
  relay web                           # phonebook UI

Set the same RELAY_URL on the other agent, add each other's relay IDs, and start a bridge on both sides.
EOF
