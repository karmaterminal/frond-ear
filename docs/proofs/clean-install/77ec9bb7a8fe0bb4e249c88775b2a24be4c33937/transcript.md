# frond-ear clean-install receipt

- Started: 2026-10-15T00:57:27Z
- Commit under test: `77ec9bb7a8fe0bb4e249c88775b2a24be4c33937`
- Harness: `tools/clean-install/` at `77ec9bb7a8fe0bb4e249c88775b2a24be4c33937`
- `$ROOT`: a fresh directory, deleted at teardown. `$ROOT/home` is HOME.

## 0. What the disposable environment holds

Every command below runs under `env -i` with only the variables listed here, as the same Linux user as the caller. HOME, the environment and the working directories are what is isolated; files outside `$ROOT` are not hidden by permissions, and nothing here reads them except the binaries on PATH and Claude Code finding its own login.

### environment (env -i: only these variables)

00:57:27Z · cwd `$ROOT/home`

```console
$ env | sort
DISABLE_AUTOUPDATER=1
EDITOR=$ROOT/human/fake-editor
GIT_CONFIG_NOSYSTEM=1
GIT_TERMINAL_PROMPT=0
HOME=$ROOT/home
LANG=C.UTF-8
LOGNAME=<login>
PATH=/opt/node22/bin:/usr/bin:/bin
PWD=$ROOT/home
SHELL=/bin/bash
SHLVL=1
TERM=xterm-256color
USER=<login>
XDG_RUNTIME_DIR=$ROOT/run
_=/usr/bin/env
[exit 0]
```

### HOME is empty: no git, gh, frond-ear or Claude Code config

00:57:27Z · cwd `$ROOT/home`

```console
$ ls -A ~; git config --list --show-origin 2>/dev/null || echo "(no git config)"; if command -v gh >/dev/null; then gh auth status 2>&1 | head -2; else echo "(no gh on PATH)"; fi; test -e ~/.config || echo "(no ~/.config)"; test -e ~/.claude.json || echo "(no ~/.claude.json)"
(no gh on PATH)
(no ~/.config)
(no ~/.claude.json)
[exit 0]
```

### toolchain

00:57:27Z · cwd `$ROOT/home`

```console
$ node --version; git --version; claude --version
v22.22.0
git version 2.43.0
2.1.300 (Claude Code)
[exit 0]
```

### unauthenticated GitHub, straight from this environment (no proxy, no credentials)

00:57:27Z · cwd `$ROOT/home`

```console
$ for repo in frond-ear binary-canticle scribe-prince-shared frond-scribe; do printf "%-22s " "$repo"; git ls-remote "https://github.com/karmaterminal/$repo" HEAD 2>&1 | head -1; done
frond-ear              fatal: could not read Username for 'https://github.com': terminal prompts disabled
binary-canticle        dcc84d9b19246e6f8420ee238547b11821bdb5fc	HEAD
scribe-prince-shared   fatal: could not read Username for 'https://github.com': terminal prompts disabled
frond-scribe           fatal: could not read Username for 'https://github.com': terminal prompts disabled
[exit 0]
```

## 1. Clone at the pinned commit

### the README's clone line

00:57:28Z · cwd `$ROOT/home`

```console
$ git clone https://github.com/karmaterminal/frond-ear && cd frond-ear && git rev-parse HEAD
Cloning into 'frond-ear'...
fatal: could not read Username for 'https://github.com': terminal prompts disabled
[exit 128]
```

The repository is not public yet (#35), so the clone fails without credentials. Stand-in: the same history, from a bundle of the commit under test made outside the disposable environment.

### stand-in: clone the bundle of the pinned commit

00:57:28Z · cwd `$ROOT/home`

```console
$ git clone -q ../frond-ear.bundle frond-ear && cd frond-ear && git rev-parse HEAD && git log -1 --format="%cI %s" && node -p "require(\"./package.json\").version"
77ec9bb7a8fe0bb4e249c88775b2a24be4c33937
2026-10-15T00:57:12+00:00 read-back: read channel history after a fresh Gateway session (#70, #72 follow-up)
0.1.0
[exit 0]
```

## 2. Bot token and config (`init`)

The person writes the token (docs/onboarding.md), so it never passes through the agent. `$EDITOR` here writes a synthetic token.

### person: create the 0600 token file and write the token

00:57:28Z · cwd `$ROOT/home`

```console
$ install -d -m 700 ~/.config/frond-ear
$ sh -c 'umask 077; set -C; : > "$1"' sh ~/.config/frond-ear/token && $EDITOR ~/.config/frond-ear/token

[exit 0]
```

### agent: init --non-interactive, with synthetic IDs

00:57:28Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts init --non-interactive --bot-user-id 100000000000000001 --principal 200000000000000002:tester --ear trial --channel 700000000000000007 --mention-pattern '\btrial\b' --token-file ~/.config/frond-ear/token
wrote $ROOT/home/.config/frond-ear/frond-ear.json (0600)
using token file $ROOT/home/.config/frond-ear/token

ear trial: 1 channel(s), 1 principal(s), 0 peer agent(s), dms on

next steps:
  1. start the daemon (needs Message Content Intent on, and the bot invited to the channels):
       FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon
     or keep it across reboots under systemd:
       FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token $ROOT/home/frond-ear/ops/install-systemd.sh
  2. check the result (read-only):
       FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts doctor
  3. register the shim in the ONE project directory whose Claude Code session owns this ear:
       claude mcp add -s local frond-ear -e FROND_EAR_EAR=trial -- /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim
  4. launch Claude Code there with the channel flag (read only at launch; --resume keeps history):
       claude --dangerously-load-development-channels server:frond-ear
  5. let the tools run unattended, in that project's .claude/settings.local.json:
       { "permissions": { "allow": ["mcp__frond-ear"] } }

docs/onboarding.md is the full contract.
(node:3908) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
[exit 0]
```

### the two files init wrote, and their modes

00:57:28Z · cwd `$ROOT/home`

```console
$ stat -c "%a %n" ~/.config/frond-ear ~/.config/frond-ear/*; cat ~/.config/frond-ear/frond-ear.json
700 $ROOT/home/.config/frond-ear
600 $ROOT/home/.config/frond-ear/frond-ear.json
600 $ROOT/home/.config/frond-ear/token
{
  "botUserId": "100000000000000001",
  "principals": [
    "200000000000000002"
  ],
  "peerAgents": [],
  "labels": {
    "200000000000000002": "tester"
  },
  "mentionPatterns": [
    "\\btrial\\b"
  ],
  "ears": {
    "trial": {
      "target": "claude-channel",
      "dms": true,
      "dmMode": "mentions",
      "attachCanary": true,
      "channels": {
        "700000000000000007": {
          "mode": "mentions"
        }
      },
      "instructions": ""
    }
  },
  "paused": false
}
[exit 0]
```

## 3. `doctor` before the daemon

### failure: doctor without the two exports

00:57:28Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts doctor
(node:3951) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
frond-ear doctor
  ✓ node: node 22.22.0
  ✗ config: no config at $ROOT/home/frond-ear/frond-ear.json (the daemon's default, ./frond-ear.json in $ROOT/home/frond-ear). $ROOT/home/.config/frond-ear/frond-ear.json exists, but a daemon started here without FROND_EAR_CONFIG will not load it: the daemon has no fallback to that path
      fix: export FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json for the daemon and for doctor (init prints it in front of every command), or pass --config to check that file
  ✗ token: neither DISCORD_BOT_TOKEN_FILE nor DISCORD_BOT_TOKEN is set, and the daemon reads its token from nowhere else; $ROOT/home/.config/frond-ear/token exists but the daemon does not look there
      fix: export DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token for the daemon and for doctor
  ✗ socket dir: $ROOT/run/frond-ear does not exist (the daemon creates it)
      fix: start the daemon: FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon  (or ops/install-systemd.sh)
  ✗ daemon: not reachable: connect ENOENT $ROOT/run/frond-ear/daemon.sock
      fix: start the daemon: FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon  (or ops/install-systemd.sh); if it is running, FROND_EAR_SOCKET must match on both sides
  ✓ claude: /opt/node22/bin/claude on PATH. Whether the shim is registered with it is NOT probed: `claude mcp list` starts a shim, and the newest attach takes the ear
4 of 6 checks failed (4 required)
[exit 1]
```

Repair: the two `export` lines from the README, which `init` also prints in front of every command.

### repaired: doctor with the exports (socket and daemon stay ✗ until the daemon runs)

00:57:28Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:3975) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
frond-ear doctor
  ✓ node: node 22.22.0
  ✓ config: $ROOT/home/.config/frond-ear/frond-ear.json (FROND_EAR_CONFIG): 1 ear(s): trial
  ✓ token: $ROOT/home/.config/frond-ear/token: present, 0600, non-empty (contents not read back)
  ✗ socket dir: $ROOT/run/frond-ear does not exist (the daemon creates it)
      fix: start the daemon: FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon  (or ops/install-systemd.sh)
  ✗ daemon: not reachable: connect ENOENT $ROOT/run/frond-ear/daemon.sock
      fix: start the daemon: FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon  (or ops/install-systemd.sh); if it is running, FROND_EAR_SOCKET must match on both sides
  ✓ claude: /opt/node22/bin/claude on PATH. Whether the shim is registered with it is NOT probed: `claude mcp list` starts a shim, and the newest attach takes the ear
2 of 6 checks failed (2 required)
[exit 1]
```

## 4. Daemon

The daemon runs as `init` printed it (its step 1), with two variables in front that point it at the loopback stand-in for Discord: `DISCORD_GATEWAY_URL=ws://127.0.0.1:46561/gateway DISCORD_API_BASE=http://127.0.0.1:46561/api/v10`. The stand-in starts with the bot's Message Content Intent off, as in a portal where nobody turned it on.

### failure: the daemon exits when Discord refuses the intent

```console
$ FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon
{"time":"2026-10-15T00:57:30.216Z","level":"error","event":"gateway.fatal_close","closeCode":4014}
{"time":"2026-10-15T00:57:30.216Z","level":"error","event":"daemon.exit_gateway_fatal","closeCode":4014}
{"time":"2026-10-15T00:57:30.220Z","level":"info","event":"daemon.stopped","code":1,"drained":true}
[exit 1]
```

### doctor names the daemon as down

00:57:31Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json" DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"; node src/cli.ts doctor | grep -E -A1 "daemon|gateway|socket"
(node:4031) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
  ✓ socket dir: $ROOT/run/frond-ear is mode 0700
  ✗ socket: $ROOT/run/frond-ear/daemon.sock does not exist
      fix: start the daemon: FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon  (or ops/install-systemd.sh)
  ✗ daemon: not reachable: connect ENOENT $ROOT/run/frond-ear/daemon.sock
      fix: start the daemon: FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon  (or ops/install-systemd.sh); if it is running, FROND_EAR_SOCKET must match on both sides
  ✓ claude: /opt/node22/bin/claude on PATH. Whether the shim is registered with it is NOT probed: `claude mcp list` starts a shim, and the newest attach takes the ear
[exit 0]
```

Repair: the runbook's troubleshooting table reads "Daemon exits with close code 4014: Message Content Intent is not enabled for the bot." The person turns it on in the developer portal (here: the stand-in's switch).

### repaired: daemon up, gateway connected

00:57:32Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({gateway: s.gateway.state, ears: s.ears.map(e => ({name: e.name, attached: e.attached, registered: e.registered}))}, null, 1))'
(node:4096) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
{
 "gateway": "connected",
 "ears": [
  {
   "name": "trial",
   "attached": false,
   "registered": false
  }
 ]
}
[exit 0]
```

## 5. `doctor` with the daemon up

### doctor: every required check passes; no session is attached yet (advisory)

00:57:32Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:4127) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
frond-ear doctor
  ✓ node: node 22.22.0
  ✓ config: $ROOT/home/.config/frond-ear/frond-ear.json (FROND_EAR_CONFIG): 1 ear(s): trial
  ✓ token: $ROOT/home/.config/frond-ear/token: present, 0600, non-empty (contents not read back)
  ✓ socket dir: $ROOT/run/frond-ear is mode 0700
  ✓ socket: $ROOT/run/frond-ear/daemon.sock is mode 0600
  ✓ daemon: answered status over $ROOT/run/frond-ear/daemon.sock
  ✓ gateway: state connected
  ✗ ear trial: attached (advisory): no session is attached; the ear keeps ingesting and holds events for it
      fix: in the project that owns this ear: claude mcp add -s local frond-ear -e FROND_EAR_EAR=trial -- /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim; then claude --dangerously-load-development-channels server:frond-ear
  ✓ claude: /opt/node22/bin/claude on PATH. Whether the shim is registered with it is NOT probed: `claude mcp list` starts a shim, and the newest attach takes the ear
1 of 9 checks failed (0 required)
[exit 0]
```

## 6. MCP registration

In the one project directory whose session owns the ear, the `claude mcp add` line exactly as `init` printed it (its step 3).

### claude mcp add (as init printed it)

00:57:32Z · cwd `$ROOT/home/trial-session`

```console
$ claude mcp add -s local frond-ear -e FROND_EAR_EAR=trial -- /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim
Added stdio MCP server frond-ear with command: /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim to local config
File modified: $ROOT/home/.claude.json [project: $ROOT/home/trial-session]
[exit 0]
```

### what it registered (read from ~/.claude.json; never by running claude mcp list or get)

00:57:33Z · cwd `$ROOT/home/trial-session`

```console
$ node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude.json","utf8")); console.log(JSON.stringify(c.projects[process.cwd()].mcpServers, null, 1))'
{
 "frond-ear": {
  "type": "stdio",
  "command": "/opt/node22/bin/node",
  "args": [
   "$ROOT/home/frond-ear/src/cli.ts",
   "shim"
  ],
  "env": {
   "FROND_EAR_EAR": "trial"
  }
 }
}
[exit 0]
```

Step 5 of init's output: allow the ear's tools. The `deny` list is this receipt's own containment for an unattended test session, not part of the install.

### let the tools run unattended (.claude/settings.local.json)

00:57:33Z · cwd `$ROOT/home/trial-session`

```console
$ mkdir -p .claude && printf "%s\n" "{ \"permissions\": { \"allow\": [\"mcp__frond-ear\"], \"deny\": [\"Bash\", \"Edit\", \"Write\", \"NotebookEdit\", \"WebFetch\", \"WebSearch\"] } }" > .claude/settings.local.json && cat .claude/settings.local.json
{ "permissions": { "allow": ["mcp__frond-ear"], "deny": ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"] } }
[exit 0]
```

## 6b. Failure: a registration that names an ear the config does not have

Before #70 the runbook's registration lines named the example config's ear, `frond-scribe`; a stranger's ear is the one they named (`trial` here). The shim Claude Code would launch from such a line:

### the shim with FROND_EAR_EAR=frond-scribe

00:57:33Z · cwd `$ROOT/home/trial-session`

```console
$ (printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"receipt","version":"0"}}}'; sleep 3) | FROND_EAR_EAR=frond-scribe node ~/frond-ear/src/cli.ts shim >/dev/null
(node:4225) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
frond-ear shim: unknown ear "frond-scribe"; configured: trial
[exit 0]
```

Claude Code shows none of that stderr: the session starts, no canary arrives and nothing is delivered. Repair: register with the name `init` printed (§6), as the runbook now says.

## 7. Launch Claude Code with the channel flag

Step 4 of init's output, in a tmux pane of its own (a tmux server started inside the disposable environment). Claude Code's login is not part of the install: the `claude` binary brings its own (see README.md beside the harness).

```console
$ cd ~/trial-session && claude --dangerously-load-development-channels server:frond-ear
```

Startup prompts answered as a person would: theme: Enter. security notes: Enter. trust this folder: Yes. development channels: 1 (local development). 

## 8. Attach canary

On attach the daemon pushes a `<channel kind="attach">` event that asks the session to `ack` a nonce. `registered` turns true only on that ack, or on a pushed `batch_id` used in its token form, and the receipt has sent nothing else yet.

### status: the ear is attached and registered

00:57:47Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 1,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 0,
  "stored": 0,
  "offered": 0,
  "seen": 0,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

### doctor: every check passes, the ear's advisories included

00:57:47Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:4779) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
frond-ear doctor
  ✓ node: node 22.22.0
  ✓ config: $ROOT/home/.config/frond-ear/frond-ear.json (FROND_EAR_CONFIG): 1 ear(s): trial
  ✓ token: $ROOT/home/.config/frond-ear/token: present, 0600, non-empty (contents not read back)
  ✓ socket dir: $ROOT/run/frond-ear is mode 0700
  ✓ socket: $ROOT/run/frond-ear/daemon.sock is mode 0600
  ✓ daemon: answered status over $ROOT/run/frond-ear/daemon.sock
  ✓ gateway: state connected
  ✓ ear trial: attached: a shim is attached (session fae6489d-e89e-4b46-a3ad-43f45be51d91)
  ✓ ear trial: registered: delivery confirmed: the session acked the attach canary or used a pushed batch_id in its token form (status does not say which)
  ✓ claude: /opt/node22/bin/claude on PATH. Whether the shim is registered with it is NOT probed: `claude mcp list` starts a shim, and the newest attach takes the ear
all 10 checks passed
[exit 0]
```

## 9. One inbound message, one outbound reply

The stand-in delivers one MESSAGE_CREATE over the Gateway: the principal (200000000000000002) mentions the bot in channel 700000000000000007.

Inbound dispatched: `{"id":"1400000000000000000","seq":2,"sockets":1}`

### what the stand-in for Discord received (10 s after the first post)

```json
{
 "identifies": [
  {
   "intents": 37377,
   "tokenMatches": true,
   "asksMessageContent": true
  },
  {
   "intents": 37377,
   "tokenMatches": true,
   "asksMessageContent": true
  }
 ],
 "resumes": [],
 "ended": [],
 "closes": [
  4014
 ],
 "inbound": [
  {
   "seq": 2,
   "id": "1400000000000000000",
   "content": "<@100000000000000001> receipt check: please answer in this channel with exactly the word pong"
  }
 ],
 "posts": [
  {
   "channel": "700000000000000007",
   "content": "pong",
   "replyTo": null,
   "nonce": true
  }
 ],
 "reactions": [],
 "rest": {
  "POST /channels/:id/messages": 1
 }
}
```

### the ledger: what the ear holds for the session

00:58:03Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 1,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 0,
  "stored": 0,
  "offered": 0,
  "seen": 1,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

## 10. A message that waits while no session is attached

Not a restart (§11 to §13 are): the session leaves and comes back while the daemon keeps running, which is where the canary and any backlog were lost before #70.

Session exited. Inbound dispatched while no session is attached: `{"id":"1400000000000000002","seq":3,"sockets":1}`

### the ledger: the message waits for the next session

00:58:08Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": false,
 "registered": false,
 "delivery": "detached",
 "generation": 1,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 1,
  "stored": 0,
  "offered": 0,
  "seen": 1,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

The person comes back to the same conversation (`--continue`; init says `--resume` keeps history):

```console
$ cd ~/trial-session && claude --continue --dangerously-load-development-channels server:frond-ear
```

Startup prompts answered as a person would: development channels: 1 (local development). 

### what the stand-in for Discord received

```json
{
 "identifies": [
  {
   "intents": 37377,
   "tokenMatches": true,
   "asksMessageContent": true
  },
  {
   "intents": 37377,
   "tokenMatches": true,
   "asksMessageContent": true
  }
 ],
 "resumes": [],
 "ended": [],
 "closes": [
  4014
 ],
 "inbound": [
  {
   "seq": 2,
   "id": "1400000000000000000",
   "content": "<@100000000000000001> receipt check: please answer in this channel with exactly the word pong"
  },
  {
   "seq": 3,
   "id": "1400000000000000002",
   "content": "<@100000000000000001> receipt check: while you were away. please answer in this channel with exactly the word backlog"
  }
 ],
 "posts": [
  {
   "channel": "700000000000000007",
   "content": "pong",
   "replyTo": null,
   "nonce": true
  },
  {
   "channel": "700000000000000007",
   "content": "backlog",
   "replyTo": null,
   "nonce": true
  }
 ],
 "reactions": [],
 "rest": {
  "POST /channels/:id/messages": 2
 }
}
```

### the ledger after the session came back

00:58:25Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 2,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 0,
  "stored": 0,
  "offered": 0,
  "seen": 2,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

## 11. Reboot

#70's item 5, with this receipt's own session and ear: no real host is rebooted. The reboot happens inside the disposable root. Every process of the ear and the session gets SIGTERM, as systemd sends at shutdown, and has 20 s to exit: the daemon drains and closes its Gateway connection itself. Then `$XDG_RUNTIME_DIR`, a tmpfs that a reboot empties, is emptied. HOME stands for the disk: it keeps the ear's SQLite ledger and Claude Code's conversation. The stand-in for Discord stays up, as Discord does, and treats sessions as Discord does: a client that closes its connection with 1000 or 1001 ends its session, and any other end leaves it resumable.

### before: the daemon's Gateway session and the last sequence it has stored

00:58:26Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const g=JSON.parse(require("fs").readFileSync(0,"utf8")).gateway; console.log(JSON.stringify({state: g.state, sessionId: g.sessionId, lastSequence: g.lastSequence, lastError: g.lastError}))'
{"state":"connected","sessionId":"receipt-session-2","lastSequence":3,"lastError":null}
[exit 0]
```

### before: the ear and the session that holds it

00:58:27Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 2,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 0,
  "stored": 0,
  "offered": 0,
  "seen": 2,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

### the host's processes: the session's tmux server and everything under it, and the ear's daemon

00:58:27Z · cwd `$ROOT/home`

```console
$ ps -o pid=,args= -p 5110,5011,5010,4055
 4055 /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon
 5010 tmux -L fe-receipt new-session -d -s trial -x 200 -y 50 claude --continue --dangerously-load-development-channels server:frond-ear
 5011 claude --continue --dangerously-load-development-channels server:frond-ear
 5110 /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim
[exit 0]
```

### shutdown: SIGTERM to every one of them, as systemd sends at shutdown, and 20 s to exit, then $XDG_RUNTIME_DIR emptied as a reboot empties it

00:58:27Z · cwd `$ROOT/home`

```console
$ kill -TERM 5110 5011 5010 4055
$ for _ in $(seq 40); do sleep 0.5; [ -z "$(ps -o pid=,stat= -p 5110,5011,5010,4055 | awk '$2 !~ /^Z/')" ] && break; done
$ [ -z "$(ps -o pid=,stat= -p 5110,5011,5010,4055 | awk '$2 !~ /^Z/')" ] || { echo 'still running after 20 s: SIGKILL, as systemd sends when its stop timeout passes'; kill -KILL 5110 5011 5010 4055 2>/dev/null; sleep 1; }
$ [ -z "$(ps -o pid=,stat= -p 5110,5011,5010,4055 | awk '$2 !~ /^Z/')" ] || { echo still running; ps -o pid=,stat= -p 5110,5011,5010,4055 | awk '$2 !~ /^Z/'; exit 1; }
$ echo '(none of them is left)'
$ find "${XDG_RUNTIME_DIR:?}" -mindepth 1 -delete && ls -A "$XDG_RUNTIME_DIR" && echo '($XDG_RUNTIME_DIR is empty)'
(none of them is left)
($XDG_RUNTIME_DIR is empty)
[exit 0]
```

While the host is down, a message arrives: `{"id":"1400000000000000004","seq":4,"sockets":0}`

The host comes back. The daemon starts as it did before, the way its systemd unit would at boot.

The daemon resumed its Gateway session `receipt-session-2` (RESUME, op 6), and the stand-in replayed what was sent while the host was down.

### after the restart: the daemon's Gateway session

00:58:29Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const g=JSON.parse(require("fs").readFileSync(0,"utf8")).gateway; console.log(JSON.stringify({state: g.state, sessionId: g.sessionId, lastSequence: g.lastSequence, lastError: g.lastError}))'
{"state":"connected","sessionId":"receipt-session-2","lastSequence":4,"lastError":null}
[exit 0]
```

### the ledger: what the ear holds for the session

00:58:29Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": false,
 "registered": false,
 "delivery": "detached",
 "generation": 2,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 1,
  "stored": 0,
  "offered": 0,
  "seen": 2,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

### doctor after the restart: the ear is detached, and its fix resumes the session it recorded

00:58:29Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:5777) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
frond-ear doctor
  ✓ node: node 22.22.0
  ✓ config: $ROOT/home/.config/frond-ear/frond-ear.json (FROND_EAR_CONFIG): 1 ear(s): trial
  ✓ token: $ROOT/home/.config/frond-ear/token: present, 0600, non-empty (contents not read back)
  ✓ socket dir: $ROOT/run/frond-ear is mode 0700
  ✓ socket: $ROOT/run/frond-ear/daemon.sock is mode 0600
  ✓ daemon: answered status over $ROOT/run/frond-ear/daemon.sock
  ✓ gateway: state connected
  ✗ ear trial: attached (advisory): no session is attached; the ear keeps ingesting and holds events for it
      fix: in the project that owns this ear: claude mcp add -s local frond-ear -e FROND_EAR_EAR=trial -- /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim; then claude --resume fae6489d-e89e-4b46-a3ad-43f45be51d91 --dangerously-load-development-channels server:frond-ear
  ✓ claude: /opt/node22/bin/claude on PATH. Whether the shim is registered with it is NOT probed: `claude mcp list` starts a shim, and the newest attach takes the ear
1 of 9 checks failed (0 required)
[exit 0]
```

The person resumes that session exactly as `doctor` printed it; the registration from §6 is unchanged:

```console
$ cd ~/trial-session && claude --resume fae6489d-e89e-4b46-a3ad-43f45be51d91 --dangerously-load-development-channels server:frond-ear
```

Startup prompts answered as a person would: development channels: 1 (local development). 

### what the stand-in for Discord received

```json
{
 "identifies": [
  {
   "intents": 37377,
   "tokenMatches": true,
   "asksMessageContent": true
  },
  {
   "intents": 37377,
   "tokenMatches": true,
   "asksMessageContent": true
  }
 ],
 "resumes": [
  {
   "session": "receipt-session-2",
   "from": 3,
   "tokenMatches": true,
   "accepted": true
  }
 ],
 "ended": [],
 "closes": [
  4014
 ],
 "inbound": [
  {
   "seq": 2,
   "id": "1400000000000000000",
   "content": "<@100000000000000001> receipt check: please answer in this channel with exactly the word pong"
  },
  {
   "seq": 3,
   "id": "1400000000000000002",
   "content": "<@100000000000000001> receipt check: while you were away. please answer in this channel with exactly the word backlog"
  },
  {
   "seq": 4,
   "id": "1400000000000000004",
   "content": "<@100000000000000001> receipt check: sent while the host was down. please answer in this channel with exactly the word rebooted"
  }
 ],
 "posts": [
  {
   "channel": "700000000000000007",
   "content": "pong",
   "replyTo": null,
   "nonce": true
  },
  {
   "channel": "700000000000000007",
   "content": "backlog",
   "replyTo": null,
   "nonce": true
  },
  {
   "channel": "700000000000000007",
   "content": "rebooted",
   "replyTo": null,
   "nonce": true
  }
 ],
 "reactions": [],
 "rest": {
  "POST /channels/:id/messages": 3
 }
}
```

### the ledger after the restart

00:58:46Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 3,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 0,
  "stored": 0,
  "offered": 0,
  "seen": 3,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

## 12. Power cut

The same, but the power is cut: every process of the ear and the session gets SIGKILL at once, with no drain, no `/exit` and no shutdown handler. The stand-in sees the connection drop at once, where Discord would notice the missed heartbeats.

### before: the daemon's Gateway session and the last sequence it has stored

00:58:46Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const g=JSON.parse(require("fs").readFileSync(0,"utf8")).gateway; console.log(JSON.stringify({state: g.state, sessionId: g.sessionId, lastSequence: g.lastSequence, lastError: g.lastError}))'
{"state":"connected","sessionId":"receipt-session-2","lastSequence":4,"lastError":null}
[exit 0]
```

### before: the ear and the session that holds it

00:58:46Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 3,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 0,
  "stored": 0,
  "offered": 0,
  "seen": 3,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

### the host's processes: the session's tmux server and everything under it, and the ear's daemon

00:58:47Z · cwd `$ROOT/home`

```console
$ ps -o pid=,args= -p 5959,5806,5805,5582
 5582 /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon
 5805 tmux -L fe-receipt new-session -d -s trial -x 200 -y 50 claude --resume fae6489d-e89e-4b46-a3ad-43f45be51d91 --dangerously-load-development-channels server:frond-ear
 5806 claude --resume fae6489d-e89e-4b46-a3ad-43f45be51d91 --dangerously-load-development-channels server:frond-ear
 5959 /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim
[exit 0]
```

### power cut: SIGKILL to every one of them at once, then $XDG_RUNTIME_DIR emptied as a reboot empties it

00:58:47Z · cwd `$ROOT/home`

```console
$ kill -KILL 5959 5806 5805 5582
$ for _ in $(seq 2); do sleep 0.5; [ -z "$(ps -o pid=,stat= -p 5959,5806,5805,5582 | awk '$2 !~ /^Z/')" ] && break; done
$ [ -z "$(ps -o pid=,stat= -p 5959,5806,5805,5582 | awk '$2 !~ /^Z/')" ] || { echo still running; ps -o pid=,stat= -p 5959,5806,5805,5582 | awk '$2 !~ /^Z/'; exit 1; }
$ echo '(none of them is left)'
$ find "${XDG_RUNTIME_DIR:?}" -mindepth 1 -delete && ls -A "$XDG_RUNTIME_DIR" && echo '($XDG_RUNTIME_DIR is empty)'
(none of them is left)
($XDG_RUNTIME_DIR is empty)
[exit 0]
```

While the host is down, a message arrives: `{"id":"1400000000000000006","seq":5,"sockets":0}`

The host comes back. The daemon starts as it did before, the way its systemd unit would at boot.

The daemon resumed its Gateway session `receipt-session-2` (RESUME, op 6), and the stand-in replayed what was sent while the host was down.

### after the restart: the daemon's Gateway session

00:58:49Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const g=JSON.parse(require("fs").readFileSync(0,"utf8")).gateway; console.log(JSON.stringify({state: g.state, sessionId: g.sessionId, lastSequence: g.lastSequence, lastError: g.lastError}))'
{"state":"connected","sessionId":"receipt-session-2","lastSequence":5,"lastError":null}
[exit 0]
```

### the ledger: what the ear holds for the session

00:58:49Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": false,
 "registered": false,
 "delivery": "detached",
 "generation": 3,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 1,
  "stored": 0,
  "offered": 0,
  "seen": 3,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

### doctor after the restart: the ear is detached, and its fix resumes the session it recorded

00:58:49Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:6534) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
frond-ear doctor
  ✓ node: node 22.22.0
  ✓ config: $ROOT/home/.config/frond-ear/frond-ear.json (FROND_EAR_CONFIG): 1 ear(s): trial
  ✓ token: $ROOT/home/.config/frond-ear/token: present, 0600, non-empty (contents not read back)
  ✓ socket dir: $ROOT/run/frond-ear is mode 0700
  ✓ socket: $ROOT/run/frond-ear/daemon.sock is mode 0600
  ✓ daemon: answered status over $ROOT/run/frond-ear/daemon.sock
  ✓ gateway: state connected
  ✗ ear trial: attached (advisory): no session is attached; the ear keeps ingesting and holds events for it
      fix: in the project that owns this ear: claude mcp add -s local frond-ear -e FROND_EAR_EAR=trial -- /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim; then claude --resume fae6489d-e89e-4b46-a3ad-43f45be51d91 --dangerously-load-development-channels server:frond-ear
  ✓ claude: /opt/node22/bin/claude on PATH. Whether the shim is registered with it is NOT probed: `claude mcp list` starts a shim, and the newest attach takes the ear
1 of 9 checks failed (0 required)
[exit 0]
```

The person resumes that session exactly as `doctor` printed it; the registration from §6 is unchanged:

```console
$ cd ~/trial-session && claude --resume fae6489d-e89e-4b46-a3ad-43f45be51d91 --dangerously-load-development-channels server:frond-ear
```

Startup prompts answered as a person would: development channels: 1 (local development). 

### what the stand-in for Discord received

```json
{
 "identifies": [
  {
   "intents": 37377,
   "tokenMatches": true,
   "asksMessageContent": true
  },
  {
   "intents": 37377,
   "tokenMatches": true,
   "asksMessageContent": true
  }
 ],
 "resumes": [
  {
   "session": "receipt-session-2",
   "from": 3,
   "tokenMatches": true,
   "accepted": true
  },
  {
   "session": "receipt-session-2",
   "from": 4,
   "tokenMatches": true,
   "accepted": true
  }
 ],
 "ended": [],
 "closes": [
  4014
 ],
 "inbound": [
  {
   "seq": 2,
   "id": "1400000000000000000",
   "content": "<@100000000000000001> receipt check: please answer in this channel with exactly the word pong"
  },
  {
   "seq": 3,
   "id": "1400000000000000002",
   "content": "<@100000000000000001> receipt check: while you were away. please answer in this channel with exactly the word backlog"
  },
  {
   "seq": 4,
   "id": "1400000000000000004",
   "content": "<@100000000000000001> receipt check: sent while the host was down. please answer in this channel with exactly the word rebooted"
  },
  {
   "seq": 5,
   "id": "1400000000000000006",
   "content": "<@100000000000000001> receipt check: sent while the host was down. please answer in this channel with exactly the word resumed"
  }
 ],
 "posts": [
  {
   "channel": "700000000000000007",
   "content": "pong",
   "replyTo": null,
   "nonce": true
  },
  {
   "channel": "700000000000000007",
   "content": "backlog",
   "replyTo": null,
   "nonce": true
  },
  {
   "channel": "700000000000000007",
   "content": "rebooted",
   "replyTo": null,
   "nonce": true
  },
  {
   "channel": "700000000000000007",
   "content": "resumed",
   "replyTo": null,
   "nonce": true
  }
 ],
 "reactions": [],
 "rest": {
  "POST /channels/:id/messages": 4
 }
}
```

### the ledger after the restart

00:59:06Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 4,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 0,
  "stored": 0,
  "offered": 0,
  "seen": 4,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

## 13. Power cut, after Discord has dropped the session

The same power cut, but the host stays down longer than Discord keeps a Gateway session resumable, which Discord's Gateway documentation puts at a few minutes. The stand-in forgets every session it issued, so it answers the RESUME the way Discord answers one for an expired session: op 9, Invalid Session, `d: false`, and replays nothing. The daemon identifies afresh, and reads back from the channel's history what came after the newest message it had heard there. This step passes when the message sent while the host was down is held for the session after the restart, the session is told of the read-back (a `catch_up` event), and it answers the message once.

### before: the daemon's Gateway session and the last sequence it has stored

00:59:07Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const g=JSON.parse(require("fs").readFileSync(0,"utf8")).gateway; console.log(JSON.stringify({state: g.state, sessionId: g.sessionId, lastSequence: g.lastSequence, lastError: g.lastError}))'
{"state":"connected","sessionId":"receipt-session-2","lastSequence":5,"lastError":null}
[exit 0]
```

### the host's processes: the session's tmux server and everything under it, and the ear's daemon

00:59:07Z · cwd `$ROOT/home`

```console
$ ps -o pid=,args= -p 6656,6557,6556,6398
 6398 /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon
 6556 tmux -L fe-receipt new-session -d -s trial -x 200 -y 50 claude --resume fae6489d-e89e-4b46-a3ad-43f45be51d91 --dangerously-load-development-channels server:frond-ear
 6557 claude --resume fae6489d-e89e-4b46-a3ad-43f45be51d91 --dangerously-load-development-channels server:frond-ear
 6656 /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim
[exit 0]
```

### power cut: SIGKILL to every one of them at once, then $XDG_RUNTIME_DIR emptied as a reboot empties it

00:59:07Z · cwd `$ROOT/home`

```console
$ kill -KILL 6656 6557 6556 6398
$ for _ in $(seq 2); do sleep 0.5; [ -z "$(ps -o pid=,stat= -p 6656,6557,6556,6398 | awk '$2 !~ /^Z/')" ] && break; done
$ [ -z "$(ps -o pid=,stat= -p 6656,6557,6556,6398 | awk '$2 !~ /^Z/')" ] || { echo still running; ps -o pid=,stat= -p 6656,6557,6556,6398 | awk '$2 !~ /^Z/'; exit 1; }
$ echo '(none of them is left)'
$ find "${XDG_RUNTIME_DIR:?}" -mindepth 1 -delete && ls -A "$XDG_RUNTIME_DIR" && echo '($XDG_RUNTIME_DIR is empty)'
(none of them is left)
($XDG_RUNTIME_DIR is empty)
[exit 0]
```

Discord drops the session while the host is down: `{"expired":1}`

While the host is down, a message arrives: `{"id":"1400000000000000008","seq":6,"sockets":0}`

The host comes back, and the daemon starts as before.

### after the restart: the daemon's Gateway session

00:59:12Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const g=JSON.parse(require("fs").readFileSync(0,"utf8")).gateway; console.log(JSON.stringify({state: g.state, sessionId: g.sessionId, lastSequence: g.lastSequence, lastError: g.lastError}))'
{"state":"connected","sessionId":"receipt-session-6","lastSequence":7,"lastError":null}
[exit 0]
```

A new Gateway session: the stand-in refused the RESUME of `receipt-session-2` (op 9), and the daemon identified afresh (IDENTIFY, op 2).

### the read-back: what the daemon read from the channel's history after identifying afresh

00:59:12Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({catchUp: s.catchUp, read: s.counters.catch_up_read ?? 0, truncated: s.counters.catch_up_truncated ?? 0}, null, 1))'
{
 "catchUp": {
  "owed": 0,
  "running": false,
  "last": {
   "at": "2026-10-15T00:59:09.573Z",
   "chats": [
    {
     "ear": "trial",
     "chatId": "700000000000000007",
     "read": 1
    }
   ],
   "skipped": []
  }
 },
 "read": 1,
 "truncated": 0
}
[exit 0]
```

### the ledger: what the ear holds for the session

00:59:13Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": false,
 "registered": false,
 "delivery": "detached",
 "generation": 4,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 1,
  "stored": 0,
  "offered": 0,
  "seen": 4,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

### doctor after the restart: the ear is detached, and its fix resumes the session it recorded

00:59:13Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:7288) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
frond-ear doctor
  ✓ node: node 22.22.0
  ✓ config: $ROOT/home/.config/frond-ear/frond-ear.json (FROND_EAR_CONFIG): 1 ear(s): trial
  ✓ token: $ROOT/home/.config/frond-ear/token: present, 0600, non-empty (contents not read back)
  ✓ socket dir: $ROOT/run/frond-ear is mode 0700
  ✓ socket: $ROOT/run/frond-ear/daemon.sock is mode 0600
  ✓ daemon: answered status over $ROOT/run/frond-ear/daemon.sock
  ✓ gateway: state connected
  ✗ ear trial: attached (advisory): no session is attached; the ear keeps ingesting and holds events for it
      fix: in the project that owns this ear: claude mcp add -s local frond-ear -e FROND_EAR_EAR=trial -- /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim; then claude --resume fae6489d-e89e-4b46-a3ad-43f45be51d91 --dangerously-load-development-channels server:frond-ear
  ✓ claude: /opt/node22/bin/claude on PATH. Whether the shim is registered with it is NOT probed: `claude mcp list` starts a shim, and the newest attach takes the ear
1 of 9 checks failed (0 required)
[exit 0]
```

The person resumes that session exactly as `doctor` printed it; the registration from §6 is unchanged:

```console
$ cd ~/trial-session && claude --resume fae6489d-e89e-4b46-a3ad-43f45be51d91 --dangerously-load-development-channels server:frond-ear
```

Startup prompts answered as a person would: development channels: 1 (local development). 

### the daemon's log of the read-back

```console
{"time":"2026-10-15T00:59:09.565Z","level":"info","event":"ear.catch_up_owed","chats":1}
{"time":"2026-10-15T00:59:09.577Z","level":"info","event":"ear.caught_up","ear":"trial","chatId":"700000000000000007","read":1,"truncated":false}
{"time":"2026-10-15T00:59:15.306Z","level":"info","event":"ear.catch_up_told","ear":"trial","chats":1,"skipped":0}
```

### what the stand-in for Discord received

```json
{
 "identifies": [
  {
   "intents": 37377,
   "tokenMatches": true,
   "asksMessageContent": true
  },
  {
   "intents": 37377,
   "tokenMatches": true,
   "asksMessageContent": true
  },
  {
   "intents": 37377,
   "tokenMatches": true,
   "asksMessageContent": true
  }
 ],
 "resumes": [
  {
   "session": "receipt-session-2",
   "from": 3,
   "tokenMatches": true,
   "accepted": true
  },
  {
   "session": "receipt-session-2",
   "from": 4,
   "tokenMatches": true,
   "accepted": true
  },
  {
   "session": "receipt-session-2",
   "from": 5,
   "tokenMatches": true,
   "accepted": false
  }
 ],
 "ended": [],
 "closes": [
  4014
 ],
 "inbound": [
  {
   "seq": 2,
   "id": "1400000000000000000",
   "content": "<@100000000000000001> receipt check: please answer in this channel with exactly the word pong"
  },
  {
   "seq": 3,
   "id": "1400000000000000002",
   "content": "<@100000000000000001> receipt check: while you were away. please answer in this channel with exactly the word backlog"
  },
  {
   "seq": 4,
   "id": "1400000000000000004",
   "content": "<@100000000000000001> receipt check: sent while the host was down. please answer in this channel with exactly the word rebooted"
  },
  {
   "seq": 5,
   "id": "1400000000000000006",
   "content": "<@100000000000000001> receipt check: sent while the host was down. please answer in this channel with exactly the word resumed"
  },
  {
   "seq": 6,
   "id": "1400000000000000008",
   "content": "<@100000000000000001> receipt check: sent while the host was down for longer. please answer in this channel with exactly the word expired"
  }
 ],
 "posts": [
  {
   "channel": "700000000000000007",
   "content": "pong",
   "replyTo": null,
   "nonce": true
  },
  {
   "channel": "700000000000000007",
   "content": "backlog",
   "replyTo": null,
   "nonce": true
  },
  {
   "channel": "700000000000000007",
   "content": "rebooted",
   "replyTo": null,
   "nonce": true
  },
  {
   "channel": "700000000000000007",
   "content": "resumed",
   "replyTo": null,
   "nonce": true
  },
  {
   "channel": "700000000000000007",
   "content": "expired",
   "replyTo": null,
   "nonce": true
  }
 ],
 "reactions": [],
 "rest": {
  "POST /channels/:id/messages": 5,
  "GET /channels/:id/messages?limit=50": 1
 }
}
```

### the ledger after the restart

00:59:30Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 5,
 "sessionId": "fae6489d-e89e-4b46-a3ad-43f45be51d91",
 "events": {
  "context": 0,
  "queued": 0,
  "stored": 0,
  "offered": 0,
  "seen": 5,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

## 14. Teardown

The Claude Code session exited (`/exit`).

### the ear after the session left

00:59:32Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const e=JSON.parse(require("fs").readFileSync(0,"utf8")).ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, delivery: e.delivery}))'
{"name":"trial","attached":false,"delivery":"detached"}
[exit 0]
```

### remove the MCP registration

00:59:33Z · cwd `$ROOT/home/trial-session`

```console
$ claude mcp remove -s local frond-ear
Removed MCP server frond-ear from local config
File modified: $ROOT/home/.claude.json [project: $ROOT/home/trial-session]
[exit 0]
```

### Claude Code's log of the frond-ear server, one block per launch

From `~/.cache/claude-cli-nodejs/*/mcp-logs-frond-ear/`. A channel notification that arrives before the `Channel notifications registered` line finds no handler and is dropped without a line of its own.

```console
2026-10-15T00:57:41.112Z Successfully connected (transport: stdio) in 373ms
2026-10-15T00:57:41.131Z Channel notifications registered
2026-10-15T00:57:43.122Z notifications/claude/channel: frond-ear ear "trial" attached to this session (attach 1). T…
2026-10-15T00:57:47.097Z Calling MCP tool: ack
2026-10-15T00:57:49.654Z notifications/claude/channel: [00:57:48Z] tester / tester (id 200000000000000002, principa…
2026-10-15T00:57:52.425Z Calling MCP tool: reply
2026-10-15T00:58:04.711Z Sending SIGINT to MCP server process
```

```console
2026-10-15T00:58:11.121Z Successfully connected (transport: stdio) in 370ms
2026-10-15T00:58:11.133Z Channel notifications registered
2026-10-15T00:58:13.131Z notifications/claude/channel: frond-ear ear "trial" attached to this session (attach 2). T…
2026-10-15T00:58:13.136Z notifications/claude/channel: [00:58:05Z] tester / tester (id 200000000000000002, principa…
2026-10-15T00:58:14.423Z Calling MCP tool: ack
2026-10-15T00:58:15.059Z Calling MCP tool: reply
2026-10-15T00:58:27.338Z Sending SIGINT to MCP server process
```

```console
2026-10-15T00:58:32.141Z Successfully connected (transport: stdio) in 336ms
2026-10-15T00:58:32.155Z Channel notifications registered
2026-10-15T00:58:34.151Z notifications/claude/channel: frond-ear ear "trial" attached to this session (attach 3). T…
2026-10-15T00:58:34.156Z notifications/claude/channel: [00:58:27Z] tester / tester (id 200000000000000002, principa…
2026-10-15T00:58:35.399Z Calling MCP tool: ack
2026-10-15T00:58:36.067Z Calling MCP tool: reply
```

```console
2026-10-15T00:58:51.713Z Successfully connected (transport: stdio) in 229ms
2026-10-15T00:58:51.725Z Channel notifications registered
2026-10-15T00:58:53.721Z notifications/claude/channel: frond-ear ear "trial" attached to this session (attach 4). T…
2026-10-15T00:58:53.727Z notifications/claude/channel: [00:58:47Z] tester / tester (id 200000000000000002, principa…
2026-10-15T00:58:55.120Z Calling MCP tool: ack
2026-10-15T00:58:55.733Z Calling MCP tool: reply
```

```console
2026-10-15T00:59:15.304Z Successfully connected (transport: stdio) in 244ms
2026-10-15T00:59:15.316Z Channel notifications registered
2026-10-15T00:59:17.313Z notifications/claude/channel: frond-ear could not resume its Discord session, so it starte…
2026-10-15T00:59:17.315Z notifications/claude/channel: frond-ear ear "trial" attached to this session (attach 5). T…
2026-10-15T00:59:17.319Z notifications/claude/channel: [00:59:08Z] tester / tester (id 200000000000000002, principa…
2026-10-15T00:59:19.228Z Calling MCP tool: ack
2026-10-15T00:59:19.810Z Calling MCP tool: reply
2026-10-15T00:59:32.034Z Sending SIGINT to MCP server process
```

### stop the daemon (SIGTERM)

```console
{"time":"2026-10-15T00:59:33.670Z","level":"info","event":"daemon.draining","inFlight":0}
{"time":"2026-10-15T00:59:33.674Z","level":"info","event":"daemon.stopped","code":0,"drained":true}
[daemon process gone: yes]
```

### nothing left running, then the disposable root is deleted

```console
$ pgrep -af "$ROOT"
[0 process(es)]
$ rm -rf "$ROOT" && test ! -e "$ROOT"
[exit 0]
$ # the caller's own HOME: frond-ear config and Claude Code registrations, before and after
before: ~/.config/frond-ear: absent; FROND_EAR_EAR in ~/.claude.json: 0
after:  ~/.config/frond-ear: absent; FROND_EAR_EAR in ~/.claude.json: 0
```

- Finished: 2026-10-15T00:59:35Z
