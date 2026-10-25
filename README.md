# frond-ear

> **What it is.** A self-hosted bridge that lets a long-running AI agent take part in a Discord server. A daemon holds your Discord bot's Gateway connection, filters what arrives, and pushes it into a live Claude Code session as MCP channel events, or into a GitHub Copilot CLI session through an extension. The agent answers with tools such as `reply` and `react`.
>
> **Who it's for.** Anyone who keeps a Claude Code or Copilot CLI session running as an agent and wants it to hear and answer in Discord as messages arrive, instead of polling. You host it yourself, with your own bot. karmaterminal built it for its own agents.
>
> **Status.** Pre-1.0. Claude Code has to be started with `--dangerously-load-development-channels server:frond-ear`, and Copilot CLI with `--experimental`.
>
> **Not affiliated with Anthropic, Discord or GitHub.** frond-ear is an independent project, and none of them makes, endorses or supports it.

A Discord Gateway **ear** for long-running Claude Code (or Copilot CLI) sessions.

Existing Discord MCP plugins are pull-based: a session only learns about new messages by polling. frond-ear instead holds the bot's Gateway connection open and filters what arrives:

- debounces bursts of messages
- keeps unmentioned room chatter as context
- breaks bot-to-bot loops

It then **pushes** the result into a live Claude Code session as [channel](https://code.claude.com/docs/en/channels) events. Events that arrive while Claude is busy wait for its next turn, and they are never typed in as if they were user input. Claude answers through the shim's twelve tools: `reply`, `react` and `edit_message` post; `fetch_messages`, `inbox`, `fetch_attachment`, `hear` and `sitrep` read; `ack` marks events seen; `set_attention` and `set_canticle_delivery` narrow what it hears; and `ear_status` checks that the ear works.

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

This is the whole path from a fresh clone to the session's first reply in Discord.

**Before you start**, you need two things that frond-ear cannot set up for you:

- **A Discord bot.** In the [Discord Developer Portal](https://discord.com/developers/applications),
  create an application with a bot, and turn on **Message Content Intent** under
  _Bot → Privileged Gateway Intents_. Invite the bot to your server with _View Channels_,
  _Send Messages_, _Send Messages in Threads_, _Read Message History_ and _Add Reactions_, and keep
  its token to hand. With Discord's Developer Mode on (right-click → Copy ID), copy the bot's user
  ID, your own user ID (you give it to `init` as a principal, someone the session answers to)
  and the IDs of the channels it should hear.
- **Node.js ≥ 22.18 and Claude Code ≥ 2.1.128**, logged in with claude.ai or a Console API key.
  Channels don't work on Bedrock, Vertex or Foundry, and in a Team or Enterprise org an Owner must
  enable them first ([runbook §0](docs/runbook.md#0-prerequisites)).

**1. Clone, configure and check.**

```sh
git clone https://github.com/karmaterminal/frond-ear && cd frond-ear
node src/cli.ts init      # asks for the IDs, a name for the ear, its channels and the token
export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
node src/cli.ts doctor    # read-only: ✓/✗ per check, a fix line for each ✗
```

`init` validates the config, writes `~/.config/frond-ear/frond-ear.json`, and prints the commands
for steps 2 to 4, numbered its own way, with your paths and ear name filled in. It writes the 0600
token file `~/.config/frond-ear/token` only if you paste the token. If the token is already in a
file, `init` uses that file, so export its path instead; if you skip, `init` prints the command
that creates the file. An agent can run `init --non-interactive` with flags instead: it needs
only the IDs from you, and you write the token file yourself, as in
[onboarding §6](docs/onboarding.md#6-agent-onboarding). The daemon and `doctor` find the config
and token only through `FROND_EAR_CONFIG` and `DISCORD_BOT_TOKEN_FILE` (the daemon's own default
is `./frond-ear.json`), so every terminal that runs them needs the two `export` lines. Once the
token file holds the token, `doctor` passes config and token, and its socket and daemon checks
stay ✗ until step 2.

**2. Start the daemon** in a second terminal, in the checkout. It runs in the foreground, so leave
it there:

```sh
export FROND_EAR_CONFIG="$HOME/.config/frond-ear/frond-ear.json"
export DISCORD_BOT_TOKEN_FILE="$HOME/.config/frond-ear/token"
node src/cli.ts daemon
```

To keep it running across reboots, stop this daemon and run `ops/install-systemd.sh` instead. It
installs a systemd user unit for the files `init` wrote, and warns if lingering, which a reboot
needs, is off.

Back in the first terminal, run `doctor` again. Once the daemon has connected, it exits 0, and the
one ✗ left is the ear's advisory `attached` check, which passes once step 4 attaches a session.

**3. Register the shim** in a directory of its own, so that no other Claude Code session claims
the ear. `<ear>` is the name you gave `init`, which prints this line with your paths filled in:

```sh
mkdir -p ~/ear-trial && cd ~/ear-trial
claude mcp add -s local frond-ear -e FROND_EAR_EAR=<ear> -- node /abs/path/to/frond-ear/src/cli.ts shim
```

To let the ear's tools run without a prompt each time, put
`{ "permissions": { "allow": ["mcp__frond-ear"] } }` in `.claude/settings.local.json` there.

**4. Launch Claude Code there** with the channel flag. It asks you to trust the folder and to
confirm the development-channel flag:

```sh
claude --dangerously-load-development-channels server:frond-ear
```

**5. Check the attach.** The session gets an attach event and `ack`s its nonce. Ask it to call
`ear_status`, or run `node src/cli.ts status` in the checkout: the gateway should be `connected`
and the ear's delivery `confirmed`.

**6. Get a first reply.** From the account you gave `init` as a principal, @mention the bot with
a question in one of the ear's `mentions` channels (the mode `init` offers by default). The
session wakes, and its answer appears in the channel.

For a Copilot CLI session, steps 3 and 4 are the three steps under
[GitHub Copilot CLI](#github-copilot-cli) instead. That path is covered by tests against a fake
session, but no live Copilot CLI attach has been proved yet.

**If a step fails,** start with `doctor` and the `fix:` lines it prints. The failures a new
install usually meets:

- `doctor` marks config and token ✗: that terminal lacks the two `export` lines.
- The daemon exits with close code 4014: Message Content Intent is off. Close code 4004 means the
  token is wrong.
- `attached` stays `false` while the session runs: `FROND_EAR_EAR` names an ear the config does
  not have.
- `registered` stays `false`: Claude Code was started without the channel flag, or an org policy
  blocks channels.

The runbook's [Troubleshooting](docs/runbook.md#troubleshooting) table has more, and
[`docs/recovery.md`](docs/recovery.md) covers a reboot, a stopped daemon and a session that is
gone. `tools/clean-install/receipt.sh` runs this same path against a stand-in for Discord and a
real Claude Code session, and [`docs/proofs/clean-install/`](docs/proofs/clean-install/README.md)
holds its records.

Once the trial works, remove its registration (`claude mcp remove -s local frond-ear` in
`~/ear-trial`) and attach the session you mean to keep, as in
[runbook §5](docs/runbook.md#5-attach-the-long-running-session).

- [`docs/onboarding.md`](docs/onboarding.md): the contract. Every config field and where it comes
  from, what `init` writes and what stays manual, what `doctor` checks and what it refuses to probe.
- [`docs/runbook.md`](docs/runbook.md): the manual path, stage by stage, with the dry-run proof of
  delivery on a throwaway session before you hand the ear to a long-running one.

## binary-canticle: alerts and distress

An ear can also hear [binary-canticle](https://github.com/karmaterminal/binary-canticle) stations (off by
default; [runbook §8](docs/runbook.md#8-hear-binary-canticle-optional)). For a seat's `distress` and `alerts`
streams (frond-ear#85):

- **Per stream.** `canticle.delivery.<ear>.streams` sets each stream's ceiling (`"distress": "immediate"`,
  `"alerts": "digest"`), and the session narrows within it with `set_canticle_delivery`'s `stream`.
- **What did I miss.** `sitrep(streams: ["distress", "alerts"])` shows what stands on them now: one entry per
  station and state_key, the newest standing. An incident missing from it is not resolved.
- **Who speaks.** A watcher's finding about another seat is bannered as the watcher's report, never as that seat
  speaking. Heard text stays data either way: it can't authorize an action.

## GitHub Copilot CLI

An ear can serve a Copilot CLI session instead of a Claude Code one (`target: "copilot-extension"`, #13). A Copilot CLI **extension** is the Copilot-side shim. It joins the live interactive session, speaks the same ear protocol, and pushes each event as a `<channel>` element through `session.send({ source: "system", mode: "enqueue" })`, so events wait for the next turn instead of interrupting. It exposes the same tools, generated from the shim's own definitions. Each attach prefixes its daemon instructions to its first push, so a reconnect carries the new daemon's instructions. A failed tool call returns the SDK's failure result (`resultType: "failure"`, or `"timeout"`), not success text.

1. In the daemon config, set `ears.<name>.target` to `"copilot-extension"`.
2. Install the extension: `node src/cli.ts copilot-extension --ear <name>`. It writes to `$COPILOT_HOME/extensions/frond-ear/`, with `config.json` at 0600.
3. Start Copilot with extensions enabled: `copilot --experimental`. The attach canary works the same way: `ack` its nonce.

**After upgrading frond-ear, re-run the install** (step 2), with the `FROND_EAR_SOCKET`, or `FROND_EAR_TCP` and `FROND_EAR_TOKEN_FILE`, that the daemon uses: the install writes the daemon's address into `config.json`. It copies the extension's files and the shim's tool schemas, so an existing install keeps the old ones until it is reinstalled and lacks any tool added since. An install from before #30 also still declares `batch_id` as a number, so its session cannot pass a pushed id as the `<channel>` element shows it (`N-<token>`), one of the two ways to prove delivery.

Copilot extensions are experimental. An extension reloads on `/clear`, which is just a re-attach. A `source: "system"` message is still a user-message event tagged as system, not a separate channel type, and the trust model is unchanged: trust comes from verified author IDs in the element's attributes, never from text.

## claude.ai custom connector (#53, echo step)

`node src/cli.ts connector-echo` runs a read-only MCP server for a claude.ai custom connector, so
a claude.ai web session can reach a seat through Tailscale Funnel. This first step has **no
Discord access**: its tools are `echo` and `connection_info`, and it exists to prove which MCP
transport and auth the connector actually uses, with one log line per request. It listens on
loopback only and takes no auth, a bearer token, or a single-owner OAuth sign-in.
[`docs/connector.md`](docs/connector.md) has the flags, the claude.ai dialog settings for each
auth mode, and the proof steps for the seat and figs. The Discord facade is a later PR.

## Docs

- [`docs/spike/2026-09-claude-channel-gateway.md`](docs/spike/2026-09-claude-channel-gateway.md) explains the design: an assessment of prior work, Claude Code channels, the OpenClaw patterns it borrows, and the trust model and its limits.
- [`docs/runbook.md`](docs/runbook.md) covers setup and operation.
- [`docs/connector.md`](docs/connector.md) covers the claude.ai connector's echo step (#53).
- The roadmap is epic karmaterminal/frond-ear#2.
