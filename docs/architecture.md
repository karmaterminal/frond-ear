# Architecture and failure modes

## Composition boundaries

`DiscordGateway` owns Discord protocol state and persists the latest sequence,
session ID, and resume URL in SQLite. A message dispatch is synchronously
enqueued before its sequence advances, so a persistence failure leaves the
older cursor available for replay. On a fresh connection the client identifies;
after restart it resumes when Discord has supplied a resumable session. Invalid
non-resumable sessions clear the session ID and identify on the next
connection.

`EarService` is the ingestion composition boundary. It snapshots the current
validated policy, classifies a message, records suppression counters, and calls
`EventStore.enqueue`. The store transaction owns duplicate identity,
count/weight admission, priority eviction, and the queue state machine.

`EventStore.leaseNext` owns delivery composition. It first recovers expired
leases, chooses priority before routine work, and leases one priority event or
one quiet channel burst under a random claim token. Ack and release only affect
rows with the matching active token. Delivery failures return rows to pending
until `maxDeliveryAttempts`, then dead-letter them.

The HTTP API and optional `CommandAdapter` are consumers of that lease
boundary. The command adapter uses `spawn` with `shell: false`, fixed
configuration argv, a reduced environment, bounded JSON stdin, and a timeout.
The manual adapter intentionally leaves delivery to explicit API clients.

## SQLite data and retention

The service enables WAL mode. Discord message IDs are unique across all queue
states, so replay after reconnect or process restart cannot enqueue a second
copy. Delivered and dead-letter rows are tombstones until bounded retention
removes them. Pruning runs at service startup; operators should restart or add
an external maintenance restart on long-lived deployments where strict
wall-clock retention is required.

Gateway state and operational counters share the database but not the queue
state machine. The bot token is never stored.

## Failure modes

| Failure                                   | Behavior                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Gateway disconnect or requested reconnect | Socket closes, durable session/sequence remain, and reconnect attempts resume with bounded exponential backoff         |
| Fatal Gateway close                       | Authentication, sharding, version, intent, and configuration close codes stop reconnecting and surface `failed` health |
| Missing heartbeat ACK                     | The stale socket closes and the durable session reconnects                                                             |
| Invalid resumable session                 | Session remains for Discord's resumable response; a non-resumable response clears it                                   |
| Duplicate replay                          | Unique message ID returns `duplicate`; the existing row remains unchanged                                              |
| Crash after lease                         | The row remains leased until expiry, then returns to pending                                                           |
| Consumer release or adapter failure       | Pending retry until the attempt bound, then explicit dead letter                                                       |
| Queue count/weight overflow               | Normal event dead-letters; priority first evicts oldest pending normal events                                          |
| Gateway kill switch                       | Socket stops and new ingestion is rejected; queued rows are unchanged                                                  |
| Wake pause                                | Claims and automatic adapter delivery stop; Gateway ingestion and queued rows continue                                 |
| Policy reload validation failure          | Request fails and the previous in-memory policy remains active                                                         |
| Command timeout or nonzero exit           | Process is terminated/rejected and the claim follows release/dead-letter policy                                        |
| Process shutdown                          | Gateway and polling stop, in-flight adapter delivery settles, HTTP drains, then SQLite closes                          |

The health response exposes Gateway state, last sequence/event time, queue
depths, suppression/coalescing counters, last successful delivery, wake pause,
and adapter state. It never includes the bot token or raw environment.
