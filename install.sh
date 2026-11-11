#!/usr/bin/env bash
set -euo pipefail

# RELAY installer
#   curl -fsSL https://raw.githubusercontent.com/0xCheetah1/relay/main/install.sh | bash
#
# Flags (all optional; the installer auto-detects Hermes/OpenClaw and the profile):
#   --profile <name>     RELAY profile (default: detected from the gateway, or "default")
#   --url <ws(s)://...>  relay server URL (default: $RELAY_URL or the public relay)
#   --harness <name>     hermes-gateway | openclaw (default: auto-detected; prompts if both are detected)
#   --openclaw           only install the OpenClaw bridge/plugin
#   --hermes             only install the Hermes bridge/plugin
#   --dir <path>         install directory (default: ~/.local/share/relay)
#   --dry-run            print what would be installed, then exit
#
# It backs up and enables the Telegram plugin in the detected harness config.

REPO_URL="${RELAY_REPO_URL:-https://github.com/0xCheetah1/relay.git}"
PROFILE="${RELAY_PROFILE:-}"
URL="${RELAY_URL:-wss://relay.thecheetah11.com/ws}"
HARNESS=""
INSTALL_DIR="${RELAY_INSTALL_DIR:-$HOME/.local/share/relay}"
DRY_RUN=0
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
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '3,18p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

gateway_profile() {
  local service="$1" value detected
  value="$(systemctl --user show "$service" -p Environment --value 2>/dev/null || true)"
  detected="$(printf '%s\n' "$value" | tr ' ' '\n' | sed -n 's/^RELAY_PROFILE=//p' | head -1)"
  printf '%s' "$detected"
}

TARGETS=()
HERMES_ON=0
OPENCLAW_ON=0

if [ -n "$HARNESS" ]; then
  case "$HARNESS" in
    hermes-gateway|openclaw) ;;
    *) echo "Unknown harness: $HARNESS (use hermes-gateway or openclaw)" >&2; exit 2 ;;
  esac
  selected_profile="$PROFILE"
  [ -n "$selected_profile" ] || selected_profile="$(gateway_profile "$HARNESS")"
  [ -n "$selected_profile" ] || selected_profile=default
  TARGETS+=("$HARNESS|$selected_profile")
else
  if [ "$COPY_HERMES" -eq 1 ] || [ "$COPY_OPENCLAW" -eq 1 ]; then
    [ "$COPY_HERMES" -eq 1 ] && HERMES_ON=1
    [ "$COPY_OPENCLAW" -eq 1 ] && OPENCLAW_ON=1
  else
    if command -v systemctl >/dev/null 2>&1; then
      if systemctl --user is-active --quiet hermes-gateway.service 2>/dev/null; then HERMES_ON=1; fi
      if systemctl --user is-active --quiet openclaw-gateway.service 2>/dev/null; then OPENCLAW_ON=1; fi
    fi
    if [ "$HERMES_ON" -eq 0 ] && [ "$OPENCLAW_ON" -eq 0 ]; then
      [ -d "$HOME/.hermes" ] && HERMES_ON=1
      [ -d "$HOME/.openclaw" ] && OPENCLAW_ON=1
    fi
  fi

  count=$((HERMES_ON + OPENCLAW_ON))
  if [ "$count" -gt 1 ] && [ "$COPY_HERMES" -eq 0 ] && [ "$COPY_OPENCLAW" -eq 0 ]; then
    if [ -r /dev/tty ]; then
      echo
      echo "Both Hermes and OpenClaw gateways were detected. Install RELAY on which one?"
      echo "  1) Hermes"
      echo "  2) OpenClaw"
      echo "  3) Cancel"
      while :; do
        printf 'Choose [1-3]: '
        read -r choice </dev/tty
        case "$choice" in
          1) OPENCLAW_ON=0; break ;;
          2) HERMES_ON=0; break ;;
          3) echo "Cancelled."; exit 0 ;;
          *) echo "Please choose 1, 2, or 3." >&2 ;;
        esac
      done
    else
      echo "Both Hermes and OpenClaw gateways are present. Re-run with --harness hermes-gateway or --harness openclaw." >&2
      exit 2
    fi
  fi

  if [ "$HERMES_ON" -eq 1 ]; then
    hp="$PROFILE"
    [ -n "$hp" ] || hp="$(gateway_profile hermes-gateway)"
    [ -n "$hp" ] || hp=default
    TARGETS+=("hermes-gateway|$hp")
  fi
  if [ "$OPENCLAW_ON" -eq 1 ]; then
    op="$PROFILE"
    [ -n "$op" ] || op="$(gateway_profile openclaw-gateway)"
    [ -n "$op" ] || op=default
    TARGETS+=("openclaw|$op")
  fi

  if [ "${#TARGETS[@]}" -eq 2 ]; then
    p1="${TARGETS[0]#*|}"
    p2="${TARGETS[1]#*|}"
    if [ "$p1" = "$p2" ]; then
      TARGETS[0]="hermes-gateway|hermes"
      TARGETS[1]="openclaw|openclaw"
      echo "Both gateways report the same profile; using 'hermes' and 'openclaw'. Set RELAY_PROFILE in each gateway." >&2
    fi
  fi
fi

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "No Hermes/OpenClaw harness detected; installing the CLI only."
else
  echo "Detected:"
  for target in "${TARGETS[@]}"; do
    IFS='|' read -r target_harness target_profile <<<"$target"
    echo "  - $target_harness (profile: $target_profile)"
  done
fi

if [ "$DRY_RUN" -eq 1 ]; then
  for target in "${TARGETS[@]}"; do
    IFS='|' read -r target_harness target_profile <<<"$target"
    echo "DRY: profile $target_profile -> $target_harness plugin -> relay-$target_profile.service"
  done
  exit 0
fi

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
RELAY_BIN="$HOME/.local/bin/relay"

copy_openclaw_plugin() {
  local target_profile="$1"
  mkdir -p "$HOME/.openclaw/extensions/relay-telegram"
  cp -R "$INSTALL_DIR/adapters/openclaw/telegram-plugin/." "$HOME/.openclaw/extensions/relay-telegram/"
  cat <<EOF

OpenClaw plugin copied (profile: $target_profile). Add to ~/.openclaw/openclaw.json:
  plugins.allow:       include "relay-telegram"
  plugins.entries:     "relay-telegram": { "enabled": true }
  channels.telegram.capabilities.inlineButtons: "all"
Gateway environment:
  RELAY_PROFILE=$target_profile
  RELAY_OPENCLAW_TELEGRAM_OWNER=<your telegram numeric id>
  RELAY_OPENCLAW_APPROVAL_SOCKET=\$HOME/.config/relay/$target_profile.sock
Then restart the Gateway.
EOF
}

copy_hermes_plugin() {
  local target_profile="$1"
  mkdir -p "$HOME/.hermes/plugins/relay-telegram"
  cp -R "$INSTALL_DIR/adapters/hermes/telegram-plugin/." "$HOME/.hermes/plugins/relay-telegram/"
  local config="${HERMES_HOME:-$HOME/.hermes}/config.yaml"
  if [ -f "$config" ] && ! grep -q 'relay-telegram' "$config" 2>/dev/null; then
    cp "$config" "$config.bak.$(date +%Y%m%d-%H%M%S)"
    if command -v python3 >/dev/null 2>&1; then
      python3 - "$config" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
s = p.read_text()
if '- relay-telegram' not in s and 'plugins:\n  enabled:\n' in s:
    p.write_text(s.replace('plugins:\n  enabled:\n', 'plugins:\n  enabled:\n  - relay-telegram\n', 1))
    print('enabled relay-telegram in Hermes config')
else:
    print('enable relay-telegram under plugins.enabled manually')
PY
    fi
  fi
  cat <<EOF

Hermes plugin copied and enabled in ~/.hermes/config.yaml (backup saved). Restart the Hermes Gateway.
Gateway environment:
  RELAY_PROFILE=$target_profile
  RELAY_APPROVAL_SOCKET=\$HOME/.config/relay/$target_profile.sock
EOF
}

enable_openclaw_plugin() {
  local config="${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
  if [ -f "$config" ]; then
    cp "$config" "$config.bak.$(date +%Y%m%d-%H%M%S)"
    if command -v python3 >/dev/null 2>&1; then
      python3 - "$config" <<'PY'
import json
import sys
from pathlib import Path
p = Path(sys.argv[1])
d = json.loads(p.read_text())
plugins = d.setdefault('plugins', {})
allow = plugins.setdefault('allow', [])
if 'relay-telegram' not in allow:
    allow.append('relay-telegram')
entries = plugins.setdefault('entries', {})
entries.setdefault('relay-telegram', {})['enabled'] = True
channels = d.setdefault('channels', {})
telegram = channels.setdefault('telegram', {})
caps = telegram.setdefault('capabilities', {})
caps['inlineButtons'] = 'all'
p.write_text(json.dumps(d, indent=2) + '\n')
print('enabled relay-telegram in OpenClaw config')
PY
    fi
  fi
}

UNITS=()
target_already_installed() {
  local target_harness="$1" target_profile="$2"
  local unit="$HOME/.config/systemd/user/relay-$target_profile.service"
  [ -f "$HOME/.config/relay/$target_profile.json" ] || return 1
  [ -f "$unit" ] || return 1
  grep -q "Environment=RELAY_PROFILE=$target_profile" "$unit" || return 1
  grep -q "bridge $target_harness" "$unit" || return 1
  if [ "$target_harness" = "openclaw" ]; then
    [ -d "${OPENCLAW_HOME:-$HOME/.openclaw}/extensions/relay-telegram" ] || return 1
  else
    [ -d "${HERMES_HOME:-$HOME/.hermes}/plugins/relay-telegram" ] || return 1
  fi
}

for target in "${TARGETS[@]}"; do
  IFS='|' read -r target_harness target_profile <<<"$target"
  if target_already_installed "$target_harness" "$target_profile"; then
    echo "Already installed: $target_harness (profile: $target_profile); leaving the existing installation unchanged."
    continue
  fi
  export RELAY_PROFILE="$target_profile"

  if [ ! -f "$HOME/.config/relay/$target_profile.json" ]; then
    "$RELAY_BIN" init
  fi
  "$RELAY_BIN" config set-url "$URL"
  echo "RELAY ID ($target_harness/$target_profile): $("$RELAY_BIN" id)"

  HERMES_ENV=""
  if [ "$target_harness" = "openclaw" ]; then
    copy_openclaw_plugin "$target_profile"
    enable_openclaw_plugin
  elif [ "$target_harness" = "hermes-gateway" ]; then
    copy_hermes_plugin "$target_profile"
    mkdir -p "$HOME/.config/relay"
    if [ ! -s "$HOME/.config/relay/hermes-webhook.key" ]; then
      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$HOME/.config/relay/hermes-webhook.key"
      chmod 600 "$HOME/.config/relay/hermes-webhook.key"
    fi
    HERMES_BIN=""
    if command -v hermes >/dev/null 2>&1; then
      HERMES_BIN="$(command -v hermes)"
    elif [ -x "$HOME/.local/bin/hermes" ]; then
      HERMES_BIN="$HOME/.local/bin/hermes"
    fi
    HERMES_A2A=""
    if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q '127.0.0.1:9900'; then
      HERMES_A2A="http://127.0.0.1:9900/"
    fi
    HERMES_ENV="Environment=RELAY_HERMES_TELEGRAM_SOCKET=%h/.config/relay/telegram.sock
Environment=RELAY_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/relay-incoming
Environment=RELAY_HERMES_WEBHOOK_SECRET_FILE=%h/.config/relay/hermes-webhook.key"
    if [ -n "$HERMES_BIN" ]; then
      HERMES_ENV="$HERMES_ENV
Environment=RELAY_HERMES_BIN=$HERMES_BIN"
    fi
    if [ -n "$HERMES_A2A" ]; then
      HERMES_ENV="$HERMES_ENV
Environment=RELAY_HERMES_A2A_URL=$HERMES_A2A"
    fi
  fi

  UNIT="$HOME/.config/systemd/user/relay-$target_profile.service"
  mkdir -p "$(dirname "$UNIT")"
  cat >"$UNIT" <<EOF
[Unit]
Description=RELAY bridge ($target_profile, $target_harness)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
Environment=RELAY_PROFILE=$target_profile
Environment=RELAY_URL=$URL
Environment=RELAY_HEADLESS=1
Environment=RELAY_HARNESS_TIMEOUT_MS=280000
$HERMES_ENV
ExecStart=$RELAY_BIN bridge $target_harness
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
EOF
  UNITS+=("relay-$target_profile.service")
done

if [ "${#UNITS[@]}" -gt 0 ]; then
  systemctl --user daemon-reload
  for unit in "${UNITS[@]}"; do
    systemctl --user enable --now "$unit"
    echo "Bridge service: $unit ($(systemctl --user is-active "$unit"))"
  done
fi

cat <<EOF

Done.
  relay id
  relay contacts add <alias> <relay-id>
  relay ask <alias> "<question>"      # owner-initiated, no approval tap
  relay call <alias> "<intent>" "<task>"
  relay web                           # phonebook UI

Uses the public relay by default: wss://relay.thecheetah11.com/ws. Pass --url to run your own.
Add each other's relay IDs and start a bridge on both sides.
EOF
