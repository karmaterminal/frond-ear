#!/usr/bin/env bash
# Clean-install receipt for frond-ear (#70): a stranger's install, end to end, in a disposable
# root with a fresh HOME and an emptied environment, against a loopback stand-in for Discord and
# a real Claude Code session. README.md beside this file says what it needs and what it proves.
#
#   tools/clean-install/receipt.sh all [STEP]  every step in order, or from STEP on; tears
#                                              down even on failure
#   tools/clean-install/receipt.sh STEP        one step: setup isolation fetch init doctor-pre
#                                              discord daemon-fail daemon doctor-post register
#                                              wrong-ear launch canary event away teardown
#   tools/clean-install/receipt.sh screen      print the session's pane (emails redacted)
#
# Environment: PIN, the commit under test (default: HEAD of this checkout); FE_RECEIPT, the
# workspace (default: ${TMPDIR:-/tmp}/frond-ear-receipt); WAIT, seconds a session step waits
# (default 240); KEEP=1 skips the teardown after a failed `all`.
set -u
DEV=$(cd "$(dirname "$0")/../.." && pwd)
W=${FE_RECEIPT:-${TMPDIR:-/tmp}/frond-ear-receipt}
ROOT=$W/root
R=$W/receipt
T=$R/transcript.md
STATE=$W/state.env
WAIT=${WAIT:-240}
BOT=100000000000000001
PRINCIPAL=200000000000000002
CHANNEL=700000000000000007
EAR=trial
TMUX_SERVER=fe-receipt

[ -f "$STATE" ] && . "$STATE"

save() { printf '%s=%q\n' "$1" "$2" >>"$STATE"; }

# The disposable environment: nothing from the caller's environment passes through.
clean() {
  env -i HOME="$ROOT/home" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/bash \
    PATH="$CLEAN_PATH" LANG=C.UTF-8 TERM=xterm-256color XDG_RUNTIME_DIR="$ROOT/run" \
    GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 DISABLE_AUTOUPDATER=1 \
    EDITOR="$ROOT/human/fake-editor" "$@"
}

scrub() { sed -E -e "s#$ROOT#\$ROOT#g" -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g'; }

# record TITLE CWD SCRIPT: runs SCRIPT under bash in the disposable environment and appends the
# commands, their output and the exit status to the transcript. Returns the exit status.
record() {
  local title=$1 cwd=$2 script=$3 out code
  {
    printf '\n### %s\n\n' "$title"
    printf '%s · cwd `%s`\n\n```console\n' "$(date -u +%H:%M:%SZ)" "${cwd/#$ROOT/\$ROOT}"
    printf '%s\n' "$script" | scrub | sed 's/^/$ /'
  } >>"$T"
  out=$(cd "$cwd" && clean bash -c "$script" 2>&1)
  code=$?
  [ -n "${RAW_OUT:-}" ] && printf '%s\n' "$out" >"$RAW_OUT"
  printf '%s\n[exit %s]\n```\n' "$out" "$code" | scrub >>"$T"
  printf '%s\n[exit %s]\n' "$out" "$code" | scrub
  return $code
}

note() { printf '\n%s\n' "$*" >>"$T"; }

fake() { curl -sS "http://127.0.0.1:$PORT$1" "${@:2}"; }

wait_for() { # wait_for SECONDS DESCRIPTION COMMAND...
  local deadline=$((SECONDS + $1)) what=$2
  shift 2
  until "$@" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      echo "timed out waiting for $what" >&2
      return 1
    fi
    sleep 1
  done
}

# The ear's entry in `frond-ear status`, read from inside the disposable environment.
ear() {
  (cd "$ROOT/home/frond-ear" && clean node src/cli.ts status 2>/dev/null) |
    node -e 'const s = JSON.parse(require("fs").readFileSync(0, "utf8")); const e = s.ears.find((x) => x.name === process.argv[1]); if (!e) process.exit(1); console.log(JSON.stringify({ gateway: s.gateway.state, ...e }));' "$EAR"
}
ear_is() { ear | node -e 'const e = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(process.argv.slice(1).every((k) => k.startsWith("!") ? !e[k.slice(1)] : e[k]) ? 0 : 1);' "$@"; }
gateway_connected() { ear | grep -q '"gateway":"connected"'; }
posts() { fake /control/state | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).posts.length)'; }
posts_at_least() { [ "$(posts)" -ge "$1" ]; }

tm() { TMUX_TMPDIR="$ROOT/run" tmux -L "$TMUX_SERVER" "$@"; }
pane() { tm capture-pane -p -t trial 2>/dev/null; }
press() { # press KEY: one key, then up to 5 s for the pane to change
  local before
  before=$(pane)
  tm send-keys -t trial "$1"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    [ "$(pane)" != "$before" ] && break
  done
  return 0
}

# Presses what a person presses at each startup prompt until the ear is attached. Prints the
# answers given; returns 2 when Claude Code asks for a login, 1 on timeout.
answer_prompts() {
  local deadline=$((SECONDS + $1)) screen answers=""
  while ((SECONDS < deadline)); do
    if ear_is attached; then
      printf '%s' "${answers:-none}"
      return 0
    fi
    screen=$(pane)
    case "$screen" in
    *"Select login method"*) return 2 ;;
    *"Choose the text style"*) press Enter && answers+="theme: Enter. " ;;
    *"Press Enter to continue"*) press Enter && answers+="security notes: Enter. " ;;
    *"❯ Yes, I trust this folder"*) press Enter && answers+="trust this folder: Yes. " ;;
    *"Yes, I trust this folder"*) press Down ;;
    *"❯ 1. I am using this for local development"*) press Enter && answers+="development channels: 1 (local development). " ;;
    *) sleep 1 ;;
    esac
  done
  return 1
}

launch_session() { # launch_session COMMAND: starts Claude Code in the session's pane
  tm kill-session -t trial 2>/dev/null
  (cd "$ROOT/home/trial-session" && clean env TMUX_TMPDIR="$ROOT/run" tmux -L "$TMUX_SERVER" new-session -d -s trial -x 200 -y 50 "$1")
  local answers code
  answers=$(answer_prompts "$WAIT")
  code=$?
  if [ $code -eq 2 ]; then
    echo "Claude Code wants a login in the disposable HOME. Attach with" >&2
    echo "  TMUX_TMPDIR=$ROOT/run tmux -L $TMUX_SERVER attach -t trial" >&2
    echo "log in, leave Claude Code with /exit, then run: $0 all launch" >&2
    return 2
  fi
  [ $code -eq 0 ] || {
    echo "the ear was not attached within ${WAIT}s; the pane:" >&2
    pane | scrub >&2
    return 1
  }
  note "Startup prompts answered as a person would: $answers"
}

exit_session() {
  tm has-session -t trial 2>/dev/null || return 0
  tm send-keys -t trial Escape
  sleep 1
  tm send-keys -t trial "/exit" Enter
  for _ in $(seq 1 20); do
    tm has-session -t trial 2>/dev/null || return 0
    sleep 1
  done
  tm kill-server
  note 'The Claude Code session did not exit on `/exit` within 20 s; its tmux server was killed.'
}

start_daemon() { # start_daemon LOGFILE: the daemon line init printed, pointed at the stand-in
  local line
  line=$(grep -m1 -E '^ +FROND_EAR_CONFIG=.* daemon$' "$R/init.out" | sed -E 's/^ +//')
  [ -n "$line" ] || {
    echo "init printed no daemon line" >&2
    return 1
  }
  save DAEMON_LINE "$line"
  DAEMON_LINE=$line
  # The whole background subshell is redirected, so nothing it holds keeps a caller's pipe open.
  (
    cd "$ROOT/home" &&
      clean bash -c "exec env DISCORD_GATEWAY_URL=ws://127.0.0.1:$PORT/gateway DISCORD_API_BASE=http://127.0.0.1:$PORT/api/v10 $line"
  ) >/dev/null 2>"$1" </dev/null &
  DAEMON_SUBSHELL=$!
}

daemon_pid() { pgrep -n -f "$ROOT/home/frond-ear/src/cli.ts daemon$"; }

ledger() { # ledger TITLE: the ear's status, as the session's owner would read it
  record "$1" "$ROOT/home/frond-ear" \
    'node src/cli.ts status 2>/dev/null | node -e '"'"'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'"'"''
}

doctor() { # doctor TITLE
  record "$1" "$ROOT/home/frond-ear" \
    'export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
node src/cli.ts doctor'
}

inbound() { # inbound TEXT: the principal mentions the bot in the channel
  fake /control/inbound -XPOST -H 'content-type: application/json' \
    -d "{\"channel\":\"$CHANNEL\",\"author\":\"$PRINCIPAL\",\"username\":\"tester\",\"mention\":true,\"content\":\"$1\"}"
}

discord_record() { # discord_record TITLE: what the stand-in for Discord received
  {
    printf '\n### %s\n\n```json\n' "$1"
    fake /control/state | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({identifies: s.identifies, closes: s.closes, inbound: s.dispatches.filter(d => d.t === "MESSAGE_CREATE").map(d => ({seq: d.s, id: d.d.id, content: d.d.content})), posts: s.posts.map(p => ({channel: p.channel_id, content: p.content, replyTo: p.replyTo, nonce: p.nonce !== null})), reactions: s.reactions, rest: s.restCalls.reduce((a, c) => { const k = c.method + " " + c.path.replace(/\d{17,20}/gu, ":id") + (c.authOk ? "" : " (bad auth)"); a[k] = (a[k] ?? 0) + 1; return a; }, {})}, null, 1))'
    printf '```\n'
  } >>"$T"
}

step() {
  case "$1" in
  setup)
    command -v tmux >/dev/null && command -v curl >/dev/null && command -v claude >/dev/null || {
      echo "needs tmux, curl and claude on PATH" >&2
      return 1
    }
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' || {
      echo "needs Node >= 22.18" >&2
      return 1
    }
    [ -d "$DEV/node_modules/ws" ] || {
      echo "run pnpm install in $DEV first: the stand-in for Discord needs ws" >&2
      return 1
    }
    [ ${#ROOT} -le 80 ] || { # the daemon's socket path must stay under 108 bytes
      echo "FE_RECEIPT is too long for a unix socket path under it; use a shorter one" >&2
      return 1
    }
    tm kill-server 2>/dev/null
    rm -rf "$ROOT" "$STATE" "$R"
    mkdir -p "$ROOT/home" "$ROOT/run" "$ROOT/human" "$R" || return 1
    chmod 700 "$ROOT/home" "$ROOT/run"
    PIN=$(git -C "$DEV" rev-parse "${PIN:-HEAD}") || return 1
    save PIN "$PIN"
    local node_dir claude_dir
    node_dir=$(dirname "$(command -v node)")
    claude_dir=$(dirname "$(command -v claude)")
    save CLEAN_PATH "$node_dir$([ "$claude_dir" = "$node_dir" ] || printf ':%s' "$claude_dir"):/usr/bin:/bin"
    # What the caller's own HOME holds of frond-ear now; teardown checks it is unchanged.
    save REAL_HOME_BEFORE "$(real_home_state)"
    # The source a stranger would clone, frozen at PIN, for when the repository is not public.
    rm -rf "$W/pin.git"
    git init -q --bare "$W/pin.git" &&
      git -C "$DEV" push -q "$W/pin.git" "$PIN:refs/heads/main" &&
      git -C "$W/pin.git" symbolic-ref HEAD refs/heads/main &&
      git -C "$W/pin.git" bundle create -q "$ROOT/frond-ear.bundle" HEAD main &&
      rm -rf "$W/pin.git" || return 1
    # The person's $EDITOR, for the step where the person writes the token: it writes a
    # synthetic token. Nothing in this receipt is a real Discord token.
    printf '%s\n' '#!/bin/sh' \
      "printf '%s\\n' 'receipt-only-not-a-discord-token-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')' > \"\$1\"" \
      >"$ROOT/human/fake-editor"
    chmod 755 "$ROOT/human/fake-editor"
    {
      printf '# frond-ear clean-install receipt\n\n'
      printf -- '- Started: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf -- '- Commit under test: `%s`\n' "$PIN"
      printf -- '- Harness: `tools/clean-install/` at `%s`%s\n' "$(git -C "$DEV" rev-parse HEAD)" \
        "$([ -z "$(git -C "$DEV" status --porcelain -- tools/clean-install)" ] || echo ', with uncommitted changes')"
      printf -- '- `$ROOT`: a fresh directory, deleted at teardown. `$ROOT/home` is HOME.\n'
    } >>"$T"
    echo "setup done: $ROOT"
    ;;

  isolation)
    note '## 0. What the disposable environment holds'
    note 'Every command below runs under `env -i` with only the variables listed here, as the same Linux user as the caller. HOME, the environment and the working directories are what is isolated; files outside `$ROOT` are not hidden by permissions, and nothing here reads them except the binaries on PATH and Claude Code finding its own login.'
    record "environment (env -i: only these variables)" "$ROOT/home" 'env | sort'
    record "HOME is empty: no git, gh, frond-ear or Claude Code config" "$ROOT/home" \
      'ls -A ~; git config --list --show-origin 2>/dev/null || echo "(no git config)"; if command -v gh >/dev/null; then gh auth status 2>&1 | head -2; else echo "(no gh on PATH)"; fi; test -e ~/.config || echo "(no ~/.config)"; test -e ~/.claude.json || echo "(no ~/.claude.json)"'
    record "toolchain" "$ROOT/home" 'node --version; git --version; claude --version'
    record "unauthenticated GitHub, straight from this environment (no proxy, no credentials)" "$ROOT/home" \
      'for repo in frond-ear binary-canticle scribe-prince-shared frond-scribe; do printf "%-22s " "$repo"; git ls-remote "https://github.com/karmaterminal/$repo" HEAD 2>&1 | head -1; done'
    ;;

  fetch)
    note '## 1. Clone at the pinned commit'
    if record "the README's clone line" "$ROOT/home" \
      'git clone https://github.com/karmaterminal/frond-ear && cd frond-ear && git rev-parse HEAD'; then
      record "check out the commit under test" "$ROOT/home/frond-ear" \
        "git fetch -q origin $PIN; git checkout -q --detach $PIN && git rev-parse HEAD && node -p 'require(\"./package.json\").version'"
    else
      note 'The repository is not public yet (#35), so the clone fails without credentials. Stand-in: the same history, from a bundle of the commit under test made outside the disposable environment.'
      rm -rf "$ROOT/home/frond-ear"
      record "stand-in: clone the bundle of the pinned commit" "$ROOT/home" \
        'git clone -q ../frond-ear.bundle frond-ear && cd frond-ear && git rev-parse HEAD && git log -1 --format="%cI %s" && node -p "require(\"./package.json\").version"'
    fi
    ;;

  init)
    note '## 2. Bot token and config (`init`)'
    note 'The person writes the token (docs/onboarding.md), so it never passes through the agent. `$EDITOR` here writes a synthetic token.'
    record "person: create the 0600 token file and write the token" "$ROOT/home" \
      'install -d -m 700 ~/.config/frond-ear
sh -c '"'"'umask 077; set -C; : > "$1"'"'"' sh ~/.config/frond-ear/token && $EDITOR ~/.config/frond-ear/token' || return 1
    RAW_OUT="$R/init.out" record "agent: init --non-interactive, with synthetic IDs" "$ROOT/home/frond-ear" \
      "node src/cli.ts init --non-interactive --bot-user-id $BOT --principal $PRINCIPAL:tester --ear $EAR --channel $CHANNEL --mention-pattern '\\btrial\\b' --token-file ~/.config/frond-ear/token" || return 1
    record "the two files init wrote, and their modes" "$ROOT/home" \
      'stat -c "%a %n" ~/.config/frond-ear ~/.config/frond-ear/*; cat ~/.config/frond-ear/frond-ear.json'
    ;;

  doctor-pre)
    note '## 3. `doctor` before the daemon'
    record "failure: doctor without the two exports" "$ROOT/home/frond-ear" 'node src/cli.ts doctor'
    note 'Repair: the two `export` lines from the README, which `init` also prints in front of every command.'
    doctor "repaired: doctor with the exports (socket and daemon stay ✗ until the daemon runs)"
    return 0
    ;;

  discord)
    # Test equipment, outside the disposable environment: it needs ws from this checkout.
    rm -f "$W/fake.port"
    node "$DEV/tools/clean-install/fake-discord.ts" --port-file "$W/fake.port" \
      --log "$R/fake-discord.jsonl" --bot "$BOT" --token-file "$ROOT/home/.config/frond-ear/token" \
      --message-content-intent "${INTENT:-off}" >"$R/fake-discord.out" 2>&1 &
    save FAKE_PID $!
    wait_for 10 "the stand-in for Discord" test -s "$W/fake.port" || return 1
    save PORT "$(tr -d '\n' <"$W/fake.port")"
    echo "stand-in for Discord on 127.0.0.1:$(cat "$W/fake.port"), Message Content Intent ${INTENT:-off}"
    ;;

  daemon-fail)
    note '## 4. Daemon'
    note "The daemon runs as \`init\` printed it (its step 1), with two variables in front that point it at the loopback stand-in for Discord: \`DISCORD_GATEWAY_URL=ws://127.0.0.1:$PORT/gateway DISCORD_API_BASE=http://127.0.0.1:$PORT/api/v10\`. The stand-in starts with the bot's Message Content Intent off, as in a portal where nobody turned it on."
    start_daemon "$R/daemon-1.log" || return 1
    wait "$DAEMON_SUBSHELL"
    local code=$?
    {
      printf '\n### failure: the daemon exits when Discord refuses the intent\n\n```console\n$ %s\n' "$DAEMON_LINE"
      grep -E 'gateway\.fatal_close|daemon\.exit_gateway_fatal|daemon\.stopped' "$R/daemon-1.log"
      printf '[exit %s]\n```\n' "$code"
    } | scrub >>"$T"
    [ "$code" -ne 0 ] || return 1
    record "doctor names the daemon as down" "$ROOT/home/frond-ear" \
      'export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json" DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"; node src/cli.ts doctor | grep -E -A1 "daemon|gateway|socket"'
    note 'Repair: the runbook'"'"'s troubleshooting table reads "Daemon exits with close code 4014: Message Content Intent is not enabled for the bot." The person turns it on in the developer portal (here: the stand-in'"'"'s switch).'
    fake /control/intent -XPOST -H 'content-type: application/json' -d '{"enabled":true}' >/dev/null
    ;;

  daemon)
    start_daemon "$R/daemon-2.log" || return 1
    wait_for 30 "the gateway to connect" gateway_connected || return 1
    save DAEMON_PID "$(daemon_pid)"
    record "repaired: daemon up, gateway connected" "$ROOT/home/frond-ear" \
      'node src/cli.ts status | node -e '"'"'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({gateway: s.gateway.state, ears: s.ears.map(e => ({name: e.name, attached: e.attached, registered: e.registered}))}, null, 1))'"'"''
    ;;

  doctor-post)
    note '## 5. `doctor` with the daemon up'
    doctor "doctor: every required check passes; no session is attached yet (advisory)"
    ;;

  register)
    note '## 6. MCP registration'
    note 'In the one project directory whose session owns the ear, the `claude mcp add` line exactly as `init` printed it (its step 3).'
    mkdir -p "$ROOT/home/trial-session"
    local line
    line=$(grep -m1 -E '^ +claude mcp add ' "$R/init.out" | sed -E 's/^ +//')
    record "claude mcp add (as init printed it)" "$ROOT/home/trial-session" "$line" || return 1
    record "what it registered (read from ~/.claude.json; never by running claude mcp list or get)" "$ROOT/home/trial-session" \
      'node -e '"'"'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude.json","utf8")); console.log(JSON.stringify(c.projects[process.cwd()].mcpServers, null, 1))'"'"''
    note 'Step 5 of init'"'"'s output: allow the ear'"'"'s tools. The `deny` list is this receipt'"'"'s own containment for an unattended test session, not part of the install.'
    record "let the tools run unattended (.claude/settings.local.json)" "$ROOT/home/trial-session" \
      'mkdir -p .claude && printf "%s\n" "{ \"permissions\": { \"allow\": [\"mcp__frond-ear\"], \"deny\": [\"Bash\", \"Edit\", \"Write\", \"NotebookEdit\", \"WebFetch\", \"WebSearch\"] } }" > .claude/settings.local.json && cat .claude/settings.local.json'
    ;;

  wrong-ear)
    note '## 6b. Failure: a registration that names an ear the config does not have'
    note 'Before #70 the runbook'"'"'s registration lines named the example config'"'"'s ear, `frond-scribe`; a stranger'"'"'s ear is the one they named (`trial` here). The shim Claude Code would launch from such a line:'
    record "the shim with FROND_EAR_EAR=frond-scribe" "$ROOT/home/trial-session" \
      "(printf '%s\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"receipt\",\"version\":\"0\"}}}'; sleep 3) | FROND_EAR_EAR=frond-scribe node ~/frond-ear/src/cli.ts shim >/dev/null"
    note 'Claude Code shows none of that stderr: the session starts, no canary arrives and nothing is delivered. Repair: register with the name `init` printed (§6), as the runbook now says.'
    return 0
    ;;

  launch)
    note '## 7. Launch Claude Code with the channel flag'
    note 'Step 4 of init'"'"'s output, in a tmux pane of its own (a tmux server started inside the disposable environment). Claude Code'"'"'s login is not part of the install: the `claude` binary brings its own (see README.md beside the harness).'
    local line
    line=$(grep -m1 -E '^ +claude --dangerously-load-development-channels ' "$R/init.out" | sed -E 's/^ +//')
    save LAUNCH_LINE "$line"
    printf '\n```console\n$ cd ~/trial-session && %s\n```\n' "$line" >>"$T"
    launch_session "$line"
    ;;

  canary)
    note '## 8. Attach canary'
    note 'On attach the daemon pushes a `<channel kind="attach">` event that asks the session to `ack` a nonce. `registered` turns true only on that ack, or on a pushed `batch_id` used in its token form, and the receipt has sent nothing else yet.'
    wait_for "$WAIT" "the ear to register" ear_is attached registered || note "**Not registered within ${WAIT} s.**"
    ledger "status: the ear is attached and registered"
    doctor "doctor: every check passes, the ear's advisories included"
    ear_is attached registered
    ;;

  event)
    note '## 9. One inbound message, one outbound reply'
    note "The stand-in delivers one MESSAGE_CREATE over the Gateway: the principal ($PRINCIPAL) mentions the bot in channel $CHANNEL."
    note "Inbound dispatched: \`$(inbound 'receipt check: please answer in this channel with exactly the word pong')\`"
    wait_for "$WAIT" "a reply at the stand-in" posts_at_least 1 || note "**No reply within ${WAIT} s.**"
    sleep 10
    discord_record "what the stand-in for Discord received (10 s after the first post)"
    ledger "the ledger: what the ear holds for the session"
    posts_at_least 1
    ;;

  away)
    note '## 10. A message that waits while no session is attached'
    note 'Not the cold restart or resume receipt (out of scope here): the session leaves and comes back while the daemon keeps running, which is where the canary and any backlog were lost before #70.'
    exit_session
    wait_for 30 "the ear to detach" ear_is '!attached' || return 1
    note "Session exited. Inbound dispatched while no session is attached: \`$(inbound 'receipt check: while you were away. please answer in this channel with exactly the word backlog')\`"
    sleep 3
    ledger "the ledger: the message waits for the next session"
    local line="claude --continue --dangerously-load-development-channels server:frond-ear"
    note 'The person comes back to the same conversation (`--continue`; init says `--resume` keeps history):'
    printf '\n```console\n$ cd ~/trial-session && %s\n```\n' "$line" >>"$T"
    launch_session "$line" || return 1
    wait_for "$WAIT" "the ear to register again" ear_is attached registered || note "**Not registered within ${WAIT} s.**"
    wait_for "$WAIT" "a reply to the waiting message" posts_at_least 2 || note "**No reply to the waiting message within ${WAIT} s.**"
    sleep 10
    discord_record "what the stand-in for Discord received"
    ledger "the ledger after the session came back"
    ear_is attached registered && posts_at_least 2
    ;;

  teardown)
    note '## 11. Teardown'
    exit_session
    note 'The Claude Code session exited (`/exit`).'
    [ -d "$ROOT/home/frond-ear" ] && record "the ear after the session left" "$ROOT/home/frond-ear" \
      'node src/cli.ts status 2>/dev/null | node -e '"'"'const e=JSON.parse(require("fs").readFileSync(0,"utf8")).ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, delivery: e.delivery}))'"'"''
    [ -d "$ROOT/home/trial-session" ] && record "remove the MCP registration" "$ROOT/home/trial-session" 'claude mcp remove -s local frond-ear'
    # Claude Code's own log of the shim's MCP traffic: when it registered its channel handler,
    # and when each channel notification reached it. Message text is cut at 60 characters.
    note '### Claude Code'"'"'s log of the frond-ear server, one block per launch'
    note 'From `~/.cache/claude-cli-nodejs/*/mcp-logs-frond-ear/`. A channel notification that arrives before the `Channel notifications registered` line finds no handler and is dropped without a line of its own.'
    for log in "$ROOT"/home/.cache/claude-cli-nodejs/*/mcp-logs-frond-ear/*.jsonl; do
      [ -f "$log" ] || continue
      {
        printf '\n```console\n'
        node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n")) { const j = JSON.parse(l); const m = String(j.debug ?? j.error ?? ""); if (/^(Successfully connected|Channel notifications registered|notifications\/claude\/channel|Calling MCP tool|Sending SIGINT)/u.test(m)) console.log(j.timestamp, m.length > 90 ? `${m.slice(0, 90)}…` : m); }' "$log"
        printf '```\n'
      } | scrub >>"$T"
    done
    local pid=${DAEMON_PID:-}
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid"
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
    fi
    {
      printf '\n### stop the daemon (SIGTERM)\n\n```console\n'
      grep -E 'daemon\.draining|daemon\.stopped' "$R/daemon-2.log" 2>/dev/null
      printf '[daemon process gone: %s]\n```\n' "$([ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo no || echo yes)"
    } | scrub >>"$T"
    [ -n "${FAKE_PID:-}" ] && kill "$FAKE_PID" 2>/dev/null
    sleep 1
    local left
    left=$(pgrep -af "$ROOT")
    {
      printf '\n### nothing left running, then the disposable root is deleted\n\n```console\n'
      printf '$ pgrep -af "$ROOT"\n'
      [ -n "$left" ] && printf '%s\n' "$left"
      printf '[%s process(es)]\n' "$(printf '%s' "$left" | grep -c .)"
      printf '$ rm -rf "$ROOT" && test ! -e "$ROOT"\n'
    } | scrub >>"$T"
    rm -rf "$ROOT" && test ! -e "$ROOT" && printf '[exit 0]\n' >>"$T"
    {
      printf '$ # the caller'"'"'s own HOME: frond-ear config and Claude Code registrations, before and after\n'
      printf 'before: %s\nafter:  %s\n```\n' "$REAL_HOME_BEFORE" "$(real_home_state)"
      printf '\n- Finished: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } >>"$T"
    rm -f "$STATE" "$W/fake.port"
    echo "teardown done; receipt in $R"
    ;;

  screen) pane | scrub ;;

  *)
    echo "unknown step: $1 (see the header of $0)" >&2
    return 2
    ;;
  esac
}

# What the caller's HOME holds of frond-ear: its config directory's listing and how many Claude
# Code registrations set FROND_EAR_EAR. Contents are never read.
real_home_state() {
  local dir="$HOME/.config/frond-ear" count=0
  [ -f "$HOME/.claude.json" ] && count=$(grep -c FROND_EAR_EAR "$HOME/.claude.json")
  printf '~/.config/frond-ear: %s; FROND_EAR_EAR in ~/.claude.json: %s' \
    "$([ -d "$dir" ] && ls -A "$dir" | tr '\n' ' ' || echo absent)" "$count"
}

STEPS="setup isolation fetch init doctor-pre discord daemon-fail daemon doctor-post register
  wrong-ear launch canary event away"
if [ "${1:-}" = all ]; then
  from=${2:-setup}
  case " $(echo $STEPS) " in
  *" $from "*) ;;
  *)
    echo "unknown step: $from" >&2
    exit 2
    ;;
  esac
  for name in $STEPS; do
    [ "$name" = "$from" ] && from=""
    [ -n "$from" ] && continue
    [ -f "$STATE" ] && . "$STATE"
    echo "== $name"
    step "$name"
    code=$?
    [ $code -eq 2 ] && exit 2 # a login to finish by hand; nothing is torn down
    if [ $code -ne 0 ]; then
      echo "step $name failed" >&2
      note "**Step \`$name\` failed.**"
      [ "${KEEP:-}" = 1 ] || {
        . "$STATE"
        step teardown
      }
      exit 1
    fi
  done
  . "$STATE"
  step teardown
  exit 0
fi
step "${1:?usage: receipt.sh all|STEP (see the header)}"
