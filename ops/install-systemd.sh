#!/usr/bin/env bash
# Install frond-ear as a systemd --user service so the ear survives a reboot.
#
# The daemon has no runtime dependencies: a clone and a node binary are enough.
# What it does need is a config and a bot token; see docs/recovery.md for where
# those come from if you no longer have them.
set -euo pipefail

EAR_NAME="${FROND_EAR_UNIT:-frond-ear}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_DIR="${FROND_EAR_CONF_DIR:-$HOME/.config/frond-ear}"
CONFIG="${FROND_EAR_CONFIG:-$CONF_DIR/frond-ear.json}"
TOKEN="${DISCORD_BOT_TOKEN_FILE:-$CONF_DIR/token}"
UNIT_DIR="$HOME/.config/systemd/user"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

die() { echo "frond-ear: $*" >&2; exit 1; }

[ -n "$NODE_BIN" ] || die "no node on PATH; set NODE_BIN"
# systemd has no login shell, so a version-manager shim must be an absolute path.
case "$NODE_BIN" in /*) ;; *) die "NODE_BIN must be absolute: $NODE_BIN" ;; esac

[ -s "$CONFIG" ] || die "no config at $CONFIG (copy frond-ear.example.json and fill it in)"
[ -s "$TOKEN" ]  || die "no bot token at $TOKEN (see docs/recovery.md)"
"$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$CONFIG" \
  || die "config is not valid JSON: $CONFIG"

chmod 700 "$CONF_DIR"; chmod 600 "$CONFIG" "$TOKEN"

if [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" != "yes" ]; then
  echo "frond-ear: WARNING — linger is off, so user units do not start until you log in." >&2
  echo "frond-ear:   enable it with: loginctl enable-linger $USER" >&2
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$EAR_NAME.service" <<UNIT
[Unit]
Description=frond-ear — Discord gateway ear for a long-running Claude Code session
Documentation=https://github.com/karmaterminal/frond-ear
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
Environment=FROND_EAR_CONFIG=$CONFIG
Environment=DISCORD_BOT_TOKEN_FILE=$TOKEN
# Fail loudly in the journal rather than crash-loop on a missing credential.
ExecStartPre=/usr/bin/test -s $TOKEN
ExecStart=$NODE_BIN src/cli.ts daemon
Restart=always
RestartSec=5
# The ear holds messages for a detached session; give it time to close cleanly.
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "$EAR_NAME.service"

for _ in $(seq 1 15); do
  state="$("$NODE_BIN" "$REPO_DIR/src/cli.ts" status 2>/dev/null \
    | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).gateway.state)}catch{process.stdout.write("?")}})' || true)"
  [ "$state" = "connected" ] && { echo "frond-ear: installed and connected ($EAR_NAME.service)"; exit 0; }
  sleep 1
done

echo "frond-ear: unit installed but the gateway is not connected yet." >&2
echo "frond-ear:   journalctl --user -u $EAR_NAME.service -n 30" >&2
exit 1
