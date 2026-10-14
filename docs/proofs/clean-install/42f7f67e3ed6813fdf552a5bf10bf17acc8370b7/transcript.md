# frond-ear clean-install receipt

- Started: 2026-10-13T17:37:12Z
- Commit under test: `42f7f67e3ed6813fdf552a5bf10bf17acc8370b7`
- Harness: `tools/clean-install/` at `92e9c43d2d9dc05d61a68cf537a794e1ecfd4e9a`
- `$ROOT`: a fresh directory, deleted at teardown. `$ROOT/home` is HOME.

## 0. What the disposable environment holds

Every command below runs under `env -i` with only the variables listed here, as the same Linux user as the caller. HOME, the environment and the working directories are what is isolated; files outside `$ROOT` are not hidden by permissions, and nothing here reads them except the binaries on PATH and Claude Code finding its own login.

### environment (env -i: only these variables)

17:37:12Z · cwd `$ROOT/home`

```console
$ env | sort
DISABLE_AUTOUPDATER=1
EDITOR=$ROOT/human/fake-editor
GIT_CONFIG_NOSYSTEM=1
GIT_TERMINAL_PROMPT=0
HOME=$ROOT/home
LANG=C.UTF-8
LOGNAME=root
PATH=/opt/node22/bin:/usr/bin:/bin
PWD=$ROOT/home
SHELL=/bin/bash
SHLVL=1
TERM=xterm-256color
USER=root
XDG_RUNTIME_DIR=$ROOT/run
_=/usr/bin/env
[exit 0]
```

### HOME is empty: no git, gh, frond-ear or Claude Code config

17:37:12Z · cwd `$ROOT/home`

```console
$ ls -A ~; git config --list --show-origin 2>/dev/null || echo "(no git config)"; if command -v gh >/dev/null; then gh auth status 2>&1 | head -2; else echo "(no gh on PATH)"; fi; test -e ~/.config || echo "(no ~/.config)"; test -e ~/.claude.json || echo "(no ~/.claude.json)"
(no gh on PATH)
(no ~/.config)
(no ~/.claude.json)
[exit 0]
```

### toolchain

17:37:12Z · cwd `$ROOT/home`

```console
$ node --version; git --version; claude --version
v22.22.0
git version 2.43.0
2.1.296 (Claude Code)
[exit 0]
```

### unauthenticated GitHub, straight from this environment (no proxy, no credentials)

17:37:12Z · cwd `$ROOT/home`

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

17:37:12Z · cwd `$ROOT/home`

```console
$ git clone https://github.com/karmaterminal/frond-ear && cd frond-ear && git rev-parse HEAD
Cloning into 'frond-ear'...
fatal: could not read Username for 'https://github.com': terminal prompts disabled
[exit 128]
```

The repository is not public yet (#35), so the clone fails without credentials. Stand-in: the same history, from a bundle of the commit under test made outside the disposable environment.

### stand-in: clone the bundle of the pinned commit

17:37:12Z · cwd `$ROOT/home`

```console
$ git clone -q ../frond-ear.bundle frond-ear && cd frond-ear && git rev-parse HEAD && git log -1 --format="%cI %s" && node -p "require(\"./package.json\").version"
42f7f67e3ed6813fdf552a5bf10bf17acc8370b7
2026-10-10T13:46:40-07:00 Merge pull request #66 from karmaterminal/claude/canticle-delivery-modes-9wwp7t
0.1.0
[exit 0]
```

## 2. Bot token and config (`init`)

The person writes the token (docs/onboarding.md), so it never passes through the agent. `$EDITOR` here writes a synthetic token.

### person: create the 0600 token file and write the token

17:37:13Z · cwd `$ROOT/home`

```console
$ install -d -m 700 ~/.config/frond-ear
$ sh -c 'umask 077; set -C; : > "$1"' sh ~/.config/frond-ear/token && $EDITOR ~/.config/frond-ear/token

[exit 0]
```

### agent: init --non-interactive, with synthetic IDs

17:37:13Z · cwd `$ROOT/home/frond-ear`

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
(node:9953) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
[exit 0]
```

### the two files init wrote, and their modes

17:37:13Z · cwd `$ROOT/home`

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

17:37:13Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts doctor
(node:9993) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
frond-ear doctor
  ✓ node: node 22.22.0
  ✗ config: no config at $ROOT/home/frond-ear/frond-ear.json (the daemon's default, ./frond-ear.json in $ROOT/home/frond-ear). $ROOT/home/.config/frond-ear/frond-ear.json exists, but a daemon started here without FROND_EAR_CONFIG will not load it: the daemon has no fallback to that path
      fix: export FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json for the daemon and for doctor (init prints it in front of every command), or pass --config to check that file
  ✗ token: neither DISCORD_BOT_TOKEN_FILE nor DISCORD_BOT_TOKEN is set, and the daemon reads its token from nowhere else; $ROOT/home/.config/frond-ear/token exists but the daemon does not look there
      fix: export DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token for the daemon and for doctor
  ✗ socket dir: $ROOT/run/frond-ear does not exist (the daemon creates it)
      fix: start the daemon: FROND_EAR_CONFIG=$ROOT/home/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon  (or ops/install-systemd.sh)
  ✗ daemon: not reachable: connect ENOENT $ROOT/run/frond-ear/daemon.sock
      fix: start the daemon: FROND_EAR_CONFIG=$ROOT/home/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon  (or ops/install-systemd.sh); if it is running, FROND_EAR_SOCKET must match on both sides
  ✓ claude: /opt/node22/bin/claude on PATH. Whether the shim is registered with it is NOT probed: `claude mcp list` starts a shim, and the newest attach takes the ear
4 of 6 checks failed (4 required)
[exit 1]
```

Repair: the two `export` lines from the README, which `init` also prints in front of every command.

### repaired: doctor with the exports (socket and daemon stay ✗ until the daemon runs)

17:37:13Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:10014) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

The daemon runs as `init` printed it (its step 1), with two variables in front that point it at the loopback stand-in for Discord: `DISCORD_GATEWAY_URL=ws://127.0.0.1:40551/gateway DISCORD_API_BASE=http://127.0.0.1:40551/api/v10`. The stand-in starts with the bot's Message Content Intent off, as in a portal where nobody turned it on.

### failure: the daemon exits when Discord refuses the intent

```console
$ FROND_EAR_CONFIG=$ROOT/home/.config/frond-ear/frond-ear.json DISCORD_BOT_TOKEN_FILE=$ROOT/home/.config/frond-ear/token /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts daemon
{"time":"2026-10-13T17:37:14.996Z","level":"error","event":"gateway.fatal_close","closeCode":4014}
{"time":"2026-10-13T17:37:14.996Z","level":"error","event":"daemon.exit_gateway_fatal","closeCode":4014}
{"time":"2026-10-13T17:37:15.002Z","level":"info","event":"daemon.stopped","code":1,"drained":true}
[exit 1]
```

### doctor names the daemon as down

17:37:15Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json" DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"; node src/cli.ts doctor | grep -E -A1 "daemon|gateway|socket"
(node:10071) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

17:37:16Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({gateway: s.gateway.state, ears: s.ears.map(e => ({name: e.name, attached: e.attached, registered: e.registered}))}, null, 1))'
(node:10151) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

17:37:16Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:10182) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

17:37:17Z · cwd `$ROOT/home/trial-session`

```console
$ claude mcp add -s local frond-ear -e FROND_EAR_EAR=trial -- /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim
Added stdio MCP server frond-ear with command: /opt/node22/bin/node $ROOT/home/frond-ear/src/cli.ts shim to local config
File modified: $ROOT/home/.claude.json [project: $ROOT/home/trial-session]
[exit 0]
```

### what it registered (read from ~/.claude.json; never by running claude mcp list or get)

17:37:17Z · cwd `$ROOT/home/trial-session`

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

17:37:17Z · cwd `$ROOT/home/trial-session`

```console
$ mkdir -p .claude && printf "%s\n" "{ \"permissions\": { \"allow\": [\"mcp__frond-ear\"], \"deny\": [\"Bash\", \"Edit\", \"Write\", \"NotebookEdit\", \"WebFetch\", \"WebSearch\"] } }" > .claude/settings.local.json && cat .claude/settings.local.json
{ "permissions": { "allow": ["mcp__frond-ear"], "deny": ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"] } }
[exit 0]
```

## 6b. Failure: a registration that names an ear the config does not have

Before #70 the runbook's registration lines named the example config's ear, `frond-scribe`; a stranger's ear is the one they named (`trial` here). The shim Claude Code would launch from such a line:

### the shim with FROND_EAR_EAR=frond-scribe

17:37:17Z · cwd `$ROOT/home/trial-session`

```console
$ (printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"receipt","version":"0"}}}'; sleep 3) | FROND_EAR_EAR=frond-scribe node ~/frond-ear/src/cli.ts shim >/dev/null
(node:10274) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

**Not registered within 90 s.**

### status: the ear is attached and registered

17:38:55Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": false,
 "delivery": "pending",
 "generation": 1,
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

17:38:56Z · cwd `$ROOT/home/frond-ear`

```console
$ export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
$ export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
$ node src/cli.ts doctor
(node:12749) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
frond-ear doctor
  ✓ node: node 22.22.0
  ✓ config: $ROOT/home/.config/frond-ear/frond-ear.json (FROND_EAR_CONFIG): 1 ear(s): trial
  ✓ token: $ROOT/home/.config/frond-ear/token: present, 0600, non-empty (contents not read back)
  ✓ socket dir: $ROOT/run/frond-ear is mode 0700
  ✓ socket: $ROOT/run/frond-ear/daemon.sock is mode 0600
  ✓ daemon: answered status over $ROOT/run/frond-ear/daemon.sock
  ✓ gateway: state connected
  ✓ ear trial: attached: a shim is attached (session 873d5b1a-35e8-492b-a99c-885737fb4c65)
  ✗ ear trial: registered (advisory): not yet: the session attached moments ago and has not confirmed delivery (grace period)
      fix: re-run doctor in a minute; the session confirms when it does either: ack the attach canary's nonce, or act on a pushed batch_id exactly as the <channel> element shows it (N-<token>)
  ✓ claude: /opt/node22/bin/claude on PATH. Whether the shim is registered with it is NOT probed: `claude mcp list` starts a shim, and the newest attach takes the ear
1 of 10 checks failed (0 required)
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

17:39:13Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": true,
 "delivery": "confirmed",
 "generation": 1,
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

Not the cold restart or resume receipt (out of scope here): the session leaves and comes back while the daemon keeps running, which is where the canary and any backlog were lost before #70.

Session exited. Inbound dispatched while no session is attached: `{"id":"1400000000000000002","seq":3,"sockets":1}`

### the ledger: the message waits for the next session

17:39:19Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": false,
 "registered": false,
 "delivery": "detached",
 "generation": 1,
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

**Not registered within 90 s.**

**No reply to the waiting message within 90 s.**

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
  }
 ],
 "reactions": [],
 "rest": {
  "POST /channels/:id/messages": 1
 }
}
```

### the ledger after the session came back

17:42:31Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const e=s.ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, registered: e.registered, delivery: e.delivery, generation: e.generation, events: e.events, ambiguousSends: s.ambiguousSends}, null, 1))'
{
 "name": "trial",
 "attached": true,
 "registered": false,
 "delivery": "unconfirmed",
 "generation": 2,
 "events": {
  "context": 0,
  "queued": 0,
  "stored": 0,
  "offered": 1,
  "seen": 1,
  "expired": 0,
  "dropped": 0
 },
 "ambiguousSends": []
}
[exit 0]
```

## 11. Teardown

The Claude Code session exited (`/exit`).

### the ear after the session left

17:42:34Z · cwd `$ROOT/home/frond-ear`

```console
$ node src/cli.ts status 2>/dev/null | node -e 'const e=JSON.parse(require("fs").readFileSync(0,"utf8")).ears[0]; console.log(JSON.stringify({name: e.name, attached: e.attached, delivery: e.delivery}))'
{"name":"trial","attached":false,"delivery":"detached"}
[exit 0]
```

### remove the MCP registration

17:42:34Z · cwd `$ROOT/home/trial-session`

```console
$ claude mcp remove -s local frond-ear
Removed MCP server frond-ear from local config
File modified: $ROOT/home/.claude.json [project: $ROOT/home/trial-session]
[exit 0]
```

### Claude Code's log of the frond-ear server, one block per launch

From `~/.cache/claude-cli-nodejs/*/mcp-logs-frond-ear/`. A channel notification that arrives before the `Channel notifications registered` line finds no handler and is dropped without a line of its own.

```console
2026-10-13T17:37:25.704Z Successfully connected (transport: stdio) in 324ms
2026-10-13T17:37:25.749Z Channel notifications registered
2026-10-13T17:38:58.093Z notifications/claude/channel: [17:38:56Z] tester / tester (id 200000000000000002, principa…
2026-10-13T17:39:03.399Z Calling MCP tool: reply
2026-10-13T17:39:15.334Z Sending SIGINT to MCP server process
```

```console
2026-10-13T17:39:21.803Z Successfully connected (transport: stdio) in 337ms
2026-10-13T17:39:21.825Z Channel notifications registered
2026-10-13T17:42:33.474Z Sending SIGINT to MCP server process
```

### stop the daemon (SIGTERM)

```console
{"time":"2026-10-13T17:42:35.043Z","level":"info","event":"daemon.draining","inFlight":0}
{"time":"2026-10-13T17:42:35.047Z","level":"info","event":"daemon.stopped","code":0,"drained":true}
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

- Finished: 2026-10-13T17:42:36Z
