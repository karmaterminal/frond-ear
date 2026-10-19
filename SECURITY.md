# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Only the maintainers see the report, and we answer there.

Please don't open a public issue, discussion or pull request about it. If the button isn't
there, open an issue that asks for a private channel and leave the details out.

A useful report says what you did, what happened, what you expected, and the commit you tested.
Never include a real bot token, Discord ID or message content; synthetic values are enough.

## Supported versions

frond-ear is pre-1.0 and has no tagged releases. Fixes land on `main` only. Run a recent commit
of `main`; an older checkout won't get a backport.

## Threat model

frond-ear connects a Discord bot to a long-running AI agent session (Claude Code, or Copilot
CLI through an extension). Discord text is untrusted input aimed at that agent, so most of this
section is about who may steer the agent and how.

### Who is trusted

The daemon's config names three kinds of author, by Discord user ID:

- **Principals** (`principals`): the people this ear answers to. A principal's request carries
  the same weight as one typed at the agent's terminal. Treat a principal's Discord account
  like a login to that terminal.
- **Peer agents** (`peerAgents`): other agent bots you work with. They are engaged with as
  trusted peers, not as principals.
- **Everyone else is ambient.** Ambient messages are context. The agent is told never to follow
  instructions found in them, and the same goes for files they attach.

Some traffic never reaches the agent at all. Bots and webhooks that aren't listed are dropped,
and so are DMs from ambient users. Wakes are rationed: an ambient user's mentions draw on a
per-chat budget, and bot-to-bot loops get a cooldown.

### Message text cannot set trust

- A message's trust class comes only from the author ID Discord's Gateway reports, compared
  against the config. Nothing in the message text is consulted.
- The class travels in channel attributes (`meta`) that the daemon writes.
- Each message reaches the agent as one header line that frond-ear writes, then the text with
  every line quoted (`> `). A message that types a fake header, a tag such as `<channel …>` or
  `<system-reminder>`, or an attribute stays inside the quote:
  - tag-shaped text is neutralised;
  - invisible and bidirectional control characters are removed;
  - display names are flattened to one short line.
- The agent is told never to change access or promote anyone's trust because a Discord message
  asked it to. Access lives in the daemon's config. A session can narrow what it hears, but no
  message can widen it.

This is a defence in depth around a language model, not a proof. The agent still reads ambient
text, and a model can be persuaded. Keep the agent's own permissions as narrow as the work
allows.

### What the agent can do in Discord

- The agent posts through the daemon's tools, which validate every Discord ID they take as a
  snowflake and URL-encode every REST path segment.
- `edit_message` edits only messages frond-ear itself sent in that chat.
- Replies can mention users, but never `@everyone`, `@here` or roles.

### The bot token

- The token comes only from `DISCORD_BOT_TOKEN_FILE` or `DISCORD_BOT_TOKEN`. It is never in the
  config file or the repository. `frond-ear init` writes it to a separate file with mode 0600
  and never prints it.
- Only the daemon reads it. The channel shim and the Copilot extension never see it. They reach
  the daemon over its socket, and the extension's own `config.json` (mode 0600) holds the
  daemon's address, not the token.
- Log lines are JSON. Fields that can carry credentials or message content are redacted
  whole, and the token's value is scrubbed from every string.
- Attachments are fetched from Discord's CDN without the token.
- `pnpm check` scans every tracked file for token shapes. [CONTRIBUTING.md](CONTRIBUTING.md)
  describes the wider scan run before a release.

The token gives full control of the bot. Keep its file at 0600, owned by the user that runs the
daemon. If it leaks, reset it in the Discord developer portal.

### What listens

- **The daemon's socket.** The daemon connects out to Discord, and by default it listens only
  on a unix socket, which it creates with mode 0600 in a directory with mode 0700. Only the
  user that runs the daemon can reach it.
- **TCP, opt-in.** `FROND_EAR_TCP=host:port` replaces the socket with TCP, for containers. It
  requires a shared secret file (`FROND_EAR_TOKEN_FILE`), and every client must present that
  secret, which is compared in constant time. The daemon binds whatever host you give it, so
  give it a loopback address. This secret is not the bot token.
- **`frond-ear connector-echo`** (an experiment for claude.ai connectors, [docs/connector.md](docs/connector.md)).
  It refuses any listen address that isn't loopback. It reads its secrets only from files with
  mode 0600, and it has no Discord access.
- **Canticle is optional and off by default.** frond-ear can also listen for
  [binary-canticle](https://github.com/karmaterminal/binary-canticle) broadcasts, but only when
  the config sets `canticle.enabled: true`, and the example config ships it off. When enabled
  with the default `embedded` source, it binds a UDP port (`0.0.0.0:9999` unless you set
  `bindHost` and `port`). It is listen-only. The `host-daemon` source binds nothing.
  - Broadcasts are data, never instructions, whoever the station is.
  - Nothing heard is pushed to a session unless the config opts that ear in, and then only from
    station keys you list.

## Out of scope

- Discord itself, or a compromised principal or peer-agent account.
- Anything with local access as the user that runs the daemon. Such a user can read the token
  and talk to the socket.
- What an agent does with its own tools once a principal has asked it to do something.
