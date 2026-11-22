# Design: a ringserver-backed canticle reader for frond-ear

**Status:** design note, no code (2026-11-22). Reviewers: 🍃 frond-gloss (co-owner), 🌫 silas.

On 2026-11-22 figs asked how frond-ear can sustain a high degree of content IO without the ringserver, and why
using it was put off. 🌿 answered that it was deferred, not a wrong fit. Today, short-lived signed UDP cues are
verified by binary-canticle's host daemon and pushed by frond-ear with custody. Durable replay and volume belong to
RFC-0001's ringserver tier (§18), which nobody has built. The proposed shape: **the daemon verifies, then appends
verified records to a ring; ears read the ring by cursor, check expiry at read time, and keep custody in
frond-ear.** This note designs frond-ear's half of that before any code.

Citations are `path:line` at these refs. A path starting `bc:` is in binary-canticle, `rs:` is in ringserver, and
anything else is in frond-ear. `RFC` means `bc:rfc/0001-binary-canticle.md`.

| Source                                          | Ref                                     |
| ----------------------------------------------- | --------------------------------------- |
| frond-ear                                       | `43dab0e` (main)                        |
| binary-canticle                                 | `08c1112` (main)                        |
| ringserver (karmaterminal fork of EarthScope's) | `2df558c` (v4.5.4, the RFC's proof SHA) |

## Decisions at a glance

| #     | Question                    | Decision                                                                                                                                                                                                                                                 |
| ----- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Who writes                  | The host daemon, after it has verified a frame and saved the state that frame implies. Stations never write the canticle lane.                                                                                                                           |
| 1     | What a reader may assume    | Only that something with write access appended these bytes. The reader re-verifies each signature against its own manifest, checks expiry on its own clock, and trusts a completeness claim only when the writer's envelope authenticates.               |
| 2     | Packet                      | One ring packet per distinct frame, meaning per identity tuple plus frame digest. Each packet is a 32-byte writer envelope, the station's canonical frame byte for byte, and a 16-byte HMAC tag, under the stream id `BC_<key_id>_<stream_id>/CANTICLE`. |
| 2     | Identity                    | A record is identified by its frame tuple, as today. A position in the ring is identified by the authenticated pair (writer run, writer seq). ringserver's packet id only locates a packet; the same id can later name a different packet.               |
| 3     | Cursor                      | Kept in frond-ear's SQLite store, in the same transaction as the listener's safety state. On resume the reader reads the cursor's packet back and checks that it is the one recorded.                                                                    |
| 3     | Gaps                        | A hole in the writer seq is loss, and it is reported. Items heard before the hole are hidden until they are confirmed again or expire. The reader never issues `STREAM` after a failed `POSITION`.                                                       |
| 3     | Backpressure                | The reader never waits for the session. The cursor advances as packets are processed. Keeping pace with the session stays delivery's job: digests, and drops that are counted.                                                                           |
| 4     | Expiry                      | Checked at read time on the reader's clock, with no positive clock offset on the ring path. A retained packet that has expired is never pushed, live or late; it is counted.                                                                             |
| 4     | Custody                     | Unchanged: the same identities, tombstones, offered and echoed rows, and compaction-boundary stamps. Rows gain an `origin` field.                                                                                                                        |
| 5     | Volume                      | The ring buys reliability and replay, not throughput. The carousel's budgets cap what comes in and the session caps what goes out. Anything bigger than one frame, or continuous, goes by reference.                                                     |
| 6     | ringserver down             | Report it. Never fall back to the socket automatically.                                                                                                                                                                                                  |
| 6     | Wrap, reset, crash          | Detected by checking the envelope at the cursor, and reported with counts. The reader then re-reads from the earliest packet the ring still holds.                                                                                                       |
| 6     | Station with a skewed clock | Fail closed: items may expire early, never late.                                                                                                                                                                                                         |
| 7     | Migration                   | `canticle.ring.mode`: `off` (the default), then `shadow` (compare only), then `primary` (content comes from the ring; control still comes from the host socket).                                                                                         |
| Scope | Where it runs               | Version 1 is same-host: the ringserver runs on the daemon's host, and the reader runs beside the record v1 socket. Readers on other hosts are an open question.                                                                                          |

## 1. What the ring changes

Today, with `canticle.source: host-daemon`, the path is: station → UDP → host daemon (verifies, emits record v1) →
host socket → `RecordClient`/`RecordConsumer` → live set → `hear` and delivery, which polls every second
(`src/canticle/delivery.ts:65`). That path runs short in four places:

- **A full queue drops frames.** The daemon keeps 1 024 records per connection and drops a `frame` record that
  doesn't fit (RFC:2161-2163; `bc:prototype/canticle-station/canticle/daemon.py:63`).
- **Any gap clears everything.** The binding treats any `rec_seq` gap as loss and clears its live set
  (`src/canticle/records.ts:644-647`), because the missing record might have been a `retract`.
- **Catch-up is shallow.** After a reconnect the only catch-up is the join snapshot: current state only, at most
  511 entries (`src/canticle/records.ts:49`; RFC:2283).
- **Nothing outlives its TTL.** Durable replay "belong[s] to a separate ringserver tier … which is not built"
  (`bc:README.md:167-168`).

A ring adds:

- **Pull at the reader's pace.** Nothing is dropped on the producer's side for a slow reader until the ring wraps,
  and retention is bounded by bytes, not by TTL.
- **Resume by cursor** across a restart of either side, with exact loss accounting.
- **Many readers on one append.** frond-ear, an OpenClaw binding, bc#130's tool and dashboards each keep their own
  cursor, with no per-peer queue in the daemon.
- **It is the RFC's chosen tier.** Binding (d) (RFC:1178), decision D10 ("Clean-path snapshots, replay, dashboards"
  over TCP, RFC:1193), and §18.

It does not add throughput (§6).

**Why version 1 is same-host.** The ring is a content bus, not a control plane. The receptor's landing state (MUTE,
breaker, modulation), presence and health invert when they arrive late, and the staleness rule puts such signals on
the no-replay plane (RFC:368). So they stay on the live host socket. A reader on another host would need MUTE and the
other control frames in the ring (§10.6), and frond-ear implements neither (Q-B8).

## 2. Who writes, and the trust boundary

**Decision: the host daemon writes, after verification. Stations never write the canticle lane.**

- **The daemon already checks what ringserver can't.** It verifies frames, applies grants and per-key quotas, refuses
  epoch regressions, detects equivocation and deduplicates loops (RFC:2211-2233). ringserver stores any bytes ("not
  format specific", `rs:README.md:7-9`), with no dedup and no ordering check on writes (`rs:src/dlclient.c:863-1018`).
- **One writer means one address to grant.** Write access is granted by IP address, and only localhost has it when
  nothing is configured (`rs:doc/ring.conf:325-335`, `rs:src/config.c:810-818`). Letting stations write directly would
  give every station host write access to a shared ring that evicts its oldest packets first
  (`rs:src/ring.c:744-788`). One flooding station would then evict every other station's history.
- **Writing the ring directly would be a new binding.** The broadcast edge is UDP by decision D10 (RFC:1186-1193).
  The RFC joins the two tiers "at a ring" through a bridge (RFC:2728, RFC:2738). A station writing TCP to a ring is a
  different binding (Q-B7).
- **"One ring packet per identity tuple" (RFC:2738) needs loops already deduplicated**, which only happens after a
  receptor.

**What the writer does.** These requirements are for the binary-canticle owners:

| #   | Requirement                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Append every ITEM its receptor admits as `verified` (whatever the disposition, `resurfaced` re-hearings after its own restart included) and every PLUCK it admits. Also append the second byte string of an equivocation, once, so the reader's listener sees the equivocation and quarantines the key. Append no refusals, no benign repeats and no BEACONs (§4.1). |
| W2  | Append only after the daemon's write-ahead save for that datagram (`bc:prototype/canticle-station/canticle/daemon.py:32-33`), so no ring packet ever precedes the guard it implies.                                                                                                                                                                                  |
| W3  | Never block the receive path. Keep a bounded writer queue, assign `seq` when a packet is queued, and never reuse it. A packet dropped at the writer leaves a hole, as record v1's `rec_seq` does (RFC:2161).                                                                                                                                                         |
| W4  | After a lost ack, retry with the same bytes: the same run and seq. ringserver doesn't deduplicate, so a retry would otherwise be a second packet.                                                                                                                                                                                                                    |
| W5  | Write a `hello` packet when a run starts, a `bye` on clean stop, and a `tick` every 10 s carrying the writer's counters.                                                                                                                                                                                                                                             |
| W6  | Add an HMAC-SHA-256 tag, truncated to 16 bytes, over the envelope and body, keyed by a per-host key held in a 0600 file.                                                                                                                                                                                                                                             |
| W7  | Set the DataLink header's datastart to `issued_at` and dataend to the effective expiry, in µs. This serves dashboards and `POSITION AFTER`. Readers never trust these times.                                                                                                                                                                                         |

**What a reader may assume about a ring packet.** Only what it checks itself:

| Property                                        | What the reader trusts on the ring path                                                              | Why it is checked again                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content and author                              | The station's signature, resolved through the reader's own manifest (`src/canticle/wire.ts:445-560`) | ringserver accepts any bytes from any address allowed to write. A revocation made after a packet was written then applies to that retained packet on its next read. |
| Freshness                                       | The signed `expires_at`, read on the reader's clock (§5.1)                                           | The ring evicts by size, not by TTL (RFC:2752), so retained packets outlive their items.                                                                            |
| Identity                                        | The frame's own tuple, never the ring stream id or the packet id                                     | Stream ids are text the writer chooses. Packet ids are handed out again after a crash (Appendix A, E3).                                                             |
| Order and completeness                          | The authenticated (run, seq)                                                                         | A lapped reader is skipped forward without notice (E2), crash recovery reuses ids (E3), and on loopback any local process can write.                                |
| Admission (dedup, plucks, supersession, quotas) | The reader's own listener                                                                            | The daemon's decisions are not carried in the ring; only its frames are.                                                                                            |

**Why verify again when the writer already did.** It costs one Ed25519 verification per new frame, not per loop
copy, at a few frames a second at most (§6). In return, the ringserver process, its ACLs, its other writers and the
ring file all drop out of what must be trusted for content. The writer stays trusted for availability and
completeness only.

**Why the envelope is authenticated.** ringserver cannot bind loopback only: it listens on every address
(`getaddrinfo(NULL, …, AI_PASSIVE)`, `rs:src/config.c:2675-2677`). `WriteIP` grants by address, and on a shared host
every local process shares 127.0.0.1. Without the tag, anything that can write could forge `hello`, `bye` or `tick`
packets, or fabricate a clean-looking sequence. It could never forge a station's content (signatures stop that), but
it could fake completeness. ringserver's `AuthCommand` can limit writes to a credential, but a credential check in
ringserver is a property of its config, while the tag is a property of the packet (Q-S2).

## 3. Packet identity and mapping

### 3.1 Ring stream id

The stream id is `BC_<key_id, 16 hex>_<stream_id, 8 hex>/CANTICLE`: 37 bytes, under ringserver's limit of 63
(`rs:src/ring.h:58`; a longer id gets `ERROR` and a disconnect, `rs:src/dlclient.c:876-884`). Writer control packets
use the all-zero id `BC_0000000000000000_00000000/CANTICLE`.

This departs from RFC §18.3 lane (c), which names the stream `<NET>_<STA>_<stream>/CANTICLE` (RFC:2744). Stream names
can be 64 bytes (RFC:327) and station names 31 (RFC:323), so that form can exceed the limit, and it needs §18.5's
NET/STA table (RFC:2756-2764). Hex ids need no table, and names stay a manifest lookup at the reader (RFC:341). See
Q-B2.

### 3.2 Payload

| Offset | Size | Field                                                                                                                                                                                                                                                                                                              |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0      | 4    | magic `BCRP`                                                                                                                                                                                                                                                                                                       |
| 4      | 1    | version `1`                                                                                                                                                                                                                                                                                                        |
| 5      | 1    | kind: `1` frame, `2` hello, `3` bye, `4` tick                                                                                                                                                                                                                                                                      |
| 6      | 2    | reserved, zero                                                                                                                                                                                                                                                                                                     |
| 8      | 8    | `run`: random, fixed for the writer process's lifetime                                                                                                                                                                                                                                                             |
| 16     | 8    | `seq`: within the run, starts at 1 and rises by 1 for each packet assigned; a hole is loss                                                                                                                                                                                                                         |
| 24     | 8    | `heard_at`: ms since the epoch; the daemon's receive time for a frame, its send time for a control packet                                                                                                                                                                                                          |
| 32     | n    | body. For a frame, the canonical frame byte for byte (at most 1 100 B, RFC:750). For a control packet, a small deterministic CBOR map: `hello` carries the writer version, its manifest's SHA-256 and its tick interval; `bye` carries the last seq; `tick` carries counts written and dropped and the queue depth |
| 32 + n | 16   | tag: the first 16 bytes of HMAC-SHA-256(key, bytes 0 to 32 + n)                                                                                                                                                                                                                                                    |

The largest packet is 1 148 B. Use `MaxPacketSize 1280`. Every slot then costs 1 400 B (`rs:src/ring.c:147`; the
server logs `pktsize: 1400 (1280 payload)`, Appendix A).

### 3.3 Ordering and identity across reconnects

- **Order.** Writes are totally ordered under the server's ring lock and delivered in write order
  (`rs:src/ring.c:709-742`). With one writer, packet id order is seq order. Across stations the order is the daemon's
  admission order, which is the order the reader's listener needs: plucks and supersessions apply as the daemon
  applied them.
- **Record identity.** The tuple (key_id, epoch, stream_id, seq) is record v1's `idem` (RFC:2196) and delivery's
  `identity()` (`src/canticle/delivery.ts:101`, with the stream named). Both paths produce the same string, so
  tombstones, custody and dedup work across them.
- **Byte identity.** The SHA-256 of the frame is record v1's `frame.sha256` (RFC:2195). Shadow mode compares paths
  byte for byte with it (§8).
- **Position.** A position is (run, seq). A packet id locates it within one ring generation and nothing more. Packet
  ids are handed out again after a `kill -9`, restart at 1 after a reset or with a volatile ring, and keep their
  number with a new pkttime after a resize (Appendix A, E3). ringserver has no generation marker to tell these apart
  (its saved header holds only format, sizes and offsets, `rs:src/ring.h:70-81`).
- **Writer-supplied packet ids were considered and rejected.** A DataLink `WRITE` with flag `I` sets the id
  (`rs:src/dlclient.c:914-919`), which would let the writer keep ids stable across a ringserver crash. But the flag is
  undocumented, the server checks the ids neither for uniqueness nor for order, and one writer would have to own an id
  space the dashboard lanes share.

## 4. Reader semantics

### 4.1 Shape in frond-ear

A third `CanticleSource` (`src/canticle/source.ts:19-24`), `RingSource`, combines two parts:

- **The existing `RecordClient` on the host socket.** It supplies `landing_state`, presence and health. In `primary`
  mode its live set is kept only for comparison.
- **A `RingReader`.** It keeps one DataLink TCP connection (`node:net`, no dependencies) and feeds each authenticated
  frame into the existing `Listener` (`src/canticle/listener.ts`), with `warmup: false` (`listener.ts:337`) and no
  beacons. Reusing the listener brings the verification, dedup, plucks, supersession, quotas and journaled guards
  that the embedded path already proves (`src/canticle/receptor.ts:335-376`). The ring path then adds transport and
  a cursor, not a second admission implementation.

**Feeding at hearing time.** Each frame is fed as `listener.hear(frame, h)`, where `h = min(envelope heard_at, now)`.
The guards (epoch high-water mark, sticky plucks, supersession marks) are then raised exactly as the daemon raised
them, and liveness is judged against `now` afterwards (§5.1). This matters when one key's items have different TTLs:
after a restart, a supersessor that has expired must still block its predecessor that hasn't. The listener has so far
seen only forward-moving time, so the code must run `tick(now)` after each `hear(…, h)` and test that purges still
hold (§9, case 2).

**Warm-up off, no beacons.**

- §6.3 item 4's warm-up (RFC:400) guards against hearing an older looped copy before the newer one after a restart.
  The ring has no loops, and it keeps the daemon's admission order, in which an older value never follows its
  superseder: the daemon refuses it as `superseded` (RFC:2230). The persisted marks cover a restart.
- With warm-up on and no beacons, the listener would hold live-state items forever, since `#warm` needs a beacon
  (`listener.ts:1123-1130`).
- Beacons loop at the station's cadence and each is a new identity, so at cue rates they would fill most of the ring.
  What they carry, presence and the clock offset δ̂, is live-only and comes from the host socket.
- A beacon read late would also inflate δ̂ by the read lag, since the offset is measured as now minus wallclock
  (`listener.ts:140-141`), and that would lengthen local expiry.

### 4.2 Cursor persistence

- **Where.** In frond-ear's SQLite store, as one `runtime_state` value named `canticle.ring`. It holds the listener's
  `SafetyState`, the cursor `{pktid, pkttime, run, seq, digest}`, the run history (below), the packet ids of the live
  and hidden items (at most `MAX_LIVE`), and the counters.
- **Atomic.** `checkpointRuntimeState` replaces the snapshot and empties its journal in one transaction
  (`src/store.ts:1058-1065`). Guards raised between checkpoints are journaled per packet with `appendRuntimeJournal`
  (`src/store.ts:1051-1056`) before the packet's effects can be seen, as the embedded receptor does
  (`src/canticle/receptor.ts:335-376`). Checkpoints happen on each one-second tick when anything changed.
- **Invariant: the checkpointed cursor never runs ahead of the state it implies.** After a crash the reader re-reads
  from that cursor. Packets whose guards are already in the journal are applied again harmlessly, because guards only
  grow (epoch maxima, marks, plucks). Their items deduplicate at delivery through identity tombstones
  (`docs/runbook.md:757-775`).
- **If the store fails,** the cursor stops advancing and the reader reports `state_not_durable`, failing closed as the
  receptor does (`receptor.ts:378-387`).

### 4.3 Resume, and the client rules ringserver forces

1. **Send `ID` at once, and again every 60 s.** ringserver drops a client that says nothing for 10 s
   (`rs:src/clients.c:395-404`), and an idle reader after `ClientTimeout`, 3 600 s by default
   (`rs:doc/ring.conf:154`). `ID` doesn't end streaming.
2. **Read `INFO STATUS`:** `StartTime`, `EarliestPacketID` and `LatestPacketID`. No trust is needed.
3. **Validate the cursor with `READ <cursor.pktid>`.** Go on only if that packet authenticates and its run, seq and
   digest match the cursor's. Then `STREAM` delivers from pktid + 1 (E1).
   - **Never send `POSITION SET` and then `STREAM` blindly.** On "not found" the server leaves the reader unpositioned,
     and the following `STREAM` starts at the next new packet. The backlog is skipped and nothing says so
     (`rs:src/dlclient.c:173-177`; E2).
   - **Don't start from `POSITION SET EARLIEST` or `POSITION AFTER` either.** Both skip their first packet (E1). Use
     `READ <id>` and then `STREAM`.
4. **If validation fails,** the cursor's packet is gone or has been replaced. The cases:
   - the packet id is below `EarliestPacketID`: the ring has wrapped past it;
   - the packet id is above `LatestPacketID`, or the packet there authenticates but is a different packet: ringserver
     crashed and rolled back, or the ring was reset (E3).

   In every case, report `ring_overrun` or `ring_reset`, then `READ <EarliestPacketID>` (processing the packet it
   returns), `STREAM`, and read everything the ring holds. A packet already processed, by (run, seq), is skipped.
   Holes are counted exactly within a run. Across runs the count is `unknown`.

5. **Remember up to 16 runs, with each run's last seq and whether it ended with `bye`.** Re-reading from the earliest
   packet then doesn't mistake an old run for a writer restart:
   - a known run with seq at or below its last seq has already been processed;
   - a known run that hasn't ended continues from its last seq, with the hole check;
   - a run that has ended, seen again with a higher seq, is counted as `stale_run` and skipped: two writers are
     sharing the ring, which is a misconfiguration;
   - an unknown run is a writer restart.
6. **While streaming,** a packet whose tag fails is dropped and changes no state. A jump in packet ids is not loss on
   its own (other lanes share the ring); only a hole in seq is loss. A lap therefore shows as a hole, with its exact
   size.

### 4.4 Gap detection and reporting: never silently skip

| Signal                                         | Meaning                                                                                                            | Reported as                                                                    | Live items                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------- |
| seq jumps by more than one, within a run       | Packets lost: dropped at the writer (queue full, ring unreachable), a lapped reader (E2), or a crash rollback (E3) | `ring_gap` with the exact count; health `degraded` while anything stays hidden | Those heard before the hole are hidden |
| a new run, after the previous run's `bye`      | The writer restarted cleanly                                                                                       | `writer_restarted`                                                             | Kept                                   |
| a new run, with no `bye` from the previous one | The writer crashed, or the end of its run was lost; the count is unknown                                           | `writer_restarted_without_bye`                                                 | The previous run's items are hidden    |
| cursor validation fails                        | Overrun, reset or crash reuse (§4.3)                                                                               | `ring_overrun` or `ring_reset`, with a count or `unknown`                      | Hidden                                 |
| a tag fails                                    | Not from the writer                                                                                                | `unauthenticated` (a count)                                                    | None affected                          |
| no `tick` for three intervals                  | The writer is silent, or the ring is unreachable                                                                   | `writer_silent`: blind, and saying so                                          | Kept; expiry carries on                |

**Hidden until confirmed.** A lost packet may have been a PLUCK. `records.ts` clears its live set on any gap
(`:644-647`). The ring reader stops rendering and pushing the affected items in the same way, but keeps them (within
`MAX_LIVE`) so that a later re-append of the same identity can confirm them. The daemon re-appends a frame only while
its receptor still holds it unplucked, for example when it hears the frame again after a restart (`resurfaced`,
RFC:2218; W1). This is how the join snapshot confirms carried records (`src/canticle/records.ts:85-90`). An item that
is never confirmed leaves at its local expiry.

Every one of these signals is reported: in `ear_status` (`canticle.ring`), in a header line in `hear` (as
`joinedLate` does, `src/canticle/hear.ts:324-334`), in a footer line on the next report ("ring: N records lost since
the last report"), and in a log line carrying counts, never payload.

### 4.5 Duplicates and idempotence

- **The same (run, seq) twice** comes from a writer retry after a lost ack (W4) or from re-reading after a reset. The
  second copy is skipped and counted as `ring_duplicate`. With different bytes it is `ring_conflict`, a writer fault,
  and the first copy wins.
- **The same frame identity in another packet** comes from a `resurfaced` re-append or a later run. Identical bytes
  are a harmless repeat (RFC:481); different bytes are an equivocation.
- **Across paths and restarts,** delivery's identity tombstones (`docs/runbook.md:757-775`) make sure nothing is
  pushed twice, whichever path heard it and whether digest or immediate tried to push it.

### 4.6 Backpressure: the ring is never held for the session

**Decision: the cursor advances when a packet has been processed into the reader's state, never when a session
consumes it.** Keeping pace with the session stays delivery's job: per-ear caps, digest windows, oldest-first drops
from `bufferPerStream` counted as `dropped`, `off_air_unpushed`, and `maxPushesPerHour` (`docs/runbook.md:704-717`).

Why not hold the cursor until the session catches up:

- Holding it turns a slow session into ring lag, and ring lag into a lap. A lap skips a ring's worth of packets
  without notice (E2), retractions along with content.
- Delivery already keeps the durable dedup and custody that make a push at-most-once. A session can't take records
  faster than delivery shows them, so holding the ring gains it nothing.
- An item held past its expiry is worth nothing (§5.1).

The reader drops nothing on content grounds either. It judges no content, and every authenticated packet goes through
the listener so that the guards stay complete.

| Where                       | Bound                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The connection              | One DataLink connection with TCP flow control. ringserver keeps no per-client queue; a send stalled for `NetIOTimeout` (10 s) disconnects (`rs:src/clients.c:823-899`). |
| The listener                | Per-key dedup and mark quotas (RFC:484-493)                                                                                                                             |
| Live and hidden items       | `MAX_LIVE` 4 096, as in `records.ts:46`; overflow is counted                                                                                                            |
| Run history                 | 16 runs                                                                                                                                                                 |
| Live packet ids, checkpoint | At most `MAX_LIVE`                                                                                                                                                      |
| Delivery                    | `MAX_WAITING` 4 096 and `bufferPerStream` up to 256 (`src/canticle/delivery.ts:74`)                                                                                     |

**Lag.** The reader reports `lag_packets` (`LatestPacketID` minus the cursor, from `INFO STATUS`, which ringserver
answers mid-stream) and `lag_ms` (now minus the last frame's `heard_at`). It warns `ring_lag_high` when the lag passes
half of the ring's span, estimated from the earliest and latest creation times.

### 4.7 Restart rebuild

On start, the reader loads the checkpoint and replays the journal. It then reads each checkpointed live packet id
with `READ`, checking its run and seq, to rebuild the live set. Rebuilt items surface with `origin: "replay"`, and
tombstones stop them being pushed again. Then it resumes streaming from the cursor. A live item whose packet the ring
no longer holds is counted as `rebuild_missing`; that only happens when retention is shorter than the item's TTL,
which is a sizing error (§6).

Why a list of packet ids rather than re-reading from the oldest live item: a single `finding-ref` item lives up to
86 400 s (RFC:383), so it would force a re-read of a day of packets.

## 5. Expiry and custody

### 5.1 Expiry at read time

```
expires_eff        = min(expires_at, issued_at + class max TTL)      (wire.ts:421-437, RFC:1780)
h                  = min(envelope heard_at, read time)
local_expiry_ring  = min(expires_eff, h + (expires_eff − issued_at)) (δ̂ = 0)
```

- **δ̂ is pinned to 0 on the ring path, because no beacons are fed.** RFC §14.6.3 lets δ̂ move expiry later, bounded
  only by first hearing plus TTL (RFC:1781-1784). On a ring, "first hearing" would be the read, so a writer, or simply
  a late read, could stretch a replayed item to a full TTL from now. With δ̂ = 0, nothing on the ring path outlives
  the station's signed `expires_at` on the reader's clock.
- **An expired packet still reaches the listener, and nowhere else.** A packet with `local_expiry_ring ≤ now` is fed
  to the listener, because its guards matter (§4.1). It never enters the live set, `hear` or a push. It is counted
  as `expired_on_read` for its station and stream.
- **Never pushed, not even as a late report.** At local expiry an item loses current-state authority in every
  surface (RFC:397). An expired frame is what a replay attack looks like (RFC:483). frond-ear already never pushes a
  record that goes off air first (`docs/runbook.md:779-780`). Reports count `expired_on_read` beside
  `off_air_unpushed`. The history of expired items is for dashboards (§18.8) and possibly a future pull tool, never
  for pushes (Q-G3).
- **Unexpired packets read late are marked late.** This happens on catch-up after a restart or an outage. `heardAt`
  is `h`, so delivery's existing rules apply: `immediate` pushes only within `maxAgeMs` of hearing
  (`delivery.ts:210-211`), and anything older goes into the next report with a `late:` line (`delivery.ts:219-242`),
  such as `late: heard 54s ago (replay)`. `LiveItem.origin` gains `"replay"` (`receptor.ts:101`).

### 5.2 Custody

The mechanism is unchanged (`docs/runbook.md:809-872`, `src/canticle/custody.ts`). There is one row per record per
exposure. A push is first claimed: its batch, tombstones, cursor and rows are written in one transaction. It becomes
offered when the shim says it handed the event over, and echoed when the session names the whole `batch_id`. Each step
is stamped with the session's compaction boundary from its pressure hook. The ring path adds:

- **An `origin` and the ring position on each row.** `origin` is `live`, `snapshot`, `resurfaced` or `replay`, and for
  the ring the row also keeps `run:seq`, so an audit can tie a session's exposure to the exact ring packet (Q-G5).
- **Nothing that depends on the path.** The identity and payload digest are the strings the socket path writes, so
  custody, `strict-fresh` and derived publication (`src/canticle/derived.ts`) don't care which path heard a record.
- **No link between custody and the cursor.** Custody never moves the ring cursor, and the cursor never settles
  custody.

### 5.3 Mute, digest, immediate and `wakeKeys`

All of these are unchanged, and apply when the reader first takes a record in (`delivery.ts:510-650`):

- **The push filter.** `wakeKeys`, hop 0 and not wake-derived are checked by `#passOver` (`delivery.ts:652-664`).
  The ring path improves one thing: `wake_derived` comes from the signed flags, so it is never unknown. Record v1 may
  leave it out, and an unknown value counts as wake-derived (`receptor.ts:80-84`).
- **Mute at any scope wins.** A record first taken in under a mute is never pushed. The host daemon's MUTE and breaker
  arrive in `landing_state` on the host socket (RFC:2303). Until that socket has delivered a `landing_state`, nothing
  from the ring is pushed, by record v1's rule that nothing is delivered before a run's first `landing_state`
  (RFC:2251). `hear` says so.
- **Catch-up records** are judged by the mute in force when the reader takes them in, as join-snapshot entries are
  today (`docs/runbook.md:806`). Whether a mute in force at hearing time should bind instead is Q-G4.
- **Digest and immediate** work as above. `style: counts` suits sustained streams (§6).

## 6. Volume model

**Supply is capped upstream by the carousel's budgets.** Each stream has `B_stream` 4 000 bit/s, each station
`B_station` 16 000 bit/s, and each item needs `k_avail` = 3 repeats in its life (RFC:505-509). The ring stores one
copy per frame, so it is written at the new-item rate, not the loop rate.

A stream's loop traffic is held at `B_stream`, and an item stays available only while
`fair_ms = 8 · size · n / B_stream ≤ TTL / 3` (RFC:515-522). So at most `n` items can be live at once, and new items
arrive at most at `n / TTL` per second:

| Stream                                 | Live items at most | New items/s at most |
| -------------------------------------- | ------------------ | ------------------- |
| chatter, 600 B, TTL 60 s               | 16                 | 0.27                |
| chatter, 200 B, TTL 60 s               | 50                 | 0.83                |
| ambient, 900 B, TTL 300 s              | 55                 | 0.18                |
| one station at `B_station` (4 streams) |                    | about 1 to 3        |
| six stations at `B_station`            |                    | about 6 to 20       |

At 1 400 B a slot, a fleet ceiling of 6/s writes about 518 000 slots (726 MB) a day, and 20/s about 1.7 million slots
(2.4 GB). ringserver's default 1 GiB ring holds about 766 000 slots, so 1.5 days at 6/s and about 10 hours at 20/s.
Today's traffic is mostly cues, such as fleet scripts announcing a flush, deploy or restart on `ops.fleet`
(`docs/runbook.md:682-685`), far below these ceilings.

**Sizing rule.** Retention must exceed the longest TTL in use (up to 86 400 s for `finding-ref`, which the restart
rebuild needs) and the longest frond-ear outage the ring should bridge, with margin.

**Demand is capped by the session.** A push carries at most `maxItems` records (up to 10) and `maxNotificationChars`
characters (6 000 by default), at most `maxPushesPerHour` times an hour (up to 360) (`docs/runbook.md:711-717`). That
is 3 600 records an hour at the outer limit and 300 by default: about 360 KB of text an hour, roughly 90 k tokens at
four characters a token. A
session cannot take even one station at its carousel ceiling record by record. The ring sustains ingestion and replay
at that ceiling with room to spare. Sessions get digests (`style: counts`) and pull detail with `hear`.

**Sustained streams, such as music or readings, go by reference.**

- **They don't fit the broadcast plane as inline items.** A reading at one 200-byte line a second is 1 600 bit/s,
  40 % of a stream's budget before its three repeats, and every line would be a separate record for the session.
- **The content becomes an object, and the frame a doorbell.** The producer stores each segment (an audio chunk, a
  chapter, a transcript slice) as an object in the frond's MinIO with its SHA-256. It then sings a `finding-ref`
  carrying `body_ref = [url, sha256, size]`, content type 8, and optionally a short summary body (RFC:820,
  RFC:924-927, decision D2). That is one doorbell per segment or minute, not per line or beat.
- **frond-ear never fetches it.** It shows `body_ref` and stops there (`src/canticle/hear.ts:176`; RFC:832). Fetching
  is a separate act by the session.
- **Inline or reference.** Inline when the content fits one frame (a body of up to about 980 B with core keys,
  RFC:912) and loses its meaning when late: cues and live state. By reference when it is bigger than one frame,
  arrives faster than one item per loop period on a stream, or must outlive the class's maximum TTL.
- **Never raise `MaxPacketSize` to carry blobs.** Frames are at most 1 100 B (RFC:750; `src/canticle/wire.ts:33`),
  and a 1 280-byte slot carries the envelope, frame and tag with room to spare. Every slot costs `MaxPacketSize` plus
  120 B whatever its payload (`rs:src/ring.c:147`), so big slots shrink retention for every cue.
- **High-rate signed streams that must stay inline** (beat events at 10/s, say) need a binding the RFC doesn't have
  (Q-B7).

## 7. Failure modes

| Failure                                        | Detected by                                                                                                          | Behaviour                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ringserver down or unreachable                 | A connect error, a send timeout, or no `tick` for three intervals                                                    | Back off as the receptor does (1 s·2ⁿ up to 30 s, plus jitter, `receptor.ts:309-318`). Health `degraded`, reason `ring_unavailable`. `hear` says content since T may be missing, and live items keep expiring. Resume from the cursor afterwards; holes from writer drops show as `ring_gap`. |
| Ring wrap (reader too slow, or down too long)  | Cursor validation (not found, below `EarliestPacketID`), or a seq hole while streaming (a lap, E2)                   | `ring_overrun`, counted exactly within a run. Affected items are hidden until confirmed. `READ EarliestPacketID`, then `STREAM`.                                                                                                                                                              |
| Clean ringserver restart, persistent ring      | `READ` at the cursor validates                                                                                       | Nothing to report.                                                                                                                                                                                                                                                                            |
| ringserver crash (`kill -9`, power loss)       | Validation fails: the packet id is above `LatestPacketID`, or another packet now holds it (E3)                       | `ring_reset`. Re-read from the earliest packet, skip known (run, seq) pairs, and count holes.                                                                                                                                                                                                 |
| Ring reset, volatile restart, or corrupt files | `LatestPacketID` is below the cursor, or `StartTime` changed                                                         | `ring_reset`, count `unknown` across runs. With `AutoRecovery 1` (the default) corrupt files are set aside and the ring starts empty.                                                                                                                                                         |
| Ring resized                                   | Packet ids are kept but their pkttimes are reset (E3)                                                                | Envelope validation passes. Never rely on pkttime alone.                                                                                                                                                                                                                                      |
| Writer (daemon) restart                        | A new run                                                                                                            | After a `bye`, nothing is hidden. Without one, the previous run's items are hidden until confirmed.                                                                                                                                                                                           |
| Station clock ahead                            | `issued_at` more than 5 s after `h`                                                                                  | Refused as `not-yet-valid` (`wire.ts:546-547`). Within 5 s, the first-hearing cap bounds it.                                                                                                                                                                                                  |
| Station clock behind                           | `expired_on_read` for that key; `expiry_delta` in shadow mode; the daemon's `health` reports `clock_skew` (RFC:2185) | Items expire early by the skew, on the ring path only (δ̂ = 0). Fail closed.                                                                                                                                                                                                                   |
| Unauthenticated packets (another local writer) | The tag                                                                                                              | Dropped and counted. They never move the seq accounting.                                                                                                                                                                                                                                      |
| Manifest change                                |                                                                                                                      | Applies to the next read. A restart rebuild drops items from revoked keys.                                                                                                                                                                                                                    |

**Why there is no automatic fallback to the socket when the ring is down.**

- **The two paths lose data differently.** Record v1 drops `frame` records and clears its live set on gaps; the ring
  keeps everything and reports holes. With both behind one view, "never silently skip" can't be stated for the moments
  of switching, and every switch back would need the hidden-until-confirmed reconciliation in both directions.
- **`primary` exists for exactly the case where the socket path does worse.** Falling back silently would bring that
  case back in the middle of a session.
- **An outage is visible, short and lossless.** ringserver is a local, supervised process with a persistent ring. An
  outage shows as `ring_unavailable`, and the reader recovers from its cursor without loss if the ring outlived it.
- **Rollback stays an operator's act.** Setting `ring.mode: shadow` and restarting puts the socket path back in
  charge. Nothing is pushed twice, because tombstones are kept by identity.

## 8. Migration

```json
"canticle": {
  "source": "host-daemon",
  "ring": {
    "mode": "off",
    "address": "127.0.0.1:16000",
    "keyFile": "/path/to/canticle-ring.key"
  }
}
```

- **`mode`** is `off` (the default), `shadow` or `primary`. Any other mode needs `source: host-daemon`, or config
  load fails. Like `source` and `tune`, it is read only at start (`docs/runbook.md:642`). In version 1 `address` must
  be loopback, and `keyFile` must be mode 0600. The tick interval comes from the writer's `hello`, not from config.
- **`shadow`.** `RingSource` runs with its own cursor and listener state and feeds nothing to `hear` or delivery. It
  compares, by identity, what it reads against what the socket consumer reports:

  | Counter           | Meaning                                                                                                         |
  | ----------------- | --------------------------------------------------------------------------------------------------------------- |
  | `both`            | Seen on both paths with the same frame SHA-256 (record v1's `frame.sha256`, RFC:2195)                           |
  | `digest_mismatch` | The same identity with different bytes: a bug, or an equivocation one path missed                               |
  | `ring_only`       | The socket lost it (`records_lost`). This is the ring's value.                                                  |
  | `socket_only`     | The ring lost it or the writer skipped it. An unexplained one blocks promotion.                                 |
  | `expiry_delta`    | The ring's local expiry minus the socket's `local_expiry_at`. Expected to be negative for stations whose δ̂ > 0. |
  | `latency`         | The ring's read time minus the socket's receive time, p50 and p99                                               |

  The comparison window is the longest live TTL, keyed by identity and capped at twice `MAX_LIVE`, with overflow
  counted. It shows in `ear_status` as `canticle.ring.shadow`, with one log line per divergence giving the identity
  only.

- **Promotion to `primary` (proposed).** N days of shadow on one seat with no unexplained `socket_only` or
  `digest_mismatch`, every `ring_gap` explained, and latency p99 under 2 s.
- **`primary`.** The ring feeds `hear` and delivery. The socket still feeds `landing_state`, presence and health, and
  its consumer keeps the shadow counters with the roles reversed.
- **Rollback.** Set `mode` to `shadow` or `off` and restart. Tombstones and custody are kept by identity, so switching
  paths pushes nothing twice.
- **Order (proposed).**
  1. The binary-canticle writer, behind its own flag (bc#130's bridge).
  2. frond-ear in `shadow` on one mixed host.
  3. `primary` on that host.
  4. The other hosts.

## 9. Test plan for the code

**Fakes,** alongside the existing `FakeClock`, `FakeTimers`, fake shim over a real socket, and
`test/canticle-host.ts`:

- **`FakeRingserver`.** A DataLink server over a real loopback socket (`node:net`) that answers `ID`, `INFO STATUS`,
  `WRITE` (with flags `A` and `N`), `READ`, `POSITION SET` (an id, an id with a pkttime, `EARLIEST` and `LATEST`),
  `STREAM` and `ENDSTREAM`, using fixed slots. It reproduces the real server's quirks from Appendix A:
  - `POSITION SET N` then `STREAM` delivers from N + 1;
  - `STREAM` after a failed `POSITION SET` starts at the next new packet;
  - `EARLIEST` and `AFTER` skip their first match;
  - a lapped reader is skipped forward without notice;
  - a crash rolls back to the last saved header and hands ids out again;
  - a reset starts ids at 1, and a resize resets pkttimes;
  - delivery is throttled by up to 1 s, and a client silent for 10 s is dropped.

  It can also inject faults: a drop in mid-packet, a stall, a refused connection.

- **`FakeWriter`.** Builds tagged envelopes around frames signed with the fixture keys
  (`test/fixtures/canticle/frame-v2-candidates.json`, as `test/canticle-listener.test.ts` does). It has switches for
  holes, retries, bad tags, and runs with or without `bye`.
- **A conformance script,** outside `pnpm check` like `tools/chaos`, that runs the same scenarios against a real
  ringserver 4.5.4 built in a temp dir. It keeps the fake's quirks true to the server; Appendix A is its first run.

Each case asserts the counters, what `hear` shows and what is pushed:

1. **Cursor.** Process N packets, checkpoint, restart: the reader resumes at N + 1, nothing is pushed twice, and no
   gap is reported.
2. **Crash between the journal and the checkpoint.** Replay changes nothing: a PLUCK stays sticky, and a predecessor
   stays superseded even when its supersessor has expired by the time of the replay (TTLs that differ). Purges still
   hold although `hear(…, h)` runs behind `tick(now)`.
3. **Rebuild from the list of live packet ids.** Items that expired meanwhile are dropped and counted. The others show
   `late: … (replay)`. A 24-hour `finding-ref` item doesn't force a full re-read.
4. **A gap within a run.** One `ring_gap` with the exact count. Items from before it are hidden. A re-append of the
   same identity confirms one; an unconfirmed one leaves at expiry.
5. **A writer restart.** After `bye`, nothing is hidden. Without it, the previous run is hidden and
   `writer_restarted_without_bye` is reported.
6. **A wrap while the reader is stopped.** `ring_overrun` with the exact count, then `READ EarliestPacketID` and
   `STREAM`. Nothing is skipped silently, and the client never sends `STREAM` after a failed `POSITION`.
7. **A lap while streaming** (the fake skips forward). It shows as a seq hole, reported as `ring_gap`.
8. **Ids handed out again after a crash** (the fake rolls back). The cursor's packet id now holds another packet:
   `ring_reset`. Known (run, seq) pairs are skipped and holes are counted.
9. **A reset or volatile restart.** Ids start again at 1; the reader detects it and records the change in `StartTime`.
10. **Duplicates.** The same (run, seq) twice (a writer retry) is admitted once and counted as `ring_duplicate`; with
    different bytes it is `ring_conflict`. The same identity in two runs is pushed once.
11. **Expiry.**
    - A packet expired on read never reaches the live set, `hear` or a push, and counts as `expired_on_read`.
    - One with 2 s left is gone after 2 s (test EM-01, RFC:1788).
    - A `heard_at` in the future is clamped to now, and δ̂ is never positive.
    - An old frame replayed with `heard_at` set to now can't outlive its `expires_at`.
12. **Trust.**
    - A bad tag is dropped and moves no seq.
    - A stream label that doesn't match its frame is dropped.
    - A bad signature or unknown key is refused.
    - After a key is removed from the manifest and frond-ear restarts, that key's retained packets are refused.
13. **Backpressure.**
    - With no session attached, delivery holds; the reader keeps reading, its cursor advances, and memory stays
      bounded.
    - Drops from `bufferPerStream` are counted.
    - 100 000 packets from one key over quota are refused as `over-quota`, and memory stays bounded.
14. **Ring unavailable.** `ring_unavailable`, backoff, and a line in `hear`. Recovery from the cursor; holes from
    writer drops show as `ring_gap`.
15. **Landing state.** A daemon MUTE arriving over the host socket withdraws ring items from pushes. With no
    `landing_state` yet, nothing is pushed. An open breaker holds pushes.
16. **Custody.** A push from the ring writes claimed, offered and echoed rows with the same identity and digest as the
    socket path, plus `origin` and `run:seq`. A `hear` exposure does the same.
17. **Shadow.** The same frames through `canticle-host.ts` and the fake ring count as `both`. An injected socket drop
    gives `ring_only`, an injected writer skip gives `socket_only`, and a station with a δ̂ gives `expiry_delta`.
18. **Keepalive.** An idle reader sends `ID` within `ClientTimeout`, and its first command within 10 s.

## 10. Open questions

**For the binary-canticle owners:**

- **Q-B1.** bc#130 leaves lane (c), raw frames, out of scope. frond-ear's reader needs it, to verify again at read
  time. Can lane (c) become the machine lane frond-ear reads, with §3.2's envelope? Lanes (b) and (e) carry the
  bridge's JSON projection of an item, which is never signed (RFC:902), so a reader can't verify them.
- **Q-B2.** Can the stream id be hex, `BC_<key>_<stream>/CANTICLE`, rather than `<NET>_<STA>_<stream>/CANTICLE`? That
  avoids ringserver's 63-byte limit and the naming table.
- **Q-B3.** Should the writer live inside the daemon, after its write-ahead save (W2, preferred), or in a sidecar that
  reads record v1? A sidecar can't produce lane (c): record v1 carries only the frame's digest and size, not its bytes
  (RFC:2195).
- **Q-B4.** Can the writer re-append `resurfaced` frames after a daemon restart? Confirming hidden items depends on it.
- **Q-B5.** The HMAC key would be per host, in a 0600 file readable by the binding's uid (the daemon allows only its
  own uid by default, `bc:prototype/canticle-station/canticle/daemon.py:8`). How is it rotated?
- **Q-B6.** Version 1 writes no beacons. Should a later version write occasional beacons, so ring readers get
  `head_seq` and `trail_seq` to check for censorship (RFC:348)?
- **Q-B7.** Should there be a reliable binding (station to ring, or relay to ring) for high-rate signed streams that
  can't go by reference? It would need an RFC amendment alongside §11.
- **Q-B8.** Should control frames (MUTE, §10.6) go in the ring, so readers on other hosts can honour them?

**For 🍃 frond-gloss:**

- **Q-G1.** Do you agree there should be no automatic content fallback when the ring is down (§7)?
- **Q-G2.** For gaps, hide until confirmed (this note), or clear, as `records.ts` does?
- **Q-G3.** Expired retained packets never reach a session. Or should there be a pull tool (a `canticle_replay`, with
  custody path `replay` and each item labelled expired)?
- **Q-G4.** Should the mute for catch-up records apply at take-in, as for join snapshots today, or at hearing time?
- **Q-G5.** Are custody's `origin` and `run:seq` fields worth the schema change?

**For 🌫 silas:**

- **Q-S1.** ringserver can't bind loopback, since it always listens on every address (`rs:src/config.c:2675-2677`).
  Are `AcceptIP 127.0.0.1/32` and a host firewall enough? `READ <pktid>` bypasses `AllowedStreamsIP` and
  `ForbiddenStreamsIP` (`rs:src/ring.c:938-943`), and `AuthRequiredForStreams` gates only `STREAM`
  (`rs:src/dlclient.c:164-171`). So stream ACLs within one ring can't keep bc#130's line between human and machine
  lanes. Should the machine lanes get their own ringserver instance?
- **Q-S2.** Would write authentication through `AuthCommand` be enough to drop the HMAC? Note that a failed `AUTH`
  doesn't disconnect, and a successful one replaces the permissions granted by IP.
- **Q-S3.** A crash makes ringserver hand ids out again (E3). Which should silas and ronan run: a memory-mapped ring,
  `MemoryMapRing 0`, or a volatile one? Who owns the systemd unit, and what ring size (§6)?
- **Q-S4.** Lanes (b) and (e) stay as RFC §18.3 has them, for dashboards. Does anything here conflict with
  `bc:spike/silas-seedlink-mapping.md`?

## Appendix A. Local experiment (2026-11-22)

The experiment was a throwaway, run on loopback only, and touched no live system. ringserver 4.5.4 was built from the
karmaterminal fork at `2df558c` in a temp dir and configured with `AcceptIP 127.0.0.1/32`,
`WriteIP 127.0.0.1/32`, `ListenPort <free port> DataLink IPv4`, `RingSize 1M` and `MaxPacketSize 1280`, which gives
746 slots of 1 400 B. The client was a zero-dependency DataLink client in about 100 lines of Node.

```sh
git clone https://github.com/karmaterminal/ringserver.git && cp -r ringserver build && make -C build
build/ringserver -v ring.conf              # the config above
node e1.mjs <port>                         # handshake, positions, latency, oversize
node e2.mjs <port>                         # wrap, STREAM after "not found", a lapped reader
node e3.mjs <port> write|status|read|pos   # between restarts: kill -TERM, kill -9, volatile, resize
```

| #   | What was checked                                                           | Result                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Handshake                                                                  | `ID DataLink v1.1 (RingServer/4.5.4) :: DLPROTO:1.1 PACKETSIZE:1280 WRITE`                                                                                                                                                                                      |
| E1  | Write ack                                                                  | `OK <pktid> 0`; ids 1, 2, 3 … across all streams                                                                                                                                                                                                                |
| E1  | `POSITION SET 3 <pkttime>`, then the same with a pkttime 5 s off           | `OK 3`, then `ERROR … Packet not found`                                                                                                                                                                                                                         |
| E1  | `POSITION SET 2` then `STREAM`                                             | The first packet is 3                                                                                                                                                                                                                                           |
| E1  | `POSITION SET EARLIEST` then `STREAM`                                      | The first packet is 2: the earliest is skipped                                                                                                                                                                                                                  |
| E1  | `POSITION AFTER` (first match 2) then `STREAM`                             | Positioned at 2, first packet 3: the first match is skipped                                                                                                                                                                                                     |
| E1  | `READ 1` then `STREAM`                                                     | The first packet is 2, so this is the safe resume                                                                                                                                                                                                               |
| E1  | Latency to a caught-up reader                                              | 500 to 501 ms, six times, at one write per 1.5 s (the server's send throttle steps 200 ms up to 1 s, `rs:src/clients.c:47-48`)                                                                                                                                  |
| E1  | A 1 281-byte payload on a 1 280 ring                                       | `ERROR 0 … Error adding packet to ring`, then disconnected                                                                                                                                                                                                      |
| E2  | 811 packets into 746 slots                                                 | `EarliestPacketID` 66                                                                                                                                                                                                                                           |
| E2  | `POSITION SET 3 <pkttime>` after the wrap                                  | `ERROR … Packet not found`                                                                                                                                                                                                                                      |
| E2  | `STREAM` sent anyway, then one new write                                   | The first packet is 812, the new one: the 746 packets still held (66 to 811) were skipped silently                                                                                                                                                              |
| E2  | A streaming reader paused about 4 s while 20 000 packets were written      | 1 349 packets arrived, then the ids jumped from 1340 to 20737 with no message. Packets 20068 to 20736 were still in the ring and were skipped too.                                                                                                              |
| E3  | Clean restart of a memory-mapped ring                                      | Ids carry on (latest 5, next 6), and `POSITION SET 5 <pkttime>` still succeeds                                                                                                                                                                                  |
| E3  | `kill -9` after a clean restart and 3 more writes (B-1 to B-3, ids 6 to 8) | Restarted with latest 5. `READ 6` and `READ 8` were not found. The next writes C-1 to C-3 **got ids 6 to 8 again**.                                                                                                                                             |
| E3  | `kill -9` of a ring never shut down cleanly                                | `Packet buffer signature mismatch` and `Resetting ring packet buffer, contents are discarded`; ids start at 1                                                                                                                                                   |
| E3  | Volatile ring restart                                                      | Empty; ids start at 1                                                                                                                                                                                                                                           |
| E3  | `MemoryMapRing 0`, then a clean cycle, 3 writes and `kill -9`              | Rolled back to latest 3. The next write got id 4 again, with a different payload.                                                                                                                                                                               |
| E3  | `RingSize` changed from 1M to 2M across a restart                          | The packets were loaded from `.version3` with their ids kept. The pkttime changed (`…311328259` to `…311850677` µs). `POSITION SET 3 <old pkttime>` passed only because both fell in the same second (the check is to the second, `rs:src/dlclient.c:509-527`). |

What the experiment settles for the design: a packet id can't serve as a cursor on its own (E3). pkttime is checked
only to the second (`rs:src/dlclient.c:509-527`), so it can't tell a reused id from the original when both fall in
the same second. And a careless resume or a slow reader loses data with no message (E2). Hence the authenticated
(run, seq) envelope, validating the cursor by `READ`, and treating a seq hole as the only loss signal.
