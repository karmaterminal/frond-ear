# frond-ear — notes for Claude sessions working in this repo

frond-ear is a Discord Gateway daemon that pushes debounced, trust-classified events into a long-running Claude Code session through a thin channel shim, a stdio MCP server that declares `claude/channel`. Replies go back out through its tools.

- Direction and rationale: `docs/spike/2026-09-claude-channel-gateway.md`.
- Operating it: `docs/runbook.md`.

## Stack and conventions

- **Runtime.** Node ≥ 22.18, target 24. TypeScript runs through Node's built-in type stripping, so there is **no build step**.
  - Source imports use `.ts` extensions.
  - Only erasable syntax is allowed. No `enum`, no `namespace`, no constructor parameter properties. `tsc` enforces this with `erasableSyntaxOnly`.
- **Dependencies.** The daemon and shim have **zero runtime dependencies**. They use `node:sqlite`, the global `WebSocket` and `fetch`, and `node:net`.
  - Dev dependencies are `typescript`, `@types/node`, `prettier`, and `@modelcontextprotocol/sdk`. The SDK is used only as a conformance client in tests.
- **Tests.** `node:test` with fakes: `FakeClock`, `FakeSocket`, the fake REST client, and a fake shim over a real socket. Tests never touch real Discord or a real Claude session.
- **Checks.** `pnpm check` runs, in order:
  1. `format:check`
  2. `typecheck`
  3. `test`
  4. `scan:credentials`

  Run it before pushing. CI runs the same thing.

- **Secrets.**
  - The bot token only ever comes from `DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN_FILE`.
  - Never log it or pass it to the shim.
  - Never commit real IDs or tokens. Fixtures use placeholder IDs.

## Invariants to preserve

- **Where trust comes from.** A trust class comes only from the verified Discord author ID and is carried in channel `meta`, never in message content. Message text is always rendered quoted (`> `) under a header the daemon writes.
- **How the shim delivers.** The shim never pretends to be user input, and it negotiates a pinned MCP protocol version. Revision `2026-07-28` breaks channel registration.
- **Ledger states.** Events move `context|queued → offered → seen`, or `stored → seen` for silent channels. Only tool activity from the model marks events `seen`. A tool action acknowledges only confirmed batches up to the `batch_id` it names, or up to the latest confirmed batch when the call starts. A batch offered later stays unseen. Admission (insert, schedule, caps) is one transaction.
- **Outbound IDs.** Every Discord ID from a tool is validated as a snowflake, and every REST path segment is URL-encoded. `edit_message` only edits messages frond-ear sent in that same chat.
- **Bot token.** It exists only in the daemon.
