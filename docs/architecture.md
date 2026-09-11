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
one quiet conversation-generation burst under a random claim token. It joins
the active, unpaused binding while selecting work. Ack requires both the active
claim and the still-active binding generation. Delivery failures return rows
to pending until `maxDeliveryAttempts`, then dead-letter them.

`EventStore.rotate` is the binding composition boundary. Under one immediate
SQLite transaction it idempotently consumes a rotation request, retires the
active immutable generation, dead-letters all pending or leased predecessor
events, and inserts the successor with a new UUID session ID and predecessor
lineage. A late ack for a predecessor claim updates zero rows.

The store also records an immutable ingress disposition by Discord message ID.
Service replay consults it before current policy, so an authorized `/new`
cannot later become content and untrusted content cannot later become a
rotation after a reload. Rotation dispositions are retained permanently;
ordinary and suppressed dispositions follow queue retention once no event
tombstone remains.

`CopilotSdkAdapter` owns the isolated SDK client and a bounded LRU-like cache of
binding-specific sessions. It resolves a persisted session ID through SDK
metadata, creates it when absent, resumes it after restart when present, and
accepts delivery only through a system-source enqueue turn. The released SDK
lacks system-source support, so the production capability object is explicitly
unavailable and the service does not claim a lease. Tests inject a
capability-compatible fake at this same boundary.
One deadline covers setup and enqueue. Immediately before enqueue, the adapter
requires the claim and active generation to remain valid for the deadline's
remaining duration.

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
| Binding rotation during a lease           | Predecessor rows are atomically dead-lettered and the late ack updates zero rows                                       |
| Per-binding pause                         | Ingestion continues; lease selection skips the binding until resumed                                                   |
| SDK capability unavailable                | Adapter health is explicitly unavailable and no queue lease is taken                                                   |
| SDK enqueue acceptance timeout            | Ambiguous lease is dead-lettered instead of retried, preventing a possible duplicate turn                              |
| Queue count/weight overflow               | Normal event dead-letters; priority first evicts oldest pending normal events                                          |
| Gateway kill switch                       | Socket stops and new ingestion is rejected; queued rows are unchanged                                                  |
| Wake pause                                | Claims and automatic adapter delivery stop; Gateway ingestion and queued rows continue                                 |
| Policy reload validation failure          | Request fails and the previous in-memory policy remains active                                                         |
| Command timeout or nonzero exit           | Process is terminated/rejected and the claim follows release/dead-letter policy                                        |
| Process shutdown                          | Gateway and polling stop, in-flight adapter delivery settles, HTTP drains, then SQLite closes                          |

The health response exposes Gateway state, last sequence/event time, queue
depths, suppression/coalescing counters, last successful delivery, wake pause,
and adapter state. It never includes the bot token or raw environment.
