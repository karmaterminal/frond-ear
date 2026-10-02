# frond-ear

A Discord Gateway **ear** for long-running Claude Code sessions.

Existing Discord MCP plugins are pull-based: a session only learns about new messages by polling. frond-ear instead holds the bot's Gateway connection open and filters what arrives:

- debounces bursts of messages
- keeps unmentioned room chatter as context
- breaks bot-to-bot loops

It then **pushes** the result into a live Claude Code session as [channel](https://code.claude.com/docs/en/channels) events. Events that arrive while Claude is busy wait for its next turn, and they are never typed in as if they were user input. Claude answers through the shim's tools: `reply`, `react`, `edit_message`, `fetch_messages`, `inbox` and `ack`.

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
node src/cli.ts doctor    # read-only: ✓/✗ per check, a fix line for each ✗
```

`init` writes two files, `~/.config/frond-ear/frond-ear.json` and the 0600 token file, validates
the config before writing, and prints the steps it cannot do for you: start the daemon (or
`ops/install-systemd.sh`), `claude mcp add` in the project that owns the ear, and the launch flag
`--dangerously-load-development-channels server:frond-ear`. `doctor` then checks config, token,
socket, daemon, gateway and each ear. An agent can run `init --non-interactive` with flags and
needs only the token and the IDs from you.

- [`docs/onboarding.md`](docs/onboarding.md): the contract. Every config field and where it comes
  from, what `init` writes and what stays manual, what `doctor` checks and what it refuses to probe.
- [`docs/runbook.md`](docs/runbook.md): the manual path, stage by stage, with the dry-run proof of
  delivery on a throwaway session before you hand the ear to a long-running one.

## Docs

- [`docs/spike/2026-09-claude-channel-gateway.md`](docs/spike/2026-09-claude-channel-gateway.md) explains the design: an assessment of prior work, Claude Code channels, the OpenClaw patterns it borrows, and the trust model and its limits.
- [`docs/runbook.md`](docs/runbook.md) covers setup and operation.
- The roadmap is epic karmaterminal/frond-ear#2.
