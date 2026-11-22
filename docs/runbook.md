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

| Field                       | Meaning                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ears.<name>`               | One ear per session.                                                                                                                                                                            |
| `ears.<name>.target`        | `claude-channel` (the default, which `init` writes) or `copilot-extension`. This runbook attaches Claude Code; the [README](../README.md#github-copilot-cli) has the Copilot CLI steps.         |
| `ears.<name>.channels`      | Channel IDs to modes: `silent`, `mentions` (the default) or `room`. Per-channel `quietWindowMs`, `maxDelayMs` and `historyLimit` are optional. Threads inherit their parent channel's settings. |
| `ears.<name>.dms`           | Whether this ear receives DMs from principals and peers.                                                                                                                                        |
| `ears.<name>.dmMode`        | `mentions` (the default: every DM wakes the session) or `silent` (DMs are stored for `inbox` only).                                                                                             |
| `ears.<name>.attachCanary`  | Asks Claude to `ack` a nonce each time a session attaches. This proves the channel is actually registered, because a notification can otherwise be dropped with no error.                       |
| `ears.<name>.instructions`  | Extra text you write, appended to the channel instructions.                                                                                                                                     |
| `ears.<name>.sendFileRoots` | Absolute directories a `reply`'s `files` may come from. Empty (the default): this ear sends no files. See **Sending files** below.                                                              |

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

| Task                        | How                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Status                      | `node src/cli.ts status`, or ask Claude to call `ear_status`                                                                     |
| Pause pushes                | Set `"paused": true` in the config; it reloads live                                                                              |
| Read what Claude missed     | Claude calls `inbox`; everything stays in SQLite until the retention window expires                                              |
| Logs                        | JSON lines on the daemon's stderr. Message text and tokens are redacted.                                                         |
| Post from a script          | `node src/cli.ts send --chat <id> "<text>"`, below                                                                               |
| Letters across a compaction | `leave_letter`, then a `SessionStart` hook running `release --hook` (and a `PreCompact` hook running `precompact --hook`), below |

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
        "matcher": "startup|compact",
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
(and then prints no reminder, since it couldn't take a letter). Leave `resume` out: a resumed
session keeps its context.

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
    "my-ear": { "mode": "digest", "stations": { "station-a": "immediate" } }
  }
}
```

| Field                | Default        | Meaning                                                                                                                                                                                                                                                                                              |
| -------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakeKeys`           | `[]`           | Station key ids (16 hex digits, the `key=` of a `hear` banner) whose records may be pushed. Empty: nothing is pushed, and `ear_status` warns. Leave out the host's own station key, or it hears itself.                                                                                              |
| `muted`              | `false`        | `true` mutes every push to every ear.                                                                                                                                                                                                                                                                |
| `delivery.<ear>`     | absent (`off`) | The ear's ceiling. A bare string (`"digest"`) sets `mode` alone.                                                                                                                                                                                                                                     |
| `….mode`             | `off`          | `immediate`, `digest` or `off`, for every station.                                                                                                                                                                                                                                                   |
| `….stations`         | `{}`           | `station → mode`, overriding `mode` for that station. A station can be named by its key id (16 hex digits, the `key=` of a `hear` banner), which outlasts a manifest rename; where its key id and its name both have an entry, the narrower holds.                                                   |
| `….windowMs`         | `60000`        | `digest`: at most one report per window, 5 s to 1 h. The window opens when a record starts waiting.                                                                                                                                                                                                  |
| `….debounceMs`       | `5000`         | `immediate`: a burst is coalesced over this long, 5 s (RFC §14.10) to 1 min, and less than `maxAgeMs`.                                                                                                                                                                                               |
| `….maxAgeMs`         | `30000`        | `immediate` pushes only a record heard at most this long ago and at most this old when first heard (RFC §14.10 item 9). Any other goes into the next report instead, marked late. 10 s to 2 min (item 9's 120 s).                                                                                    |
| `….style`            | `records`      | `digest`: `records` (each record behind its banner) or `counts` (per stream: how many, seqs skipped, repeats caught; no payloads).                                                                                                                                                                   |
| `….maxItems`         | `5`            | Records per push, 1 to 10 (RFC §14.6.5's dose is 5). The rest wait for the next push.                                                                                                                                                                                                                |
| `….bufferPerStream`  | `32`           | Records waiting per `station:stream`, 1 to 256. When it is full the oldest is dropped, and the next push says so.                                                                                                                                                                                    |
| `derivedPublication` | `false`        | Whether the derived-publication seam may open at all ([Custody](#custody-and-confirmation-binary-canticle161)). frond-ear makes no station call either way.                                                                                                                                          |
| `….maxPushesPerHour` | `60` or more   | Pushes to the ear per hour, from `immediate` and reports together, 1 to 360: 60 by default, or one per window when `windowMs` is under a minute, so a busy band's reports fit the hour. `ear_status` warns when it is less than one per window. Past it, records wait. The count survives a restart. |

**What the session gets.** Channel events with `kind="canticle"` and `delivery="immediate"` (the new records of
the last few seconds) or `delivery="report"` (a "what's on the radio" report, `report=<n>`). Each push is a batch
of its own, outside the Discord ledger: it carries a `batch_id`, with the delivery token as a Discord batch's does,
and touches no Discord event. Passing that `batch_id` to `ack` on its own is how the session says it heard the push
([Custody](#custody-and-confirmation-binary-canticle161)). Each record carries the `[canticle:heard]` banner `hear` shows,
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
not delivery: it is written with the push's batch before the push goes out, so a crash after it loses that push and
never repeats it. A push that no session's connection takes gives its claim back, and its records wait for the next. A record heard again with a later
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
`muted` reason, per-station modes (each scope as config or the session names it), the session's `choices`,
`wakeKeys` (a count) and any `warning` (no `wakeKeys`, or `maxPushesPerHour` under one report per window),
`windowMs`, `debounceMs`, `maxAgeMs`, `waiting`, `nextPushAt`, `held` (`paused`, `no_session`, `breaker_open`,
`breaker_half_open` or `push_budget`), `lastPushAt`, `pushesLastHour`, `reports`, and `counts`: what was pushed
(`pushes`, `reports`, `records_pushed`, and of those `records_pushed_late`), sent from `immediate` to a report
for its age (`routed_late`), passed over (`not_allowlisted`, `relayed`, `wake_derived`, `off`, `muted`,
`refresh_collapsed`), went off air unpushed (`off_air_unpushed`) or was dropped from a full buffer (`dropped`),
pushes that didn't fit at all (`too_big`), and pushes no session's connection took (`unsent`; their records waited
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
| §14.18.3 (D36)            | Join-snapshot entries and `resurfaced` records never wake a session.                                                                                                                                               | One already pushed is never pushed again; one never pushed goes out once, so each record is heard once across a dropped link (#65). It is marked `late: … (snapshot)` or `(resurfaced)`, and goes `immediate` only within `maxAgeMs`; an older one goes into the next report.                                                                                                                                                                                                                                                                                                                       |
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
| echoed  | The session names the push's `batch_id` in `ack`, `reply`, `react`, `edit_message` or `fetch_messages`.                                                     | When, the tool, the session, and its boundary then.                                                                                                                                                                                   |

`mode` is the ear's effective mode for the record's station then (a record too old for `immediate` shows `mode:
immediate`, `path: report`). `shown` is how much of it the push showed: `whole`, `cut` to fit, or `none` (a `counts`
report, a non-text payload).

- **A push alone is never heard.** A call that names no id, or a Discord batch's id, echoes nothing. A canticle push's
  `batch_id` names the canticle stream, never a chat: in any tool, with or without `chat_id`, it echoes the push and
  marks no Discord event seen. The echo is the id in the call, so it counts even if the call then fails (a Discord
  error, a refused file).
- **Naming a push echoes the earlier ones** shown to the same session, as a later Discord batch settles its chat. The
  session is the one the host confirmed each push to, by id; only a push confirmed while no id was known falls back to
  the attach. Such a record shows `echoedThrough: "a later push"`. A session never echoes what another was shown, even
  one it replaced within the same attach (a `/clear`). The bare id a tap prints echoes too, since the tap shows the same
  push; the token form also registers the ear by use, as a Discord batch's does.
- **`hear` is an exposure too.** Each record whose payload text `hear` returns to the ear's own session is a row with
  `path: "hear"`, offered and echoed at the tool's return. Another reader's `hear`, and a record it lists without its
  text (non-text, or cut to nothing), add nothing.
- **Boundaries come from the pressure hook** (`pressure.boundary`, §6): the latest compaction marker its session's
  transcript holds, `null` before the first. Without that hook run with `--ear`, and after a daemon restart until it
  reports again, the boundary is unknown. Custody is only as current as that reading: add the `PostCompact` hook so a
  compaction is seen at once.
- **A push nobody confirms stays claimed.** If the shim never answers `offered` (it held the event through its settle
  window and lost the daemon, say), the record stays `claimed` and is not pushed again: a push is lost rather than
  repeated, as before. Custody just stops calling it pushed and heard.

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
| `claimed`                 | Pushed to the session's connection; the host never confirmed it.                                                                                                                                      |

`history` is `complete` when every record exposed in the window was offered and echoed within the current boundary;
`incomplete` when one is `claimed`, `offered` or `echoed_before_boundary`; and `unknown` when no session holds the
ear, no boundary reading from it is kept, an idle compaction was forecast (`pressure.idleCompactDueAt`) with no reading
since, the window reaches back before custody was kept (the upgrade that added it, or the prune's cutoff), or a record
was echoed under an unknown boundary. `reasons` says which.

**Derived publication: the seam, closed.** A path that would publish something derived from heard records asks the
daemon's `derivedPublicationGate(ear, sources)`, naming each source by identity (`key:epoch:stream:seq`). It is closed
unless `canticle.derivedPublication` is `true` (default `false`; it reloads with the config) **and** every source was
heard whole (not cut, not counts-only) and echoed within the current boundary of the session holding the ear. A source
custody doesn't hold reads as unknown. An open answer names the derived op, never `sing`: heard content is never sung
back as heard. Nothing calls the seam yet, and it makes no station call (binary-canticle#162's derived op isn't on
seats). `canticle_custody` shows under `publication` what it would answer for its window.

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
