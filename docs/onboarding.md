# Onboarding contract

What it takes to stand up a frond-ear, what `frond-ear init` does for you, what it cannot do, and
how `frond-ear doctor` tells you where you are. The [runbook](runbook.md) is the long form and the
manual path; this page is the contract.

```sh
git clone https://github.com/karmaterminal/frond-ear && cd frond-ear
node src/cli.ts init      # asks for IDs, the ear name, channels and the token; writes two files
export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"   # what the daemon and doctor read
export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
node src/cli.ts doctor    # read-only: says what is working and how to fix what is not
```

The two `export` lines matter: the daemon and `doctor` have no fallback to `~/.config/frond-ear`
(§3), so without them `doctor` looks for `./frond-ear.json` and finds no token. `init` prints the
same two variables in front of every command it suggests.

Node ≥ 22.18 is the only requirement for the daemon and the CLI. `pnpm install` is for the tests.

## 1. Before you start: the Discord side

`init` cannot do any of this. It is all in the [Discord developer portal](https://discord.com/developers/applications):

| Step                     | Where                                                | What you come away with                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create an application    | _New Application_                                    | the app                                                                                                                                                                                             |
| Add a bot user           | _Bot_                                                | the **bot user ID**: with Developer Mode on in Discord, right-click the bot in a server → _Copy User ID_. It is also the application ID on the _General Information_ page for bots created recently |
| Turn on message content  | _Bot → Privileged Gateway Intents → Message Content_ | without it the daemon exits with close code **4014**                                                                                                                                                |
| Get the token            | _Bot → Reset Token_                                  | the **bot token**: the one secret. Shown once; a reset invalidates the old one                                                                                                                      |
| Invite the bot           | _OAuth2 → URL Generator_, scope `bot`                | permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Add Reactions                                                                                            |
| Collect the IDs you need | Discord, Developer Mode on, right-click → _Copy ID_  | **principal** user IDs (the humans who may command the session), **peer agent** user IDs (other bots allowed through), **channel** IDs for each channel the ear should hear                         |

IDs are 17–20 digit snowflakes and are not secret. The token is.

## 2. The config, field by field

The file is JSON. `init` writes the fields marked **init**; the rest take defaults from
`parseConfig` and are yours to add later. Every field is validated on load and on live reload; a
bad value names the field.

| Field                      | Required | Set by `init` | What it is, and where it comes from                                                                                                                                                                                                                                                      |
| -------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `botUserId`                | yes      | init          | The bot's own Discord user ID. Its own messages are always ignored.                                                                                                                                                                                                                      |
| `principals`               | no       | init          | User IDs whose messages carry `trust="principal"`. They may DM the bot. Nobody has principal trust until one is listed.                                                                                                                                                                  |
| `peerAgents`               | no       | init          | Bot user IDs allowed through with `trust="peer_agent"`. Every other bot is dropped.                                                                                                                                                                                                      |
| `labels`                   | no       | init          | `id → name`, shown in event headers and the channel instructions. `init` takes `id:label` on `--principal` and `--peer`.                                                                                                                                                                 |
| `mentionPatterns`          | no       | init          | Regexes (case-insensitive) that count as addressing the bot, e.g. `\bscribe\b`.                                                                                                                                                                                                          |
| `ears.<name>`              | yes, ≥1  | init          | One ear per session. The name is what the shim attaches to (`FROND_EAR_EAR`); letters, digits, `-`, `_`, up to 64. `init` writes one ear.                                                                                                                                                |
| `ears.<name>.target`       | no       | init          | `claude-channel` (the default) or `copilot-extension` (a Copilot CLI session, [#36](https://github.com/karmaterminal/frond-ear/pull/36); see the README). `copilot-sdk` and `claude-monitor` are reserved.                                                                               |
| `ears.<name>.channels`     | no       | init          | `channelId → mode` or `channelId → { mode, quietWindowMs?, maxDelayMs?, historyLimit? }`. Modes: `silent` (store only), `mentions` (default: wake on @mention, reply, pattern or DM), `room` (every message wakes, debounced). A channel belongs to one ear. Threads inherit the parent. |
| `ears.<name>.dms`          | no       | init          | Whether DMs from principals and peers route here. Only one ear may own DMs. `init` sets `true` unless `--no-dms`.                                                                                                                                                                        |
| `ears.<name>.dmMode`       | no       | init          | `mentions` (default: every DM wakes) or `silent`.                                                                                                                                                                                                                                        |
| `ears.<name>.attachCanary` | no       | init          | Default `true`: on attach the session is asked to `ack` a nonce, which is how `registered` is proven.                                                                                                                                                                                    |
| `ears.<name>.instructions` | no       | init (empty)  | Text appended to the channel instructions the session reads. Write it after the first `doctor` passes.                                                                                                                                                                                   |
| `defaults.*`               | no       | —             | `quietWindowMs` 4000, `maxDelayMs` 30000, `priorityQuietMs` 1500, `historyLimit` 20. `maxDelayMs ≥ quietWindowMs`.                                                                                                                                                                       |
| `botLoop`, `ambientWake`   | no       | —             | `{ maxEvents, windowMs, cooldownMs }` wake budgets for bot chatter and for ambient (non-principal, non-peer) humans.                                                                                                                                                                     |
| `limits.*`                 | no       | —             | `maxMessageChars` 4000, `maxNotificationChars` 6000, `maxPendingPerEar` 500, `retentionMs` 14 days.                                                                                                                                                                                      |
| `paused`                   | no       | init (false)  | Kill switch: keep ingesting, push nothing. Reloads live.                                                                                                                                                                                                                                 |

`frond-ear.example.json` shows every field filled in. The runbook explains the timing fields.

## 3. The install boundary

**`init` writes exactly two files and nothing else:**

| File      | Path                                 | Mode | Override                                   |
| --------- | ------------------------------------ | ---- | ------------------------------------------ |
| config    | `~/.config/frond-ear/frond-ear.json` | 0600 | `--config <path>`, or `FROND_EAR_CONF_DIR` |
| bot token | `~/.config/frond-ear/token`          | 0600 | `--token-file <path>`                      |

The directory is created 0700. `init` validates the whole config through `parseConfig` before
writing, refuses to overwrite either file without `--force`, and never prints the token. If the
token already lives in a file, `--token-file <existing>` uses it (and tightens it to 0600).
Without any token flag it writes the config only and prints the `install -m 600` line.

**You do by hand** (`init` prints the exact lines, with absolute paths):

1. Start the daemon, or install it under systemd with `ops/install-systemd.sh`, which reads the
   same two paths. Needs the intent on and the bot invited, or it exits with 4014 / 4004.
2. Register the shim in the one project directory whose Claude Code session owns the ear:
   `claude mcp add -s local frond-ear -e FROND_EAR_EAR=<ear> -- node /abs/src/cli.ts shim`.
   `local` scope, on purpose: a user-scope registration makes every session claim the ear.
3. Launch Claude Code there with `--dangerously-load-development-channels server:frond-ear`.
   The flag is read only at launch; `--resume <id>` keeps the session's history.
4. Allow the tools to run unattended: `{ "permissions": { "allow": ["mcp__frond-ear"] } }` in
   that project's `.claude/settings.local.json`.

**Other files the ear owns, not written by `init`:**

| What            | Path                                                                      | Mode                                                                                         |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| socket          | `$XDG_RUNTIME_DIR/frond-ear/daemon.sock`, else `~/.frond-ear/daemon.sock` | dir 0700, socket 0600; `FROND_EAR_SOCKET` overrides on **both** daemon and shim; ≤ 107 bytes |
| ledger (SQLite) | `$XDG_STATE_HOME/frond-ear/frond-ear.db` (`FROND_EAR_DATABASE`)           | created by the daemon; survives restarts                                                     |
| systemd unit    | `~/.config/systemd/user/frond-ear.service`                                | written by `ops/install-systemd.sh`                                                          |

The daemon's own default for `FROND_EAR_CONFIG` is `./frond-ear.json` in its working directory,
which is why `init` prints `FROND_EAR_CONFIG=` and `DISCORD_BOT_TOKEN_FILE=` in front of every
command. The systemd installer bakes both into the unit, and tightens `~/.config/frond-ear` to
0700 only when one of the two files lives there.

## 4. Clients

| Client                | How it attaches                                                                                                                  | State                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code           | the channel shim (`frond-ear shim`), a stdio MCP server Claude Code launches; `FROND_EAR_EAR` names the ear                      | on `main`, proven live                                                                                                                                                                              |
| GitHub Copilot CLI    | a Copilot extension that joins the session and enqueues events (`copilot-extension` target, `frond-ear copilot-extension --ear`) | on `main` since [#36](https://github.com/karmaterminal/frond-ear/pull/36), covered by tests against a fake session; no live Copilot CLI attach has been proved yet. Nothing else here depends on it |
| `frond-ear tap --ear` | read-only stream of what is pushed to an ear; never attaches                                                                     | on `main`                                                                                                                                                                                           |
| `frond-ear send`      | posts text from a script (an alert) through the daemon's `reply`; never attaches, marks nothing seen                             | on `main`                                                                                                                                                                                           |

One session per ear. A second shim attaching to the same ear takes it over, and the first is told
it has been detached.

## 5. `doctor`

Read-only. Every check prints ✓ or ✗ with a fix line; `--json` gives `{ ok, checks[] }`. Exit
status is 1 if any **required** check fails, 0 otherwise. Flags: `--config`, `--token-file`,
`--timeout-ms` (daemon reply, default 3000). The env the daemon uses (`FROND_EAR_CONFIG`,
`DISCORD_BOT_TOKEN_FILE`, `FROND_EAR_SOCKET`, `FROND_EAR_TCP`) is honoured, and is the way to run
it: set the same two paths you give the daemon (or that `init` printed), as in the examples above.
Bare `doctor` checks what a daemon started in the current directory with no env would load.

| Check               | Required | What passes                                                                                                                                                                                                      |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node                | yes      | ≥ 22.18                                                                                                                                                                                                          |
| config              | yes      | `--config`, else what the daemon loads here: `FROND_EAR_CONFIG`, else `./frond-ear.json` (no `~/.config` fallback); names a home config the daemon would miss                                                    |
| token               | yes      | `--token-file` / `DISCORD_BOT_TOKEN_FILE` is 0600 and non-empty (never read back), or `DISCORD_BOT_TOKEN` is set; no default path                                                                                |
| socket dir / socket | yes      | 0700 / 0600, path ≤ 107 bytes; skipped in TCP mode                                                                                                                                                               |
| daemon              | yes      | answers `status` over the socket                                                                                                                                                                                 |
| gateway             | yes      | `connected`, or `dry-run`                                                                                                                                                                                        |
| paused              | advisory | reported when the kill switch is on                                                                                                                                                                              |
| ear _n_: attached   | advisory | a shim is attached. Not required: an ear with no session is healthy and holds events for it. The fix is per target: `claude mcp add` + the channel flag, or `copilot-extension --ear` + `copilot --experimental` |
| ear _n_: registered | advisory | delivery confirmed: a canary ack or a pushed `batch_id` used in its token form (`status` does not say which). The fix is per target                                                                              |
| claude              | advisory | `claude` is on `PATH`; skipped when every ear is `copilot-extension`                                                                                                                                             |

Two things `doctor` deliberately does not do:

- **It does not probe `claude mcp` registration.** `claude mcp list` / `claude mcp get` start the
  shim to query it, and the newest attach takes the ear from the live session. Check the
  registration by reading `.claude/settings.local.json` or `.mcp.json`, never by running those.
- **It does not treat `registered: false` as proof of deafness.** Two things set `registered`: the canary ack,
  and acting on a pushed `batch_id`. Since [#30](https://github.com/karmaterminal/frond-ear/pull/30),
  using the id exactly as a `<channel>` element shows it (`N-<token>`) proves delivery, while an id read from `tap` or `inbox` marks the
  batch seen but proves nothing. A session that has only acted on such ids stays `registered: false`
  by design. If events really do not arrive, the usual cause for a Claude Code ear is a launch without the
  development-channel flag; for a Copilot ear, an extension not installed for that ear (or not
  reinstalled after an upgrade), Copilot started without `--experimental`, or a push Copilot
  refused, which the extension logs in the session as `frond-ear: could not deliver batch`.

## 6. Agent onboarding

An agent (a Claude Code or Copilot session) can run the whole install except for two things it
cannot know: **the bot token** and **the Discord IDs**. Ask the human for exactly those, nothing
else. The token must not pass through the agent's transcript or a shell argument: have the human
write it to the token file themselves, or pipe it in from a file they control.

```sh
# the human does this once, in their own terminal, so the token never appears in a transcript.
# The second line refuses a token file that already exists: it may be another ear's on this host.
install -d -m 700 ~/.config/frond-ear
sh -c 'umask 077; set -C; : > "$1"' sh ~/.config/frond-ear/token && $EDITOR ~/.config/frond-ear/token

# the agent does this, with the IDs the human gave it:
node src/cli.ts init --non-interactive \
  --bot-user-id 100000000000000001 \
  --principal 200000000000000002:figs \
  --peer 300000000000000003:other-bot \
  --ear my-ear \
  --channel 700000000000000007 --channel 700000000000000008:room \
  --mention-pattern '\bmy-ear\b' \
  --token-file ~/.config/frond-ear/token
export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
node src/cli.ts doctor
```

Flags: `--bot-user-id`, `--principal id[:label]` (repeatable), `--peer id[:label]` (repeatable),
`--ear`, `--channel id[:mode]` (repeatable; mode defaults to `mentions`), `--mention-pattern`
(repeatable), `--no-dms`, `--token-file <path>`, `--token-stdin` (read the token from stdin and
write it to `--token-file` 0600; for a human-driven pipe, not for an agent that would have to hold
the token), `--config <path>`, `--force`.

`init` exits 1 and writes nothing when a flag is not a snowflake, the ear name is invalid, or
`parseConfig` rejects the result. The interactive mode answers the same questions one line at a
time and also works over a pipe, so a transcript of answers can drive it; the token prompt is not
echoed on a terminal.

What is still the human's: the developer-portal steps in §1, the `claude mcp add` in the project
that will own the ear, and the launch with the channel flag. The agent can print those lines (they
are `init`'s output) but should not run `claude mcp add` from inside a live session that already
holds an ear.

## 7. Canticle

Optional, and off: the daemon builds no canticle source unless its config has a `canticle` block
with `"enabled": true` (and never under `--dry-run`), and nothing in `init` or `doctor` touches
it. When on, it listens only, and nothing heard enters the Discord ledger. An ear hears only the
`station:stream` pairs its `canticle.tune` lists, and the session reads them with the `hear` tool.
Nothing heard reaches a session unasked unless its ear has a `canticle.delivery` entry; even then,
only records from station keys on `canticle.wakeKeys` are pushed
([runbook § Delivery modes](runbook.md#delivery-modes)). Where frond-ear is the host's one canticle listener it binds its own
(`canticle.source: "embedded"`, the default). On a **shared host** (one where another harness,
such as an OpenClaw prince, also hears canticle) it binds nothing and reads record v1 from
binary-canticle's host daemon (`"host-daemon"`); the embedded listener refuses to bind while a
daemon answers. The fields, their defaults and how to check them are in
[runbook §8](runbook.md#8-hear-binary-canticle-optional).
