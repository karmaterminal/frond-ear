# frond-ear runbook

This runbook takes a Claude Code session from polling Discord to having Discord events pushed to it. Work through the stages in order, and don't point frond-ear at a long-running session (such as your main agent) until stage 2 passes on a throwaway session.

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

| Field             | Meaning                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `botUserId`       | The bot's own user ID. Its own messages are always ignored.                                                                                                             |
| `principals`      | Your operators, the people this ear answers to. Their messages have `trust="principal"` and they may DM the bot. Being a principal does not by itself wake the session. |
| `peerAgents`      | OpenClaw or other agent bots allowed through, with `trust="peer_agent"`. Any other bot is dropped.                                                                      |
| `labels`          | Optional friendly names for IDs, shown in headers and in the channel instructions.                                                                                      |
| `mentionPatterns` | Regexes that count as addressing the bot, e.g. `\bmy-ear\b`.                                                                                                            |

**Ears**

| Field                      | Meaning                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ears.<name>`              | One ear per session.                                                                                                                                                                            |
| `ears.<name>.target`       | `claude-channel` (the default, which `init` writes) or `copilot-extension`. This runbook attaches Claude Code; the [README](../README.md#github-copilot-cli) has the Copilot CLI steps.         |
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

| Field         | Meaning                                                                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaults`    | `quietWindowMs` sets how long the room must be quiet before a flush. `maxDelayMs` caps how long continuous chatter can delay one. `priorityQuietMs` is the short wait after a mention. `historyLimit` caps how much context is kept.                                              |
| `botLoop`     | If more than `maxEvents` bot messages arrive within `windowMs` in one chat, bot messages stop waking the session for `cooldownMs`.                                                                                                                                                |
| `ambientWake` | If more than `maxEvents` mention- or reply-driven wakes from ambient (non-principal, non-peer) users arrive within `windowMs` in one chat, further ones stop waking the session for `cooldownMs`. They are kept as context.                                                       |
| `limits`      | Per-message and per-notification size caps, the per-ear pending cap, retention time, and how much is read back after an outage too long for Discord to resume the session: `catchUpMessages` per chat (50; 0 turns it off) in the `catchUpChats` most recently active chats (25). |
| `paused`      | Kill switch. Messages are still ingested, but nothing is pushed.                                                                                                                                                                                                                  |

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

Register the shim for a throwaway directory only, with `local` scope, so no other session claims the ear.
`<ear>` is the ear's name in the config, the one you gave `init` (which prints this line filled in):

```sh
mkdir -p /tmp/ear-trial && cd /tmp/ear-trial
claude mcp add -s local frond-ear -e FROND_EAR_EAR=<ear> -- node /abs/path/to/frond-ear/src/cli.ts shim
claude --dangerously-load-development-channels server:frond-ear
```

Claude Code asks you to confirm the development-channel flag. Then:

1. **Canary.** Claude receives a `<channel … kind="attach">` event and calls `ack` with the nonce. Running `node src/cli.ts status` should show `"attached": true, "registered": true`. If `registered` stays `false`, the channel was not registered; see Troubleshooting. A session whose canary was lost also registers the first time it passes a pushed `batch_id` to a tool: that id carries a delivery token only the push has. The bare id `frond-ear tap` prints works in tools but proves nothing.
2. **Idle wake.** From another terminal, inject a mention from a principal:
   ```sh
   FROND_EAR_BOT_USER_ID=<botUserId> node src/cli.ts inject \
     --chat <a mentions channel id> --guild <guild id> --author <principal id> --name your-principal \
     --mention "are you there?"
   ```
   The idle session should wake, and its `reply` should appear on the daemon's stderr as `dry-run send → …`.
3. **Busy, no interrupt.** Give Claude a long task, inject again, and confirm the event is picked up at the next turn without interrupting the current one.
4. **Debounce.** Inject several messages into a `room` channel in quick succession. They should arrive as **one** notification.

## 3. Let the tools run unattended

A long-running session stalls on permission prompts. Allow frond-ear's tools in that project's `.claude/settings.local.json`, or in `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__frond-ear"] } }
```

## 4. Connect Discord

Stop the dry-run daemon and start it for real. Skip the first line if `init` already wrote the
token (§1). It creates the token file and refuses one that already exists: on a host shared with
another agent's ear, that file may be the other ear's token.

```sh
sh -c 'umask 077; set -C; : > "$1"' sh ~/.config/frond-ear/token && $EDITOR ~/.config/frond-ear/token
DISCORD_BOT_TOKEN_FILE=~/.config/frond-ear/token node src/cli.ts daemon
```

Check that `node src/cli.ts status` shows `"gateway": {"state": "connected"}`. Then, still using the throwaway session:

- post an @mention in a `mentions` channel;
- post a `<@!id>`-style mention;
- post a reply to one of the bot's messages;
- post a message from an OpenClaw peer bot.

## 5. Attach the long-running session

Only one Claude session should claim an ear. In that session's working directory, run:

```sh
claude mcp add -s local frond-ear -e FROND_EAR_EAR=<ear> -- node /abs/path/to/frond-ear/src/cli.ts shim
claude --resume <session id> --dangerously-load-development-channels server:frond-ear
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
bot, for scripts such as a watchdog that posts an outage alert when a host goes down. It finds
the daemon the way `status` does: `FROND_EAR_SOCKET` (default
`$XDG_RUNTIME_DIR/frond-ear/daemon.sock`), or `FROND_EAR_TCP` with `FROND_EAR_TOKEN_FILE`, never
`FROND_EAR_CONFIG`. It goes through the daemon's `reply` tool, so the daemon keeps the token, sends
only to chats an ear serves, and splits text longer than 2000 characters into several messages. A
script is never the ear's session, so a send marks nothing seen. It exits 0 once Discord has
confirmed every message; 1 when the daemon refused the send, Discord failed it or never confirmed
it, or the daemon could not be reached or gave no answer within 30 seconds; and 2 for bad usage.
The reason goes to stderr, and for a long text it names the parts already sent. After an
unconfirmed send or a timeout the message may still post. Retrying the identical text within 5
minutes of the first try at the unconfirmed message cannot post anything twice: the daemon skips
the parts Discord confirmed and reuses the unconfirmed message's nonce. An unconfirmed send's error
says how much of the 5 minutes is left, and retrying again does not restart them. A later retry,
such as the watchdog's next pulse 10 minutes on, posts every part again. Text that starts with `-`
goes after `--`.

An unconfirmed send stays in `status` under `ambiguousSends` until the prune drops it, once it is
older than `limits.retentionMs` (14 days by default). Each entry's `sessionEar` names the ear whose
session made it, or is `null` for a script (and for a send recorded before frond-ear kept track).
Its `part` and `parts` say which message of the reply it was (`part` counts from 0; both are `null`
for a send recorded before frond-ear tracked replies, whose nonce a retry never reuses, so retrying
one sends a new message). A session is never asked to check a script's send: the `send_check`
notice at an ear's next attach lists only unconfirmed replies made by that ear's sessions,
including one it has since replaced.

## 7. Survive a reboot

Run the daemon under systemd so the ear is not tied to whichever terminal started it:

```sh
ops/install-systemd.sh
```

It writes a `--user` unit pointing at this checkout, enables it, and waits for the gateway to
report `connected` before claiming success. Lingering must be on (`loginctl enable-linger $USER`)
or user units will not start until someone logs in — the script warns if it is off.

The SQLite state lives outside the checkout, so a restart keeps everything the ear is holding for
a detached session. Messages sent while the daemon is down are replayed by Discord when the
daemon is back within a few minutes; after a longer outage the daemon reads them back from each
chat's history instead, up to `limits.catchUpMessages` per chat, and tells the session in a
`catch_up` event. `docs/recovery.md` covers the rest: what is durable, what you have to back up
yourself, and how to get back from a lost checkout, a lost home directory, or a lost session.

## 8. Hear binary-canticle (optional)

frond-ear can listen to [binary-canticle](https://github.com/karmaterminal/binary-canticle) stations: signed,
looping, short-lived items on `station:stream` (RFC-0001). It's **listen-only**, and **silent unless an ear opts
in**: heard items never enter the Discord ledger, the session reads them with the `hear` tool when it wants to,
and only an ear with a `canticle.delivery` entry has any pushed to it ([Delivery modes](#delivery-modes)). Off
by default.

1. Get the fleet manifest (unsigned in v0, a local file). The ear never fetches one.
2. Add to the config and restart the daemon (canticle's source and `tune` aren't hot-reloaded):

   ```json
   "canticle": {
     "enabled": true,
     "manifestPath": "/path/to/canticle-fleet.json",
     "port": 9999,
     "binding": "lan",
     "tune": { "my-ear": ["*:ops.fleet", "station-a:chatter"] }
   }
   ```

   `tune` is per ear: the `station:stream` pairs it hears (`*` = any station). One listener per host serves
   every ear.
   **Where frames come from (`canticle.source`).** `embedded` (default) runs frond-ear's own listener. That's
   allowed only while frond-ear is the host's one listener (RFC-0001 §14), and it refuses to bind if a canticle
   host daemon answers on `canticle.hostSocket`. `host-daemon` binds nothing and reads record v1
   (§14.18.3) from the host daemon's socket (default `$XDG_RUNTIME_DIR/canticle/daemon.sock`). Use it on any
   host where another agent harness (such as OpenClaw) also hears canticle (binary-canticle#65). Each connection
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
   everyone at once is more likely our own socket or network. For what stands on a few streams after time
   away, call `sitrep` with them (`streams: ["distress", "alerts"]`; [What did I miss](#what-did-i-miss-sitrep)).

**`ops.fleet`** is the first real stream. Fleet scripts (flush, deploy, restart) announce themselves with the
spike's `canticle sing --control <station.sock> --stream ops.fleet --class advisory --ctype 1 --state-key <host>
--text "…"`, so an agent going dark is explained without anyone asking. One `state_key` per host means a newer
status supersedes the older one.

### Delivery modes

By default nothing heard reaches a session unasked (frond-ear#65). An ear opts in with a `canticle.delivery`
entry, and even then only records from station keys on `canticle.wakeKeys`, sung at hop 0 and not wake-derived
(RFC §14.8.1), are pushed. Every other record stays `hear`-only, and its station still shows on the on-air line,
so a station calling CQ is seen whether or not it may wake anyone. These fields reload with the config; `tune`
and `source` still need a restart.

```json
"canticle": {
  "wakeKeys": ["0123456789abcdef"],
  "delivery": {
    "my-ear": {
      "mode": "digest",
      "stations": { "station-a": "immediate" },
      "streams": { "distress": "immediate", "alerts": "digest" }
    }
  }
}
```

| Field                | Default        | Meaning                                                                                                                                                                                                                                                                                              |
| -------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakeKeys`           | `[]`           | Station key ids (16 hex digits, the `key=` of a `hear` banner) whose records may be pushed. Empty: nothing is pushed, and `ear_status` warns. Leave out the host's own station key, or it hears itself.                                                                                              |
| `muted`              | `false`        | `true` mutes every push to every ear.                                                                                                                                                                                                                                                                |
| `delivery.<ear>`     | absent (`off`) | The ear's ceiling. A bare string (`"digest"`) sets `mode` alone.                                                                                                                                                                                                                                     |
| `….mode`             | `off`          | `immediate`, `digest` or `off`, for every station and stream without an entry of its own.                                                                                                                                                                                                            |
| `….stations`         | `{}`           | `station → mode`, overriding `mode` for that station. A station can be named by its key id (16 hex digits, the `key=` of a `hear` banner), which outlasts a manifest rename; where its key id and its name both have an entry, the narrower holds.                                                   |
| `….streams`          | `{}`           | `stream → mode`, overriding `mode` for that stream on every station (frond-ear#85), such as `distress` immediate and `alerts` digest. A stream is named without its station (the `stream=` of a `hear` banner). Where a record's station and its stream both have an entry, the narrower holds.      |
| `….windowMs`         | `60000`        | `digest`: at most one report per window, 5 s to 1 h. The window opens when a record starts waiting.                                                                                                                                                                                                  |
| `….debounceMs`       | `5000`         | `immediate`: a burst is coalesced over this long, 5 s (RFC §14.10) to 1 min, and less than `maxAgeMs`.                                                                                                                                                                                               |
| `….maxAgeMs`         | `30000`        | `immediate` pushes only a record heard at most this long ago and at most this old when first heard (RFC §14.10 item 9). Any other goes into the next report instead, marked late. 10 s to 2 min (item 9's 120 s).                                                                                    |
| `….style`            | `records`      | `digest`: `records` (each record behind its banner) or `counts` (per stream: how many, seqs skipped, repeats caught; no payloads).                                                                                                                                                                   |
| `….maxItems`         | `5`            | Records per push, 1 to 10 (RFC §14.6.5's dose is 5). The rest wait for the next push.                                                                                                                                                                                                                |
| `….bufferPerStream`  | `32`           | Records waiting per `station:stream`, 1 to 256. When it is full the oldest is dropped, and the next push says so.                                                                                                                                                                                    |
| `….maxPushesPerHour` | `60` or more   | Pushes to the ear per hour, from `immediate` and reports together, 1 to 360: 60 by default, or one per window when `windowMs` is under a minute, so a busy band's reports fit the hour. `ear_status` warns when it is less than one per window. Past it, records wait. The count survives a restart. |

**What the session gets.** Channel events with `kind="canticle"` and `delivery="immediate"` (the new records of
the last few seconds) or `delivery="report"` (a "what's on the radio" report, `report=<n>`). They sit outside the
Discord ledger: no `batch_id`, nothing to `ack`. Each record carries the `[canticle:heard]` banner `hear` shows,
with `mode=silent-wake`, and its payload quoted inside an `EXTERNAL_UNTRUSTED_CONTENT` wrapper. A report gives
the on-air line, then each `station:stream` in order with its records in seq order, under a line that counts them
and says what it skipped since the last report (seqs lost on air, plucked or `hear`-only), what came out of
order, how many are late, what went off air before a push could carry it, and what a full buffer dropped. A
report a cap cut short says how many records wait, and the next one starts after the last stream it covered
(`continues after …`), so a busy stream can't starve the rest. The cursor survives restarts.

**Late records.** A record that wasn't heard live just now has a `late:` line under its banner's timing line:
`late: heard 54s ago (snapshot)`, `late: heard 7s ago (resurfaced)`, or
`late: heard 12s ago, 300s old when first heard`. Every record from a join snapshot or a `resurfaced` copy gets
one. So does every record `immediate` sent to a report because it was too old (see `maxAgeMs`), and any record a
report carries more than `windowMs + maxAgeMs` after it was heard. A late record tells the session what was so
then, not what is so now; the channel instructions say so. Pushes don't keep the station's order either: after a
rejoin, `immediate` can push seq N+1 while N, too old for `immediate`, waits for the next report. Each banner's
seq gives the station's order, not the time a push arrives.

Every push fits `limits.maxNotificationChars`. A record too big for it alone is cut inside its wrapper. Below
about 1,000 characters no banner fits, so a push gives counts instead; when even those run over, it drops the
notes about the listener and the on-air line, and sums up in one line what other streams missed. If not even one
stream's counts line fits, nothing is pushed or taken as delivered: the records wait, and `counts.too_big` grows.

**The session's choice.** `set_canticle_delivery` sets `immediate`, `digest` or `mute` for one station (by name,
or by key id to outlast a rename), one stream (`stream`, on every station), one station's stream (both), or
(with neither) all of them, optionally for `ttl_seconds`; `configured` clears the choice for that scope (every
choice, with neither), and `style` picks the report's form. The config is the ceiling, so the session can only
narrow it. The choice that names more of a record wins, as a chat's own `set_attention` choice beats `*`: a
station's stream beats that station's choice and that stream's, and either beats the one for everything. With
everything at `digest` and `distress` at `immediate`, distress goes `immediate`. Where a station's choice and a
stream's both apply, the narrower holds. Each scope holds one choice, as with `set_attention`: a new one replaces
it, and when its `ttl_seconds` lapses the config applies again, style included. A mute at any scope that covers a
record wins: the session's, an ear-wide `set_attention` silence, or `canticle.muted`. It is for good: a record
first heard under a mute is never pushed, even after the mute lifts, and both tools say so. `hear` still reads it
while it is live.

**Exactly once.** A record is told apart by its identity, never its text: RFC §7.4's tuple of key id, epoch,
stream and seq, which record v1's `idem` spells out (the stream by name, one to one with its id, §5.4). The same
words under a new seq are new speech, and a retransmission is not. A pushed record keeps a tombstone in the store
until its local expiry plus 5 s (RFC §14.18.5), so no retransmission, `resurfaced` record, join snapshot or
frond-ear restart pushes it twice, and digest and immediate never both push it. A record heard again with a later
local expiry (a restarted receptor's new δ̂, §14.6.3) keeps its tombstone until then. Once a tombstone has
lapsed, though, a receptor that hears the record again as new (after a restart, with a later local expiry) can
have it pushed once more, still within §14.18.5's bound; it is marked late if it is older than `maxAgeMs` by
then. A refresh re-issue with the same body as a pushed record is not pushed (§7.9). A record first heard under a
mute is never pushed, even after the mute lifts or frond-ear restarts. A config reload re-reads what is on air,
as a restart does, and a key taken off `wakeKeys` holds back what it had waiting.

**Holds.** Nothing is pushed while the daemon is paused, the ear has no session, the host daemon's breaker is
open or half-open (§14.18.4), or the hour's pushes are spent: records wait while they are on air. In `immediate`,
one that waits past `maxAgeMs` goes into the next report instead, marked late. A record that goes off air or is
plucked first is never pushed, and the next push counts it. After a dropped link the join snapshot brings back
what is on air: what was pushed stays pushed, and a record sung meanwhile goes out once.

**Check it.** `ear_status` shows `ears[].canticleDelivery`: the `ceiling` and effective `mode`, `style`, any
`muted` reason, per-station modes (`stations`) and per-stream ones (`streams`, as `*:stream` or
`station:stream`), each scope as config or the session names it, the session's `choices`,
`wakeKeys` (a count) and any `warning` (no `wakeKeys`, or `maxPushesPerHour` under one report per window),
`windowMs`, `debounceMs`, `maxAgeMs`, `waiting`, `nextPushAt`, `held` (`paused`, `no_session`, `breaker_open`,
`breaker_half_open` or `push_budget`), `lastPushAt`, `pushesLastHour`, `reports`, and `counts`: what was pushed
(`pushes`, `reports`, `records_pushed`, and of those `records_pushed_late`), sent from `immediate` to a report
for its age (`routed_late`), passed over (`not_allowlisted`, `relayed`, `wake_derived`, `off`, `muted`,
`refresh_collapsed`), went off air unpushed (`off_air_unpushed`) or was dropped from a full buffer (`dropped`),
and pushes that didn't fit at all (`too_big`).

### What did I miss (sitrep)

`sitrep` (frond-ear#85) answers "what stands now" on the streams a session names, in its order:
`sitrep(streams: ["distress", "alerts"], limit: 20)`. A stream name means every station's; `station:stream`
means one station's. It reads the same live set as `hear`, behind the same banner and wrapper, and folds it to
**one entry per station and state_key**: the newest standing, by RFC-0001 §7.8's order (`issued_at`, then epoch,
then seq), with a `folded:` line naming the older items it stands for. It never folds across stations (§6.5),
and tells them apart by key id. An item without a state_key is its own entry. The fold is only how `sitrep` shows
them: `hear` still reads every item. An item folded from another stream is still current there, since only a
newer item on its own stream supersedes it (§7.8) or, for a finding, resolves it (§6.7): the `folded:` line names
each older item's stream, with a finding's status and severity, and says so.

Where the set comes from: with `host-daemon`, the daemon's join snapshot (§14.18.3, D36) and every record since,
which is what a new snapshot would give; with `embedded`, what frond-ear's own listener heard while it ran
(passive catch-up, §7.10). No source here can ask a relay for a fill-only view (§7.10), so `sitrep` doesn't. It
says which basis it read, and when it can't see: the listener down, every station unknown, a late join, the run
ended, or the host receptor muted (which withdraws every item; `hear` now says so too). A chosen stream this ear
doesn't tune is named as unheard, not quiet. **Absent is not resolved**: an incident that expired, was plucked or
went unheard is simply not there, and only a newer `resolved` finding from the same station, on the same stream
and state_key, resolves one.

Like `hear`, it is a read: it marks no Discord event seen, pushes nothing, and doesn't count or claim a record,
so delivery still pushes each one once.

### Findings: who speaks

A probe or watcher that finds something about a seat sings a **finding**: an advisory with content type 11,
`application/vnd.canticle.finding+cbor`, keyed by the incident (RFC-0001 §6.7, amendment FP-1, proposed in
binary-canticle#115 with the probe profile, `rfc/0001-notes/probe-profile.md`; frond-ear reads it ahead of the
merge). Record v1 shows the type by id or by name and the body in `base64`; frond-ear reads either. A finding gets
one more banner line, after the `[canticle:heard]` line that names the signing station:

```
[canticle:finding] status=open severity=moderate voice=observer — the station named above reports about the subject named below, which is not speaking
```

The signing station is always the speaker. The line carries only the finding's `status` and `severity` words and
its voice as attributed (§6.7): `self` only when the subject is the signer's own station, as the manifest names
it; `self-unmatched` when the body says `self` about another seat, which is the signer's observation of that seat;
`observer` otherwise. `status` is `open` (with CAP's `severity`: `extreme`, `severe`, `moderate`, `minor` or
`unknown`), `resolved`, or `ended` (it stopped watching without seeing a resolution). The station's own text, its
`subject`, its `summary` and what it has `not proved`, stays inside the untrusted wrapper under frond-ear's
`(subject)`, `(summary)` and `(not proved)` labels. A content type 11 body that isn't a finding (another class, an
incident other than the state_key, a missing or malformed field) stays opaque, never shown with a status or
severity, and says it isn't one; unsigned integer keys other than 1-7 are ignored. Evidence is the item's own
`body_ref`, shown and never fetched. Delivery never reads a finding's words: a session picks a mode by stream,
never by status or severity.

**Departures from RFC-0001.** The frond settled these modes on #65 (2026-10-10), and the §6.7 row applies them to
findings (#85). Where they go past RFC-0001, the RFC hasn't been amended to match yet (binary-canticle#100 tracks
the amendment):

| RFC                         | It says                                                                                                                                                                                                            | frond-ear                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6.2, §6.7 (FP-1, proposed) | `advisory`, a finding's class, is not wake-eligible in v1, and a finding's `status` and `severity` never map to wake.                                                                                              | A finding from an allowlisted key is pushed like any other record (the §14.10 row). Its words never pick the mode: the session picks by stream (`distress` immediate, `alerts` digest), never by status or severity.                                                                                                                                                                                                                                                                                                                                                                                |
| §14.6.4, §14.6.6, §14.6.7   | Salience regulation: a stream's threshold doubles after 5 surfacings in 10 min; no station fills more than 25% of a session's digest over 10 min (AGC); each session's threshold tracks 12 surfaced items an hour. | Not applied: nothing is ranked or thresholded. Every allowlisted record is pushed, in `station:stream` order, and a report a cap cut short continues after the last stream it covered, so a busy stream can't starve the rest. This suits a small allowlist under the hourly cap.                                                                                                                                                                                                                                                                                                                   |
| §14.6.5, §14.14             | At most two slots per session, rebuilt in place; a digest of at most 5 one-line items and 1.5 KB per turn, full text on demand; a drained item that is later plucked or expires gets a one-line note.              | Each push is a new channel event, which can't be rebuilt or recalled. The dose is per ear instead: `maxItems` records (5 by default, at most 10) and `limits.maxNotificationChars` (6,000 by default) per push, and `maxPushesPerHour` (at most 360). A `records` report carries each record whole, as #65's radio report asks; `counts` is the compact form. A pushed record gets no note when it is plucked or expires (#67).                                                                                                                                                                     |
| §14.10                      | Only `alarm` may wake, when all 11 conditions hold; until S3 passes, deployments behave as if nothing wakes.                                                                                                       | Any class from an allowlisted key is pushed. Kept: verified and not under the host daemon's MUTE, an allowlist (in place of the alarm capability), the ear's opt-in, hop 0 and not wake-derived, coalescing of at least 5 s, the breaker, and item 9's freshness bound for `immediate` (`maxAgeMs`, 30 s by default and at most 120 s, on the age at first hearing and on the time since). A report may still carry an older record, marked late. Not applied: the class rule, the session, host and token budgets (a per-ear cap on pushes per hour instead), host prerequisites and proofreading. |
| §14.12, BC-1                | No ambient delivery to a session with an off-host channel route, such as Discord, until §23.2 question 22 is settled.                                                                                              | A frond-ear session has a Discord route by design. It already takes the same agents' Discord messages as `peer_agent` events, outside any untrusted-content wrapper, so canticle adds no new trust level; this holds for frond-ear hosts only. Pushes come behind the banner and wrapper; frond-ear can't taint what the session does next.                                                                                                                                                                                                                                                         |
| §14.16 item 3 (A11)         | Chatter, ambient and advisory items land after a random per-session delay.                                                                                                                                         | No delay beyond the debounce or window. This is agreed for frond-ear hosts; revisit it before an agent on another harness opts in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| §14.18.3 (D36)              | Join-snapshot entries and `resurfaced` records never wake a session.                                                                                                                                               | One already pushed is never pushed again; one never pushed goes out once, so each record is heard once across a dropped link (#65). It is marked `late: … (snapshot)` or `(resurfaced)`, and goes `immediate` only within `maxAgeMs`; an older one goes into the next report.                                                                                                                                                                                                                                                                                                                       |
| §14.18.4                    | A half-open breaker allows a wake within its allowance.                                                                                                                                                            | Half-open holds, as open does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Troubleshooting

Start with `node src/cli.ts doctor`, with `FROND_EAR_CONFIG` and `DISCORD_BOT_TOKEN_FILE` set to what the daemon uses (§1): it checks config, token, socket, daemon, gateway and each ear, and prints a fix line for every ✗.

| Symptom                                       | Likely cause                                                                                                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registered: false`, no events in the session | Claude Code was started without `--dangerously-load-development-channels server:frond-ear`; or org policy blocks channels; or `MCP_PROTOCOL_NEGOTIATION=auto` on the v2 runtime (unset it or set it to `legacy`).                                               |
| `registered: false`, later events do arrive   | The attach canary was lost: a shim from before the #70 fix sent it, and any backlog, before Claude Code was listening (2.1.296 starts just after `initialize`). Update frond-ear. Until then, the session registers the first time it uses a pushed `batch_id`. |
| `attached: false` while the session runs      | `FROND_EAR_EAR` names an ear the config does not have; the shim logs `unknown ear` to Claude Code's MCP log. Register it with the ear's name from the config (§2).                                                                                              |
| `registered: false` on a Copilot ear          | The extension is not installed for that ear, or Copilot was started without `--experimental`. If the ear is attached, look in the Copilot session for `frond-ear: could not deliver batch` (a refused push).                                                    |
| Copilot tools are stale after an upgrade      | The install copies the tool schemas: an old one lacks newer tools, or (before #30) takes a numeric `batch_id`. Re-run `node src/cli.ts copilot-extension --ear <name>` with the daemon's socket or TCP env (§1).                                                |
| Shim reports "daemon is not reachable"        | The daemon isn't running, or the shim's `FROND_EAR_SOCKET` doesn't match the daemon's.                                                                                                                                                                          |
| Daemon exits with close code 4014             | Message Content Intent is not enabled for the bot.                                                                                                                                                                                                              |
| Daemon exits with close code 4004             | The bot token is wrong.                                                                                                                                                                                                                                         |
| Every session claims the ear                  | `FROND_EAR_EAR` was set in a user-scope MCP config. Use `local` or project scope for the one session that owns the ear.                                                                                                                                         |
