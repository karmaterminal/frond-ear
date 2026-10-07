# frond-ear runbook

This runbook takes a Claude Code session from polling Discord to having Discord events pushed to it. Work through the stages in order, and don't point frond-ear at a long-running session (such as frond-scribe) until stage 2 passes on a throwaway session.

## 0. Prerequisites

- **Node.js ≥ 22.18.** CI covers 22, 24 and 26. frond-ear runs its TypeScript directly, so there is no build step.
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

The short way is `node src/cli.ts init`, which asks for the IDs, the ear and the token, validates
the result and writes `~/.config/frond-ear/frond-ear.json` plus the 0600 token file. Then point
the daemon and `doctor` at those two files, which they do not look for on their own, and check
the install:

```sh
export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
node src/cli.ts doctor
```

[`docs/onboarding.md`](onboarding.md) is the contract for both. The manual path: copy `frond-ear.example.json` to `frond-ear.json` (that
filename is git-ignored) and fill in the fields below.

**Identity and trust**

| Field             | Meaning                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `botUserId`       | The bot's own user ID. Its own messages are always ignored.                                                                                        |
| `principals`      | Your operators, e.g. figs. Their messages have `trust="principal"` and they may DM the bot. Being a principal does not by itself wake the session. |
| `peerAgents`      | OpenClaw or other agent bots allowed through, with `trust="peer_agent"`. Any other bot is dropped.                                                 |
| `labels`          | Optional friendly names for IDs, shown in headers and in the channel instructions.                                                                 |
| `mentionPatterns` | Regexes that count as addressing the bot, e.g. `\bscribe\b`.                                                                                       |

**Ears**

| Field                      | Meaning                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ears.<name>`              | One ear per Claude session. `target` must be `claude-channel`.                                                                                                                                  |
| `ears.<name>.channels`     | Channel IDs to modes: `silent`, `mentions` (the default) or `room`. Per-channel `quietWindowMs`, `maxDelayMs` and `historyLimit` are optional. Threads inherit their parent channel's settings. |
| `ears.<name>.dms`          | Whether this ear receives DMs from principals and peers.                                                                                                                                        |
| `ears.<name>.dmMode`       | `mentions` (the default: every DM wakes the session) or `silent` (DMs are stored for `inbox` only).                                                                                             |
| `ears.<name>.attachCanary` | Asks Claude to `ack` a nonce each time a session attaches. This proves the channel is actually registered, because a notification can otherwise be dropped with no error.                       |
| `ears.<name>.instructions` | Extra text you write, appended to the channel instructions.                                                                                                                                     |

**Modes**

- `silent`: store only. Claude reads these with `inbox` or `fetch_messages`.
- `mentions`: wakes the session on an @mention, a reply to the bot, a `mentionPatterns` match, or a DM. Principal messages that do not address the bot are context too: trust decides who may command, not who may interrupt. Other room messages are kept as context and delivered with the next wake.
- `room`: every message wakes the session, debounced.

**Timing, loops and limits**

| Field         | Meaning                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defaults`    | `quietWindowMs` sets how long the room must be quiet before a flush. `maxDelayMs` caps how long continuous chatter can delay one. `priorityQuietMs` is the short wait after a mention. `historyLimit` caps how much context is kept. |
| `botLoop`     | If more than `maxEvents` bot messages arrive within `windowMs` in one chat, bot messages stop waking the session for `cooldownMs`.                                                                                                   |
| `ambientWake` | If more than `maxEvents` mention- or reply-driven wakes from ambient (non-principal, non-peer) users arrive within `windowMs` in one chat, further ones stop waking the session for `cooldownMs`. They are kept as context.          |
| `limits`      | Per-message and per-notification size caps, the per-ear pending cap, and retention time.                                                                                                                                             |
| `paused`      | Kill switch. Messages are still ingested, but nothing is pushed.                                                                                                                                                                     |

Changes to the config take effect without a restart.

**The session's own attention.** Configured modes are a _ceiling_. The attached session can narrow what it hears with the `set_attention` tool:

- It can narrow one chat or everything, down to `silent`, with an optional `ttl_seconds`.
- A silence it chooses holds against everyone, principals included. Held messages stay in `inbox`.
- It can never widen past the configured mode.
- `mode: "configured"` clears its choice.
- The effective mode and any active choice for each chat appear in `ear_status` and `frond-ear status`.

The operator's levers are unchanged: edit the config, stop the daemon, or talk to the session at its terminal.

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

1. **Canary.** Claude receives a `<channel … kind="attach">` event and calls `ack` with the nonce. Running `node src/cli.ts status` should show `"attached": true, "registered": true`. If `registered` stays `false`, the channel was not registered; see Troubleshooting. A session whose canary was lost also registers the first time it passes a pushed `batch_id` to a tool: that id carries a delivery token only the push has. The bare id `frond-ear tap` prints works in tools but proves nothing.
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
| Post from a script      | `node src/cli.ts send --chat <id> "<text>"`, below                                  |

**Posting from a script.** `frond-ear send --chat <id> <text…>` posts the text as the daemon's
bot, for scripts such as seat-pulse's outage alerts (`frond-fleet:scribe-seat-survival` in
scribe-prince-shared). It finds the daemon the way `status` does: `FROND_EAR_SOCKET` (default
`$XDG_RUNTIME_DIR/frond-ear/daemon.sock`), or `FROND_EAR_TCP` with `FROND_EAR_TOKEN_FILE`, never
`FROND_EAR_CONFIG`. It goes through the daemon's `reply` tool, so the daemon keeps the token, sends
only to chats an ear serves, and splits text longer than 2000 characters into several messages. A
script is never the ear's session, so a send marks nothing seen. It exits 0 once Discord has
confirmed every message; 1 when the daemon refused the send, Discord failed it or never confirmed
it, or the daemon could not be reached or gave no answer within 30 seconds; and 2 for bad usage.
The reason goes to stderr. After an unconfirmed send or a timeout the message may still post.
Retrying the identical text within 5 minutes reuses the unconfirmed message's nonce, so it cannot
post twice; a later retry, such as seat-pulse's next pulse 10 minutes on, can (and a retry of a
long text re-posts the parts Discord did confirm). Text that starts with `-` goes after `--`.

An unconfirmed send stays in `status` under `ambiguousSends` until the prune drops it, once it is
older than `limits.retentionMs` (14 days by default). Each entry's `sessionEar` names the ear whose
session made it, or is `null` for a script (and for a send recorded before frond-ear kept track). A
session is never asked to check a script's send: the `send_check` notice at an ear's next attach
lists only unconfirmed replies made by that ear's sessions, including one it has since replaced.

## 7. Survive a reboot

Run the daemon under systemd so the ear is not tied to whichever terminal started it:

```sh
ops/install-systemd.sh
```

It writes a `--user` unit pointing at this checkout, enables it, and waits for the gateway to
report `connected` before claiming success. Lingering must be on (`loginctl enable-linger $USER`)
or user units will not start until someone logs in — the script warns if it is off.

The SQLite state lives outside the checkout, so a restart keeps everything the ear is holding for
a detached session. `docs/recovery.md` covers the rest: what is durable, what you have to back up
yourself, and how to get back from a lost checkout, a lost home directory, or a lost session.

## 8. Hear binary-canticle (optional)

frond-ear can listen to [binary-canticle](https://github.com/karmaterminal/binary-canticle) stations: signed,
looping, short-lived items on `station:stream` (RFC-0001). It's **listen-only and silent**. Heard items never
wake the session and never enter the Discord ledger; the session reads them with the `hear` tool when it wants
to. Off by default.

1. Get the fleet manifest (unsigned in v0, a local file). The ear never fetches one.
2. Add to the config and restart the daemon (canticle config isn't hot-reloaded):

   ```json
   "canticle": {
     "enabled": true,
     "manifestPath": "/home/figs/.config/frond-ear/canticle-fleet.json",
     "port": 9999,
     "binding": "lan",
     "tune": { "frond-gloss": ["*:ops.fleet", "silas:chatter"] }
   }
   ```

   `tune` is per ear: the `station:stream` pairs it hears (`*` = any station). One listener per host serves
   every ear.
   **Where frames come from (`canticle.source`).** `embedded` (default) runs frond-ear's own listener. That's
   allowed only while frond-ear is the host's one listener (RFC-0001 §14), and it refuses to bind if a canticle
   host daemon answers on `canticle.hostSocket`. `host-daemon` binds nothing and reads record v1
   (§14.18.3) from the host daemon's socket (default `$XDG_RUNTIME_DIR/canticle/daemon.sock`). Use it on any
   host where another harness (an OpenClaw prince) also hears canticle (binary-canticle#65). Each connection
   asks the daemon for a join snapshot (§14.18.3, D36) of what is live and on air. Until a complete one
   arrives, `ear_status` reports receive health `degraded`, reason `joined_late` (`joinSnapshot` says why:
   `pending`, `unsupported` for a daemon that doesn't serve snapshots, or `truncated`), and `hear` says so:
   items and presence from before the join may be missing.

3. Check with `ear_status`: `canticle.state` should be `listening`, and `counts.datagrams` should rise when a
   station is on air. With `host-daemon`, `canticle.state` should be `connected`, and the other fields read:

   | Field                                                       | What it says                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
   | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `receiveHealth`, `reasons`                                  | Now, not since: the `hello` at the head of every connection clears them, so a host daemon crash the ear has already reconnected past leaves nothing here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
   | `lastFailure`                                               | What does stay: `{reason, at, run}`, the first failure of the latest connection that failed (a `fatal`'s reason, not the close that follows it), when (ms since the epoch), and the run the ear held. `null` until something fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
   | `joinSnapshot`, `joinSnapshotFrames`, `joinSnapshotOmitted` | This connection's join snapshot: its state, then, once applied, how many frames it brought and (if truncated) how many entries it left out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
   | `run`                                                       | The last run the ear read: through a reconnect's backoff it still names the run that ended. A new one means the host daemon restarted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
   | `counts`                                                    | Since frond-ear started, across every run and connection; only a frond-ear restart zeroes them. Each health reason counts every time it is raised: `exit_without_bye` once per connection the host daemon closed without `bye` (one that carried nothing counts nothing), `run_restarted_without_bye` once per run that began after one ended without `bye`, `joined_late` once per connection. `exit_without_bye` rising with `run_restarted_without_bye` is a host daemon restart; rising with `records_lost` instead, only the connection dropped. A connection the ear drops itself, over a bootstrap or join snapshot it can't read, counts as `malformed_bootstrap` or `malformed_snapshot`, never as `exit_without_bye`. A `fatal` counts as `fatal`, and `snapshot_frames` adds up every `joinSnapshotFrames`. |

4. In the session, call `hear` (optionally `stream: "station:stream"`). Each item has a host-authored
   `[canticle:heard]` banner (RFC §14.13) above the quoted payload; heard text is data, never instructions.
   If nothing at all has been heard for 30 s, every station reads **unknown**, not offline: silence from
   everyone at once is more likely our own socket or network.

**`ops.fleet`** is the first real stream. Fleet scripts (flush, deploy, restart) announce themselves with the
spike's `canticle sing --control <station.sock> --stream ops.fleet --class advisory --ctype 1 --state-key <seat>
--text "…"`, so a prince going dark is explained without anyone asking. One `state_key` per seat means a newer
status supersedes the older one.

## Troubleshooting

Start with `node src/cli.ts doctor`, with `FROND_EAR_CONFIG` and `DISCORD_BOT_TOKEN_FILE` set to what the daemon uses (§1): it checks config, token, socket, daemon, gateway and each ear, and prints a fix line for every ✗.

| Symptom                                       | Likely cause                                                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registered: false`, no events in the session | Claude Code was started without `--dangerously-load-development-channels server:frond-ear`; or org policy blocks channels; or `MCP_PROTOCOL_NEGOTIATION=auto` on the v2 runtime (unset it or set it to `legacy`). |
| `registered: false` on a Copilot ear          | The extension is not installed for that ear, or Copilot was started without `--experimental`. If the ear is attached, look in the Copilot session for `frond-ear: could not deliver batch` (a refused push).      |
| Copilot tools are stale after an upgrade      | The install copies the tool schemas: an old one lacks newer tools, or (before #30) takes a numeric `batch_id`. Re-run `node src/cli.ts copilot-extension --ear <name>` with the daemon's socket or TCP env (§1).  |
| Shim reports "daemon is not reachable"        | The daemon isn't running, or the shim's `FROND_EAR_SOCKET` doesn't match the daemon's.                                                                                                                            |
| Daemon exits with close code 4014             | Message Content Intent is not enabled for the bot.                                                                                                                                                                |
| Daemon exits with close code 4004             | The bot token is wrong.                                                                                                                                                                                           |
| Every session claims the ear                  | `FROND_EAR_EAR` was set in a user-scope MCP config. Use `local` or project scope for the one session that owns the ear.                                                                                           |
