#!/usr/bin/env bash
# Install supervised re-entry for one ear: a oneshot unit that runs
# `frond-ear rez --ear <ear>`, and a timer that runs it at boot and every few
# minutes. rez is a no-op while the ear's bound session is live, resumes it with
# the channel flag in tmux session "frond-<ear>" when it is not, and refuses
# (loudly, in the journal) rather than start a second copy.
#
#   ops/install-rez.sh <ear> [--no-timer] [--launcher <abs path>] [--permission-mode <mode>]
#
# A seat that runs claude through its own launcher (its own CLAUDE_CONFIG_DIR, env file, ...)
# passes --launcher: rez runs it in place of claude, with claude's arguments, so the launcher
# must end in `exec claude "$@"`. CLAUDE_CONFIG_DIR, if set now, is written into the unit too.
#
# Stop resurrection with: systemctl --user disable --now frond-ear-rez-<ear>.timer
# (or `frond-ear bind --ear <ear> --release`, which leaves nothing to resume).
set -euo pipefail

USAGE="usage: ops/install-rez.sh <ear> [--no-timer] [--launcher <abs path>] [--permission-mode <mode>]"
EAR="${1:-}"
[ -n "$EAR" ] || { echo "$USAGE" >&2; exit 2; }
shift
TIMER=1; LAUNCHER=""; MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-timer) TIMER=0 ;;
    --launcher) LAUNCHER="${2:-}"; shift ;;
    --permission-mode) MODE="${2:-}"; shift ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
  shift
done

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
case "$LAUNCHER${CLAUDE_CONFIG_DIR:-}" in *[[:space:]]*) die "paths with spaces cannot go in a unit line" ;; esac
case "$LAUNCHER" in "" | /*) ;; *) die "--launcher must be an absolute path" ;; esac
[ -z "$LAUNCHER" ] || [ -x "$LAUNCHER" ] || die "$LAUNCHER is not executable"
case "$MODE" in "" | default | acceptEdits | plan | auto | dontAsk | bypassPermissions) ;;
  *) die "unknown permission mode: $MODE" ;; esac
case "${CLAUDE_CONFIG_DIR:-}" in "" | /*) ;; *) die "CLAUDE_CONFIG_DIR must be absolute" ;; esac
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
}${CLAUDE_CONFIG_DIR:+Environment=CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR
}ExecStart=$NODE_BIN src/cli.ts rez --ear $EAR${LAUNCHER:+ --launcher $LAUNCHER}${MODE:+ --permission-mode $MODE}
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
