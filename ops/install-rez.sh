#!/usr/bin/env bash
# Install supervised re-entry for one ear: a oneshot unit that runs
# `frond-ear rez --ear <ear>`, and a timer that runs it at boot and every few
# minutes. rez is a no-op while the ear's bound session is live, resumes it with
# the channel flag in tmux session "frond-<ear>" when it is not, and refuses
# (loudly, in the journal) rather than start a second copy.
#
#   ops/install-rez.sh <ear> [--no-timer]
#
# Stop resurrection with: systemctl --user disable --now frond-ear-rez-<ear>.timer
# (or `frond-ear bind --ear <ear> --release`, which leaves nothing to resume).
set -euo pipefail

EAR="${1:-}"
[ -n "$EAR" ] || { echo "usage: ops/install-rez.sh <ear> [--no-timer]" >&2; exit 2; }
TIMER=1; [ "${2:-}" = "--no-timer" ] && TIMER=0

INSTANCE="${FROND_EAR_INSTANCE:-}"
DAEMON_UNIT="${FROND_EAR_UNIT:-frond-ear${INSTANCE:+-$INSTANCE}}"
UNIT="frond-ear-rez-$EAR"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
TMUX_BIN="$(command -v tmux || true)"

die() { echo "frond-ear: $*" >&2; exit 1; }
case "$EAR" in *[!A-Za-z0-9_-]*) die "ear names are letters, digits, - or _" ;; esac
# systemd has no login shell, so every binary must be an absolute path.
case "$NODE_BIN" in /*) ;; *) die "no absolute node; set NODE_BIN" ;; esac
case "$CLAUDE_BIN" in /*) ;; *) die "no absolute claude; set CLAUDE_BIN" ;; esac
[ -n "$TMUX_BIN" ] || die "tmux is required (the session needs a terminal to live in)"
systemctl --user cat "$DAEMON_UNIT.service" >/dev/null 2>&1 \
  || die "$DAEMON_UNIT.service is not installed; run ops/install-systemd.sh first"

mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$UNIT.service" <<UNIT
[Unit]
Description=frond-ear — bring ear $EAR's Claude session back, hearing
Documentation=https://github.com/karmaterminal/frond-ear/blob/main/docs/reentry.md
Requires=$DAEMON_UNIT.service
After=$DAEMON_UNIT.service

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
Environment=PATH=$(dirname "$CLAUDE_BIN"):$(dirname "$NODE_BIN"):$(dirname "$TMUX_BIN"):/usr/bin:/bin
Environment=CLAUDE_BIN=$CLAUDE_BIN
${INSTANCE:+Environment=FROND_EAR_INSTANCE=$INSTANCE
}ExecStart=$NODE_BIN src/cli.ts rez --ear $EAR
# 3 = unbound, nothing to resume: not a failure. 4 (refused) and 5 (failed) stay visible.
SuccessExitStatus=3
# The tmux server (and the session inside it) must outlive this oneshot.
KillMode=process
UNIT

if [ "$TIMER" = 1 ]; then
  cat > "$UNIT_DIR/$UNIT.timer" <<UNIT
[Unit]
Description=frond-ear — keep ear $EAR's Claude session alive

[Timer]
OnBootSec=2min
OnUnitInactiveSec=5min

[Install]
WantedBy=timers.target
UNIT
fi

systemctl --user daemon-reload
if [ "$TIMER" = 1 ]; then
  systemctl --user enable --now "$UNIT.timer"
  echo "frond-ear: installed $UNIT.service + $UNIT.timer (runs at boot, then every 5 minutes)"
else
  echo "frond-ear: installed $UNIT.service; run it with: systemctl --user start $UNIT"
fi
echo "frond-ear:   journal: journalctl --user -u $UNIT -n 20"
