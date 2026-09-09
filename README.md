# frond-ear

`frond-ear` is a small Discord Gateway ingress service for frond-scribe. It
accepts allowlisted `MESSAGE_CREATE` events, applies deterministic suppression
and priority policy, and stores them in a durable SQLite lease/ack queue. It is
an ear and bounded wake bridge, not a Discord speaker or administration tool.
It does not modify or replace the running Discord MCP container.

## Safety model

- Guild and channel allowlists are mandatory. Empty allowlists accept nothing.
- The service ignores its own messages. Configured figs authors and direct bot
  mentions override author, pattern, and event-class suppression, but never the
  guild or channel allowlists.
- Discord bodies are untrusted data. Summaries label them as data, are bounded,
  and retain message, author, guild, channel, timestamp, and link provenance.
- Queue rows have explicit `pending`, `leased`, `delivered`, and `dead_letter`
  states. Claims use random tokens and expiring leases; stale leases recover on
  restart or the next claim.
- Normal bursts share a channel quiet window and lease as one bounded summary.
  Priority events remain separate and are leased first. Continuous traffic
  cannot defer a routine row beyond `maxCoalesceWindowMs`.
- Queue count and UTF-8 weight are bounded. Normal overflow is explicitly
  dead-lettered. Priority admission first dead-letters the oldest pending
  non-priority rows; if it still cannot fit, the priority row is explicitly
  dead-lettered rather than silently discarded.
- Structured logs redact fields named like tokens, secrets, content, payloads,
  or bodies, and replace the configured token anywhere else.
- The HTTP server rejects non-loopback bind addresses.

## Setup

Requires Node.js 24 or newer and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm build
cp policy.example.json policy.json
```

Edit `policy.json` with Discord IDs and policy bounds. The bot must have the
Gateway `Guild Messages` and privileged `Message Content` intents enabled.

The token is read only from `DISCORD_BOT_TOKEN`. On a host that already has a
protected environment file, source that file into the service process without
printing it:

```sh
set -a
. /path/to/protected/runtime.env
set +a
pnpm start
```

Do not use `cat`, shell tracing (`set -x`), command-line token arguments, or
copy the protected file into this repository. For systemd, point
`EnvironmentFile=` in `deploy/frond-ear.service` at the existing protected
file. Keep it owned by the service administrator and unreadable by other users.

Configuration environment variables:

| Variable                       | Default               | Purpose                               |
| ------------------------------ | --------------------- | ------------------------------------- |
| `DISCORD_BOT_TOKEN`            | required              | Existing bot credential               |
| `FROND_EAR_DATABASE`           | `./data/frond-ear.db` | SQLite path                           |
| `FROND_EAR_POLICY`             | `./policy.json`       | Reloadable policy file                |
| `FROND_EAR_HOST`               | `127.0.0.1`           | Loopback bind address only            |
| `FROND_EAR_PORT`               | `8791`                | Local API port                        |
| `FROND_EAR_LEASE_MS`           | `60000`               | Default claim lease                   |
| `FROND_EAR_GATEWAY_URL`        | Discord Gateway       | Test/override endpoint                |
| `FROND_EAR_ADAPTER_COMMAND`    | unset                 | Optional executable adapter           |
| `FROND_EAR_ADAPTER_ARGS`       | `[]`                  | JSON array of fixed adapter arguments |
| `FROND_EAR_ADAPTER_TIMEOUT_MS` | `30000`               | Adapter timeout                       |
| `FROND_EAR_ADAPTER_MAX_BYTES`  | `65536`               | Maximum adapter stdin payload         |

Start with `gatewayEnabled: false`, inspect `/health`, then enable and reload
policy when the allowlists are correct.

## Local API and CLI

All responses use JSON and `Cache-Control: no-store`.

| Method | Path                | Purpose                                                   |
| ------ | ------------------- | --------------------------------------------------------- |
| `GET`  | `/health`           | Gateway, queue, suppression, delivery, and adapter health |
| `GET`  | `/queue/status`     | Queue and runtime status                                  |
| `POST` | `/queue/lease-next` | Lease the next priority event or quiet burst              |
| `POST` | `/queue/ack`        | Mark a matching claim delivered                           |
| `POST` | `/queue/release`    | Release or dead-letter a matching claim                   |
| `POST` | `/policy/reload`    | Atomically validate and load policy from disk             |

```sh
pnpm cli -- status
pnpm cli -- lease
pnpm cli -- ack CLAIM_TOKEN
pnpm cli -- release CLAIM_TOKEN "consumer failed"
pnpm cli -- reload
```

The default manual adapter does no automatic delivery; a local consumer polls,
leases, and acknowledges. The command adapter starts a configured executable
without a shell and writes one bounded JSON object to stdin. Discord content is
never interpolated into a shell command or placed in argv.

## Copilot CLI limitation

No real event-driven Copilot wakeup is claimed or included. The current
supported shape is event-driven Discord ingestion plus cheap loopback polling,
or an explicitly configured external command adapter. A non-interactive
Copilot CLI process does not provide this service with a demonstrated API for
waking and steering an existing terminal session. Any future adapter needs an
end-to-end proof before it can replace polling.

## Deployment

`deploy/frond-ear.service` provides a hardened, restartable systemd shape.
`Dockerfile` provides a non-root container shape. Because the service binds to
`127.0.0.1`, containers should use host networking when a host-local consumer
must reach the API; do not broaden the bind address to publish it externally.
Both shapes persist `/var/lib/frond-ear` or `/data` across restarts and stop
cleanly on `SIGTERM`.

## Development

```sh
pnpm format:check
pnpm typecheck
pnpm test
pnpm scan:credentials
```

Tests use fake Gateway payloads, injectable time, and temporary SQLite
databases. They never contact Discord.

Run the local acceptance demo after building:

```sh
pnpm demo
```

The demo injects fake Gateway events and prints boolean proof for a bounded
priority notification, restart lease recovery, duplicate replay suppression,
and routine-noise suppression. It uses a temporary database and no network.

See [Architecture and failure modes](docs/architecture.md) for state ownership,
recovery behavior, and operational tradeoffs.
