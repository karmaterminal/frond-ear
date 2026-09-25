# Spike: frond-ear as a push gateway into long-running Claude Code sessions

- **Date:** 2026-09-25
- **Status:** accepted direction for v1. The implementation tracks the v1 epic issue.
- **Supersedes:** the Copilot-first framing of karmaterminal/frond-ear#1. Its requirements carry forward and are mapped in [Relationship to issue #1](#relationship-to-issue-1).

## 1. Problem

frond-scribe is a Claude that lives in one Claude Code TUI session for weeks or months. Two things limit how it takes part on Discord with people and OpenClaw agents:

- **It can only pull.** Discord MCP servers give it tools to call, so it only learns about new messages by calling a read tool. In practice that means cron sweeps, or a polling loop that tightens whenever a conversation is active.
- **Nothing tells the session a message arrived.** The bot's Gateway websocket receives mentions and room traffic immediately, but no mechanism turns that into a wake in the session.

frond-ear closes that gap. It is a small daemon that holds the bot's Gateway connection and applies OpenClaw-style debounce, queueing, mention gating and ambient history. It pushes events into the live Claude Code session and carries replies back out, and it does this without imitating keyboard input.

## 2. What already existed (assessment)

### 2.1 Issues and projects

- **karmaterminal/frond-ear#1** is the only issue.
  - It specifies durable Gateway ingress, a SQLite queue, suppression, and a health surface.
  - Its comments add a generation-fenced session registry with admin-only `/new`, the `silent|mentions|room` delivery modes, and a design workorder for a GitHub Copilot SDK continuation plugin.
  - Its last activity was 2026-09-18, waiting on a detached design review.
- **Project 92** is referenced as the project of record. It was not readable from this spike's tooling.

### 2.2 Implementation branches

The branches form a chain, and `main` contains only a README:

```
codeagent/frond-ear-v0 → codeagent/frond-ear-copilot-sidecar-v1 → codeagent/frond-ear-live-canary-v2
```

About 2.9k lines of TypeScript, with 40 `node:test` tests. The stack is Node ≥24 with zero runtime dependencies (`node:sqlite`, global `WebSocket`).

| Area | Verdict |
|---|---|
| `src/gateway.ts`: hand-rolled Gateway v10 client (identify/resume, jittered heartbeat, ACK timeout, op 7/9, backoff, stale-socket guard, persisted cursor) | **Salvaged into v1** with fixes |
| `src/logger.ts`: JSON logger with key- and value-based redaction | **Salvaged** |
| `src/policy.ts`: allowlists, priority authors and mentions, suppression patterns | Ideas kept; **rewritten** around ears, trust classes and modes |
| `src/store.ts`: SQLite queue (lease/ack/release/dead-letter, dedupe, generation-fenced `session_bindings`, idempotent rotation) | Ideas kept (dedupe, durable cursor, fencing); **rewritten** as a ledger (the lease model assumed frond-ear owned session creation) |
| `src/adapters.ts`: `CopilotSdkAdapter` | **Not salvaged.** `ReleasedCopilotSdkFactory.createClient()` always throws, and enabling the live canary dead-letters queued work after about 5 retries. Parked for the Copilot-parity issue. |
| `src/http.ts`: loopback HTTP control API | **Not salvaged.** It has no auth, no Content-Type or Host checks (CSRF/DNS-rebind risk), and every error returns 400. |

Defects found in the salvaged or rewritten areas, and fixed in v1:

- **Unhandled close codes.** 4007 (invalid seq) and 4009 (session timed out) were not handled, so the client kept resuming a dead session.
- **Ingest exceptions.** An exception in ingest was thrown inside the WebSocket listener, which risked a crash loop on a poison message.
- **Fatal close.** A fatal close left the process alive in `failed` state, so the supervisor never restarted it.
- **Mention forms.** `<@!id>` mentions were missed, and replies to the bot didn't count as mentions.
- **Thread routing.** Threads had to be allowlisted individually because there was no parent lookup and no `GUILDS` intent.
- **Head-of-line blocking.** A single global serial delivery loop polled every second, so one slow target stalled every conversation.
- **Lease handling.** `ack` ignored lease expiry, and `isLeaseActive` ignored pause.

### 2.3 Design branches

The design branches are `design/frond-ear-continuation-v2`, `design/frond-ear-continuation-astra-v2`, and `cael/20260916/p92-frond-ear-design-successor`. Together they hold about 2k lines of design, proof and journal material.

Carried into v1:
- the untrusted-envelope and provenance idea: trust derived from verified identity, never from content;
- the distinction between accepted, completed and ambiguous;
- the normative `silent|mentions|room` table and the control-authority rules from the cael successor;
- the bug list and fake-harness scenario table.

Not carried forward:
- the Copilot SDK matrix, the create/resume/heartbeat pump and the "+1 continuation" problem. Claude Code channels make these unnecessary for the Claude target.
- the process ceremony: workorders, journals, gate names, and hash receipts.

## 3. Key finding: Claude Code already has a push path

### 3.1 Channels

Channels have been a research preview since Claude Code v2.1.80. At the time of writing the current version is v2.1.282.

Sources:
- <https://code.claude.com/docs/en/channels>
- <https://code.claude.com/docs/en/channels-reference>
- the Claude Code CHANGELOG

How a channel works:
- **Registration.** A channel is a **stdio MCP server launched by Claude Code**. It declares `capabilities.experimental['claude/channel']`.
- **Events.** The server emits `notifications/claude/channel` with `{content, meta}`, and the session sees `<channel source="…" key="value">content</channel>`.
  - `meta` keys must match `[A-Za-z0-9_]`; any other key is silently dropped.
- **Busy and idle sessions.**
  - Events that arrive while Claude is busy **are queued and delivered together on the next turn**. They never pre-empt the running turn and are never keyboard input.
  - An idle session wakes and takes a turn.
- **Replies** go out through ordinary MCP tools.
- **Server `instructions`**, which the operator authors, are loaded into Claude's context when the server connects.
- **Launch flags.** Custom (non-allowlisted) channels load with `--dangerously-load-development-channels server:<name>` or `plugin:<p>@<marketplace>`. Allowlisted ones use `--channels plugin:…`.
- **Auth.** Channels need a claude.ai login or a Console API key.
  - Pro/Max personal accounts skip the org gates.
  - Team/Enterprise orgs need an Owner to enable channels and use `allowedChannelPlugins`.
  - Channels are not available on Bedrock, Vertex or Foundry.
- **No acknowledgement.** Delivery is fire-and-forget. The notification promise resolves when the bytes reach the pipe, and events are **dropped silently** if the server isn't registered as a channel.
- **Protocol trap.** On the v2 MCP runtime with `MCP_PROTOCOL_NEGOTIATION=auto`, a server that negotiates protocol revision `2026-07-28` is not registered as a channel.
- **Session identity.** Stdio MCP servers receive `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE=1` and `CLAUDE_PROJECT_DIR` in their environment (CHANGELOG).

**Consequence for auth.** frond-ear needs **no Anthropic credentials at all**. The shim runs inside the session that is already logged in, so it works with whatever login that Claude uses, including Pro/Max OAuth.

### 3.2 The official Discord plugin

The plugin is `plugin:discord@claude-plugins-official` (Apache-2.0), read at `anthropics/claude-plugins-official@ad30d62`, `external_plugins/discord/server.ts`. It is push-based, but:

- **Scope:** the discord.js gateway runs inside the MCP process, so it lives and dies with one session, and one session receives every channel.
- **Bot authors are all dropped** (`msg.author.bot`). OpenClaw agents can never reach the session.
- **Unmentioned guild messages are dropped** (`requireMention` defaults to true). They can't become context, and `--no-mention` turns every message into a full prompt.
- **No reliability or throttling:** no debounce, dedupe or durable queue, and no caps or rate limits.
- **What it gets right, and v1 mirrors:**
  - the tool surface: `reply` with 2000-character chunking, `react`, `edit_message`, `fetch_messages`, `download_attachment`;
  - putting identity in `meta` rather than in content ("an in-content annotation is forgeable");
  - operator-authored instructions that refuse access changes requested from chat.

### 3.3 Other push paths considered

| Mechanism | Verdict |
|---|---|
| **Plugin monitors** (`experimental.monitors`) | Viable second carrier. It needs no dev flag: a background command's stdout reaches Claude as notifications. It works only in interactive sessions and is experimental. Tracked as an exploratory issue. |
| **Hooks** (`asyncRewake`, `additionalContext`) | Suitable for **operator-authored** context only, e.g. restating the ear's identity after `/clear` or compaction. Routing Discord content through hooks would promote third-party text to harness authority, so v1 won't do it. |
| **`claude -p --resume` per batch, or Agent SDK streaming input** | Headless only. These can't reach an open TUI. They are a reasonable fit for the future Copilot-style "frond-ear owns the session" target. |
| **tmux `send-keys`** | Rejected. It *is* impersonating the user, which is exactly the behaviour to avoid. |

### 3.4 OpenClaw patterns (MIT)

Source: `openclaw/openclaw@74a22a9`, © 2026 OpenClaw Foundation, MIT. v1 re-implements these ideas rather than copying code. If code is ever ported, the MIT notice travels with it.

- **Inbound debounce, keyed per sender.** The key is `discord:<account>:<channel>:<author>`, with maxWait at 5× the debounce. Media and commands bypass it (`src/auto-reply/inbound-debounce.ts`, `src/channels/inbound-debounce-policy.ts`).
- **Queue modes** `steer|followup|collect|interrupt`, with `cap` and `drop: old|new|summarize` (`docs/concepts/queue.md`).
- **Mention gating plus a history buffer.** Unmentioned messages are kept and prefixed with `[Chat messages since your last reply - for context]` (`src/auto-reply/reply/history.ts`).
- **Ambient `room_event` mode** (`docs/channels/ambient-room-events.md`).
- **Bot-loop protection:** 20 events per 60s, then a 60s cooldown.
- **A durable inbound journal with tombstones** (`src/channels/message/durable-receive.ts`).

## 4. v1 architecture

```
Discord ──ws──▶ frond-ear daemon  (local user process; container later)       ◀── bot token lives ONLY here
                 gateway ─▶ policy ─▶ SQLite ledger ─▶ scheduler ─▶ ear hub
                 (trust class, modes,  (dedupe, events,   (quiet window +    │
                  bot allow + loop     batches, ears,     max delay, history │
                  limiter, threads)    gateway cursor)    buffer, caps)      │
                 Discord REST out (reply chunking, react, edit, history, 429)│
                                                                             │ NDJSON over unix socket (0600)
Claude Code TUI (its own login) ──stdio──▶ frond-ear shim (MCP, hand-rolled) ─┘
    <channel source="frond-ear" chat_id=… kind=mention|room|dm|digest trust=principal|peer_agent|ambient …>
    tools: reply · react · edit_message · fetch_messages · inbox · ack · ear_status
```

### 4.1 Ears and typed bindings

- **Ears.** An **ear** is a named delivery target, for example `frond-scribe`. It is typed with `target: "claude-channel"`, and `"copilot-sdk"` and `"claude-monitor"` are reserved for later.
- **Channel ownership.** Discord channels and DMs are bound to exactly one ear, each with a mode.
- **Claiming an ear.** A shim claims an ear only when `FROND_EAR_EAR=<name>` is set. Otherwise it serves tools only, because a user-scope MCP server is launched in *every* Claude Code session.
- **Takeover.** Each ear has one attached shim. The newest shim takes over, and the attach generation is fenced, so offers made to an older attach never count as delivered to the new one.

### 4.2 Delivery modes

| Mode | What is stored | What wakes the session |
|---|---|---|
| `silent` | every allowed message | nothing; available through `inbox`/`fetch_messages` |
| `mentions` (default) | every allowed message | @mention (`<@id>` or `<@!id>`), a reply to the bot, a `mentionPatterns` match, or a DM. A principal's unaddressed message is context: trust grants command authority, not interrupt authority. Other traffic becomes **context** attached to the next wake, capped by `historyLimit`. |
| `room` | every allowed message | every message, debounced |

**Debounce.** A channel with anything waiting to wake is flushed at the earlier of two times:
- `quietWindowMs` after the most recent message;
- `maxDelayMs` after the first pending message.

Priority triggers (mentions and DMs) use the shorter `priorityQuietMs`, so a quick follow-up still merges into the same batch, and nearby context rides along with it. One notification is sent per channel flush.

### 4.3 Delivery ledger

A notification promise proves nothing, so the ledger tracks what the model has *acted on*:

```
context ─┐
queued  ─┴─▶ offered(batch, attach_gen) ─▶ seen      (silent: stored ─▶ seen via inbox)
context ─▶ expired (history cap)              queued ─▶ dropped (per-ear cap; counted, surfaced)
```

- **`seen`** is set when the model calls `reply`, `react`, `edit_message`, `fetch_messages`, `inbox` or `ack` for that chat.
- **On attach:**
  - never-offered queued events are delivered normally;
  - events offered to an earlier attach and never seen produce **one digest**, not a replay.
- **Attach canary (optional).** The daemon can ask Claude to call `ack(nonce)` when a shim attaches. Until Claude does, `ear_status` reports `registered: false`, which catches the silent-drop cases: missing flag, org policy, or protocol negotiation.

### 4.4 Trust: the honest version of "as if of self"

**The requirement:** Discord messages should reach Claude as its own trusted senses, not as user prompts that interrupt it.

What frond-ear does:

1. **Non-interruption comes from the carrier.** Channel events queue while Claude is busy and are delivered on the next turn. They are not keystrokes and not user turns.
2. **Trust comes from verified identity, never from content.** The daemon classifies each author ID as one of:
   - `principal`: the operators;
   - `peer_agent`: configured OpenClaw and other agents;
   - `ambient`: everyone else.

   The class travels in channel `meta`, which message text cannot set.
3. **Operator-authored `instructions`** establish that frond-ear is Claude's own ear:
   - principal requests carry the operator's authority;
   - peer agents are collaborators;
   - ambient text is room context to read, never instructions to follow.
4. **Rendering resists forgery.** Every line of message text is quoted with `> ` under a daemon-written header, so a message that fakes a header stays visibly quoted. `<channel`/`</channel` sequences are neutralised.

**What it cannot do:** channel content does not become system-prompt authority, and v1 doesn't try to make it. "Trusted" means *the operator has told Claude this sender speaks for them*, and Claude still applies its own judgement.

**Copilot equivalent:** SDK `source: "system"` is unreleased at the pinned SDK version. The Copilot-parity issue will use it once it ships.

### 4.5 Auth and configuration discovery

| Link | Mechanism |
|---|---|
| **Claude ↔ frond-ear** | The shim runs inside the user's authenticated session and inherits its login. The shim reports `CLAUDE_CODE_SESSION_ID` and its client info in `hello`, and `ear_status` shows them. |
| **frond-ear ↔ Discord** | The bot token comes from `DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN_FILE`, only in the daemon. It is never passed to the shim, the model or the logs, and a credential scan runs in `pnpm check`. |
| **shim ↔ daemon** | A unix socket in a 0700 directory, with the socket itself at 0600. Container or TCP mode uses a loopback port plus a token file. |

### 4.6 Context budget for weeks-long sessions

- Each notification is capped (`maxNotificationChars`, default 6000). Overflow is summarised with a pointer to `inbox`.
- The history buffer is capped per channel.
- The daemon ledger is the source of truth after compaction.

## 5. Relationship to issue #1

| Issue #1 requirement | v1 disposition |
|---|---|
| Gateway `MESSAGE_CREATE`, reconnect/resume | kept (salvaged client, fixed) |
| Token only via env or secret file, never logged | kept |
| Allowlisting, author/mention priority, pause/kill switch, dedupe, burst coalescing, suppression | kept: modes, trust classes, `paused`, dedupe on message id, debounce, bot-loop limiter |
| Durable SQLite queue with restart-safe cursor | kept, as a ledger (`queued/offered/seen`) rather than leases |
| Read/lease/ack interface plus a separate wake adapter | replaced by the ear protocol plus channel shim, which is a real wake |
| Health/status surface | `ear_status` tool and `frond-ear status` CLI |
| Channel-bound session registry, generations, admin `/new` | ears with attach generations. `/new` is **not applicable** to the Claude target, because frond-ear does not create Claude sessions. It is reserved for the Copilot target. |
| `silent|mentions|room` modes | implemented per channel |
| "Provenance explicit and untrusted" | refined: provenance is explicit; principal and peer classes are trusted **by operator policy**; ambient stays untrusted |
| Canary never targets the primary frond-scribe session | kept. The runbook proves delivery on a disposable session first, using `--dry-run` with injected messages. |

## 6. Risks

- **Research preview.** The channels protocol and flags may change. Mitigations: the shim is thin, it pins its protocol version, and it has a conformance test against the MCP SDK client.
- **Dev-flag dialog.** The development-channels flag shows a confirmation dialog at startup. That is fine for a supervised TUI but needs checking for unattended restarts.
- **Silent drops.** Mitigated by the attach canary and `registered` status.
- **Bot ping-pong** between frond-scribe and OpenClaw agents. Mitigated by the loop limiter; the loop is broken for wakes, not for storage.
- **Permission prompts stall a long session.** The runbook adds allow rules for the frond-ear tools.

## 7. Verification matrix (live-only checks)

These cannot be proven offline. Each one is owned by an issue in the v1 epic.

| Check | Where |
|---|---|
| Channel registers in server form and plugin form with the dev flag | MVP e2e / packaging |
| Idle session wakes; a busy session batches without interrupting; exact `source` string | MVP e2e |
| Pinned protocol version accepted on both v1 and v2 MCP runtimes | shim |
| `CLAUDE_CODE_SESSION_ID` behaviour across `/clear`, resume and compaction | packaging / lifecycle |
| How Claude treats principal vs ambient events in practice | trust hardening |
| Real Discord: intents (4014), mention forms, OpenClaw bot pass-through, loop limiter | MVP e2e / delivery policy |
| Plugin monitor framing and deadline | monitor spike |
