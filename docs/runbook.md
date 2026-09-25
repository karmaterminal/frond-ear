# frond-ear runbook

This runbook takes a Claude Code session from polling Discord to having Discord events pushed to it. Work through the stages in order, and don't point frond-ear at a long-running session (such as frond-scribe) until stage 2 passes on a throwaway session.

## 0. Prerequisites

- **Node.js ≥ 22.18.** 24 is recommended. frond-ear runs its TypeScript directly, so there is no build step.
- **pnpm.** Only needed to install the dev tooling for tests. The daemon and shim have no runtime dependencies.
- **Claude Code ≥ 2.1.128**, logged in with claude.ai (Pro/Max/Team/Enterprise) or a Console API key. Check with `claude --version` and `claude auth status`.
  - Channels don't work on Bedrock, Vertex or Foundry.
  - Team and Enterprise orgs: an Owner must enable channels first.
  - frond-ear never needs your Anthropic credentials. The shim runs inside your already logged-in Claude Code session.
- **A Discord bot application**:
  - **Message Content Intent** turned on under _Bot → Privileged Gateway Intents_. Without it the daemon exits with close code 4014.
  - Invited with _View Channels_, _Send Messages_, _Send Messages in Threads_, _Read Message History_ and _Add Reactions_.

```sh
git clone https://github.com/karmaterminal/frond-ear && cd frond-ear
pnpm install          # dev tooling only
pnpm check            # format, typecheck, tests, credential scan
```

## 1. Configure

Copy `frond-ear.example.json` to `frond-ear.json`. That filename is git-ignored. Then fill in the fields below.

**Identity and trust**

| Field             | Meaning                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `botUserId`       | The bot's own user ID. Its own messages are always ignored.                                                                      |
| `principals`      | Your operators, e.g. figs. Their messages have `trust="principal"`, wake the session in `mentions` channels, and may DM the bot. |
| `peerAgents`      | OpenClaw or other agent bots allowed through, with `trust="peer_agent"`. Any other bot is dropped.                               |
| `labels`          | Optional friendly names for IDs, shown in headers and in the channel instructions.                                               |
| `mentionPatterns` | Regexes that count as addressing the bot, e.g. `\bscribe\b`.                                                                     |

**Ears**

| Field                      | Meaning                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ears.<name>`              | One ear per Claude session. `target` must be `claude-channel`.                                                                                                                                  |
| `ears.<name>.channels`     | Channel IDs to modes: `silent`, `mentions` (the default) or `room`. Per-channel `quietWindowMs`, `maxDelayMs` and `historyLimit` are optional. Threads inherit their parent channel's settings. |
| `ears.<name>.dms`          | Whether this ear receives DMs from principals and peers.                                                                                                                                        |
| `ears.<name>.attachCanary` | Asks Claude to `ack` a nonce each time a session attaches. This proves the channel is actually registered, because a notification can otherwise be dropped with no error.                       |
| `ears.<name>.instructions` | Extra text you write, appended to the channel instructions.                                                                                                                                     |

**Modes**

- `silent`: store only. Claude reads these with `inbox` or `fetch_messages`.
- `mentions`: wakes the session on an @mention, a reply to the bot, a `mentionPatterns` match, any principal message, or a DM. Other room messages are kept as context and delivered with the next wake.
- `room`: every message wakes the session, debounced.

**Timing, loops and limits**

| Field      | Meaning                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defaults` | `quietWindowMs` sets how long the room must be quiet before a flush. `maxDelayMs` caps how long continuous chatter can delay one. `priorityQuietMs` is the short wait after a mention. `historyLimit` caps how much context is kept. |
| `botLoop`  | If more than `maxEvents` bot messages arrive within `windowMs` in one chat, bot messages stop waking the session for `cooldownMs`.                                                                                                   |
| `limits`   | Per-message and per-notification size caps, the per-ear pending cap, and retention time.                                                                                                                                             |
| `paused`   | Kill switch. Messages are still ingested, but nothing is pushed.                                                                                                                                                                     |

Changes to the config take effect without a restart.

**Environment**

| Variable                                | Default                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `FROND_EAR_CONFIG`                      | `./frond-ear.json`                                                                                                  |
| `FROND_EAR_DATABASE`                    | `$XDG_STATE_HOME/frond-ear/frond-ear.db`                                                                            |
| `FROND_EAR_SOCKET`                      | `$XDG_RUNTIME_DIR/frond-ear/daemon.sock`, or `~/.frond-ear/daemon.sock`. The directory is 0700 and the socket 0600. |
| `DISCORD_BOT_TOKEN_FILE`                | A file holding the bot token, mode 0600. `DISCORD_BOT_TOKEN` also works.                                            |
| `FROND_EAR_TCP`, `FROND_EAR_TOKEN_FILE` | TCP mode for containers. Every client must present the token.                                                       |

## 2. Prove channel delivery on a throwaway session (no Discord)

Start the daemon in dry-run mode. It makes no Discord connection, prints the outbound calls it would have made to stderr, and accepts `inject`:

```sh
node src/cli.ts daemon --dry-run
```

Register the shim for a throwaway directory only, with `local` scope, so no other session claims the ear:

```sh
mkdir -p /tmp/ear-trial && cd /tmp/ear-trial
claude mcp add -s local frond-ear -e FROND_EAR_EAR=frond-scribe -- node /abs/path/to/frond-ear/src/cli.ts shim
claude --dangerously-load-development-channels server:frond-ear
```

Claude Code asks you to confirm the development-channel flag. Then:

1. **Canary.** Claude receives a `<channel … kind="attach">` event and calls `ack` with the nonce. Running `node src/cli.ts status` should show `"attached": true, "registered": true`. If `registered` stays `false`, the channel was not registered; see Troubleshooting.
2. **Idle wake.** From another terminal, inject a mention from a principal:
   ```sh
   FROND_EAR_BOT_USER_ID=<botUserId> node src/cli.ts inject \
     --chat <a mentions channel id> --guild <guild id> --author <principal id> --name figs \
     --mention "are you there?"
   ```
   The idle session should wake, and its `reply` should appear on the daemon's stderr as `dry-run send → …`.
3. **Busy, no interrupt.** Give Claude a long task, inject again, and confirm the event is picked up at the next turn without interrupting the current one.
4. **Debounce.** Inject several messages into a `room` channel in quick succession. They should arrive as **one** notification.

Record the results in the live checklist on karmaterminal/frond-ear#6.

## 3. Let the tools run unattended

A long-running session stalls on permission prompts. Allow frond-ear's tools in that project's `.claude/settings.local.json`, or in `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__frond-ear"] } }
```

## 4. Connect Discord

Stop the dry-run daemon and start it for real:

```sh
install -m 600 /dev/null ~/.config/frond-ear/token && $EDITOR ~/.config/frond-ear/token
DISCORD_BOT_TOKEN_FILE=~/.config/frond-ear/token node src/cli.ts daemon
```

Check that `node src/cli.ts status` shows `"gateway": {"state": "connected"}`. Then, still using the throwaway session:

- post an @mention in a `mentions` channel;
- post a `<@!id>`-style mention;
- post a reply to one of the bot's messages;
- post a message from an OpenClaw peer bot.

## 5. Attach frond-scribe

Only one Claude session should claim an ear. In frond-scribe's working directory, run:

```sh
claude mcp add -s local frond-ear -e FROND_EAR_EAR=frond-scribe -- node /abs/path/to/frond-ear/src/cli.ts shim
claude --resume <frond-scribe session id> --dangerously-load-development-channels server:frond-ear
```

- **Why `--resume`:** it keeps the session's full history. The development-channel flag only has to be present when the process launches.
- **Takeover:** if another session attaches to the same ear, the newer one takes over and the older one is told it has been detached.
- **Missed messages:** anything that arrived while the ear was detached is delivered when it reattaches. Anything that was delivered but never acted on arrives as a single digest, not a replay.

## 6. Operating

| Task                    | How                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Status                  | `node src/cli.ts status`, or ask Claude to call `ear_status`                        |
| Pause pushes            | Set `"paused": true` in the config; it reloads live                                 |
| Read what Claude missed | Claude calls `inbox`; everything stays in SQLite until the retention window expires |
| Logs                    | JSON lines on the daemon's stderr. Message text and tokens are redacted.            |

## Troubleshooting

| Symptom                                       | Likely cause                                                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registered: false`, no events in the session | Claude Code was started without `--dangerously-load-development-channels server:frond-ear`; or org policy blocks channels; or `MCP_PROTOCOL_NEGOTIATION=auto` on the v2 runtime (unset it or set it to `legacy`). |
| Shim reports "daemon is not reachable"        | The daemon isn't running, or the shim's `FROND_EAR_SOCKET` doesn't match the daemon's.                                                                                                                            |
| Daemon exits with close code 4014             | Message Content Intent is not enabled for the bot.                                                                                                                                                                |
| Daemon exits with close code 4004             | The bot token is wrong.                                                                                                                                                                                           |
| Every session claims the ear                  | `FROND_EAR_EAR` was set in a user-scope MCP config. Use `local` or project scope for the one session that owns the ear.                                                                                           |
