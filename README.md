# frond-ear

> **What it is.** A self-hosted bridge that lets a long-running AI agent take part in a Discord server. A daemon holds your Discord bot's Gateway connection, filters what arrives, and pushes it into a live Claude Code session as MCP channel events, or into a GitHub Copilot CLI session through an extension. The agent answers with tools such as `reply` and `react`.
>
> **Who it's for.** Anyone who keeps a Claude Code or Copilot CLI session running as an agent and wants it to hear and answer in Discord as messages arrive, instead of polling. You host it yourself, with your own bot. karmaterminal built it for its own agents.
>
> **Not affiliated with Anthropic, Discord or GitHub.** frond-ear is an independent project, and none of them makes, endorses or supports it.

A Discord Gateway **ear** for long-running Claude Code sessions.

Existing Discord MCP plugins are pull-based: a session only learns about new messages by polling. frond-ear instead holds the bot's Gateway connection open and filters what arrives:

- debounces bursts of messages
- keeps unmentioned room chatter as context
- breaks bot-to-bot loops

It then **pushes** the result into a live Claude Code session as [channel](https://code.claude.com/docs/en/channels) events. Events that arrive while Claude is busy wait for its next turn, and they are never typed in as if they were user input. Claude answers through the shim's ten tools: `reply`, `react` and `edit_message` post; `fetch_messages`, `inbox`, `fetch_attachment` and `hear` read; `ack` marks events seen; `set_attention` narrows what it hears; and `ear_status` checks that the ear works.

```
Discord ──ws──▶ frond-ear daemon ──unix socket──▶ frond-ear shim ──stdio (MCP channel)──▶ Claude Code
               (bot token, SQLite ledger,                    (launched by Claude Code; uses the
                debounce, trust classes)                      session's own login)
```

- **Trust comes from the verified author ID, never from message text.** Each message is classed as `principal`, `peer_agent` or `ambient`. The class travels in channel attributes that message content cannot forge, and operator-authored channel instructions tell Claude how to weigh each one.
- **Nothing is lost while a session is away.** A durable ledger tracks every event through `queued → offered → seen`, and anything still waiting is delivered when the session reattaches.
- **No Anthropic credentials needed.** The shim rides on the Claude Code session's own login.
- **No runtime dependencies.** Node ≥ 22.18 runs the TypeScript directly.

## Quick start

```sh
git clone https://github.com/karmaterminal/frond-ear && cd frond-ear
node src/cli.ts init      # asks for the bot's ID, your IDs, the channels and the token
export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
node src/cli.ts doctor    # read-only: ✓/✗ per check, a fix line for each ✗
```

`init` writes two files, `~/.config/frond-ear/frond-ear.json` and the 0600 token file, validates
the config before writing, and prints the steps it cannot do for you: start the daemon (or
`ops/install-systemd.sh`), `claude mcp add` in the project that owns the ear, and the launch flag
`--dangerously-load-development-channels server:frond-ear`. The daemon, `doctor` and
`ops/install-systemd.sh` read the config and token only from `FROND_EAR_CONFIG` and
`DISCORD_BOT_TOKEN_FILE` (the daemon's own default is `./frond-ear.json`), which is why the two
`export` lines come before `doctor`; `init` also prints them in front of every command. `doctor`
then checks config, token, socket, daemon, gateway and each ear: config and token pass at once,
and the socket and daemon checks stay ✗ until you start the daemon. An agent can run
`init --non-interactive` with flags and needs only the token and the IDs from you.

- [`docs/onboarding.md`](docs/onboarding.md): the contract. Every config field and where it comes
  from, what `init` writes and what stays manual, what `doctor` checks and what it refuses to probe.
- [`docs/runbook.md`](docs/runbook.md): the manual path, stage by stage, with the dry-run proof of
  delivery on a throwaway session before you hand the ear to a long-running one.

## GitHub Copilot CLI

An ear can serve a Copilot CLI session instead of a Claude Code one (`target: "copilot-extension"`, #13). A Copilot CLI **extension** is the Copilot-side shim. It joins the live interactive session, speaks the same ear protocol, and pushes each event as a `<channel>` element through `session.send({ source: "system", mode: "enqueue" })`, so events wait for the next turn instead of interrupting. It exposes the same tools, generated from the shim's own definitions. Each attach prefixes its daemon instructions to its first push, so a reconnect carries the new daemon's instructions. A failed tool call returns the SDK's failure result (`resultType: "failure"`, or `"timeout"`), not success text.

1. In the daemon config, set `ears.<name>.target` to `"copilot-extension"`.
2. Install the extension: `node src/cli.ts copilot-extension --ear <name>`. It writes to `$COPILOT_HOME/extensions/frond-ear/`, with `config.json` at 0600.
3. Start Copilot with extensions enabled: `copilot --experimental`. The attach canary works the same way: `ack` its nonce.

**After upgrading frond-ear, re-run the install** (step 2), with the `FROND_EAR_SOCKET`, or `FROND_EAR_TCP` and `FROND_EAR_TOKEN_FILE`, that the daemon uses: the install writes the daemon's address into `config.json`. It copies the extension's files and the shim's tool schemas, so an existing install keeps the old ones until it is reinstalled and lacks any tool added since. An install from before #30 also still declares `batch_id` as a number, so its session cannot pass a pushed id as the `<channel>` element shows it (`N-<token>`), one of the two ways to prove delivery.

Copilot extensions are experimental. An extension reloads on `/clear`, which is just a re-attach. A `source: "system"` message is still a user-message event tagged as system, not a separate channel type, and the trust model is unchanged: trust comes from verified author IDs in the element's attributes, never from text.

## Docs

- [`docs/spike/2026-09-claude-channel-gateway.md`](docs/spike/2026-09-claude-channel-gateway.md) explains the design: an assessment of prior work, Claude Code channels, the OpenClaw patterns it borrows, and the trust model and its limits.
- [`docs/runbook.md`](docs/runbook.md) covers setup and operation.
- The roadmap is epic karmaterminal/frond-ear#2.
