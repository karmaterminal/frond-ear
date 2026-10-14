# frond-ear clean-install receipt

- Started: 2026-10-14T16:54:08Z
- Commit under test: `0e51f41df25ca4cb34dc11ba4eed4dcb7a49a202`
- Harness: `tools/clean-install/` at `43d996c138eb293b633b0f93f14cf56f2cd5fe4c`
- `$ROOT`: a fresh directory, deleted at teardown. `$ROOT/home` is HOME.

## 0. What the disposable environment holds

Every command below runs under `env -i` with only the variables listed here, as the same Linux user as the caller. HOME, the environment and the working directories are what is isolated; files outside `$ROOT` are not hidden by permissions, and nothing here reads them except the binaries on PATH and Claude Code finding its own login.

### environment (env -i: only these variables)

16:54:08Z · cwd `$ROOT/home`

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

16:54:08Z · cwd `$ROOT/home`

```console
$ ls -A ~; git config --list --show-origin 2>/dev/null || echo "(no git config)"; if command -v gh >/dev/null; then gh auth status 2>&1 | head -2; else echo "(no gh on PATH)"; fi; test -e ~/.config || echo "(no ~/.config)"; test -e ~/.claude.json || echo "(no ~/.claude.json)"
(no gh on PATH)
(no ~/.config)
(no ~/.claude.json)
[exit 0]
```

### toolchain

16:54:08Z · cwd `$ROOT/home`

```console
$ node --version; git --version; claude --version
v22.22.0
git version 2.43.0
2.1.299 (Claude Code)
[exit 0]
```

### unauthenticated GitHub, straight from this environment (no proxy, no credentials)

16:54:08Z · cwd `$ROOT/home`

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

16:54:09Z · cwd `$ROOT/home`

```console
$ git clone https://github.com/karmaterminal/frond-ear && cd frond-ear && git rev-parse HEAD
Cloning into 'frond-ear'...
fatal: could not read Username for 'https://github.com': terminal prompts disabled
[exit 128]
```

The repository is not public yet (#35), so the clone fails without credentials. Stand-in: the same history, from a bundle of the commit under test made outside the disposable environment.

### stand-in: clone the bundle of the pinned commit

16:54:09Z · cwd `$ROOT/home`

```console
$ git clone -q ../frond-ear.bundle frond-ear && cd frond-ear && git rev-parse HEAD && git log -1 --format="%cI %s" && node -p "require(\"./package.json\").version"
0e51f41df25ca4cb34dc11ba4eed4dcb7a49a202
2026-10-14T08:48:10-07:00 Merge pull request #71 from karmaterminal/claude/frond-ear-70-public-install-w5xp6e
0.1.0
[exit 0]
```

## 2. Bot token and config (`init`)

The person writes the token (docs/onboarding.md), so it never passes through the agent. `$EDITOR` here writes a synthetic token.

### person: create the 0600 token file and write the token

16:54:09Z · cwd `$ROOT/home`

```console
$ install -d -m 700 ~/.config/frond-ear
$ sh -c 'umask 077; set -C; : > "$1"' sh ~/.config/frond-ear/token && $EDITOR ~/.config/frond-ear/token

[exit 0]
```

### agent: init --non-interactive, with synthetic IDs

16:54:09Z · cwd `$ROOT/home/frond-ear`

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
(node:6718) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
[exit 0]
```

### the two files init wrote, and their modes

16:54:09Z · cwd `$ROOT/home`

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

16:54:09Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts doctor
(node:6761) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

16:54:09Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:6785) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

The daemon runs as `init` printed it (its step 1), with two variables in front that point it at the loopback stand-in for Discord: `DISCORD_GATEWAY_URL=ws://127.0.0.1:41043/gateway DISCORD_API_BASE=http://127.0.0.1:41043/api/v10`. The stand-in starts with the bot's Message Content Intent off, as in a portal where nobody turned it on.

### failure: the daemon exits when Discord refuses the intent

```console
$ FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon
{"time":"2026-10-14T16:54:11.419Z","level":"error","event":"gateway.fatal_close","closeCode":4014}
{"time":"2026-10-14T16:54:11.419Z","level":"error","event":"daemon.exit_gateway_fatal","closeCode":4014}
{"time":"2026-10-14T16:54:11.423Z","level":"info","event":"daemon.stopped","code":1,"drained":true}
[exit 1]
```

### doctor names the daemon as down

16:54:12Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json" DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"; node src/cli.ts doctor | grep -E -A1 "daemon|gateway|socket"
(node:6849) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

16:54:13Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({gateway: s.gateway.state, ears: s.ears.map(e => ({name: e.name, attached: e.attached, registered: e.registered}))}, null, 1))'
(node:6914) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

16:54:13Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:6945) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

16:54:14Z · cwd `$ROOT/home/trial-session`

```console
$ claude mcp add -s local frond-ear -e FROND_EAR_EAR=trial -- /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim
Added stdio MCP server frond-ear with command: /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim to local config
File modified: $ROOT/home/.claude.json [project: $ROOT/home/trial-session]
[exit 0]
```

### what it registered (read from ~/.claude.json; never by running claude mcp list or get)

16:54:14Z · cwd `$ROOT/home/trial-session`

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

16:54:14Z · cwd `$ROOT/home/trial-session`

```console
$ mkdir -p .claude && printf "%s\n" "{ \"permissions\": { \"allow\": [\"mcp__frond-ear\"], \"deny\": [\"Bash\", \"Edit\", \"Write\", \"NotebookEdit\", \"WebFetch\", \"WebSearch\"] } }" > .claude/settings.local.json && cat .claude/settings.local.json
{ "permissions": { "allow": ["mcp__frond-ear"], "deny": ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"] } }
[exit 0]
```

## 6b. Failure: a registration that names an ear the config does not have

Before #70 the runbook's registration lines named the example config's ear, `frond-scribe`; a stranger's ear is the one they named (`trial` here). The shim Claude Code would launch from such a line:

### the shim with FROND_EAR_EAR=frond-scribe

16:54:14Z · cwd `$ROOT/home/trial-session`

```console
$ (printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"receipt","version":"0"}}}'; sleep 3) | FROND_EAR_EAR=frond-scribe node ~/frond-ear/src/cli.ts shim >/dev/null
(node:7043) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

16:54:29Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 1,
 "sessionId": "2d94671b-88fc-4a93-bba1-90a446b8590b",
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

16:54:29Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:7659) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
frond-ear doctor
  ✓ node: node 22.22.0
  ✓ config: $ROOT/home/.config/frond-ear/frond-ear.json (FROND_EAR_CONFIG): 1 ear(s): trial
  ✓ token: $ROOT/home/.config/frond-ear/token: present, 0600, non-empty (contents not read back)
  ✓ socket dir: $ROOT/run/frond-ear is mode 0700
  ✓ socket: $ROOT/run/frond-ear/daemon.sock is mode 0600
  ✓ daemon: answered status over $ROOT/run/frond-ear/daemon.sock
  ✓ gateway: state connected
  ✓ ear trial: attached: a shim is attached (session 2d94671b-88fc-4a93-bba1-90a446b8590b)
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

16:54:46Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 1,
 "sessionId": "2d94671b-88fc-4a93-bba1-90a446b8590b",
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

16:54:51Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": false,
 "registered": false,
 "delivery": "detached",
 "generation": 1,
 "sessionId": "2d94671b-88fc-4a93-bba1-90a446b8590b",
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

16:55:09Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 2,
 "sessionId": "2d94671b-88fc-4a93-bba1-90a446b8590b",
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

16:55:10Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const g=JSON.parse(require("fs").readFileSync(0,"utf8")).gateway; console.log(JSON.stringify({state: g.state, sessionId: g.sessionId, lastSequence: g.lastSequence, lastError: g.lastError}))'
{"state":"connected","sessionId":"receipt-session-2","lastSequence":3,"lastError":null}
[exit 0]
```

### before: the ear and the session that holds it

16:55:10Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 2,
 "sessionId": "2d94671b-88fc-4a93-bba1-90a446b8590b",
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

16:55:10Z · cwd `$ROOT/home`

```console
$ ps -o pid=,args= -p 7996,7897,7896,6873
 6873 /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon
 7896 tmux -L fe-receipt new-session -d -s trial -x 200 -y 50 claude --continue --dangerously-load-development-channels server:frond-ear
 7897 claude --continue --dangerously-load-development-channels server:frond-ear
 7996 /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim
[exit 0]
```

### shutdown: SIGTERM to every one of them, as systemd sends at shutdown, and 20 s to exit, then $XDG_RUNTIME_DIR emptied as a reboot empties it

16:55:10Z · cwd `$ROOT/home`

```console
$ kill -TERM 7996 7897 7896 6873
$ for _ in $(seq 40); do sleep 0.5; [ -z "$(ps -o pid=,stat= -p 7996,7897,7896,6873 | awk '$2 !~ /^Z/')" ] && break; done
$ [ -z "$(ps -o pid=,stat= -p 7996,7897,7896,6873 | awk '$2 !~ /^Z/')" ] || { echo 'still running after 20 s: SIGKILL, as systemd sends when its stop timeout passes'; kill -KILL 7996 7897 7896 6873 2>/dev/null; sleep 1; }
$ [ -z "$(ps -o pid=,stat= -p 7996,7897,7896,6873 | awk '$2 !~ /^Z/')" ] || { echo still running; ps -o pid=,stat= -p 7996,7897,7896,6873 | awk '$2 !~ /^Z/'; exit 1; }
$ echo '(none of them is left)'
$ find "${XDG_RUNTIME_DIR:?}" -mindepth 1 -delete && ls -A "$XDG_RUNTIME_DIR" && echo '($XDG_RUNTIME_DIR is empty)'
(none of them is left)
($XDG_RUNTIME_DIR is empty)
[exit 0]
```

While the host is down, a message arrives: `{"id":"1400000000000000004","seq":4,"sockets":0}`

The host comes back. The daemon starts as it did before, the way its systemd unit would at boot.

**The daemon did not resume its Gateway session `receipt-session-2`.** What the stand-in answered is in its record below.

**The message sent while the host was down is not held for the session.**

### after the restart: the daemon's Gateway session

16:56:13Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const g=JSON.parse(require("fs").readFileSync(0,"utf8")).gateway; console.log(JSON.stringify({state: g.state, sessionId: g.sessionId, lastSequence: g.lastSequence, lastError: g.lastError}))'
{"state":"connected","sessionId":"receipt-session-4","lastSequence":5,"lastError":null}
[exit 0]
```

### the ledger: what the ear holds for the session

16:56:14Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": false,
 "registered": false,
 "delivery": "detached",
 "generation": 2,
 "sessionId": "2d94671b-88fc-4a93-bba1-90a446b8590b",
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

### doctor after the restart: the ear is detached, and its fix resumes the session it recorded

16:56:14Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:9555) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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
      fix: in the project that owns this ear: claude mcp add -s local frond-ear -e FROND_EAR_EAR=trial -- /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim; then claude --resume 2d94671b-88fc-4a93-bba1-90a446b8590b --dangerously-load-development-channels server:frond-ear
  ✓ claude: /opt/node22/bin/claude on PATH. Whether the shim is registered with it is NOT probed: `claude mcp list` starts a shim, and the newest attach takes the ear
1 of 9 checks failed (0 required)
[exit 0]
```

The person resumes that session exactly as `doctor` printed it; the registration from §6 is unchanged:

```console
$ cd ~/trial-session && claude --resume 2d94671b-88fc-4a93-bba1-90a446b8590b --dangerously-load-development-channels server:frond-ear
```

Startup prompts answered as a person would: development channels: 1 (local development). 

**No `rebooted` within 60 s.**

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
   "accepted": false
  }
 ],
 "ended": [
  {
   "session": "receipt-session-2",
   "code": 1000
  }
 ],
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
  }
 ],
 "reactions": [],
 "rest": {
  "POST /channels/:id/messages": 2
 }
}
```

### the ledger after the restart

16:57:30Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, sessionId: e.sessionId, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 3,
 "sessionId": "2d94671b-88fc-4a93-bba1-90a446b8590b",
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

**Step `reboot` failed.**

## 14. Teardown

The Claude Code session exited (`/exit`).

### the ear after the session left

16:57:33Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const e=JSON.parse(require("fs").readFileSync(0,"utf8")).ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, delivery: e.delivery}))'
{"name":"trial","attached":false,"delivery":"detached"}
[exit 0]
```

### remove the MCP registration

16:57:33Z · cwd `$ROOT/home/trial-session`

```console
$ claude mcp remove -s local frond-ear
Removed MCP server frond-ear from local config
File modified: $ROOT/home/.claude.json [project: $ROOT/home/trial-session]
[exit 0]
```

### Claude Code's log of the frond-ear server, one block per launch

From `~/.cache/claude-cli-nodejs/*/mcp-logs-frond-ear/`. A channel notification that arrives before the `Channel notifications registered` line finds no handler and is dropped without a line of its own.

```console
2026-10-14T16:54:22.988Z Successfully connected (transport: stdio) in 395ms
2026-10-14T16:54:23.010Z Channel notifications registered
2026-10-14T16:54:24.997Z notifications/claude/channel: frond-ear ear "trial" attached to this session (attach 1). T…
2026-10-14T16:54:28.845Z Calling MCP tool: ack
2026-10-14T16:54:31.678Z notifications/claude/channel: [16:54:30Z] tester / tester (id 200000000000000002, principa…
2026-10-14T16:54:35.423Z Calling MCP tool: reply
2026-10-14T16:54:47.845Z Sending SIGINT to MCP server process
```

```console
2026-10-14T16:54:54.652Z Successfully connected (transport: stdio) in 368ms
2026-10-14T16:54:54.666Z Channel notifications registered
2026-10-14T16:54:56.662Z notifications/claude/channel: frond-ear ear "trial" attached to this session (attach 2). T…
2026-10-14T16:54:56.669Z notifications/claude/channel: [16:54:48Z] tester / tester (id 200000000000000002, principa…
2026-10-14T16:54:58.186Z Calling MCP tool: ack
2026-10-14T16:54:58.811Z Calling MCP tool: reply
2026-10-14T16:55:10.992Z Sending SIGINT to MCP server process
```

```console
2026-10-14T16:56:16.802Z Successfully connected (transport: stdio) in 370ms
2026-10-14T16:56:16.840Z Channel notifications registered
2026-10-14T16:56:18.812Z notifications/claude/channel: frond-ear ear "trial" attached to this session (attach 3). T…
2026-10-14T16:56:20.503Z Calling MCP tool: ack
2026-10-14T16:57:32.192Z Sending SIGINT to MCP server process
```

### stop the daemon (SIGTERM)

```console
{"time":"2026-10-14T16:57:33.966Z","level":"info","event":"daemon.draining","inFlight":0}
{"time":"2026-10-14T16:57:33.970Z","level":"info","event":"daemon.stopped","code":0,"drained":true}
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

- Finished: 2026-10-14T16:57:35Z
