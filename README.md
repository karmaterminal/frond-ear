# frond-ear

`frond-ear` is a generic Copilot sidecar/plugin for harness-room event sources. It
accepts allowlisted event payloads from Discord now and can be reused for other
chat or message sources later, applies deterministic suppression and priority
policy, and stores them in a durable SQLite lease/ack queue. It is an ear and
bounded wake bridge, not a production speaker or administration tool, and it does
not modify or replace the running Discord MCP container.

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
- Each Discord guild/channel-or-thread or DM channel has one active durable
  Copilot session binding. Binding generations and session IDs are immutable.
  Rotation retires the predecessor and atomically dead-letters all of its
  pending or leased events, so a late acceptance cannot cross generations.
- Exact `/new` commands rotate only for configured `priorityAuthorIds`.
  Unauthorized command-shaped messages remain ordinary untrusted content.
  The loopback control plane is the separate direct frond-scribe authorization
  path.

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

| Variable                             | Default               | Purpose                                                           |
| ------------------------------------ | --------------------- | ----------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`                  | required              | Existing bot credential                                           |
| `FROND_EAR_DATABASE`                 | `./data/frond-ear.db` | SQLite path                                                       |
| `FROND_EAR_POLICY`                   | `./policy.json`       | Reloadable policy file                                            |
| `FROND_EAR_HOST`                     | `127.0.0.1`           | Loopback bind address only                                        |
| `FROND_EAR_PORT`                     | `8791`                | Local API port                                                    |
| `FROND_EAR_LEASE_MS`                 | `60000`               | Default claim lease                                               |
| `FROND_EAR_GATEWAY_URL`              | Discord Gateway       | Test/override endpoint                                            |
| `FROND_EAR_ADAPTER_COMMAND`          | unset                 | Optional executable adapter                                       |
| `FROND_EAR_ADAPTER_ARGS`             | `[]`                  | JSON array of fixed adapter arguments                             |
| `FROND_EAR_ADAPTER_TIMEOUT_MS`       | `30000`               | Adapter timeout                                                   |
| `FROND_EAR_ADAPTER_MAX_BYTES`        | `65536`               | Maximum adapter stdin payload                                     |
| `FROND_EAR_ADAPTER`                  | inferred/manual       | `manual`, `command`, or `copilot`                                 |
| `FROND_EAR_COPILOT_MAX_SESSIONS`     | `16`                  | Bound on cached SDK sessions                                      |
| `FROND_EAR_COPILOT_SOURCE_MODE`      | `auto`                | `system`, `user`, or `none`                                       |
| `FROND_EAR_CANARY_LIVE`              | `0`                   | Opt-in disposable test canary                                     |
| `FROND_EAR_CANARY_SESSION_ALLOWLIST` | `[]`                  | Explicit session IDs or conversation keys allowed for live canary |
| `FROND_EAR_CANARY_SESSION_PREFIX`    | `frond-ear-canary`    | Prefix for dedicated test sessions                                |
| `FROND_EAR_CANARY_MAX_BYTES`         | `65536`               | Bound on summary payload to Copilot                               |

Start with `gatewayEnabled: false`, inspect `/health`, then enable and reload
policy when the allowlists are correct.

## Local API and CLI

All responses use JSON and `Cache-Control: no-store`.

| Method | Path                  | Purpose                                                   |
| ------ | --------------------- | --------------------------------------------------------- |
| `GET`  | `/health`             | Gateway, queue, suppression, delivery, and adapter health |
| `GET`  | `/queue/status`       | Queue and runtime status                                  |
| `POST` | `/queue/lease-next`   | Lease the next priority event or quiet burst              |
| `POST` | `/queue/ack`          | Mark a matching claim delivered                           |
| `POST` | `/queue/release`      | Release or dead-letter a matching claim                   |
| `POST` | `/policy/reload`      | Atomically validate and load policy from disk             |
| `GET`  | `/bindings`           | List active bindings (`?includeRetired=true` for history) |
| `GET`  | `/bindings/:key`      | Inspect one active binding                                |
| `POST` | `/bindings/rotate`    | Direct loopback-authorized generation rotation            |
| `POST` | `/bindings/pause`     | Pause wake delivery for one binding                       |
| `POST` | `/bindings/resume`    | Resume wake delivery for one binding                      |
| `GET`  | `/adapter/capability` | Report exact adapter and SDK capability                   |

```sh
pnpm cli -- status
pnpm cli -- lease
pnpm cli -- ack CLAIM_TOKEN
pnpm cli -- release CLAIM_TOKEN "consumer failed"
pnpm cli -- reload
pnpm cli -- bindings --all
pnpm cli -- binding 'guild:GUILD_ID:channel:CHANNEL_ID'
pnpm cli -- rotate CHANNEL_ID GUILD_ID
pnpm cli -- pause 'guild:GUILD_ID:channel:CHANNEL_ID'
pnpm cli -- resume 'guild:GUILD_ID:channel:CHANNEL_ID'
pnpm cli -- capability
```

The default manual adapter does no automatic delivery; a local consumer polls,
leases, and acknowledges. The command adapter starts a configured executable
without a shell and writes one bounded JSON object to stdin. Discord content is
never interpolated into a shell command or placed in argv.

## Copilot SDK capability

The implementation is intentionally compatible with the released Copilot SDK
contract that is available in the field today: `mode: "enqueue"` is accepted,
while `source: "system"` is not guaranteed. User-source delivery is therefore
explicitly acceptable for disposable canary work as long as the prompt includes
its provenance label and the adapter never targets the primary frond-scribe
session.

The adapter boundary is generic: `EventSource` implementations represent the
incoming event stream (Discord today, Teams or other harness sources later), and
`CopilotSdkAdapter` sits behind that boundary. The fake-SDK tests exercise the
production contract for both cases: a bounded cache of dedicated sessions,
create-or-resume by durable session ID, and a bounded enqueue call with explicit
provenance. The live canary path is opt-in and requires
`FROND_EAR_CANARY_LIVE=1` together with a non-empty allowlist of explicit
session IDs or conversation keys. Without that explicit allowlist, the adapter
stays offline and never leases work for the primary session.

For an explicit system-source SDK, the adapter keeps using
`send({ prompt, source: "system", mode: "enqueue" })`. For the live canary,
source falls back to `"user"` while the prompt prefix states that the content is
an untrusted Discord event summary and not a trusted system message. SDK
rejection releases a lease for bounded retry; an acceptance timeout is
dead-lettered because its outcome is ambiguous and retrying could duplicate a
turn. One end-to-end deadline covers client startup, session lookup/create/
resume, and enqueue. Immediately before enqueue, the adapter verifies that the
claim and generation remain active with enough lease time for the remaining
acceptance deadline.

## Deployment

`deploy/frond-ear.service` provides the ingress service shape.
`deploy/frond-ear-copilot-sidecar.service` adds a dedicated `COPILOT_HOME`
under the persistent state directory and selects the capability-gated Copilot
adapter. Authenticate that service-owned home through the ordinary Copilot
login flow before startup; do not point it at an active interactive CLI home.
Both units reference the existing protected `/etc/frond-ear/runtime.env` and
do not copy its bot token.
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
