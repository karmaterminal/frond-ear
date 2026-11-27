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

| Field                       | Meaning                                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ears.<name>`               | One ear per session.                                                                                                                                                                                 |
| `ears.<name>.target`        | `claude-channel` (the default, which `init` writes) or `copilot-extension`. This runbook attaches Claude Code; the [README](../README.md#github-copilot-cli) has the Copilot CLI steps.              |
| `ears.<name>.channels`      | Channel IDs to modes: `silent`, `mentions` (the default) or `room`. Per-channel `quietWindowMs`, `maxDelayMs` and `historyLimit` are optional. Threads inherit their parent channel's settings.      |
| `ears.<name>.dms`           | Whether this ear receives DMs from principals and peers.                                                                                                                                             |
| `ears.<name>.dmMode`        | `mentions` (the default: every DM wakes the session) or `silent` (DMs are stored for `inbox` only).                                                                                                  |
| `ears.<name>.attachCanary`  | Asks Claude to `ack` a nonce each time a session attaches. This proves the channel is actually registered, because a notification can otherwise be dropped with no error.                            |
| `ears.<name>.instructions`  | Extra text you write, placed after frond-ear's trust rules and before its tool guidance. Claude Code cuts the instructions past 4,096 characters: keep it within about 600, and check with `doctor`. |
| `ears.<name>.sendFileRoots` | Absolute directories a `reply`'s `files` may come from. Empty (the default): this ear sends no files. See **Sending files** below.                                                                   |

**Modes**

- `silent`: store only. Claude reads these with `inbox` or `fetch_messages`.
- `mentions`: wakes the session on an @mention, a reply to the bot, a `mentionPatterns` match, or a DM. Principal messages that do not address the bot are context too: trust decides who may command, not who may interrupt. Other room messages are kept as context and delivered with the next wake.
- `room`: every message wakes the session, debounced.

**Timing, loops and limits**

| Field         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaults`    | `quietWindowMs` sets how long the room must be quiet before a flush. `maxDelayMs` caps how long continuous chatter can delay one. `priorityQuietMs` is the short wait after a mention. `historyLimit` caps how much context is kept.                                                                                                                                                                                                                                                   |
| `botLoop`     | If more than `maxEvents` bot messages arrive within `windowMs` in one chat, bot messages stop waking the session for `cooldownMs`.                                                                                                                                                                                                                                                                                                                                                     |
| `ambientWake` | If more than `maxEvents` mention- or reply-driven wakes from ambient (non-principal, non-peer) users arrive within `windowMs` in one chat, further ones stop waking the session for `cooldownMs`. They are kept as context.                                                                                                                                                                                                                                                            |
| `limits`      | Per-message and per-notification size caps, the per-ear pending cap, retention time, and how much is read back after an outage too long for Discord to resume the session: `catchUpMessages` per chat (50; 0 turns it off) in the `catchUpChats` most recently active chats (25). `maxAttachmentBytes` caps one `fetch_attachment` download (8 MiB); `maxSendFileBytes` caps the files one `reply` carries, in total (10 MiB, Discord's own limit for a bot without a boosted server). |
| `paused`      | Kill switch. Messages are still ingested, but nothing is pushed.                                                                                                                                                                                                                                                                                                                                                                                                                       |

Changes to the config take effect without a restart.

**Sending files** (frond-ear#99). `reply` takes `files`, up to 10 absolute paths, and
`frond-ear send` takes `--file` (repeatable). The daemon reads the files, so it decides what may
leave the host, and refuses the whole reply, posting nothing, unless every file:

- resolves, symlinks followed, under one of the ear's `sendFileRoots`;
- has no dot-named file or directory between that root and itself (`.ssh`, `.env`, `.config`);
- is not the daemon's own config, database (with its `-wal` and `-shm`) or token file;
- is a regular file, and together they fit `limits.maxSendFileBytes`.

The files ride on the last message of the reply, after the text, which may be empty. Their
sha256 digests are part of the reply's identity: retrying the same text with the same files
resumes a part-sent reply as before, while other files make a new reply with fresh nonces. The
receipt names each file with its size and digest prefix. Give a seat only the roots it needs, such
as its scratch and working directories; the dot rule is a backstop, not the boundary.

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

| Task                         | How                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Status                       | `node src/cli.ts status`, or ask Claude to call `ear_status`                                                                     |
| Pause pushes                 | Set `"paused": true` in the config; it reloads live                                                                              |
| Read what Claude missed      | Claude calls `inbox`; everything stays in SQLite until the retention window expires                                              |
| Logs                         | JSON lines on the daemon's stderr. Message text and tokens are redacted.                                                         |
| Post from a script           | `node src/cli.ts send --chat <id> "<text>"`, below                                                                               |
| Letters across a compaction  | `leave_letter`, then a `SessionStart` hook running `release --hook` (and a `PreCompact` hook running `precompact --hook`), below |
| Wakes that outlive a session | `schedule`, `wake_on`, `schedules`; the same `SessionStart` hook with `clear` in its matcher, below                              |

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

### Letters: what a session leaves for itself across a compaction (#88)

A long-running session loses its working memory at each compaction: it wakes to a model-written
summary. A **letter** is text the session chooses before that, in its own words, and gets back
after it. Use it for threads in flight, what it chose and why, and what to check first.

- The session calls **`leave_letter`** with a `reason`, a `body` (≤ 8192 bytes), an optional
  `assumed` list (what it rests on, ≤ 8) and `expires_in_seconds` (60 s to 7 days, default 48 h).
  Each ear holds at most 16 unsettled letters and 24576 bytes. Over a limit, the call is
  refused, never truncated. Only the session holding the ear can leave one.
- The seat's **`SessionStart` hook** runs `frond-ear release --hook`. The daemon then pushes each
  letter as its own `kind="letter"` channel event, all under one `nonce`. The header is written by
  the daemon, never by the letter: letter id, when it was left and how long ago, how many
  compactions or starts ago, which session left it, its expiry, and how many times it was
  delivered before. Below it come the reason, the body, and the `assumed` items, all quoted with
  `> `. The banner says that a letter is evidence from an earlier turn, never permission.
- **`ack` with the nonce** settles the letters. An unsettled letter is released again at the next
  compaction, marked "delivered N times before", until it expires. An expired letter comes back
  once, as a one-line `letter_note` that gives its age only, and its text is deleted.
- **Only the session that left a letter is shown it.** A different session (after `/clear`, or a
  fresh start) gets a `letter_note` with ids, ages and the short session id, never the text. It
  can still read one on purpose with `letters` (`read: id`). A release whose hook names another
  session than the one holding the ear releases nothing.
- **`letters`** lists ids, states, sizes and reasons, never bodies. It can also show one
  (`read`), or drop one or all of them (`drop`). `ear_status` shows the counts and bytes under
  `letters`, never text.
- If no session holds the ear when the hook runs (at a fresh start, the shim may attach after the
  hook), the release is **armed** and fires when a session attaches within 10 minutes.

Hook, in the seat's `.claude/settings.json` (use the daemon's socket environment, as for `status`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|compact|clear|resume",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/frond-ear/src/cli.ts release --ear <ear> --hook",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

`--hook` reads the hook's JSON from stdin (`session_id`, `source`) and prints the result line, which
Claude Code adds to the session's context: `frond-ear: letters for ear <ear>: 2 delivered; sent as
2 channel events`. When the daemon answered, a second line follows, even with no letters: a
reminder that compaction gives no warning, and how to leave a letter. A session that's never told
forgets the tool exists. It always exits 0, so a daemon that's down never blocks a session start
(and then prints no reminder, since it couldn't take a letter). Keep `clear` and `resume` in
the matcher: they tell frond-ear which session holds the ear after a `/clear` or `/resume`
(Schedules and wakes, below). For letters, a resume only hands the session its own unsettled
letters again.

**Letters into the compaction summary** (#102). The release only hands letters back after the
compaction, as events. The summary that the next turn reasons from never saw them. Most
compactions on a quiet seat are idle compactions, about 55 minutes after the last request, with
nobody there to leave a letter just before. A `PreCompact` hook closes that gap.
`frond-ear precompact --ear <ear> --hook` prints the compacting session's own unsettled, unexpired
letters, newest first, as instructions for the summary. Claude Code uses a `PreCompact` hook's
exit-0 stdout that way, up to 10,000 characters; this stays under 9,500 and names any letter that
doesn't fit. The framing asks the summary to keep each letter's id, reason, text and `assumed`
under "Letters from before this compaction", as the session's own evidence, never permission.

- **It is read-only.** Nothing is marked delivered or settled, and the `SessionStart` release still
  hands the letters back afterwards.
- **It fails closed on the session, like a release.** The hook must name the session that holds
  the ear now, and only a CLI client may ask.
- **It blocks a compaction only for a hold the session set itself (#107).** Under `--hook` stdout
  carries the letters or nothing (an error there would land in the summary), every reason goes to
  stderr, and the exit code is 0. **Exactly one path exits 2:** `precompact --hook`, when an
  unexpired `hold_compaction` of this session blocks an `auto` trigger under the seat's ceiling
  (below). Every other frond-ear command a hook can run exits 0 under `--hook`, and 1 (never 2) on
  bad usage without it. The output never starts with `{`, so it can't be read as a JSON decision.

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto|manual",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/frond-ear/src/cli.ts precompact --ear <ear> --hook",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Holding off a compaction while you wait (#107).** A seat that goes quiet on purpose mid-task
(waiting on a CI run, a review or a Monitor) is exactly what an idle compaction catches, about 55
minutes after its last request. The `hold_compaction` tool lets the session say "not now":

- `hold_compaction {reason, ttl_seconds}` sets or replaces this session's hold (60 s to 6 h,
  default 2 h); `{release: true}` drops it. Only the session holding the ear can set or release
  one, and only its own.
- While it stands, the same `PreCompact` hook above (`precompact --ear <ear> --hook`) exits 2,
  with one line on stderr and nothing on stdout, when **all** of these hold: the trigger is
  `auto`; the hold is this session's and unexpired; the seat set `FROND_EAR_HOLD_CEILING` in the
  hook's environment; and the context, read from the main transcript at that moment, is under it.
  Otherwise the hook prints the letters as before.
- **The context is read fresh at PreCompact**: the latest main-session usage row (sidechain rows
  excluded), plus the bytes written after it at 3 bytes a token, so a big tool result that no usage
  row has counted yet pushes the reading up. That newest usage row must be valid: whole
  `input_tokens` and `output_tokens` ≥ 0, cache counters absent or the same, a total above 0.
  An invalid one is unknown; it never counts as zero, and the hook never falls back past it to an
  older row. A compaction marker newer than any usage row, a missing or unreadable transcript, or
  no usage at all is unknown too, and unknown allows.
- **`FROND_EAR_HOLD_CEILING` is required.** frond-ear can't know the model's window. Set it to about
  60% of it (600000 for a 1M window, 120000 for 200k), for example by prefixing the hook's
  command: `FROND_EAR_HOLD_CEILING=600000 node /path/to/frond-ear/src/cli.ts precompact --ear <ear> --hook`.
  Unset or unusable, a hold blocks nothing.
- **Everything else allows**: a manual `/compact`, another session, an expired hold, a down
  daemon, and stdin that is malformed, oversized or never ends. The hook does its work in a child
  process and kills it at 4 s (stdin 1 s, daemon 2.5 s inside), so even a read that blocks
  (a FIFO, a stalled filesystem) can't hold the compaction past the deadline. Only the child's
  own exit 2 blocks, and only its own exit 0 prints letters. Killed, crashed or too much output:
  nothing on stdout, exit 0. If the hook itself is stopped (SIGTERM, SIGINT, SIGHUP: a hook
  timeout, a cancel) or exits any other way, it kills its worker first; only an uncatchable
  SIGKILL of the hook can leave a blocked worker behind.
- **A hold ends** at its expiry, on `release`, when another session takes the ear (an in-place
  session change too; coming back doesn't bring it back), on a daemon restart, and after any
  compaction. A pressure report (needs `--ear`) whose compaction marker is newer than the hold
  ends it: the `PostCompact` marker-only reading, or, if that one was missed, the next reading
  with usage, which carries the marker's own time. A marker from before the hold never ends it,
  however late its report arrives. The marker's time is the transcript's, so this assumes the
  daemon and the seat share a clock (the same host, or synced). A hold that ended
  without a release owes the session one line, on its next `PostToolUse` or `UserPromptSubmit`
  pressure hook (needs `--ear`), since the tool's result still says "held".
- `ear_status` shows `hold: {reason, setAt, expiresAt, blocksAnswered}` (null for none).
  `blocksAnswered` counts block answers given to the hook, not compactions Claude Code skipped.
  `expiresAt` is the lease's end, not a promise that nothing compacts before it. `pressure`'s
  `idleCompactDueAt` stays the raw forecast. The daemon logs `compaction.hold_set`,
  `compaction.held` (session, size, ceiling, setAt, expiresAt, count), `compaction.hold_passed`
  and `compaction.hold_ended`.

**The limitation, stated plainly.** Claude Code's hooks reference (read 2026-11-18, Claude Code
2.1.316) says a blocked proactive compaction is skipped and the conversation continues, but
blocking the compaction that recovers from a context-limit error makes that error surface and the
**request fails**. The hook's input says only `auto` or `manual`, so frond-ear cannot tell the two
apart. The ceiling and the pending-bytes reading keep a hold far from the limit, but they are not
proof. Until a seat's own trial shows what happens, treat a hold as an opt-in experiment, and keep
it short. It costs tokens too: idle compaction exists because the one-hour cache has expired, so
the next turn after a blocked one re-reads the whole context uncached.

### Schedules and wakes: what the daemon keeps for a session (#111)

A `CronCreate` job lives in the Claude Code process. It is gone after a crash, after `/clear`, and
after Claude Code's 7 days for a recurring job; a Monitor that waits on a PR dies the same way. The
daemon outlives all of that, so it holds these instead. A **wake** is a notification, never a
command: its `kind="wake"` event carries the setter's own note, quoted, frond-ear's facts, and any
external text quoted and labelled as untrusted evidence.

**`schedule`** takes `at` (ISO 8601 with its zone, or epoch ms), `every` (seconds, or `"90m"`,
`"2h"`, `"1d"`; at least 5 minutes), or both (`at` is then the first due time); a `note` (≤ 2000
bytes); and `ttl_days` (1 to 30, default 30). Over a limit it refuses, never trims.

- **Fixed cadence.** `every` comes due at first due time + k × period. Delivery and ack never shift
  it. A wall clock that jumps back fires nothing twice; one that jumps forward is coalesced.
- **One transaction per due step.** frond-ear writes the occurrence (a stable id and a generation)
  and advances or retires the schedule in the same SQLite transaction. A crash before it commits
  loses nothing: the due time is still stored, and the restart fires it. A crash after it commits
  replays that same occurrence, never a second one.
- **Coalesced.** An occurrence takes in further due ticks only until it is first pushed. After that
  it is frozen, and the next tick opens a new generation. Each push sends **one event per
  schedule**, carrying every occurrence still owed under one nonce, with `ticks`, `missed`,
  `first_due`, `latest_due` and `late_ms` in its meta.
- **Owed until acked.** `ack` with the event's `nonce` settles exactly the occurrences that event
  showed. A later generation stays owed, and an old nonce never settles it. Only the session the
  push went to can settle it; anyone else is refused and nothing settles. A push is not an ack. An
  owed wake is pushed again on every attach, and while its setter holds the ear: 1 h after its
  first push, then twice as long each time, up to a day.
- **Cancel and expiry stop future wakes only.** `schedules` with `cancel: id` (only its setter can)
  stops further ticks. A wake already owed stays owed until acked. At its ttl a schedule writes one
  last owed wake saying it expired and will not fire again; nothing goes silent, as the 11-18 sweep
  did. An owed wake nobody settles is dropped 30 days after it was written, and counted in
  `ear_status` (`schedules.droppedUnacked`).
- **Limits.** 16 active schedules or watches per session, 32 per ear, a 5-minute minimum period,
  30 days ttl. A setter that has not held the ear for 7 days has its schedules **retired as
  orphaned**: no more ticks, what they already owe stays owed. `ear_status` counts active schedules
  whose setter isn't the holder (`schedules.orphaned`) and those retired (`retiredOrphaned`).

**Whose wake it is, across `/clear`.** The policy is **metadata only**. A wake belongs to the
session that set it and never moves. Another session holding the ear later is told, in a
`kind="wake_note"` event, which schedules of which short session id are held. It sees them in
`schedules` as ids, kinds, states, times and owed counts, never a note or a target. It cannot read
them, settle them or cancel them. When the setter holds the ear again (A → B → A), its wakes come
back.

Claude Code keeps its MCP servers across `/clear` and `/resume` (2.1.316). The shim keeps running
under the `CLAUDE_CODE_SESSION_ID` it started with, while the conversation gets a new id. Without
help, frond-ear would take the new session for the old one. So:

- The shim sends its ancestor pids in `hello`. Claude Code gives its hooks `CLAUDE_PID`, and
  `frond-ear release --hook` sends it. A `SessionStart` hook that names another session, whose
  `CLAUDE_PID` is one of the holding shim's ancestors, moves the holder to that session id. That is
  the `/clear` (or `/resume`) inside that process. Its wakes stay its setter's.
- A hook frond-ear can't tie to the shim (an older shim, a hook with no `CLAUDE_PID`, or a non-Linux
  host behind a wrapper) puts that shim's wake identity **in doubt**, and it fails closed. Nothing is
  shown, settled, set or cancelled through it until it re-attaches or its own session's hook runs
  again. `ear_status` shows `schedules.holderIdentity: "in-doubt"`. A hook from another Claude
  process, provably not the shim's, changes nothing.
- The release hook's matcher **must** include `clear` and `resume`:
  `"matcher": "startup|compact|clear|resume"`, as above. `resume` also hands the resumed session
  its own unsettled letters again, which is harmless. The shim must be launched by Claude Code
  itself, or through wrappers at most 6 levels deep: frond-ear reads the chain from `/proc`.
- The turn, or the doubt, is kept in the store, keyed by the id the shim said hello with. A
  reconnect or a daemon restart leaves the shim naming its spawn-time id again, and frond-ear still
  takes it for the session it turned to, while the turn's Claude process is among the shim's
  ancestors. A doubt still stands after a reconnect. A new Claude process with that id is that
  session again.
- The backstop: the pressure hook (`frond-ear pressure --hook --ear`) also sends `CLAUDE_PID`. A
  report naming another session than the holder's turns the holder when the pid ties it to the
  shim, and puts its wakes in doubt when it can't. So a `/resume` the release matcher missed fails
  closed on the session's next tool call, if the seat runs the pressure hook.

**`wake_on`** (GitHub; **off** unless `github.enabled`): `{source: "github", repo, target: "pr" |
"issue" | "run", number, on, note, ttl_days}`. The target says what `number` names.

| target  | on                              | binds, and fires when                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr`    | `review`, `comment`             | Reviews or comments there at registration are the baseline. Fires on the first one after it (a pending review doesn't count). A review is not an approval: its state is shown as GitHub gives it.                                                                                                                                                                                                                                                           |
| `pr`    | `merged`                        | Fires when merged, or when closed without merging. Already so at registration: fires at once.                                                                                                                                                                                                                                                                                                                                                               |
| `pr`    | `ci_done` (optional `head_sha`) | Binds the PR's current head (`head_sha` must be it). Fires when that commit has check runs or commit statuses, every run completed and every status read (all pages) with none pending and the combined state not pending, read the same on two polls in a row (so a second wave of checks holds it open). If the head moves first, it fires saying so, and that is not a CI result. Checks on any other commit never fire it. "No checks yet" is not done. |
| `issue` | `comment`                       | As for a PR. A number that names a PR is refused.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `run`   | `ci_done` (optional `attempt`)  | Binds one attempt (default: the current one). A rerun is another attempt; an earlier attempt's result never fires it. Already complete at registration: fires at once.                                                                                                                                                                                                                                                                                      |

The wake carries the canonical URL, the exact head, run, attempt and review or comment ids, when it
was observed, and the conclusions: completed is not success. Review and comment bodies and check
names are external text, quoted under a label that says so (at most 600 characters each).

- **Polling.** Every `github.pollSeconds` (default 120, at least 60), with `If-None-Match`, and never
  faster than GitHub's `x-poll-interval`. Cursors, ETags and baselines are stored, so after a
  restart nothing old is found again.
  - A comment watch's baseline is the highest comment id at registration, read from page 1 and
    the last page, whatever the list's length. Its polls list comments updated since just before registration and count only higher ids, reading page 1 and then the list's tail (the last page, walking back while it is all new), so baseline comments that still match can't hide one. Deletions or edits can't hide a new one.
  - A review watch keeps the set of submitted reviews it has seen. Every poll walks the list from
    page 1, each page asked with its ETag. A review begun before the watch and submitted after it
    fires. A PR with more than 1,000 reviews is refused.
  - One poll runs at a time across the daemon.
- **Two budgets.** GitHub doesn't count a correctly authenticated 304 against its primary rate
  limit. frond-ear counts **every** attempt anyway, 304s and failures included, against the ear's
  own `github.maxRequestsPerHour` (default 120). A spent budget defers polls to the next hour,
  failing nothing. A 429, or a 403 that is a rate limit, backs every watch off for its
  `Retry-After` (or until `x-ratelimit-reset`). That backoff is stored, so a restart still waits.
  `ear_status` shows `schedules.github.requestsThisHour` and `backoffUntil`.
- **Failing visibly.** A 401, 403, 404, 410 or 422, or a redirect, retires the watch with one owed
  wake that says why, written in the same transaction. frond-ear never follows a redirect, so the
  token never leaves `github.apiBase`. Network errors and 5xx back off (2^n × the poll period, at
  most an hour), and after 8 in a row, or 24 hours of failing, the watch ends the same way.
- **Credentials.** `FROND_EAR_GITHUB_TOKEN_FILE`: a file readable by its owner only (mode 0600;
  the daemon refuses anything looser). Use a fine-grained, **read-only** token scoped to the repos
  you list. Unset, watches read unauthenticated (public repos, a low limit). The token stays in the
  daemon. It is never logged, never in status (`github.token` says only whether one is set), and
  never passed to a shim. frond-ear only issues GET requests.
- **Allowed repos per ear.** `github.repos.<ear>` lists the `owner/name` repos its sessions may
  watch, so a session can't borrow the token's wider visibility by asking. A watch's target is shown
  only to its setter.

```json
"github": {
  "enabled": true,
  "pollSeconds": 120,
  "maxRequestsPerHour": 120,
  "repos": { "my-ear": ["karmaterminal/frond-ear"] }
}
```

`ear_status` under `schedules` shows `active`, `byKind`, `nextDueAt`, `owed`, `owedToHolder`,
`lastDeliveredAt`, `lastAckedAt`, `orphaned`, `retiredOrphaned`, `droppedUnacked`,
`holderIdentity`, `github` and `caps`. These are counts and times for seat-pulse, never a note or a
target. The daemon logs `wake.schedule_set`, `wake.delivered`, `wake.settled`,
`wake.schedule_ended`, `wake.schedule_orphaned`, `wake.watch_set`, `wake.github_polled`,
`wake.watch_fired`, `wake.watch_failed`, `wake.github_backoff` and `ear.wake_identity_doubt`, none
of them with a note, a target's text or the token.

### Context pressure (Claude Code)

A compaction lands with no warning, and Claude Code shows its context gauge (`/context`) only to
whoever is at the keyboard. `frond-ear pressure --hook` reads the session's own transcript (every
hook gets `transcript_path`), takes the latest assistant turn's token usage, and adds one line to
the session's context when it crosses into a new band: the size, and a nudge to leave a letter.
Bands are absolute (default 150k, 200k, 300k, 450k, 650k; `--bands` to change them): one long
session was auto-compacted anywhere from 200k to 970k tokens, so there is no fixed point to take a
share of. Once per band; a compaction starts them again (a new `compact_boundary` row in the transcript, or a drop to under half). Per-session state
is in `$XDG_STATE_HOME/frond-ear/pressure/`. It needs no daemon and always exits 0.

**Seen from outside (`--ear`, #98).** With `--ear <name>` (or `FROND_EAR_EAR`), every hook run that
reads a size or a new compaction marker also hands it to the daemon, and `ear_status` (and
`frond-ear status`) shows it on that ear:

- `pressure: { tokens, band, boundary, at, ageMs, receivedAt, idleCompactDueAt }`.
- `at` is when the evidence was written (the transcript row's `timestamp`), not when a hook ran, and
  `ageMs` counts from it; `receivedAt` is when the daemon took the report. A hook re-reading the same
  row never makes it look fresh. Rows with `isSidechain: true` (a subagent's turns) never count.
- `band` is the highest band reached (null under the first). `boundary` is the latest compaction
  marker the hook read. After a compaction with no turn since (a `PostCompact` hook), `tokens`, `band`
  and `idleCompactDueAt` are `null` and `boundary` is the new marker, so the old size isn't shown.
- `idleCompactDueAt` is a **forecast**, not a fact: `at` + 54 min when `tokens` is at or over the
  seat's idle-compaction floor (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, which the hook passes along,
  default 200k), else `null`. Claude Code compacts an idle interactive session on the one-hour cache;
  in the gloss's transcript 76 of 90 compactions landed 54–56 min after the last response. Any
  request before then moves it.

`Stop` reports the turn's final usage (no tool call follows it), even when `stop_hook_active`
suppresses a second nudge. The send is best effort within 1 s: no daemon, a refusal or a timeout
changes nothing the hook prints and never its exit code. The daemon keeps only the latest reading per
ear, in memory, and only from the session holding the ear, with `at` no more than 10 min ahead or 7
days behind its clock. Hook runs connect separately, so a report can arrive after a newer one; the
daemon never lets older evidence (an earlier `at`) replace newer, and a report with the same `at`
replaces the kept one only when it says the same thing. It is `null` until that session's hook reports, and cleared when another
session attaches or the attached shim names another session. It is never an event and never
reaches taps. Context doesn't grow while a seat is idle, and no hook runs then, so an idle seat shows
an aging reading (`ageMs`), not a fresh one. Without an ear nothing is sent. The cost to look for on a
slow seat: `PostToolUse` fires on every tool call, so a daemon that accepts the connection but never
answers adds up to 1 s to each call (a down daemon refuses at once and costs nothing). Check
`frond-ear status` answers promptly, or drop `--ear` until it does. Add `PostCompact` beside the
other three hooks so a compaction shows at once; it only reports and prints nothing.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/abs/node /abs/frond-ear/src/cli.ts pressure --hook --ear <seat>",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/abs/node /abs/frond-ear/src/cli.ts pressure --hook --ear <seat>",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/abs/node /abs/frond-ear/src/cli.ts pressure --hook --ear <seat>",
            "timeout": 5
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/abs/node /abs/frond-ear/src/cli.ts pressure --hook --ear <seat>",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**At the end of a turn (Stop).** Most compactions land idle: in the gloss's sessions, about 55
minutes after the last request once the context is large. So the turn that ends a stretch is the
last chance to leave a letter, and no prompt or tool call follows it to carry a line. On Stop,
from the second band up (200k by default), it prints Claude Code's `{"decision":"block","reason":…}`
once per band, so the turn takes one more step: leave a letter if threads changed, otherwise stop.
It is silent when `stop_hook_active` is set (the turn is already continuing because of a Stop
hook), so a turn is never held open. It keeps its own Stop band, which resets with the others on a
compaction, and never takes the line a prompt or tool call still owes. It still exits 0, never 2.

`frond-ear pressure --transcript <path>` prints the same reading for a person.

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

   | Field                                                       | What it says                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
   | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `receiveHealth`, `reasons`                                  | Now, not since: the `hello` at the head of every connection clears them, so a host daemon crash the ear has already reconnected past leaves nothing here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
   | `lastFailure`                                               | What does stay: `{reason, at, run}`, the first failure of the latest connection that failed (a `fatal`'s reason, not the close that follows it), when (ms since the epoch), and the run the ear held. `null` until something fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
   | `joinSnapshot`, `joinSnapshotFrames`, `joinSnapshotOmitted` | This connection's join snapshot: its state, then, once applied, how many frames it brought and (if truncated) how many entries it left out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
   | `run`                                                       | The last run the ear read: through a reconnect's backoff it still names the run that ended. A new one means the host daemon restarted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
   | `counts`                                                    | Since frond-ear started, across every run and connection; only a frond-ear restart zeroes them. Each health reason counts every time it is raised: `exit_without_bye` once per connection the host daemon closed without `bye` (one that carried nothing counts nothing), `run_restarted_without_bye` once per run that began after one ended without `bye`, `joined_late` once per connection. `exit_without_bye` rising with `run_restarted_without_bye` is a host daemon restart; rising with `records_lost` instead, only the connection dropped. A connection the ear drops itself, over a bootstrap or join snapshot it can't read, counts as `malformed_bootstrap` or `malformed_snapshot`, never as `exit_without_bye`. A `fatal` counts as `fatal`, and `snapshot_frames` adds up every `joinSnapshotFrames`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
   | `liveSet`                                                   | The record v1 live set, at most 4,096 records: `size`, `max`, what each share holds (`shares`: each tuned `station:stream` is a share of its own, and every untuned stream shares `untuned`), and what each dropped (`omitted`: `count`, those that would still be on air; `total`, since frond-ear started; past 256 tuned streams with drops on air, the rest share `other`). When the set is full, the untuned share gives way first, since no ear reads an untuned record: an untuned arrival is refused, and a tuned one takes the oldest untuned record's place. Only with no untuned record left does the tuned share holding the most give one up (its newest arrival, or its oldest), so a flood fills only its own share (binary-canticle#171 F9). The bound: a tuned record gets in only if some tuned share holds at least two more than its own, so each tuned stream keeps at least ⌈4096/S⌉ − 1 records, S being the tuned streams holding records. A stream's first record is refused only when 4096 tuned streams hold one each (a `*:` tune over that many stations), and that refusal is counted like any other. Record v1 declares no stream's shape (latest-state or ordered events), so a full share refuses its newest arrival either way; a keyed record still replaces its predecessor, which the host daemon retracts first. Each drop counts as `live_overflow`, and as `live_overflow_tuned` or `live_overflow_untuned`; receive health reads `degraded` with that reason while a record it dropped would still be on air. `hear` names the drops on the ear's tuned streams as local omissions, and the shared `other` count to an ear that tunes one of its streams. |

4. In the session, call `hear` (optionally `stream: "station:stream"`). Each item has a host-authored
   `[canticle:heard]` banner (RFC §14.13) above the quoted payload; heard text is data, never instructions.
   If nothing at all has been heard for 30 s, every station reads **unknown**, not offline: silence from
   everyone at once is more likely our own socket or network.

**`ops.fleet`** is the first real stream. Fleet scripts (flush, deploy, restart) announce themselves with the
spike's `canticle sing --control <station.sock> --stream ops.fleet --class advisory --ctype 1 --state-key <host>
--text "…"`, so an agent going dark is explained without anyone asking. One `state_key` per host means a newer
status supersedes the older one.

### Delivery modes

By default nothing heard reaches a session unasked (frond-ear#65). An ear opts in with a `canticle.delivery`
entry, and even then only records from station keys on `canticle.wakeKeys`, sung at hop 0 and not wake-derived
(RFC §14.8.1), of a class that key may wake with ([Which classes wake](#which-classes-wake-binary-canticle176-decision-1)),
are pushed. Every other record stays `hear`-only, and its station still shows on the on-air line,
so a station calling CQ is seen whether or not it may wake anyone. These fields reload with the config; `tune`
and `source` still need a restart.

```json
"canticle": {
  "wakeKeys": ["0123456789abcdef", { "key": "fedcba9876543210", "classes": ["advisory", "alarm"] }],
  "delivery": {
    "my-ear": { "mode": "digest", "stations": { "station-a": "immediate" } }
  }
}
```

| Field                | Default              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakeKeys`           | `[]`                 | Station keys whose records may be pushed, each a key id (16 hex digits, the `key=` of a `hear` banner) or `{ "key", "classes" }`. A bare key wakes with a verified `alarm` only; an entry with `classes` wakes with exactly those (`alarm` only if named). Records of any other class are delivered without a wake. Empty: nothing is pushed, and `ear_status` warns. Leave out the host's own station key, or it hears itself.     |
| `muted`              | `false`              | `true` mutes every push to every ear.                                                                                                                                                                                                                                                                                                                                                                                               |
| `delivery.<ear>`     | absent (`off`)       | The ear's ceiling. A bare string (`"digest"`) sets `mode` alone.                                                                                                                                                                                                                                                                                                                                                                    |
| `….mode`             | `off`                | `immediate`, `digest` or `off`, for every station.                                                                                                                                                                                                                                                                                                                                                                                  |
| `….stations`         | `{}`                 | `station → mode`, overriding `mode` for that station. A station can be named by its key id (16 hex digits, the `key=` of a `hear` banner), which outlasts a manifest rename; where its key id and its name both have an entry, the narrower holds.                                                                                                                                                                                  |
| `….windowMs`         | `60000`              | `digest`: at most one report per window, 5 s to 1 h. The window opens when a record starts waiting.                                                                                                                                                                                                                                                                                                                                 |
| `….debounceMs`       | `5000`               | `immediate`: a burst is coalesced over this long, 5 s (RFC §14.10) to 1 min, and less than `maxAgeMs`.                                                                                                                                                                                                                                                                                                                              |
| `….maxAgeMs`         | `30000`              | `immediate` pushes only a record heard at most this long ago and at most this old when first heard (RFC §14.10 item 9). Any other goes into the next report instead, marked late. 10 s to 2 min (item 9's 120 s).                                                                                                                                                                                                                   |
| `….style`            | `records`            | `digest`: `records` (each record behind its banner) or `counts` (per stream: how many, seqs skipped, repeats caught; no payloads).                                                                                                                                                                                                                                                                                                  |
| `….maxItems`         | `5`                  | Records per push, 1 to 10 (RFC §14.6.5's dose is 5). The rest wait for the next push.                                                                                                                                                                                                                                                                                                                                               |
| `….bufferPerStream`  | `32`                 | Records waiting per `station:stream`, 1 to 256. When it is full the oldest is dropped, and the next push says so.                                                                                                                                                                                                                                                                                                                   |
| `….maxPushesPerHour` | `60` or more         | Pushes to the ear per hour, from `immediate` and reports together, 1 to 360: 60 by default, or one per window when `windowMs` is under a minute, so a busy band's reports fit the hour. `ear_status` warns when it is less than one per window. Past it, records wait. The count survives a restart.                                                                                                                                |
| `derivedPublication` | `false`              | Whether derived publication may open at all ([Derived publication](#derived-publication-binary-canticle161-item-4)). Off: no station call, `derivedQuery` and the capability probe included.                                                                                                                                                                                                                                        |
| `roomPolicy`         | `observe`            | What the egress gate does at every room output ([Room output](#room-output-and-source-use-frond-ear-scope)): `observe` records and refuses nothing; `strict-fresh` refuses unless the speaker's canticle history is complete. It is a freshness-of-attention gate, not an output-content check; no seat should select it until the frond's source-use rule is settled. Anything else fails config load. It reloads with the config. |
| `exposure`           | `{"enabled": false}` | The exposure ledger ([Exposure ledger](#exposure-ledger-frond-ear117)): `enabled` (default `false`; off, no rows are written, though its empty table and index are in the schema), `maxAgeMs` (default 7 days) and `maxRecords` (per ear, default 10000) bound the offered and echoed records it keeps.                                                                                                                             |

### Which classes wake (binary-canticle#176 decision 1)

`wakeKeys` is a class list per key, not a trust list. **A bare key means alarm only**: of that station's records,
only a verified `alarm` may wake the session, and only where the manifest grants the key `alarm`. An entry
`{ "key": "…", "classes": ["advisory", "alarm"] }` names the classes that may wake from that key, and only those;
`alarm` too only if it is named. A class name frond-ear doesn't know fails config load. The list is necessary,
never sufficient: a record still needs its key on `wakeKeys`, hop 0, `wake_derived` false (unknown means no wake),
a delivery mode that pushes, no mute, the push budget, the breaker and the rest of the holds. Where frond-ear runs
its own listener it also checks the manifest's grant itself: a record whose key isn't granted its class is passed
over as `not_capable`. (The listener refuses such a record before delivery sees it, and over the host socket the
host admits as `verified` only a class the key is granted, so this is a second check, not the first.)

**Migration.** Until this change any class from a listed key could wake the session. Now an existing bare-key
config is alarm-only: an `ambient`, `advisory` or `chatter` record from a key that used to wake you no longer
does. To keep a class waking, name it, alarm included if you want it:
`{ "key": "0123456789abcdef", "classes": ["advisory", "alarm"] }`. `ear_status` counts what the change withholds,
so check `counts` for `wake_withheld:<class>` after you upgrade.

**Seats that wake on any class today (the scribes).** Once this lands, `ambient`, `advisory`, `chatter` and every
other non-alarm item from your bare `wakeKeys` arrives silently: `hear` still reads it, `ear_status` counts it
`wake_withheld:<class>`, and the next push names it, but it no longer starts a turn. To be woken by it again, name
the class on the key in config (`{ "key": "…", "classes": ["ambient", "advisory", "alarm"] }`, which lasts), or
have the session opt in for a while with `wake_grant` on one `station:stream` (below), which lapses.

**What happens to the rest.** A record from a listed key whose class may not wake is delivered without a wake. Its
custody is what any record that isn't pushed has: `hear` reads it while it is live, and nothing else changes.
`ear_status` counts it as `wake_withheld:<class>` (an unregistered class counts as `wake_withheld:unknown`), and
the next push that goes names it in its coverage note as a local omission, per stream:
`- bellwether:town.square: 3 delivered without a wake: its class may not wake this ear from this station (…) (wake_withheld:ambient; heard … to …).`
That note never asks for a push of its own, which would be the very wake it was kept from; it rides with the next
push that goes anyway, and `hear` says it waits. The decision is made when a record is first heard, as a mute's
is: the record is settled, so no later reload, restart or grant pushes it. `wake_withheld` is an attention
decision, never a receipt: it says nothing about whether the session or the prince saw the record, and no custody
row is written for it.

What the live set drops of such a class wakes nobody either. A `live_overflow` note owes a push of its own only
when a record it drops would pass the wake gate on the config alone: the manifest grants its key the class, where
the source can say, and the key's config entry lets that class wake. The same holds for a note about a record held
until it went off air. It is the gate's own predicate, so the two can't drift; a grant never makes a note owed. Drops of other classes, and drops known
only by count, ride with the next push that goes. So an ambient flood can't wake the session through its own
overflow.

**The prince's opt-in: `wake_grant`.** A session can choose, for a while, to be woken by more classes on one
`station:stream`, say `ambient` from a town it is visiting:
`wake_grant { "stream": "bellwether:town.square", "classes": ["ambient"], "ttl_seconds": 3600 }`.

- It is the session's own act, made through the tool, never something a station sends. Nothing in a record (a
  field, a flag, a `silent-wake` mode, the text) can make, extend or widen one, and none is ever inferred from a
  record's class.
- `ttl_seconds` is required, 1 s to 24 h, and the grant lapses at its expiry (`counts.wake_grant_lapsed`).
- A request is all or nothing. Every class it names, the mark it moves and its counter are written in one store
  transaction, so a `wake_grant` that returns an error has granted no class and left every existing grant as it
  was (no later expiry), except one its check before the request discards as unprovable (below): that discard
  stands. A `wake_grant` that changed grants returns success.
- It holds only for the session that made it, so a session whose shim gave no id can't make one. It is discarded
  (`counts.wake_grant_discarded`, a warning in the log) when frond-ear can't prove it still holds:
  - another session takes the ear (a rebind): discarded at that attach, in the same transaction that records it,
    before any delivery poll, so a grant never crosses another holder's hold even when the ear comes back to its
    maker. A shim that gave no session id counts as another holder, and so does the attached shim turning to
    another session (its `session` message or a SessionStart hook);
  - the session holding the ear falls in doubt: a hook names a session frond-ear can't tie to the shim, so its
    wakes are held. Every grant on the ear goes as the doubt is recorded, and `wake_grant` refuses a new one
    (`revoke` still works) until the session's own hook ends the doubt, so no grant crosses into or out of it;
  - the clock stepped back: it reads earlier than the moment the grant was made, or than the latest moment
    frond-ear found it holding (it keeps that mark per grant, in the store). Mid-run or across a restart, a
    clock that went backwards leaves how long the grant has run unknown, so every grant it holds is discarded
    rather than left to expire on that clock. A new `wake_grant` afterwards starts a fresh one. Two honest
    limits: the mark moves once a poll (`POLL_MS`, 1 s), so a step back smaller than the time since the last poll
    isn't seen and a grant can overrun its TTL by up to one poll; and if the daemon was down longer than the clock
    went back, the clock still reads past the mark on restart, so no wall-clock mark can see that step and the
    grant survives it, overrunning by as much as the clock went back, which is less than the time it was down;
  - its row claims more than 24 h;
  - its class isn't registered.
- The same session reattaching keeps its grant: a compaction, a resume, a new shim, or a daemon restart that the
  same session id comes back to (A then A, with no other holder between). Across a restart that holds only while
  all of the above still does (the clock reads no earlier than its mark). With no session on the ear nothing is
  pushed anyway, so it waits for its session.
- It never opens a station whose key isn't on `wakeKeys`, and every other gate above still applies.
- What only a grant let wake never owes a push of its own once it goes unpushed: what is left of it rides with a
  push that goes, so nothing wakes the session after the grant lapses.
- `revoke: true` removes the session's grants on a stream, or all of them with `stream` omitted.
- `ear_status` lists the grants that hold as `canticleDelivery.wakeGrants`
  (`[{ "stream", "classes", "expiresAt" }]`).

This is a deliberate amendment to RFC-0001 D1, §14.10 and §14.18's alarm-only target. A bare key matches that
target. The non-alarm path (a config entry's extra classes, or a grant) is the seat owner's or the prince's own
choice, held behind its own gates and wake budget. It is not something the current binding already guarantees.

One edge stays open. A coverage note owed a push of its own before a reload narrowed its key's classes can still
take that push once. It carries no records, and its key must still be on `wakeKeys`.

**What the session gets.** Channel events with `kind="canticle"` and `delivery="immediate"` (the new records of
the last few seconds) or `delivery="report"` (a "what's on the radio" report, `report=<n>`). Each push is a batch
of its own, outside the Discord ledger: it carries a `batch_id`, with the delivery token as a Discord batch's does,
and touches no Discord event. Passing that `batch_id`, whole, to `ack` on its own is how the session says it heard
the push ([Custody](#custody-and-confirmation-binary-canticle161)). Each record carries the `[canticle:heard]` banner `hear` shows,
with `mode=silent-wake`, and its payload quoted inside an `EXTERNAL_UNTRUSTED_CONTENT` wrapper. A report gives
the on-air line, then each `station:stream` in order with its records in seq order, under a line that counts them
and says what it skipped since the last report (seqs lost on air, plucked or `hear`-only), what came out of
order, how many are late, what went off air before a push could carry it, and what a full buffer dropped. A
report a cap cut short says how many records wait, and the next one starts after the last stream it covered
(`continues after …`), so a busy stream can't starve the rest. The cursor survives restarts.

**Coverage notes.** When frond-ear itself withheld records since the last push (local omissions, binary-canticle#168
§2.7a), the push ends with a `local omissions` note: per stream and reason, how many and the span of times.
`push_budget`, `paused`, `no_session`, `breaker_open` and `breaker_half_open` name the hold a record went off air
under; `expired_waiting` is one that went off air waiting for its push (say, sent on to a report due after its
expiry); `live_overflow` is what the live set dropped that this ear would have pushed (an allowlisted key, sung at
hop 0, not wake-derived); `wake_withheld:<class>` is a record its class kept from waking the ear
([Which classes wake](#which-classes-wake-binary-canticle176-decision-1)), which never asks for a push of its own. Each record is told once. A drop isn't told if the record is back on view, if this ear
pushed it or passed it over, or if a push already said it won't come (dropped from the ear's own full buffer, or
told as an earlier drop, say of a copy that came back and was refused again). One the ear was waiting to push stops
waiting and is told as `live_overflow`, and so is a pushed record the live set dropped while its push was
unconfirmed, once that push is given back. What a push said won't come is remembered in memory only, so after a
frond-ear restart a copy refused again is told again. A record told as dropped that comes back on air later (a
resurfaced copy, a join snapshot) is pushed all the same: the note was true when written. A config reload reads what
is on air again, as it always has, so a record dropped from the buffer before it can be told again, or pushed late.
What the live set dropped past the 256 tuned streams it counts one by one is a single `other tuned streams` line: no
station is known, so it says whether this ear would have pushed them is unknown. It only rides with a push that goes
anyway, and not at all while nothing could be pushed (no `wakeKeys`, or a mute over every station). A record that
left the view first (plucked, superseded, the link went) isn't frond-ear's doing, and is only counted, as before.
A note shows five lines one by one (a stream and reason each, or a stream each in the footer) and counts the rest,
records included: `(251 more local omissions, 266 records; …)` for local omissions,
`(3 more streams missed 7 records too.)` for the rest. It keeps up to 256 streams by name. Past them, a stream's
notes are counted together, until the note is told: local omissions in one
`- and N more across M streams past the 256 it names one by one: …` line, by reason, and what went off air unpushed
or a full buffer dropped in one `and M more streams past the 256 …` line. Every record is accounted for. A note
pushes on its own only while its station could be pushed now: its key on `wakeKeys`, a mode that pushes, no mute, as
the config and the session's choices stand now, not when it was owed. That holds for a stream counted together too:
the count keeps each stream's station, for 256 more streams, and a stream owed a push takes that place from one owed
nothing, which never wakes. One that a reload or a restart left outside that waits, still owed, rides with the next
push that goes, and `hear` says it waits (`the next push reports 1 it withheld (local omissions); nothing pushes it
on its own now, …`; off-air and dropped records are named the same way). Neither the `other tuned streams` line nor
what the count holds past those 256 more streams asks for a push of its own: no station is known to meet the
boundary. What hasn't been told yet survives a restart (`canticle.withheld.<ear>` in the store), and a note in a push
the host never confirmed is told again once that push is given back. Of the notes several unconfirmed pushes give back
together (a disconnect, a new attach, frond-ear stopping, or the first attach after a crash), a stream keeps the station
key of the newest push's, named or counted together, whatever order they come back in, and a note since keeps its own.
Past the 256, a stream counted together and owed nothing can lose its place to one owed a push while the notes merge. If
it gets a place back, it starts again from the key it had before any came back; with none, its notes wait for a push that
goes anyway.

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
or by key id to outlast a rename) or (without `station`) all of them, optionally for `ttl_seconds`; `configured`
clears the choice, and `style` picks the report's form. The config is the ceiling, so the session can only narrow
it. A station's own choice beats the one for every station, as a chat's own `set_attention` choice beats `*`:
with every station at `digest` and one at `immediate`, that one goes `immediate`. Each scope holds one choice, as
with `set_attention`: a new one replaces it, and when its `ttl_seconds` lapses the config applies again, style
included. A mute at any scope wins: the session's, an ear-wide `set_attention` silence, or `canticle.muted`. It
is for good: a record first heard under a mute is never pushed, even after the mute lifts, and both tools say so.
`hear` still reads it while it is live.

**Exactly once.** A record is told apart by its identity, never its text: RFC §7.4's tuple of key id, epoch,
stream and seq, which record v1's `idem` spells out (the stream by name, one to one with its id, §5.4). The same
words under a new seq are new speech, and a retransmission is not. A pushed record keeps a tombstone in the store
until its local expiry plus 5 s (RFC §14.18.5), so no retransmission, `resurfaced` record, join snapshot or
frond-ear restart pushes it twice, and digest and immediate never both push it. The tombstone is a dedupe claim,
not delivery: it is written with the push's batch before the push goes out. A push that no session's connection takes
gives its claim back, and its records wait for the next. So does a push the host never confirmed (no `offered` from the
shim), once frond-ear reverts it: when the session's connection goes, when another shim attaches, when frond-ear stops,
or, after a crash, at the next attach. Its records then go out once more while they are on air, as a Discord batch's
events are queued again, and a refresh that collapsed into one of them goes back with it: it stays collapsed if its
record goes out again, and is news if that record is off air. What was offered is never pushed again. The price is a rare duplicate: a shim that wrote the event
and died before it said so. A record heard again with a later
local expiry (a restarted receptor's new δ̂, §14.6.3) keeps its tombstone until then. Once a tombstone has
lapsed, though, a receptor that hears the record again as new (after a restart, with a later local expiry) can
have it pushed once more, still within §14.18.5's bound; it is marked late if it is older than `maxAgeMs` by
then. A refresh re-issue with the same body as a pushed record is not pushed (§7.9), and one of a record still waiting to
be pushed is held back until it is: then it collapses, and if the record goes unpushed it is news. A record first heard under a
mute is never pushed, even after the mute lifts or frond-ear restarts. A config reload re-reads what is on air,
as a restart does, and a key taken off `wakeKeys` holds back what it had waiting.

**Holds.** Nothing is pushed while the daemon is paused, the ear has no session, the host daemon's breaker is
open or half-open (§14.18.4), or the hour's pushes are spent: records wait while they are on air. In `immediate`,
one that waits past `maxAgeMs` goes into the next report instead, marked late. A record that goes off air or is
plucked first is never pushed, and the next push counts it, with its reason when frond-ear withheld it. After a
dropped link the join snapshot brings back what is on air: what was pushed stays pushed, and a record sung
meanwhile goes out once. A push that says `(N more records wait for the next push.)` keeps its word: the next push
carries them or says they went off air, and a push that spends the hour's last says until when the budget holds
them. If they go off air with nothing else left waiting, or what the budget held goes off air, a push of the
coverage note alone goes out (a canticle push with no records; naming its `batch_id` echoes nothing), on the
stations' cadence and inside every hold and the budget, never as an extra push or another wake (binary-canticle#171
findings 3 and 5). While records wait under a hold, `hear` says why and until when.

**Check it.** `ear_status` shows `ears[].canticleDelivery`: the `ceiling` and effective `mode`, `style`, any
`muted` reason, per-station modes (each scope as config or the session names it), the session's `choices`,
`wakeKeys` (a count), `wakeGrants` (the session's `wake_grant`s that hold) and any `warning` (no `wakeKeys`, or `maxPushesPerHour` under one report per window),
`windowMs`, `debounceMs`, `maxAgeMs`, `waiting`, `nextPushAt`, `held` (`paused`, `no_session`, `breaker_open`,
`breaker_half_open` or `push_budget`), `heldUntil` (for `push_budget`, when the hour next has room), `lastPushAt`,
`pushesLastHour`, `reports`, and `counts`: what was pushed (`pushes`, `reports`, `records_pushed`, and of those
`records_pushed_late`; `coverage_notes`, pushes of the coverage note alone), what the live set dropped that the ear
would have pushed (`live_overflow`) or past the streams it counts one by one (`live_overflow_other`), sent from
`immediate` to a report
for its age (`routed_late`), passed over (`not_allowlisted`, `relayed`, `wake_derived`, `off`, `muted`,
`not_capable`, `wake_withheld:<class>`, `refresh_collapsed`), grants that lapsed or were discarded
(`wake_grant_lapsed`, `wake_grant_discarded`), went off air unpushed (`off_air_unpushed`) or was dropped from a full buffer (`dropped`),
pushes that didn't fit at all (`too_big`), pushes the host never confirmed before they were reverted (`reverted`;
their records waited again), and pushes no session's connection took (`unsent`; their records waited
for the next push). Pushed means handed to the session's connection, not heard: `ears[].canticleCustody` says what
the session confirmed ([Custody](#custody-and-confirmation-binary-canticle161)).

**Departures from RFC-0001.** The frond settled these modes on #65 (2026-10-10). Where they go past RFC-0001,
the RFC hasn't been amended to match yet (binary-canticle#100 tracks the amendment):

| RFC                       | It says                                                                                                                                                                                                            | frond-ear                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §14.6.4, §14.6.6, §14.6.7 | Salience regulation: a stream's threshold doubles after 5 surfacings in 10 min; no station fills more than 25% of a session's digest over 10 min (AGC); each session's threshold tracks 12 surfaced items an hour. | Not applied: nothing is ranked or thresholded. Every allowlisted record is pushed, in `station:stream` order, and a report a cap cut short continues after the last stream it covered, so a busy stream can't starve the rest. This suits a small allowlist under the hourly cap.                                                                                                                                                                                                                                                                                                                   |
| §14.6.5, §14.14           | At most two slots per session, rebuilt in place; a digest of at most 5 one-line items and 1.5 KB per turn, full text on demand; a drained item that is later plucked or expires gets a one-line note.              | Each push is a new channel event, which can't be rebuilt or recalled. The dose is per ear instead: `maxItems` records (5 by default, at most 10) and `limits.maxNotificationChars` (6,000 by default) per push, and `maxPushesPerHour` (at most 360). A `records` report carries each record whole, as #65's radio report asks; `counts` is the compact form. A pushed record gets no note when it is plucked or expires (#67).                                                                                                                                                                     |
| §14.10                    | Only `alarm` may wake, when all 11 conditions hold; until S3 passes, deployments behave as if nothing wakes.                                                                                                       | Any class from an allowlisted key is pushed. Kept: verified and not under the host daemon's MUTE, an allowlist (in place of the alarm capability), the ear's opt-in, hop 0 and not wake-derived, coalescing of at least 5 s, the breaker, and item 9's freshness bound for `immediate` (`maxAgeMs`, 30 s by default and at most 120 s, on the age at first hearing and on the time since). A report may still carry an older record, marked late. Not applied: the class rule, the session, host and token budgets (a per-ear cap on pushes per hour instead), host prerequisites and proofreading. |
| §14.12, BC-1              | No ambient delivery to a session with an off-host channel route, such as Discord, until §23.2 question 22 is settled.                                                                                              | A frond-ear session has a Discord route by design. It already takes the same agents' Discord messages as `peer_agent` events, outside any untrusted-content wrapper, so canticle adds no new trust level; this holds for frond-ear hosts only. Pushes come behind the banner and wrapper; frond-ear can't taint what the session does next.                                                                                                                                                                                                                                                         |
| §14.16 item 3 (A11)       | Chatter, ambient and advisory items land after a random per-session delay.                                                                                                                                         | No delay beyond the debounce or window. This is agreed for frond-ear hosts; revisit it before an agent on another harness opts in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| §14.18.3 (D36)            | Join-snapshot entries and `resurfaced` records never wake a session.                                                                                                                                               | One already pushed is never pushed again (unless the host never confirmed it and frond-ear reverted it; see Exactly once); one never pushed goes out once, so each record is heard once across a dropped link (#65). It is marked `late: … (snapshot)` or `(resurfaced)`, and goes `immediate` only within `maxAgeMs`; an older one goes into the next report.                                                                                                                                                                                                                                      |
| §14.18.4                  | A half-open breaker allows a wake within its allowance.                                                                                                                                                            | Half-open holds, as open does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Custody and confirmation (binary-canticle#161)

A push counter is not acknowledgement. [binary-canticle#161](https://github.com/karmaterminal/binary-canticle/issues/161)
(item 4) asks frond-ear to keep custody of what canticle shows a session, to confirm it honestly, and to keep the seam a
derived-publication path would ask. frond-ear keeps one custody row per record per exposure to an ear's session, in
its SQLite store, for `limits.retentionMs`:

| Step    | When                                                                                                                                                        | Kept                                                                                                                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claimed | The push's batch, its records' dedupe tombstones, the cursor and these rows are written in one transaction; then the push goes to the session's connection. | When, the session (its id as its shim gave it, and its attach generation), the record (station, stream, key id, epoch, seq and a SHA-256 of its whole payload, never the text), `path` (`immediate` or `report`), `mode` and `shown`. |
| offered | The shim (or the Copilot extension) answers `offered` for the batch: it handed the event to the session.                                                    | When, the session it went to, and its compaction boundary then.                                                                                                                                                                       |
| echoed  | The session names the push's whole `batch_id`, delivery token and all, in `ack`, `reply`, `react`, `edit_message` or `fetch_messages`.                      | When, the tool, the session, and its boundary then.                                                                                                                                                                                   |

`mode` is the ear's effective mode for the record's station then (a record too old for `immediate` shows `mode:
immediate`, `path: report`). `shown` is how much of it the push showed: `whole`, `cut` to fit, or `none` (a `counts`
report, a non-text payload).

- **A push alone is never heard.** A call that names no id, or a Discord batch's id, echoes nothing. A canticle push's
  `batch_id` names the canticle stream, never a chat: in any tool, with or without `chat_id`, it echoes the push and
  marks no Discord event seen. The echo is the id in the call, so it counts even if the call then fails (a Discord
  error, a refused file).
- **Naming a push echoes that push alone.** Unlike a Discord batch, it settles nothing earlier: `offered` only says the
  shim wrote the event, so each push is heard only by its own id. A push the host never confirmed echoes nothing. Only
  the id the push carried counts, delivery token and all: the bare id a tap prints, a forged or another push's token
  echoes nothing, and `ack` says why. The token is keyed by the push's attach, so the same session behind a reconnected
  shim still holds it, and by the daemon process, so after a frond-ear restart an id from before it echoes nothing
  (`ack` says so): `hear` shows the record again while it is live. A push a revert gave back still names the canticle
  stream: its id echoes nothing and marks no Discord event seen, and `ack` says to name the push its records went out
  in again. The session is the one the host confirmed the push to, by id; only a
  push confirmed while no id was known falls back to the attach. A session never echoes what another was shown, even one
  it replaced within the same attach (a `/clear`). The token form also registers the ear by use, as a Discord batch's
  does.
- **`hear` is an exposure too.** Each record whose payload text `hear` returns to the ear's own session is a row with
  `path: "hear"`, offered and echoed at the tool's return. Another reader's `hear`, and a record it lists without its
  text (non-text, or cut to nothing), add nothing.
- **Boundaries come from the pressure hook** (`pressure.boundary`, §6): the latest compaction marker its session's
  transcript holds, `null` before the first. Without that hook run with `--ear`, and after a daemon restart until it
  reports again, the boundary is unknown. Custody is only as current as that reading: add the `PostCompact` hook so a
  compaction is seen at once.
- **A push nobody confirms is given back.** If the shim never answers `offered` (it held the event through its settle
  window and lost the daemon, say), the push stays `claimed` only while that attach lasts. When frond-ear reverts it (the
  connection goes, another shim attaches, frond-ear stops, or the first attach after a crash), its custody rows,
  tombstones and cursor go back, and the records are pushed again while they are on air (🍃 on #112): at most once holds
  for what was offered, not for what was only claimed. A push onto a socket that is already gone is given back at once,
  as `unsent`.

The `canticle_custody` tool answers for the ear, newest first, by identity and digest, never payload
(`since_seconds`, default 3600; `stream` narrows it; `limit`, default 20). `ear_status` carries the same counts,
`history` and `reasons` for the last hour as `ears[].canticleCustody`. A record exposed more than once takes its best
state, so a `hear` after a compaction brings it back:

| State                     | Meaning                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `echoed`                  | Offered and echoed within the current boundary of the session holding the ear.                                                                                                                        |
| `echoed_before_boundary`  | Echoed before the current boundary, or by another session: it was exposed and is no longer in context. So is a record offered before a compaction and echoed after it: only its id outlasted the cut. |
| `echoed_boundary_unknown` | Echoed, but a boundary then or now is unknown.                                                                                                                                                        |
| `offered`                 | The host handed it over; the session never echoed it.                                                                                                                                                 |
| `claimed`                 | Pushed to the session's connection; the host hasn't confirmed it. A revert gives it back, so it is pushed again.                                                                                      |

`history` is `complete` when every record exposed in the window was offered and echoed within the current boundary;
`incomplete` when one is `claimed`, `offered` or `echoed_before_boundary`; and `unknown` when no session holds the
ear, no boundary reading from it is kept, an idle compaction was forecast (`pressure.idleCompactDueAt`) with no reading
since, the window reaches back before custody was kept (the upgrade that added it, or the prune's cutoff), or a record
was echoed under an unknown boundary. `reasons` says which.

### Room output and source use (frond-ear scope)

frond-ear holds both ends for a Claude seat: canticle comes in through it (`hear`, the push) and room output goes
out through it (`reply`, `react`, `edit_message`). So the source-use check of
[binary-canticle#161](https://github.com/karmaterminal/binary-canticle/issues/161) (item 3) sits in one process, at
every room output, and what it proves is **room output via frond-ear**, nothing wider.

**One egress gate.** Every Discord write frond-ear makes goes through it: `reply` (all of its parts), `react`,
`edit_message`, and any retry or replay of one of them, including `frond-ear send`, which is a client of `reply`.
Before anything is sent, the gate:

1. reads the speaking session's canticle custody: phase 1's records and `history` flag over the last hour, as
   `ear_status` shows them under `canticleCustody`. A `batch_id` the call names is echoed first, so naming the push
   being answered counts;
2. asks `canticle.roomPolicy` to allow or refuse, with a reason;
3. writes an egress row to the store (`room_egress`), kept for `limits.retentionMs`.

A refusal is the tool's error (`refused by canticle.roomPolicy strict-fresh: <reason>; nothing was sent …`). It sends
nothing and marks no Discord event seen; a canticle `batch_id` in the call is still echoed, since the echo is the id
in the call. Only the gate can call Discord's writes: the daemon's own REST handle is typed for reads, and a test
fails if any other source file names `sendMessage`, `addReaction` or `editMessage`. One decision covers one output: a
reply's parts, and the REST client's own waits on a Discord rate limit, go out under the decision its call got (a
session doesn't compact inside its own tool call). A retry of the call goes through the gate again and never reuses
an earlier allow, so an unfinished reply retried after a compaction posts nothing more until the policy allows it;
then it resumes as #55 says.

| Policy              | What it does                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe` (default) | Records every row and refuses nothing: no behaviour change.                                                                                                                                                                                                                                                                                                                                                                |
| `strict-fresh`      | Refuses unless the speaker's `history` is `complete`: every record it was exposed to in the window offered and echoed within its current compaction boundary. So it refuses when an echoed source predates the boundary, when a push was offered and never echoed, and when history is `unknown`: no reading from the session's pressure hook with `--ear`, an idle compaction due unseen, a superseded session, or a CLI. |

The source-use rule itself is not adopted: "all history must be fresh" is a candidate. `strict-fresh` is that
candidate, for tests and for adoption, not a default.

**What `strict-fresh` is: a freshness-of-attention gate, not an output-content check.** It never reads the output.
Its only signal is the speaking session's `history` over the last hour: `complete`, with nothing echoed before the
current boundary. So, as built:

- **One un-acked push mutes the room for about an hour.** The record stays `offered`, never echoed, so every reply,
  reaction and edit is refused until the session echoes it (its `batch_id` in `ack` or in the call, or `hear` while
  the record is still on air) or it leaves the one-hour window. A record that left the air after a compaction can't be
  shown again, so the seat waits out the window.
- **`frond-ear send` is always refused**, seat-pulse's outage alerts included: a CLI connection holds no custody, so
  it reads `unknown` (and it can read `hear` without leaving any). So is every room output of a seat whose pressure
  hook doesn't run with `--ear`.
- **Verbatim reuse passes.** With complete history, re-singing a heard record word for word is allowed; so is a
  compaction summary carrying a record once that record is more than an hour old.

**No seat should select `strict-fresh` until the frond's source-use rule is settled.** The default stays `observe`.

**Who is judged.** The session holding the ear, over the same window `ear_status` uses. A session it superseded (or
whose ear was removed) keeps its own attach's exposures in the row, but frond-ear can't place them against a boundary;
a CLI or tools-only connection has none. Both read as `unknown`.

**The egress row.** By identity and digest, never text or payload:

| Field                            | Kept                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool`, `chat_id`, `target`      | `reply`, `react` or `edit_message`; the chat; the message replied to, reacted to or edited.                                                                                                                                                                                                                                     |
| `digest`                         | SHA-256 of what went out: a reply's identity (chat, `reply_to`, text and files), an edit's text, an emoji.                                                                                                                                                                                                                      |
| `speaker`, `session_id`          | `holder`, `superseded` or `other` (a CLI or tools-only connection), and its session id.                                                                                                                                                                                                                                         |
| `policy`, `decision`, `reason`   | The policy, `allow` or `refuse`, and why.                                                                                                                                                                                                                                                                                       |
| `sources`                        | Each record the speaker had echoed in the window: identity (`key:epoch:stream:seq`), payload digest, and its custody state then.                                                                                                                                                                                                |
| `history`, `reasons`, `boundary` | Phase 1's flag and why, and the compaction boundary the speaker's hook last reported (unknown when none).                                                                                                                                                                                                                       |
| `outcome`                        | `refused`; `pending` (allowed, its call still running: the row is written before Discord is called); `sent` (every write it made was confirmed); `error` (the call failed, and nothing it wrote is unknown); or `unconfirmed` (a write it made was never answered: a timeout, a lost response, a 5xx, so it may have gone out). |
| `message_ids`                    | What the output posted, by the nonces its own call first sent, or edited, as Discord confirmed it.                                                                                                                                                                                                                              |
| `nonce`                          | For an `unconfirmed` reply, the nonce of the part Discord never answered.                                                                                                                                                                                                                                                       |
| `resent`                         | Parts this output re-sent under an earlier row's nonce (an identical retry), each with that row's id and the message Discord confirmed. They are that row's, never this one's.                                                                                                                                                  |

**A send that may have posted keeps its own row.** Discord can post a message and lose its answer. That row is
`unconfirmed`, tied to the part's nonce (each send's write-ahead intent names the egress row that first sent it), and
the tool says the message may already have been posted. An identical retry within 5 minutes reuses the nonce (#55),
so Discord hands back the original instead of posting it twice. frond-ear can't tell which try posted it, so the
message is the first row's: in the same transaction that records Discord's answer, it joins that row's `message_ids`,
and every row the nonce left `unconfirmed` becomes `sent`. The retry's row lists it under `resent` and claims nothing.
A reaction or an edit with a lost answer is `unconfirmed` too, with no nonce: a retry of it is a write of its own. A
row a previous process left `pending` was cut off mid-call; when frond-ear starts it becomes `unconfirmed` (tied to
its unanswered part's nonce, if it had one) or, for a reply with nothing unanswered, `error`.

`ear_status` shows each ear's `roomEgress`: the policy, the last hour's `allowed` and `refused`, and the latest
refusal's reason.

**Outside enforcement.** The gate covers only what frond-ear sends. These reach a room without frond-ear, and nothing
here checks them or vouches for them:

- **Bash**: any command the session runs (`curl` to Discord's API or a webhook, a bot script, `canticle sing`).
- **`gh`**: issues, pull requests, comments, and whatever a repository relays to a room.
- **Files**: anything written where another process publishes it (an outbox, a log another bot posts).
- **Other MCP servers**: another Discord, Slack or chat server, or any tool holding its own credentials.

frond-ear's own claude.ai connector (`src/connector/`) has no Discord access, so it has no room output to check.

### Exposure ledger (frond-ear#117)

With `canticle.exposure.enabled` on, frond-ear keeps a record of every canticle push that carried records to an
ear's session, in binary-canticle#162's `canticle-payload-exposure/1` shape, for an issuer behind its own boundary
to read later. frond-ear only records: it holds no key, signs nothing, calls no issuer and exports nothing (🌫's
constraint on #117). Off, behaviour and `ear_status` are the same as without the ledger, but the database is not
byte for byte the same: the store creates the empty `canticle_exposure` table and its index whether the flag is on
or off. No rows are written. A config reload turns it on or off for the pushes that follow.

Each record moves through custody's steps ([Custody and confirmation](#custody-and-confirmation-binary-canticle161)):

| Phase     | When                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| `fenced`  | In the push's claim transaction, before the session's connection takes it. Its `pendingId` never changes.   |
| `offered` | The host said it handed the push to the session (the shim's `offered`).                                     |
| `echoed`  | The session it was offered to named the push's whole `batch_id`. The offered receipt is kept alongside.     |
| `unknown` | A fence whose push never reached `offered`: `unsent` (no connection took it) or `reverted` (crash, detach). |

A fence is never cleared. After a crash it stays `fenced` until the next attach reverts the push, then reads
`unknown`; its records go out again under a new push, which is a record of its own. Another session's echo, even
with the push's whole `batch_id`, leaves a record `offered`.

What a record holds, never payload text and never the delivery token:

- `sources`: one per pushed record, in the order the push's text carries them, with the verified record's own
  provenance (tuple, `idem`, root, hop, class, lens, station, principal, stream, flags, times, body digests), its
  `scope` exactly as heard, never widened (🌿's F1 on #162), and `renderedSha256` / `renderedBytes` of its exact
  rendered entry (banner and quoted payload; for a `counts` report, its stream's line). `receiver` is the record v1
  run, `live` or `snapshot`, and the record's `rec_seq`; it is `null` for a record the embedded receptor heard
  itself. A record v1 `stream_id` that isn't a number is `null`, never made up, and so is a body's `ctype` that
  record v1 left out (the body's digests are kept).
- `resultSha256` / `resultBytes`: the whole pushed event text. `toolCallId` is `push:<batch id>`, the bare id.
- `reader`, #162's `LocalReader` for a continuing session:

  | `LocalReader`       | frond-ear                                                                                               |
  | ------------------- | ------------------------------------------------------------------------------------------------------- |
  | `sessionKey`        | `frond-ear:<ear>`: the ear is the continuing reader. #162 admits only sub-agent keys (#161 settles it). |
  | `sessionId`         | The Claude Code session id holding the ear at the fence, or `null` when its shim gave none.             |
  | `lifecycleRevision` | `attach:<generation>`: the ear's attach generation, new at every attach.                                |

  Alongside it, `holder` is #114's holder identity at the fence (`known`, `unknown`, `in-doubt`). A record with no
  session id, a `null` receiver, a `null` stream id or a `null` ctype is kept, but isn't passed off as a
  `PayloadExposure` (#162's own record reader refuses a body with no `ctype`).

**Bounds.** At the hourly prune (and a config reload), offered and echoed records fenced more than `maxAgeMs` ago
are evicted, then, per ear past `maxRecords`, the oldest offered or echoed ones. Each eviction is counted
(`canticle_exposure_evicted.<ear>`, and `evicted` in `ear_status`). Fenced and unknown records are never evicted,
so they alone can hold an ear past `maxRecords`: each prune that finds it so logs `canticle.exposure_over_bound`
(warn, with `held` and `maxRecords`) and counts it (`canticle_exposure_over_bound.<ear>`, `overBound` in
`ear_status`), and `ear_status` gives the reason in `canticleExposure.reasons` while it lasts. Unknown records past
the bound are a sign of many unsent or reverted pushes: look at the ear's attach churn.

**Reading it.** While it is on, `ear_status` shows `canticleExposure`: the counts by phase, `evicted`,
`overBound` and `reasons`. `frond-ear exposure --ear <name>
[--since <ISO time | epoch ms>] [--json]` prints the records, one line each or as JSON; it opens the database
(`FROND_EAR_DATABASE`) read-only, so it works with the daemon stopped. It never creates a database and writes no
rows, but opening a WAL database, even read-only, can leave SQLite's `-wal` and `-shm` sidecar files beside it.

Not yet recorded: what `hear` returns. Only pushes are.

### Derived publication (binary-canticle#161 item 4)

A path that publishes something derived from heard records goes through the daemon's
`derivedPublish(ear, sources, text)`, naming each source by identity (`key:epoch:stream:seq`). It calls a station's
derived op ([binary-canticle#159](https://github.com/karmaterminal/binary-canticle/pull/159), assembled in
[#162](https://github.com/karmaterminal/binary-canticle/pull/162) at `452c5433`) and never `sing`: heard content is
never sung back as heard. It is not a model tool (#162 adds none, and the capsule stays out of any model's sight); the
owner's integration calls it. It stays closed, and says why, unless every one of these holds:

1. `canticle.derivedPublication` is `true` (default `false`; it reloads with the config) **and** every source was
   heard whole (not cut, not counts-only) and echoed within the current boundary of the session holding the ear. This
   is `derivedPublicationGate(ear, sources)`, phase 1's seam; a source custody doesn't hold reads as unknown.
   `canticle_custody` shows under `publication` what it would answer for its window.
2. The owner's route is wired: an issuer and the station's control socket (`DaemonOptions.derivedRoute`). The CLI
   wires none yet, so on a seat derived publication stays closed.
3. The text is 1 to 800 UTF-8 bytes (#162's bound, before any grant narrows it).
4. Custody kept each source's lineage. Every custody row now keeps what the verified record said of itself: scope,
   class, hop, lineage root, station principal, expiry and `wake_derived`. Rows from before this read as none.
5. The station's control socket offers the derived op. #162 has no capability advertisement, so frond-ear asks
   `derived_query` about an election no authority issues (all zeros). Only #162's exact answer,
   `{"ok": false, "error": "station_claim_missing"}`, means the op is configured and this uid is admitted. A refusal
   closes it in the station's words; `ok` for that election is an anomaly (no authority issued it), and any other
   answer is absence: both close it with the answer quoted. No answer closes it too. The probe can't
   see one thing: #162 refuses `derived_publish` (not `derived_query`) on a control socket not granted class
   `chatter`. On such a socket the probe passes and the station refuses the publish, after the issuer has spent an
   election: closed, but wasteful. Grant the socket `chatter`.
6. No publication of the same text from the same sources is in flight, `unknown` or `accepted`. #162: the host never
   makes a new election to retry an uncertain effect. So a later or concurrent call is closed and points at
   `derivedQuery`; this is kept in the store, so it holds across a restart.

Custody is judged again after each wait (the probe, the issuer), so a compaction or a new session meanwhile stops it
before the station gets anything. Shutdown drains a publication or a `derivedQuery` in flight as it drains a tool call,
and once frond-ear is shutting down none starts or reaches the station. With `derivedPublication` off, `derivedQuery`
makes no station call either: it throws, and a row it would settle waits until the flag is on again.

#162's transport takes only `derived_publish` with exactly `op`, `capsule_b64` and `text`, and `derived_query` with
exactly `op` and `election_id`, one JSON line per connection. Lineage, audience and signer are not request fields:
they are bound inside the capsule, which the owner's authority issues from its own ledger and the station checks
against that same ledger. So frond-ear never mints a capsule. It hands the owner's issuer the lineage (each source's
identity, payload digest and the lineage above; the author, the session holding the ear; the audience, no wider than
the narrowest source scope) and the text, then sends the station exactly `derived_publish`.

Each issued attempt is a `derived_publications` row by source ids and digests, never the text: `issuing`, `claimed`
(the election issued), then `accepted` with the station's receipt, `refused` (the issuer or the station said no, or it
was stopped after the capsule was issued: custody moved, or frond-ear began shutting down), or `unknown` when no answer
came, or an answer without a receipt naming this election and this payload. An unknown one is never published again:
`derivedQuery(ear, election_id)` asks the station about the same election and settles the row if the station reports
it accepted with such a receipt (a row a publish in this process still owns is left to that publish). The prune keeps a
row still `claimed` or `unknown` past `limits.retentionMs`: it is the record that its election may have published. A row
a previous process left `issuing` never reached the station (the request goes out only once a row is `claimed`), so
frond-ear releases it as `refused` when it starts. A `claimed` or `unknown` row the station keeps answering
`station_claim_missing` or `claimed_unknown` for blocks that text from those sources for good: #162 says absence never
proves an item wasn't emitted. Publish other text, or, once you have checked the station's air yourself, release it in
the store:
`sqlite3 "$XDG_STATE_HOME/frond-ear/frond-ear.db" "UPDATE derived_publications SET state='refused', reason='released by the operator' WHERE election_id='<id>'"`.

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
