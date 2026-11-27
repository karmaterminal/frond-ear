# frond-ear architecture

What runs, how a Discord message reaches a session and how its answer leaves, and what frond-ear
promises along the way, with what it doesn't. Each promise cites the code that keeps it, with line
numbers at `67751be`. Lines drift, so if one has moved, search for the function it names. The
[runbook](runbook.md) has the settings and procedures, and [onboarding](onboarding.md) has every
config field.

## The parts

| Part                                        | Runs as                                                                                                                 | Holds                                                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon (`src/daemon.ts`)                    | `node src/cli.ts daemon`, one per bot. `ops/install-systemd.sh` makes it a systemd user unit.                           | The bot token, the Gateway connection and REST client, the SQLite ledger, every ear's state, and the canticle listener when it is on.                                                         |
| Shim (`src/shim.ts`)                        | `node src/cli.ts shim`, a stdio MCP server that Claude Code starts for one session.                                     | Nothing durable. It relays events in and tool calls out over the daemon's Unix socket (or TCP with a token).                                                                                  |
| Copilot extension (`copilot-extension/`)    | Installed by `node src/cli.ts copilot-extension --ear <name>`; runs inside a Copilot CLI session.                       | The same ear protocol and tools, for an ear whose `target` is `copilot-extension`.                                                                                                            |
| Hooks (`release`, `precompact`, `pressure`) | Commands Claude Code runs at `SessionStart`, `PreCompact`, `PostCompact`, `PostToolUse`, `UserPromptSubmit` and `Stop`. | `release` and `precompact` ask the daemon the way `status` does. `pressure` keeps small per-session state files, and reports to the daemon when it names an ear (`--ear` or `FROND_EAR_EAR`). |
| Connector (`src/connector/`)                | `node src/cli.ts connector-echo`, its own process.                                                                      | No Discord access: it is the echo step of #53.                                                                                                                                                |

An **ear** is a named delivery target in the config (`ears.<name>`): its channels and their modes,
whether it takes DMs, and its target. One session holds an ear at a time. A new attach supersedes
the one before (`src/daemon.ts:1786-1790`), gives back every batch the host never confirmed
(`src/daemon.ts:1791`), and starts a new attach generation.

## A message in

1. **Heard.** The Gateway connection (`src/gateway.ts`) hands each new message to the daemon.
2. **Classed** (`classify`, `src/policy.ts:129-215`). Trust comes from the author's ID and nothing
   else: `principal` and `peer_agent` from the config's lists, and `ambient` for anyone else
   (`trustOf`, `src/policy.ts:60-68`). A bot that is neither is refused, and so is an ambient DM.
   The channel's mode, narrowed by whatever the session asked for with `set_attention`, then sets
   the state:
   - `stored` in a `silent` channel;
   - `queued`, which wakes the session, for a mention, a reply to the bot or a DM, and for every
     message in a `room` channel except a bot's over its budget;
   - `context` for other room chatter.

   Wake budgets stop a bot from waking the session without end, and in a `mentions` channel stop
   an ambient user who keeps @mentioning the bot. In a `room` channel an ambient mention past its
   budget only loses its priority, and still wakes the session at the room's debounce
   (`src/policy.ts:163-195`).

3. **Admitted**, in one transaction with the chat's anchor (`src/daemon.ts:1004-1014`). The row
   goes in, the chat's flush time is set and the ear's bounds are applied (`admit`,
   `src/daemon.ts:1027-1105`). The debounce flushes a chat at the earliest of `quietWindowMs`
   after its latest wake-worthy message, `maxDelayMs` after its oldest, and `priorityQuietMs`
   after its oldest mention, reply or DM (`scheduleChat`, `src/store.ts:2940-2976`).
4. **Pushed.** At its flush time a chat's queued events and its buffered context become one batch
   (`takeBatch`, `src/store.ts:3098-3146`). The daemon writes each message's header (time, name,
   author ID, trust class) and quotes its text with `> ` (`renderEvent`, `src/render.ts:54-89`).
   The batch's `meta` carries the `trust` and `user_id` of its latest wake-worthy message
   (`src/render.ts:149-161`). A batch longer than `limits.maxNotificationChars` (6000) shows its
   newest messages and points to `inbox` for the rest (`src/render.ts:119-139`). The shim sends it
   as a `notifications/claude/channel` event and tells the daemon `offered` once the event is
   written (`src/shim.ts:683-696`). No batch is pushed while the config says `paused` or no session
   holds the ear (`tick`, `src/daemon.ts:1367-1390`).
5. **Seen.** Only tool activity by the session that holds the ear marks events seen. A call in a
   chat that names a `batch_id` settles that chat's confirmed batches up to that one. A call that
   names none settles up to the latest batch confirmed when it starts, so a batch offered after
   that stays unseen; `ack` without a `chat_id` does this for the whole ear (`seenHorizon`,
   `src/daemon.ts:3573-3632`; `markSeenThrough`, `src/store.ts:3345-3364`). `inbox` marks seen
   exactly what it returns (`src/daemon.ts:3837-3846`).

## After a gap

**A session away.** The ledger is SQLite, so what waits outlives the session and the daemon.
Queued, context and stored rows have no time limit, only the pending cap below. Offered events
nobody acted on are deleted `limits.retentionMs` (14 days) after they were offered (`prune`,
`src/store.ts:3427-3437`). When a session attaches
(`hello`, `src/daemon.ts:1707-1870`):

- every batch the host never confirmed goes back to waiting: wake-worthy events as `queued`,
  context as `context` (`revertUnconfirmed`, `src/store.ts:3267-3274`). It goes out again;
- what an earlier attach was offered but never acted on isn't pushed again. One `digest` event
  counts it per chat (`src/daemon.ts:1828-1832`; `renderDigest`, `src/render.ts:169-180`), and
  `inbox` reads it until the session's next tool call in that chat settles it with the rest;
- what is queued and due flushes (`src/daemon.ts:1868`).

**A Gateway outage.** When Discord can't resume the session and the daemon starts a fresh one,
nothing sent in between is replayed. On READY, before the new session's first dispatch, every chat
with an anchor owes a read-back from it, the anchor being the newest message heard there
(`gatewayReady`, `src/daemon.ts:1109-1124`). The prune keeps the 1,000 most recently active anchors
(`src/store.ts:3449-3459`), and `limits.catchUpMessages: 0` turns read-back off. The read-back takes one
page of `limits.catchUpMessages` (50) for each of the `limits.catchUpChats` (25) most recently
active chats, counted across all ears, and admits what is newer than the anchor as if it were heard
live (`catchUp`, `src/daemon.ts:1161-1274`). A chat is settled once a read-back that began after
the latest READY reads it, fails to read it, or skips it past `catchUpChats`
(`src/daemon.ts:1218-1256`).

What it couldn't read goes into a `catch_up` notice, with the `fetch_messages` call that reads
each gap: every full page that never reached the anchor, every chat whose history couldn't be read,
and the chats past `catchUpChats` (the first five named, the rest counted; `renderCatchUp`,
`src/render.ts:196-244`). The notice is sent once and has nothing to confirm. If no session holds
the ear it is saved until one attaches, keeping the last 100 chats (`reportCatchUp`, `src/daemon.ts:1316-1340`), and
`status` shows the last run until the daemon restarts (`src/daemon.ts:5298-5313`).

## A message out

- `reply`, `react` and `edit_message` post. Each goes through one egress gate, which records what
  canticle the speaking session had echoed at that moment. It refuses only under
  `canticle.roomPolicy: "strict-fresh"`; `observe`, the default, refuses nothing
  (`src/egress.ts:1-23`; `src/config.ts:402-403`).
- Every Discord ID from a tool must be a snowflake (`src/daemon.ts:396`; `snowflakeArg`,
  `434-455`), and every REST path segment is URL-encoded (`src/rest.ts:104-108`).
- A tool reaches only chats an ear serves: configured channels, their threads and known DMs
  (`requireChat`, `src/daemon.ts:3544-3556`).
- `edit_message` edits only a message that frond-ear sent in that same chat
  (`src/daemon.ts:3787-3792`).
- Only the daemon uses the bot token, read from `DISCORD_BOT_TOKEN_FILE` or `DISCORD_BOT_TOKEN`
  (`readBotToken`, `src/config.ts:1027-1036`), and its logger redacts it (`src/cli.ts:122-125`).
  `init` writes a pasted token to its 0600 file, and `init` and `doctor` check the file isn't
  empty; neither connects with it (`src/onboard.ts:505-518`, `770`). The shim never has it.

## Letters

A session can leave text for itself before a compaction with `leave_letter`. The `SessionStart`
hook's `release --hook` hands it back afterwards as `kind="letter"` events under one nonce, which
`ack` settles (`releaseLetters`, `src/letters.ts:233-327`; runbook, "Letters").

- Each letter holds at most 8192 bytes, and each ear 16 unsettled letters and 24576 bytes. A
  letter lasts 48 h by default and 7 days at most (`LETTER_LIMITS`, `src/letters.ts:13-30`). Over
  a limit the call is refused, never truncated (`parseLeave`, `src/letters.ts:40-98`;
  `leaveLetter`, `188-201`).
- A release pushes a letter's text only to the session that left it. Both sessions must be known
  and the same; otherwise the letter is held and only named (`src/letters.ts:246-254`, `285-300`).
  Another session holding the ear sees the text only if it asks for it with `letters` (`read: id`)
  (`src/daemon.ts:3968-3986`).
- An unsettled letter comes back at each release until it expires (`src/letters.ts:243-255`). An
  expired one is reported at the next release, and its text is deleted (`src/letters.ts:301-311`).
  One still unsettled 7 days after it expired is pruned without a report (`pruneLetters`,
  `src/letters.ts:161-178`).
- A letter is the session's own evidence from an earlier turn, never permission, and its banner
  says so (`src/letters.ts:1-8`, `267`).
- `precompact --hook` also prints the session's own letters into the compaction summary,
  read-only (runbook, "Letters into the compaction summary", #102).

## Schedules and wakes

- `schedule` (a time, or every N minutes, 5 at least) and `wake_on` (one GitHub target, off by
  default) leave the daemon a wake. It is owed to the session that set it, and only to that
  session, until that session acks the exact delivery. The daemon outlives the session, so a wake
  survives a crash, a restart and `/clear` (`src/wakes.ts:1-8`). After a `/clear` the new session
  is told which wakes are held, never their notes (runbook, "Whose wake it is, across `/clear`").
- While its setter holds the ear, an owed wake is pushed again after an hour, then after twice as
  long each time, up to a day (`repushAt`, `src/wakes.ts:41-47`, `236-245`).
- An ear holds at most 32 active schedules, and a session 16. A schedule whose setter hasn't held
  the ear for 7 days retires, and what it already owes stays owed. An occurrence nobody settles is
  dropped after 30 days, and counted (`WAKE_LIMITS`, `src/wakes.ts:22-53`).
- `wake_on` only reads: GET only, to the configured API origin, no redirects, and only
  repositories the ear's config allows. Text it brings back is quoted as untrusted evidence
  (`src/github.ts:1-10`).

## Canticle delivery

frond-ear can hear binary-canticle stations. `hear` reads what is on air. The push is opt-in twice:
an ear's `canticle.delivery` (default `off`), and only records from a station key on
`canticle.wakeKeys`, sung at hop 0 and not wake-derived (`src/canticle/delivery.ts:1-7`).

- `immediate` coalesces a burst over at least 5 s into one push. `digest` sends one report per
  window. The session can narrow either, down to mute, with `set_canticle_delivery`, and a mute
  always wins (`src/canticle/delivery.ts:8-17`).
- Dedupe is by record identity, never text. A durable tombstone keeps it until the record's local
  expiry plus 5 s, so a retransmission or a restart in that time pushes nothing twice
  (`src/canticle/delivery.ts:17-21`). A push the host never confirmed gives its claim back, and its
  records go out again while they are on air: at most once holds for what was offered, not for what
  was only claimed (`src/canticle/delivery.ts:58-67`).
- Caps bound every push, every wait and the rate (`maxPushesPerHour`, 360 at most;
  `src/config.ts:244`). Nothing is pushed while the daemon is paused, the ear has no session, or
  the receptor's breaker isn't closed (`src/canticle/delivery.ts:25-29`).
- What frond-ear withheld is said in the next push's coverage note, never left silent
  (`src/canticle/delivery.ts:31-35`).
- A push alone is never heard. A push is echoed only when the session names its whole `batch_id`,
  delivery token and all (`src/canticle/delivery.ts:65-67`; `src/daemon.ts:3610-3630`). Custody
  keeps each exposure in three steps, claimed, offered and echoed, and `canticle_custody` reports
  them (`src/canticle/custody.ts:3-14`; runbook, "Custody and confirmation").

## Context pressure and quota

These come from the pressure hook, not the daemon, and a seat opts in by installing it.

- **Context pressure.** `pressure --hook` on `PostToolUse` and `UserPromptSubmit` reads the
  session's token use from its transcript. When the count crosses up into a band (150k, 200k,
  300k, 450k and 650k tokens by default), it says so once in the session's context. A compaction
  starts the bands again. They are absolute counts because one long session compacted anywhere
  from 200k to 970k tokens (`src/pressure.ts:1-15`; `DEFAULT_BANDS`, `src/pressure.ts:27`). On
  `Stop` it can continue a turn, once per band from the second band up (`stopStep`,
  `src/pressure.ts:340-366`).
- **Quota** (#129; opt-in with `FROND_EAR_QUOTA=claude`). The same hook reads the seat's Claude
  subscription usage when its last reading is 30 minutes old (hooks running at once can each read
  then; `src/quota.ts:384-392`), and says the level when it changes:
  - `burn`: the weekly reset is at most 2 days away, with at most 50% used;
  - `near`: 85% or more of the weekly or the five-hour window used;
  - `exhausted`: 100% of either window, or the week locked;
  - `unknown`;
  - back to `ok`.

  A first reading that is `ok` says nothing (`src/quota.ts:35-45`, `95-111`; `quotaStep`,
  `src/quota.ts:157-166`). The line goes out on `PostToolUse` and `UserPromptSubmit` only, never on
  `Stop` (`src/pressure.ts:742-751`, `768-778`). The access token goes only to api.anthropic.com
  and is never printed, logged or stored. The refresh token is never used (`src/quota.ts:17-20`).

## What is promised, and what isn't

| Promised                                                                                                                | Kept by                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Trust comes from the verified author ID, never from message text.                                                       | `src/policy.ts:60-68`, `src/render.ts:54-89`                              |
| Events reach Claude Code as channel events, never as user input.                                                        | `src/shim.ts:683-696`                                                     |
| The shim agrees only to MCP revisions that keep channel registration; 2026-07-28 breaks it.                             | `src/shim.ts:12-20`, `793-805`                                            |
| Admission, the anchor, the flush time and the bounds are one transaction.                                               | `src/daemon.ts:1004-1014`, `1027-1105`                                    |
| Only the holding session's tool activity marks events seen, and never a batch offered after the call began.             | `src/daemon.ts:3573-3632`, `src/store.ts:3345-3364`                       |
| A batch the host never confirmed waits again and goes out again.                                                        | `src/store.ts:3267-3274`, `src/daemon.ts:1791`                            |
| A read-back that couldn't read everything says so in a `catch_up` notice, sent once.                                    | `src/daemon.ts:1161-1274`, `src/render.ts:196-244`                        |
| Outbound IDs are snowflakes, path segments are encoded, and an edit touches only frond-ear's own message.               | `src/daemon.ts:434-455`, `src/rest.ts:104-108`, `src/daemon.ts:3787-3792` |
| The bot token stays in the daemon and out of its logs.                                                                  | `src/config.ts:1027-1036`, `src/cli.ts:122-125`                           |
| A release pushes a letter's text only to the session that left it.                                                      | `src/letters.ts:246-254`                                                  |
| A wake is owed to its setter until that session acks it, for at most 30 days.                                           | `src/wakes.ts:1-8`, `22-53`                                               |
| A canticle record the host confirmed isn't pushed again while its tombstone lasts, and what frond-ear withheld is told. | `src/canticle/delivery.ts:17-21`, `31-35`, `58-67`                        |
| The quota store never goes back to an older reading, and every line says when its reading was taken.                    | `src/quota.ts:8-16`                                                       |

Not promised:

- **Every message.** Past `limits.maxPendingPerEar` (500) unseen events, an ear drops its oldest:
  room context first, then offered events nobody acted on, then silent-channel rows, then queued
  ones (`capPending`, `src/store.ts:3050-3082`). The drop is counted (`overflow_dropped` in
  `status`) and logged as `ear.overflow`, but the session gets no event about it
  (`src/daemon.ts:1096-1103`). A chat keeps `historyLimit` (20) context rows, and older ones expire
  (`src/daemon.ts:1086-1094`). Offered events nobody acted on are deleted `retentionMs` (14 days)
  after they were offered (`src/store.ts:3427-3437`). A message's text is cut at `limits.maxMessageChars` (4000)
  (`messageText`, `src/components.ts:178-187`).
- **That seen means shown.** A call that settles a batch also settles what the batch didn't show
  for length, and what an earlier attach was offered in that chat; after that `inbox` no longer
  lists them, and `fetch_messages` reads them from Discord.
- **Through a config change.** A reload that unbinds a chat or moves it to another ear drops its
  waiting events (`routing_revoked`; `src/daemon.ts:917-932`, `src/store.ts:2989-3002`). One that
  makes it `silent` keeps them for `inbox` only (`src/store.ts:3004-3014`).
- **Exactly once.** A batch the host never confirmed goes out again, so a session can see a message
  twice. A confirmed batch the session never acted on isn't pushed again; the reattach digest only
  counts it.
- **Order after an outage.** Messages read back are admitted after the chat's page comes back, so
  they can arrive in a later batch than newer messages heard live meanwhile. Each carries the time
  it was sent.
- **Quota lines in order.** Under concurrent hooks a level can be said twice, and a line from an
  older reading can arrive after a newer one, because Claude Code orders hook output itself.
  Believe the latest reading time (`src/quota.ts:8-16`).
- **A warning before a compaction.** Claude Code gives none. The pressure bands and
  `hold_compaction` are what a session has (runbook, "Context pressure").
- **Room writes outside frond-ear.** Bash, `gh`, files and other MCP servers reach rooms without
  the egress gate, and nothing here vouches for them (`src/egress.ts:12-14`).
- **Copilot CLI parity.** The extension is covered by tests against a fake session, and a live
  attach was proved once, on 2026-11-08, with every tool call approved by hand
  ([#92](https://github.com/karmaterminal/frond-ear/issues/92#issuecomment-6728770048)). Copilot CLI
  has no post-compaction hook, and #92 tracks letters there.
- **The connector's Discord facade.** The echo step listens on loopback only and has no Discord
  access (`src/connector/echo.ts:1-5`, `177-184`). The facade is a later PR.
