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

| #     | Question                    | Decision                                                                                                                                                                                                                                                               |
| ----- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Who writes                  | The host daemon, after it has verified a frame and saved the state that frame implies. It appends each frame its receptor surfaces. Stations never write the canticle lane.                                                                                            |
| 1     | What a reader may assume    | Only that something with write access appended these bytes. The reader re-verifies each station signature against its own manifest and checks expiry on its own clock. It trusts order and completeness only when the writer's own signature on the envelope verifies. |
| 1     | Which ring                  | A ringserver instance of the canticle lane's own, with writes gated to the daemon.                                                                                                                                                                                     |
| 2     | Packet                      | One ring packet per surfaced frame per writer run. Each packet is a 40-byte envelope, the station's canonical frame byte for byte, and a 64-byte Ed25519 writer signature, under the stream id `BC_<key_id>_<stream_id>/CANTICLE`.                                     |
| 2     | Identity                    | A record is identified by its frame tuple, as today. A position in the ring is identified by the signed pair (writer run, writer seq). ringserver's packet id only locates a packet; the same id can later name a different packet.                                    |
| 3     | Cursor                      | Kept in frond-ear's SQLite store, in the same transaction as the listener's safety state. The live frames are kept there too, so a restart needs nothing from the ring. On resume the reader reads the cursor's packet back and checks that it is the one recorded.    |
| 3     | Gaps                        | A hole in the writer seq is loss, and it is reported; so is a writer run first seen past seq 1. Everything heard before a hole is hidden until the host socket confirms it or it expires. The reader sends `STREAM` only straight after a `READ` that succeeded.       |
| 3     | Backpressure                | The reader never waits for the session. The cursor advances as packets are processed. Keeping pace with the session stays delivery's job: digests, and drops that are counted.                                                                                         |
| 4     | Expiry                      | Checked at read time on the reader's clock. The clock offset may only move expiry earlier. A retained packet that has expired is never pushed, live or late; it is counted.                                                                                            |
| 4     | Landing                     | Ring items are shown and pushed only while the host socket's state is deliverable: connected, holding the `landing_state` of the writer's daemon run, and with no MUTE. This is the record v1 binding's own rule.                                                      |
| 4     | Custody                     | Unchanged: the same identities, tombstones, offered and echoed rows, and compaction-boundary stamps. Rows gain an origin and a ring position.                                                                                                                          |
| 5     | Volume                      | The ring buys reliability and replay, not throughput. The carousel's budgets cap what comes in and the session caps what goes out. Anything bigger than one frame, or continuous, goes by reference.                                                                   |
| 6     | ringserver down             | Report it. Never fall back to the socket for content automatically.                                                                                                                                                                                                    |
| 6     | Wrap, reset, crash          | Detected by checking the envelope at the cursor. Loss is counted from seq holes. What frond-ear already read stays in its store.                                                                                                                                       |
| 6     | Station with a skewed clock | Fail closed: items may expire early, never late.                                                                                                                                                                                                                       |
| 7     | Migration                   | `canticle.ring.mode`: `off` (the default), then `shadow` (compare only), then `primary` (content comes from the ring; control still comes from the host socket). It needs the daemon's manifest.                                                                       |
| Scope | Where it runs               | Version 1 is same-host: the ringserver runs on the daemon's host, and the reader runs beside the record v1 socket. Readers on other hosts are an open question.                                                                                                        |

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

- **The daemon already checks what ringserver can't.** It verifies frames, applies grants and per-key quotas, keeps
  epoch regressions from superseding anything, detects equivocation and deduplicates loops (RFC:2211-2233).
  ringserver stores any bytes ("not format specific", `rs:README.md:7-9`), with no dedup and no ordering check on
  writes (`rs:src/dlclient.c:863-1018`).
- **One writer means one credential to grant.** Letting stations write directly would give every station host write
  access to a ring that evicts its oldest packets first (`rs:src/ring.c:744-788`). One flooding station would then
  evict every other station's history.
- **Writing the ring directly would be a new binding.** The broadcast edge is UDP by decision D10 (RFC:1186-1193).
  The RFC joins the two tiers "at a ring" through a bridge (RFC:2728, RFC:2738). A station writing TCP to a ring is a
  different binding (Q-B7).
- **"One ring packet per identity tuple" (RFC:2738) needs loops already deduplicated**, which only happens after a
  receptor.

**What the writer does.** These requirements are for the binary-canticle owners:

| #   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | **What to append.** Append an ITEM when the receptor first emits a deliverable `frame` record for it (`verified` and `surface`, RFC:2213). For an item held in warm-up, that is its release (RFC:2215); a held item retracted before release (`held_*`, RFC:2216) is never appended. Also append a `resurfaced` re-hearing after a daemon restart (with flag bit 0, §3.2), each PLUCK the receptor admits, and the second byte string of an equivocation, once. Append nothing else: no control-class items (class 8: MUTE and the rest act through `landing_state`, §1), no refusals, no benign repeats, nothing `ringbuffer_only`, no BEACONs (§4.1). |
| W2  | **After the save.** Append only after the daemon's write-ahead save for that datagram (`bc:prototype/canticle-station/canticle/daemon.py:32-33`), so no ring packet ever precedes the guard it implies.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| W3  | **Never block.** Keep a bounded first-in, first-out writer queue. Assign `seq` when a packet is queued, and never reuse it. A packet dropped at the writer leaves a hole, as record v1's `rec_seq` does (RFC:2161).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| W4  | **Retry in order, with the same bytes.** After a lost ack, retry with the same run, seq and bytes, so the retry can be recognised as a duplicate (ringserver doesn't deduplicate). A deterministic error, such as an oversize write that disconnects (E1), is a dropped packet; don't retry it.                                                                                                                                                                                                                                                                                                                                                         |
| W5  | **Runs only grow.** `run` is persisted and strictly increasing: `max(previous + 1, unix ms at start)`, written durably before the first packet. This is RFC §5.2's epoch rule (RFC:312).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| W6  | **Control packets.** Write `hello` at run start, `bye` on clean stop, and `tick` every 10 s. `hello` and every `tick` carry the daemon's record v1 `run`, its manifest's SHA-256 and the tick interval; `tick` also carries counts written and dropped, and the queue depth.                                                                                                                                                                                                                                                                                                                                                                            |
| W7  | **Sign.** Sign each packet with a dedicated Ed25519 writer key. Never use a station key: a canticle key "MUST NOT be used to sign anything outside this protocol" (RFC:784). Readers pin the writer's public key.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| W8  | **Header times.** Set the DataLink header's datastart to `issued_at` and dataend to the effective expiry, in µs. This serves dashboards and `POSITION AFTER`. Readers never trust these times.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**What a reader may assume about a ring packet.** Only what it checks itself:

| Property                                        | What the reader trusts on the ring path                                                              | Why it is checked again                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content and author                              | The station's signature, resolved through the reader's own manifest (`src/canticle/wire.ts:445-560`) | ringserver accepts any bytes from any client allowed to write. A revocation made after a packet was written then applies to that retained packet on its next read.   |
| Freshness                                       | The signed `expires_at`, read on the reader's clock (§5.1)                                           | The ring evicts by size, not by TTL (RFC:2752), so retained packets outlive their items.                                                                             |
| Identity                                        | The frame's own tuple, never the ring stream id or the packet id                                     | Stream ids are text the writer chooses. Packet ids are handed out again after a crash (Appendix A, E3).                                                              |
| Order and completeness                          | The (run, seq) under the writer's signature                                                          | A lapped reader is skipped forward without notice (E2), crash recovery reuses ids (E3), and any client allowed to write can plant ids (`rs:src/dlclient.c:914-919`). |
| Admission (dedup, plucks, supersession, quotas) | The reader's own listener                                                                            | The daemon's decisions are not carried in the ring; only its frames are.                                                                                             |

**Why verify again when the writer already did.** It costs one Ed25519 verification per new frame, not per loop
copy, at a few frames a second at most (§6). In return, the ringserver process, its ACLs, its other writers and the
ring file all drop out of what must be trusted for content. The writer stays trusted for availability and
completeness only.

**Why the envelope is signed, not tagged with a shared key.**

- **Anything that can write could otherwise fake completeness.** ringserver cannot bind loopback only: it listens on
  every address (`getaddrinfo(NULL, …, AI_PASSIVE)`, `rs:src/config.c:2675-2677`). Without the signature, anything
  that can write could forge `hello`, `bye` or `tick`, or fabricate a clean-looking sequence. It could never forge a
  station's content (station signatures stop that), but it could fake completeness.
- **A shared key would let readers forge for one another.** Several readers would hold an HMAC key (frond-ear, an
  OpenClaw binding, bc#130's tool), and each could forge for the others. A verify-only public key lets none of them
  forge.
- **It works from any host,** so readers on other hosts stay possible later.

**Decision: the canticle lane gets a ringserver instance of its own, with writes gated to the daemon.**

- **One ring can't hold bc#130's line between human and machine lanes.** `READ <pktid>` bypasses `AllowedStreamsIP`
  and `ForbiddenStreamsIP` (`RingRead` checks neither, `rs:src/ring.c:952-992`), and `AuthRequiredForStreams` gates
  only `STREAM` (`rs:src/dlclient.c:164-171`).
- **A shared ring invites interference.** Any writer to it could evict canticle packets, or plant packet ids with
  `WRITE` flag `I` (`rs:src/dlclient.c:914-919`).
- **Retention is sized for one lane.**
- **How writes are gated.** With no `WriteIP`, ringserver grants writes to localhost (`rs:src/config.c:810-818`),
  which is every local process. Set `WriteIP` to an address nothing connects from, and grant write through
  `AuthCommand` to the daemon's credential alone; a successful `AUTH` replaces the permissions granted by IP
  (`rs:src/auth.c:222`). See Q-S2.
- **The two controls do different jobs.** The signature decides what a reader accepts; the write gate protects
  availability.

## 3. Packet identity and mapping

### 3.1 Ring stream id

The stream id is `BC_<key_id, 16 hex>_<stream_id, 8 hex>/CANTICLE`: 37 bytes, under ringserver's limit of 63
(`rs:src/ring.h:58`; a longer id gets `ERROR` and a disconnect, `rs:src/dlclient.c:876-884`). Writer control packets
use the all-zero id `BC_0000000000000000_00000000/CANTICLE`.

This departs from RFC §18.3 lane (c), which names the stream `<NET>_<STA>_<stream>/CANTICLE` (RFC:2744). A stream name
alone can be 64 bytes (RFC:327), so that form can exceed the limit, and it needs §18.5's NET/STA table
(RFC:2756-2764). Hex ids need no table, and names stay a manifest lookup at the reader (RFC:341). See Q-B2.

### 3.2 Payload

| Offset | Size | Field                                                                                                                                                  |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0      | 4    | magic `BCRP`                                                                                                                                           |
| 4      | 1    | version `1`                                                                                                                                            |
| 5      | 1    | kind: `1` frame, `2` hello, `3` bye, `4` tick                                                                                                          |
| 6      | 1    | flags: bit 0 `resurfaced` (a re-hearing after the daemon restarted, RFC:2218); other bits zero                                                         |
| 7      | 1    | reserved, zero                                                                                                                                         |
| 8      | 8    | `run`: strictly increasing across writer starts (W5)                                                                                                   |
| 16     | 8    | `seq`: within the run, starts at 1 (the `hello`) and rises by 1 for each packet assigned; a hole is loss                                               |
| 24     | 8    | `heard_at`: ms since the epoch; the daemon's receive time for a frame, its send time for a control packet                                              |
| 32     | 4    | `offset_ms`: signed; the daemon's δ̂ (its clock minus the station's) for the frame's key when it heard the frame; zero for control packets              |
| 36     | 4    | reserved, zero                                                                                                                                         |
| 40     | n    | body. For a frame, the canonical frame byte for byte (at most 1 100 B, RFC:750). For a control packet, a small deterministic CBOR map with W6's fields |
| 40 + n | 64   | Ed25519 signature by the writer key over `"binary-canticle/ring/v1" ‖ 0x00 ‖ bytes 0 to 40 + n`                                                        |

The largest packet is 1 204 B. Use `MaxPacketSize 1280`. Every slot then costs 1 400 B: `MaxPacketSize` plus the
120-byte `RingPacket` header (`rs:src/ring.h:87-98`, `rs:src/ringserver.c:106`). The server logs it as
`pktsize: 1400 (1280 payload)` (Appendix A).

### 3.3 Ordering and identity across reconnects

- **Order.** Writes are totally ordered under the server's ring lock and delivered in write order
  (`rs:src/ring.c:709-742`). With one writer, packet id order is seq order. Across stations the order is the daemon's
  surfacing order, which is the order the reader's listener needs: plucks and supersessions apply as the daemon
  applied them.
- **Record identity.** The tuple (key_id, epoch, stream_id, seq) is record v1's `idem` (RFC:2196) and delivery's
  `identity()` (`src/canticle/delivery.ts:101`, with the stream named). Both paths produce the same string when they
  use the same manifest, so tombstones, custody and dedup work across them. §8 requires the same manifest.
- **Byte identity.** The SHA-256 of the frame is record v1's `frame.sha256` (RFC:2195). Shadow mode and gap
  confirmation compare the paths with it (§4.4, §8).
- **Position.** A position is (run, seq). A packet id locates it within one ring generation and nothing more. Packet
  ids are handed out again after a `kill -9`, restart at 1 after a reset or with a volatile ring, and keep their
  number with a new pkttime after a resize (Appendix A, E3). ringserver has no generation marker to tell these apart:
  its saved header holds only format, sizes and offsets (`rs:src/ring.h:70-81`).
- **Writer-supplied packet ids were considered and rejected.** DataLink 1.1 lets a writer submit its own ids
  (`rs:doc/ringserver.md:354-362`, flag `I` at `rs:src/dlclient.c:914-919`). But the server checks them neither for
  uniqueness nor for order, so a reader would have to validate them anyway. (run, seq) under the writer's signature
  does that without depending on the server.

## 4. Reader semantics

### 4.1 Shape in frond-ear

A third `CanticleSource` (`src/canticle/source.ts:19-24`), `RingSource`, combines two parts:

- **The existing `RecordClient` on the host socket.** It supplies `landing_state`, presence and health, and its live
  set is the witness that confirms hidden items (§4.4). In `shadow` mode it is also the comparison.
- **A `RingReader`.** It keeps one DataLink TCP connection (`node:net`, no dependencies), checks each packet's writer
  signature, and feeds each frame into the existing `Listener` (`src/canticle/listener.ts`), with `warmup: false`
  (`listener.ts:337`) and no beacons. Reusing the listener brings the verification, dedup, plucks, supersession,
  quotas and journaled guards that the embedded path already proves (`src/canticle/receptor.ts:335-376`). The ring
  path then adds transport and a cursor, not a second admission implementation.

**Feeding at hearing time.** Each frame is fed at `h = min(envelope heard_at, now)`, with the envelope's clamped
offset (§5.1) in place of beacon samples. The guards (epoch high-water mark, sticky plucks, supersession marks) are
then raised in the daemon's order and at its hearing times; not identically, since retain horizons use the clamped
offset (`listener.ts:818`). Liveness is judged against `now` afterwards (§5.1).

This matters when one key's items have different TTLs: after a restart, a supersessor that has expired must still
block its predecessor that hasn't. The listener has so far seen only forward-moving time, so the code must run
`tick(now)` after each `hear(…, h)` and test that purges still hold (§9, case 2).

**Warm-up off, no beacons.**

- **Warm-up can be off.** §6.3 item 4's warm-up (RFC:400) stops an older value from landing as current before the
  newer one is heard after a restart. The daemon applies warm-up itself and appends a held item only on release
  (W1). The ring keeps the daemon's surfacing order, and the persisted marks cover a reader restart.
- **With warm-up on it would block.** With no beacons, the listener would hold live-state items forever, since
  `#warm` needs a beacon (`listener.ts:1123-1130`).
- **No beacons in the ring.** Beacons loop at the station's cadence and each is a new identity, so at cue rates they
  would fill most of the ring. What they carry is live-only: presence comes from the host socket, and δ̂ travels in
  the envelope.

### 4.2 Persistence

- **The cursor and safety state.** These live in frond-ear's SQLite store, as one `runtime_state` value named
  `canticle.ring`. It holds the listener's `SafetyState`, the cursor `{pktid, pkttime, run, seq, digest}` of the
  last packet that authenticated, the run history (§4.3), and the counters.
- **The live frames.** These live in a table of their own: one row per live or hidden item, holding its identity,
  envelope, frame bytes, local expiry and a hidden flag. At most `MAX_LIVE` rows, about 5 MB.
- **Atomic.** Each packet's journaled guards (`appendRuntimeJournal`, `src/store.ts:1051-1056`) and its live-row
  insert or delete are written in one transaction (`store.atomically`, `src/store.ts:988`), before the packet's
  effects can be seen, as the embedded receptor does with its guards (`src/canticle/receptor.ts:335-376`). On each
  one-second tick when anything changed, `checkpointRuntimeState` replaces the snapshot and empties its journal in
  one transaction (`src/store.ts:1058-1065`).
- **Invariant: the checkpointed cursor never runs ahead of the state it implies.** After a crash the reader re-reads
  from that cursor. Packets whose guards are already in the journal are applied again harmlessly: guards only grow
  (epoch maxima, marks, plucks), live rows are keyed by identity, and pushed items deduplicate at delivery through
  identity tombstones (`docs/runbook.md:757-775`).
- **If the store fails,** the reader keeps reading so its connection holds, but surfaces nothing and moves no
  checkpoint until one lands. That is the receptor's `state_not_durable` rule (`src/canticle/receptor.ts:439-441`).
- **A corrupt saved state stops the reader.** It is refused, as the receptor refuses one
  (`src/canticle/receptor.ts:211-219`), rather than treated as a cold start.

### 4.3 Resume, and the client rules ringserver forces

1. **Send `ID` at once, and again every 60 s.** ringserver drops a client that has sent nothing within 10 s of
   connecting (`rs:src/clients.c:395-404`), and an idle one after `ClientTimeout`, 3 600 s by default
   (`rs:doc/ring.conf:154`). `ID` doesn't end streaming.
2. **Read `INFO STATUS`:** `EarliestPacketID` and `LatestPacketID`. No trust is needed.
3. **Validate the cursor with `READ <cursor.pktid>`.** Go on only if that packet authenticates and its run, seq and
   digest match the cursor's. Then send `STREAM`, which delivers from pktid + 1 (E1).
   - **Send `STREAM` only straight after a `READ` that succeeded on this connection.** A `READ` that misses leaves the
     reader where it was: `RingRead` returns before it updates the position (`rs:src/ring.c:969-971` against
     `:987-990`). A `STREAM` with no position starts at the next new packet, so the backlog is skipped and nothing says
     so (`rs:src/dlclient.c:173-177`; E2). A failed `POSITION SET` behaves the same way.
   - **Don't start from `POSITION SET EARLIEST` or `POSITION AFTER`.** Both skip their first packet (E1).
4. **If validation fails,** the cursor's packet has been evicted, rolled back or replaced. That alone hides nothing:
   an evicted cursor packet whose successors survive loses nothing.
   - Report `ring_overrun` if the cursor is below `EarliestPacketID`, and `ring_reset` if it is above
     `LatestPacketID` or another packet now holds it.
   - Then `READ <EarliestPacketID>` and process the packet it returns. If that `READ` misses (the earliest packet can
     be evicted in between), query `INFO STATUS` again and retry.
   - Then `STREAM`, and read everything the ring holds, skipping packets already processed by (run, seq). Loss is
     counted, and items hidden, only from the holes and run boundaries this re-read shows.
5. **Runs are ordered by their `run` value (W5).** Remember up to 16, each with its last seq and whether it ended with
   `bye`:
   - a known run with seq at or below its last seq has already been processed;
   - a known run that hasn't ended continues from its last seq, with the hole check;
   - a run lower than the newest one seen is counted as `stale_run` and skipped, if it is unknown or has ended. It is
     a rollback's leftovers, or a replay of genuine old packets;
   - two runs that haven't ended and interleave are counted as `two_writers`, a misconfiguration, and nothing from
     the ring is shown until an operator clears it;
   - a higher run is a writer restart. It must start at seq 1, its `hello`; first seen at seq k > 1, it is a `ring_gap`
     of k − 1 packets.
6. **Cold start.** This means no saved state at all: the first enable, or state an operator cleared.
   - The reader starts with `READ <EarliestPacketID>` and reads everything the ring holds.
   - The first run it meets is joined wherever it starts. No loss is reported before it: anything older was evicted
     along with it.
   - Because the ring is first-in, first-out, every PLUCK or superseder of a retained frame is retained too.
   - Run boundaries after the first follow rule 5.
7. **While streaming,** a packet whose writer signature fails is dropped and changes no state. A jump in packet ids
   is not loss on its own; only a hole in seq is. A lap therefore shows as a hole, with its exact size.

### 4.4 Gap detection and reporting: never silently skip

| Signal                                                  | Meaning                                                                                                            | Reported as                                                                    | Live items                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| seq jumps by more than one, within a run                | Packets lost: dropped at the writer (queue full, ring unreachable), a lapped reader (E2), or a crash rollback (E3) | `ring_gap` with the exact count; health `degraded` while anything stays hidden | Everything heard before the hole is hidden     |
| a higher run first seen past seq 1                      | Its first packets were lost                                                                                        | `ring_gap` of seq − 1                                                          | Everything heard before the hole is hidden     |
| a higher run from seq 1, after the previous run's `bye` | The writer restarted cleanly                                                                                       | `writer_restarted`                                                             | Kept                                           |
| a higher run, with no `bye` from the previous one       | The writer crashed, or the end of its run was lost; the count is unknown                                           | `writer_restarted_without_bye`                                                 | The previous run's items are hidden            |
| cursor validation fails                                 | Eviction, rollback or a reset (§4.3)                                                                               | `ring_overrun` or `ring_reset`                                                 | Only what the re-read's holes hide             |
| a lower, unknown or ended run; interleaved runs         | Rollback leftovers, a replay, or two writers                                                                       | `stale_run`, `two_writers`                                                     | Unchanged; with `two_writers` nothing is shown |
| a writer signature fails                                | Not from the writer                                                                                                | `unauthenticated` (a count)                                                    | Unchanged                                      |
| no `tick` for three intervals                           | The writer is silent, or the ring is unreachable                                                                   | `writer_silent`: blind, and saying so                                          | Kept; expiry carries on                        |

**Hidden until confirmed.**

- **Why hide.** A lost packet may have been a PLUCK. `records.ts` clears its live set on any gap (`:644-647`). The
  ring reader hides instead: hidden items are absent from `hear` and from delivery's view, but they keep their rows.
- **Confirmed by the host socket.** Within one run the daemon never appends an identity twice, so nothing in the
  ring can confirm a hidden item. Waiting for expiry could hide everything for up to 86 400 s, for `finding-ref`
  (RFC:383). The host socket is the witness instead. A hidden item is confirmed, and shown again, when either holds:
  - the socket's record v1 consumer holds the same `idem` with the same `frame.sha256` (RFC:2195) while its connection
    is healthy (no `records_lost`, not `joined_late`). The consumer must keep `frame.sha256` for this.
  - a complete join snapshot lists it (RFC:2282). When the consumer isn't healthy, `RingSource` reconnects the host
    socket to ask for one, at most once per gap.
- **Removed by a complete snapshot.** A hidden item absent from a complete snapshot is removed from the ring path's
  view. As RFC:2286 says, this is not a `retract` and settles no custody.
- **Also confirmed by a resurfaced re-append.** A `resurfaced` re-append of the same frame from a later run (flag
  bit 0) confirms it too.
- **Otherwise it leaves at its local expiry.**

**Hidden items and delivery.** Delivery already treats a record that leaves the view like one whose link is down: it
"waits for its return or its local expiry, and is never pushed from memory" (`src/canticle/delivery.ts:703-704`). So:

- a hidden item that expires while hidden counts as `off_air_unpushed`, and as `hidden_expired` in the ring's counters;
- a confirmed item returns to the view and is pushed under the usual rules, marked late if it is older than
  `maxAgeMs`;
- delivery's `seen` map is unaffected.

Every one of these signals is reported: in `ear_status` (`canticle.ring`), in a header line in `hear` (as
`joinedLate` does, `src/canticle/hear.ts:324-334`), in a footer line on the next report ("ring: N records lost since
the last report"), and in a log line carrying counts, never payload.

### 4.5 Duplicates and idempotence

- **The same (run, seq) twice** comes from a writer retry after a lost ack (W4), or from re-reading after a reset. It
  is skipped and counted as `ring_duplicate`. Bytes are compared only for the cursor's own packet, at validation.
- **The same frame identity in another packet** comes from a `resurfaced` re-append in a later run. Identical bytes
  are a harmless repeat (RFC:481); different bytes are an equivocation.
- **Across paths and restarts,** delivery's identity tombstones (`docs/runbook.md:757-775`) keep a record from being
  pushed twice, within §14.18.5's bound. A tombstone lasts until the record's local expiry plus 5 s, and is lengthened
  when the record is heard again with a later expiry (`delivery.ts:552-554`). Once it has lapsed, a record heard again
  can be pushed once more (`docs/runbook.md:769-771`).

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

| Where                 | Bound                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The connection        | One DataLink connection with TCP flow control. ringserver keeps no per-client queue; a send stalled for `NetIOTimeout` (10 s) disconnects (`rs:src/clients.c:823-899`). |
| The listener          | Per-key dedup and mark quotas (RFC:484-493)                                                                                                                             |
| Live and hidden items | `MAX_LIVE` 4 096 rows, as in `records.ts:46`; overflow is counted                                                                                                       |
| Run history           | 16 runs                                                                                                                                                                 |
| Delivery              | `MAX_WAITING` 4 096 (`src/canticle/delivery.ts:74`), and `bufferPerStream` up to 256 (`src/config.ts:464`)                                                              |

**Lag.** The reader reports `lag_packets` (`LatestPacketID` minus the cursor, from `INFO STATUS`, which ringserver
answers mid-stream) and `lag_ms` (now minus the last frame's `heard_at`). It warns `ring_lag_high` when the lag passes
half of the ring's span, estimated from the earliest and latest creation times.

### 4.7 Restart rebuild

On start, the reader loads the checkpoint, replays the journal, and reloads the live rows from the store. It checks
each row's writer and station signatures again; items that expired meanwhile are dropped and counted. Restored items
surface with `origin: "replay"`, and tombstones stop them being pushed again. Then the reader resumes from the cursor
(§4.3).

The rebuild reads nothing from the ring, so it survives a wrap, a ringserver crash or a reset. A list of packet ids to
re-read would not: a crash can roll the ring back by days (§7), and a single `finding-ref` item lives up to
86 400 s (RFC:383).

## 5. Expiry, landing and custody

### 5.1 Expiry at read time

```
expires_eff        = min(expires_at, issued_at + class max TTL)          (wire.ts:421-437, RFC:1780)
δ̂r                 = max(min(envelope offset_ms, 0), −60 000)            (never positive)
h                  = min(envelope heard_at, read time)
local_expiry_ring  = min(expires_eff + δ̂r, h + (expires_eff − issued_at))
```

- **The clock offset may only move expiry earlier.** RFC §14.6.3 lets δ̂ move expiry later, bounded only by first
  hearing plus TTL (RFC:1781-1784). On a ring, "first hearing" would be the read, so a writer, or simply a late read,
  could stretch a replayed item to a full TTL from now. The reader therefore uses only the non-positive part of the
  daemon's δ̂, which moves expiry earlier (`wire.ts:433-436`). With δ̂r ≤ 0, nothing on the ring path outlives the
  station's signed `expires_at` on the reader's clock.
- **Why carry δ̂ at all.** A station whose clock runs ahead (δ̂ < 0) would otherwise have every frame refused as
  `not-yet-valid` (`wire.ts:546-547`, which subtracts the offset). Carrying it keeps such a station heard.
- **Why the floor.** The −60 s floor stops a writer from opening the future window wide enough for a far-future
  frame to win supersession (RFC:580).
- **An expired packet still reaches the listener, and nowhere else.** A packet with `local_expiry_ring ≤ now` is fed
  to the listener, because its guards matter (§4.1). It never enters the live set, `hear` or a push. It is counted
  as `expired_on_read` for its station and stream.
- **Never pushed, not even as a late report.** At local expiry an item loses current-state authority in every
  surface (RFC:397). An expired frame is what a replay attack looks like (RFC:483). frond-ear already never pushes a
  record that goes off air first (`docs/runbook.md:779-780`). Reports count `expired_on_read` beside
  `off_air_unpushed`. The history of expired items is for dashboards (§18.8) and possibly a future pull tool, never
  for pushes (Q-G3).
- **Unexpired packets read late are marked late by age.** Catch-up reads carry no origin. `heardAt` is `h`, so
  delivery's existing rules decide: `immediate` pushes only within `maxAgeMs` of hearing (`delivery.ts:210-211`), and
  anything older goes into the next report with a `late:` line (`delivery.ts:219-242`).
- **Origins mark the rest.** A frame with flag bit 0 gets `origin: "resurfaced"` and is marked late as on the socket
  path (`docs/runbook.md:806`). Items restored from the store at restart get `origin: "replay"`, a new value for
  `LiveItem.origin` (`receptor.ts:101`). Any origin makes delivery mark a record late (`delivery.ts:231`).

### 5.2 Landing state gates the ring as it gates record v1

Ring items are shown in `hear` and pushed only when both of these hold:

- **The host socket's consumer is deliverable.** It is connected, its receive health is neither `failed` nor
  `stopped`, it has the run's `landing_state`, and `mute` is null (`src/canticle/records.ts:917-919`).
- **The writer's latest `hello` or `tick` names that same daemon run.** The daemon's landing state belongs to its run
  (RFC:2251, RFC:2303).

So a daemon MUTE empties `hear` of ring items too, as it does today. During a socket reconnect, which happens exactly
when the daemon couldn't deliver a `landing_state` (RFC:2163), nothing from the ring is pushed under a stale state.
While the reader is still catching up on an older run, nothing is shown until it reaches the current one.

### 5.3 Mute, digest, immediate, `wakeKeys` and custody

These are unchanged, and apply when the reader first takes a record in (`delivery.ts:510-650`):

- **The push filter.** `wakeKeys`, hop 0 and not wake-derived are checked by `#passOver` (`delivery.ts:652-664`).
  The ring path improves one thing: `wake_derived` comes from the signed flags, so it is never unknown. Record v1 may
  leave it out, and an unknown value counts as wake-derived (`receptor.ts:80-84`).
- **Mute at any scope wins.** A record first heard under a mute is never pushed (`docs/runbook.md:753-754`).
  Catch-up records are judged by the mute in force when the reader takes them in, as join-snapshot entries are today.
  Whether a mute in force at hearing time should bind instead is Q-G4.
- **Digest and immediate** work as above. `style: counts` suits sustained streams (§6).
- **Custody** keeps its mechanism (`docs/runbook.md:809-872`, `src/canticle/custody.ts`): one row per record per
  exposure. A push is first claimed: its batch, tombstones, delivery's cursor and rows are written in one
  transaction. It becomes offered when the shim says it handed the event over, and echoed when the session names the
  whole `batch_id`. Each step is stamped with the session's compaction boundary. The ring path adds:
  - **An origin and the ring position on each row.** The origin is absent, `snapshot`, `resurfaced` or `replay`, and
    for the ring the row also keeps `run:seq`, so an audit can tie a session's exposure to the exact ring packet
    (Q-G5).
  - **Nothing that depends on the path.** The identity and payload digest are the strings the socket path writes, so
    custody, `strict-fresh` and derived publication (`src/canticle/derived.ts`) don't care which path heard a record.
  - **No link between custody and the ring cursor.** Custody never moves it, and it never settles custody.

## 6. Volume model

**Supply is capped upstream by the carousel's budgets.** Each stream has `B_stream` 4 000 bit/s, each station
`B_station` 16 000 bit/s, and each item should get `k_avail` = 3 repeats in its life (RFC:505-509). The ring stores one
copy per frame, so it is written at the new-item rate, not the loop rate. Two rates matter:

- **The sustainable rate.** Every live item keeps its repeats:
  `fair_ms = 1000 · 8 · size · n / B_stream ≤ TTL / 3` (RFC:515-522). That allows `n` live items, arriving at most at
  `n / TTL` per second.
- **The first-copy ceiling.** Under pressure the attenuation ladder stops repeats of the lowest classes, but first
  copies still go (A3) until new low-class frames are refused (A4, RFC:1457-1458). First copies are never shed
  (RFC:1461). So new items arrive at up to `B / (8 · size)`. PLUCKs are packets too.

| Traffic                                | Sustainable, new items/s | First-copy ceiling, new items/s |
| -------------------------------------- | ------------------------ | ------------------------------- |
| One chatter stream, 600 B, TTL 60 s    | 0.27 (16 live)           | 0.83                            |
| One chatter stream, 200 B, TTL 60 s    | 0.83 (50 live)           | 2.5                             |
| One ambient stream, 900 B, TTL 300 s   | 0.18 (55 live)           | 0.56                            |
| One station at `B_station` (4 streams) | about 1 to 3             | about 3 to 10                   |
| Six stations at `B_station`            | about 6 to 20            | about 20 to 60                  |

**What that means for the ring.** At 1 400 B a slot, ringserver's default 1 GiB ring holds about 766 000 slots:

| Rate | Time the default ring holds | Written a day              |
| ---- | --------------------------- | -------------------------- |
| 6/s  | 1.5 days                    | 518 000 slots (726 MB)     |
| 20/s | about 10.6 hours            |                            |
| 60/s | about 3.5 hours             | 5.2 million slots (7.3 GB) |

Today's traffic is mostly cues, such as fleet scripts announcing a flush, deploy or restart on `ops.fleet`
(`docs/runbook.md:682-685`), far below these ceilings.

**Sizing rule.** The restart rebuild reads frond-ear's store, not the ring (§4.7), so retention only has to cover:

- the longest reader outage the ring should bridge without loss;
- whatever dashboards want.

A 1 GiB ring bridges more than 3 hours even at six stations' first-copy ceiling; about 8 GiB covers a day.

**Demand is capped by the session.**

- **The caps.** A push carries at most `maxItems` records (5 by default, up to 10) and `limits.maxNotificationChars`
  characters (6 000 by default; `docs/runbook.md:715`, `:742`). It happens at most `maxPushesPerHour` times an hour
  (60 by default, up to 360; `docs/runbook.md:717`).
- **What they allow.** About 300 records and 360 000 characters an hour by default, roughly 90 k tokens at four
  characters a token. At the outer limits, 3 600 records and 2.16 million characters an hour.
- **The consequence.** A session cannot take even one station at its carousel ceiling record by record. The ring
  sustains ingestion and replay at that ceiling with room to spare. Sessions get digests (`style: counts`) and pull
  detail with `hear`.

**Sustained streams, such as music or readings, go by reference.**

- **They don't fit the broadcast plane as inline items.** A reading at one 200-byte line a second is 1 600 bit/s,
  40 % of a stream's budget before its three repeats, and every line would be a separate record for the session.
- **The content becomes an object, and the frame a doorbell.** The producer stores each segment (an audio chunk, a
  chapter, a transcript slice) as an object in the frond's MinIO with its SHA-256. It then sings a `finding-ref`
  carrying `body_ref = [url, sha256, size]`, content type 8, and optionally a short summary body (RFC:820,
  RFC:924-927, decision D2). That is one doorbell per segment or minute, not per line or beat.
- **frond-ear never fetches it.** It shows `body_ref` and stops there (`src/canticle/hear.ts:176`; RFC:832). Fetching
  is a separate act by the session.
- **Inline or reference.**
  - **Inline** when the content fits one frame (a body of up to about 980 B with core keys, RFC:912) and loses its
    meaning when late: cues and live state.
  - **By reference** when it is bigger than one frame, arrives faster than one item per loop period on a stream, or
    must outlive the class's maximum TTL.
- **Never raise `MaxPacketSize` to carry blobs.** Frames are at most 1 100 B (RFC:750; `src/canticle/wire.ts:33`),
  and a 1 280-byte slot carries the envelope, frame and signature. Every slot costs `MaxPacketSize` plus 120 B
  whatever its payload, so big slots shrink retention for every cue.
- **High-rate signed streams that must stay inline** (beat events at 10/s, say) need a binding the RFC doesn't have
  (Q-B7).

## 7. Failure modes

| Failure                                        | Detected by                                                                                                                                                                                                                                                                                                          | Behaviour                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ringserver down or unreachable                 | A connect error, a send timeout, or no `tick` for three intervals                                                                                                                                                                                                                                                    | Back off as the receptor does (1 s·2ⁿ up to 30 s, plus jitter, `receptor.ts:309-318`). Health `degraded`, reason `ring_unavailable`. `hear` says content since T may be missing, and live items keep expiring. Resume from the cursor afterwards; holes from writer drops show as `ring_gap`. |
| Ring wrap (reader too slow, or down too long)  | Cursor validation (below `EarliestPacketID`), or a seq hole while streaming (a lap, E2)                                                                                                                                                                                                                              | `ring_overrun`. Holes are counted exactly within a run, and what was heard before them is hidden until confirmed.                                                                                                                                                                             |
| Clean ringserver restart, persistent ring      | `READ` at the cursor validates                                                                                                                                                                                                                                                                                       | Nothing to report.                                                                                                                                                                                                                                                                            |
| ringserver crash (`kill -9`, power loss)       | Validation fails: the packet id is above `LatestPacketID`, or another packet now holds it. ringserver writes its header only at clean shutdown (`rs:src/ring.c:595-606`), so a crash rolls the ring back to its last clean shutdown and loses everything written since its last clean start, which can be days (E3). | `ring_reset`. The re-read counts the holes. Only packets frond-ear hadn't read yet are lost to it; what it read is in its store.                                                                                                                                                              |
| Ring reset, volatile restart, or corrupt files | `LatestPacketID` below the cursor, or another packet at the cursor's id (ids start again at 1). Not `StartTime`, which changes on every restart.                                                                                                                                                                     | `ring_reset`, and the counts come from the holes. With `AutoRecovery 1` (the default) corrupt files are set aside and the ring starts empty.                                                                                                                                                  |
| Ring resized                                   | Packet ids are kept but their pkttimes are reset (E3)                                                                                                                                                                                                                                                                | Envelope validation passes. Never rely on pkttime alone.                                                                                                                                                                                                                                      |
| Writer (daemon) restart                        | A higher run                                                                                                                                                                                                                                                                                                         | After a `bye`, nothing is hidden. Without one, the previous run's items are hidden until confirmed. A run first seen past seq 1 is a `ring_gap`.                                                                                                                                              |
| Two writers on one ring                        | Interleaved runs                                                                                                                                                                                                                                                                                                     | `two_writers`. Nothing from the ring is shown.                                                                                                                                                                                                                                                |
| Station clock ahead                            | The daemon's negative δ̂ travels in `offset_ms`                                                                                                                                                                                                                                                                       | Heard as on the socket path, up to 60 s ahead. Beyond that, frames are refused as `not-yet-valid` on the ring path only, and the daemon's `health` reports `clock_skew` (RFC:2185).                                                                                                           |
| Station clock behind                           | `expired_on_read` for that key; `expiry_delta` in shadow mode                                                                                                                                                                                                                                                        | Items expire early by the skew, on the ring path only. Fail closed.                                                                                                                                                                                                                           |
| Unauthenticated packets                        | The writer signature                                                                                                                                                                                                                                                                                                 | Dropped and counted. They never move the seq accounting.                                                                                                                                                                                                                                      |
| Manifest change or mismatch                    | The manifest SHA-256 in `hello` and `tick`                                                                                                                                                                                                                                                                           | A mismatch is reported (`manifest_mismatch`), and `primary` shows nothing from the ring until the manifests match (§8). A restart rebuild drops items from revoked keys.                                                                                                                      |

**Why there is no automatic fallback to the socket for content.**

- **The two paths lose data differently.** Record v1 drops `frame` records and clears its live set on gaps; the ring
  keeps everything and reports holes. With both behind one view, "never silently skip" can't be stated for the moments
  of switching.
- **`primary` exists for exactly the case where the socket path does worse.** Falling back silently would bring that
  case back in the middle of a session.
- **The socket stays a witness, not a second content source.** It confirms hidden items (§4.4) and gates landing
  (§5.2). It never supplies content on the ring path.
- **An outage is visible, and its loss is bounded and counted.** A clean ringserver restart loses nothing. A crash
  loses only what frond-ear hadn't read yet, and the holes say how many.
- **Rollback stays an operator's act.** Setting `ring.mode: shadow` and restarting puts the socket path back in
  charge, with tombstones by identity (§4.5).

## 8. Migration

```json
"canticle": {
  "source": "host-daemon",
  "manifestPath": "/path/to/canticle-fleet.json",
  "ring": {
    "mode": "off",
    "address": "127.0.0.1:16000",
    "writerKey": "<the writer's Ed25519 public key, 64 hex digits>",
    "credentialFile": "/path/to/ring-reader.credential"
  }
}
```

- **`mode`** is `off` (the default), `shadow` or `primary`. Like `source` and `tune`, it is read only at start
  (`docs/runbook.md:642`).
- **Requirements.** Any other mode needs:
  - `source: host-daemon`;
  - `manifestPath`, which `host-daemon` mode doesn't otherwise need;
  - a loopback `address`.
- **The manifests must match.** The socket path takes station and stream names from the daemon's manifest
  (`src/canticle/records.ts:750-752`), and the ring path from frond-ear's. Different names would give different
  identities, breaking tombstones across the paths. A mismatch in the manifest SHA-256 (`hello`, `tick`) is reported
  as `manifest_mismatch`. `shadow` counts it, and `primary` shows nothing from the ring until the manifests match.
- **`credentialFile`.** This is optional: a 0600 file, for an `AuthCommand` that also gates reads.
- **The tick interval** comes from the writer's `hello` and `tick`, not from config.
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
- **`primary`.** The ring feeds `hear` and delivery. The socket still feeds `landing_state`, presence and health,
  confirms hidden items, and keeps the shadow counters with the roles reversed.
- **Rollback.** Set `mode` to `shadow` or `off` and restart. Tombstones and custody are kept by identity, so switching
  paths pushes nothing twice, within §4.5's bound.
- **Order (proposed).**
  1. The binary-canticle writer, behind its own flag (bc#130's bridge).
  2. frond-ear in `shadow` on one mixed host.
  3. `primary` on that host.
  4. The other hosts.

## 9. Test plan for the code

**Fakes,** alongside the existing `FakeClock`, `FakeTimers`, fake shim over a real socket, and
`test/canticle-host.ts` (the record v1 side):

- **`FakeRingserver`.** A DataLink server over a real loopback socket (`node:net`) that answers `ID`, `INFO STATUS`,
  `WRITE` (with flags `A`, `N` and `I`), `READ`, `POSITION SET` (an id, an id with a pkttime, `EARLIEST` and
  `LATEST`), `STREAM` and `ENDSTREAM`, using fixed slots. It reproduces the real server's quirks from Appendix A:
  - `POSITION SET N` or a good `READ N`, then `STREAM`, delivers from N + 1;
  - after a missed `READ` or a failed `POSITION SET`, `STREAM` starts at the next new packet;
  - `EARLIEST` and `AFTER` skip their first match;
  - a lapped reader is skipped forward without notice;
  - a crash rolls back to the last clean shutdown and hands ids out again;
  - a reset starts ids at 1, and a resize resets pkttimes;
  - a caught-up reader waits up to 1 s, and a client silent for its first 10 s is dropped.

  It can also inject faults: a drop in mid-packet, a stall, a refused connection.

- **`FakeWriter`.** Builds signed envelopes with a test writer key around frames signed with the station fixture keys
  (`test/fixtures/canticle/frame-v2-candidates.json`, as `test/canticle-listener.test.ts` does). It has switches for
  holes, retries, bad signatures, run numbers, the `resurfaced` flag, `offset_ms`, and runs with or without `bye`.
- **A conformance script,** outside `pnpm check` like `tools/chaos`, that runs the same scenarios against a real
  ringserver 4.5.4 built in a temp dir. It keeps the fake's quirks true to the server; Appendix A is its first run.

Each case asserts the counters, what `hear` shows and what is pushed:

1. **Cursor.** Process N packets, checkpoint, restart: the reader resumes at N + 1, nothing is pushed twice, and no
   gap is reported.
2. **Crash between the journal and the checkpoint.** Replay changes nothing: a PLUCK stays sticky, live rows are not
   duplicated, and a predecessor stays superseded even when its supersessor has expired by the time of the replay
   (TTLs that differ). Purges still hold although `hear(…, h)` runs behind `tick(now)`.
3. **Rebuild from the store.** With the ring wiped, items come back from the live rows. Items that expired meanwhile
   are dropped and counted, and the others show `late: … (replay)`.
4. **A gap within a run.**
   - One `ring_gap` with the exact count, and everything heard before it is hidden.
   - The socket consumer's healthy live set confirms an item (same `idem` and `frame.sha256`); an unhealthy consumer
     triggers one reconnect for a join snapshot.
   - Absence from a complete snapshot removes an item.
   - An unconfirmed item leaves at expiry, counted as `off_air_unpushed` and `hidden_expired`; a confirmed one is
     pushed late.
5. **Writer restarts.** After `bye`, nothing is hidden. Without it, the previous run is hidden and
   `writer_restarted_without_bye` is reported. A higher run first seen at seq 5 is a `ring_gap` of 4.
6. **Runs.** A replayed lower run is `stale_run` and changes nothing. Two interleaved runs that haven't ended are
   `two_writers`, and nothing is shown. A cold start joins the first run anywhere without reporting loss.
7. **A wrap while the reader is stopped.** `ring_overrun`, a hole counted from the re-read, then
   `READ EarliestPacketID` and `STREAM`. A `READ` that misses is retried after `INFO STATUS`, never followed by
   `STREAM`. An evicted cursor whose successors survive reports no loss.
8. **A lap while streaming** (the fake skips forward). It shows as a seq hole, reported as `ring_gap`.
9. **Ids handed out again after a crash, and resets** (the fake rolls back). `ring_reset`; known (run, seq) pairs are
   skipped and holes are counted; ids planted with flag `I` cause no hiding on their own.
10. **Duplicates.** The same (run, seq) twice (a writer retry) is admitted once and counted as `ring_duplicate`. The
    same identity in two runs is pushed once.
11. **Expiry.**
    - A packet expired on read never reaches the live set, `hear` or a push, and counts as `expired_on_read`.
    - One with 2 s left is gone after 2 s (test EM-01, RFC:1788).
    - A `heard_at` in the future is clamped to now. A positive `offset_ms` is used as 0, and one below −60 s as −60 s.
    - An old frame replayed with `heard_at` set to now can't outlive its `expires_at`.
    - A station 30 s ahead is heard; one 90 s ahead is refused and counted.
12. **Trust.**
    - A bad writer signature is dropped and moves no seq.
    - A stream label that doesn't match its frame is dropped.
    - A bad station signature or unknown key is refused.
    - After a key is removed from the manifest and frond-ear restarts, that key's retained packets and live rows are
      refused.
13. **Warm-up.** The fake writer appends a held live-state item only on release. A held item retracted before release
    never appears.
14. **Landing state.**
    - A daemon MUTE empties `hear` of ring items and holds pushes.
    - During a host socket reconnect nothing is pushed.
    - A writer `tick` naming another daemon run holds everything.
    - An open breaker holds pushes.
15. **Backpressure.**
    - With no session attached, delivery holds; the reader keeps reading, its cursor advances, and memory stays
      bounded.
    - Drops from `bufferPerStream` are counted.
    - 100 000 packets from one key over quota are refused as `over-quota`, and memory stays bounded.
    - A failing store keeps the connection open, surfaces nothing and moves no checkpoint.
16. **Ring unavailable.** `ring_unavailable`, backoff, and a line in `hear`. Recovery from the cursor; holes from
    writer drops show as `ring_gap`.
17. **Custody.** A push from the ring writes claimed, offered and echoed rows with the same identity and digest as the
    socket path, plus the origin and `run:seq`. A `hear` exposure does the same.
18. **Shadow.**
    - The same frames through `canticle-host.ts` and the fake ring count as `both`.
    - An injected socket drop gives `ring_only`, and an injected writer skip gives `socket_only`.
    - A station with a positive δ̂ gives `expiry_delta`.
    - Different manifests give `manifest_mismatch`.
19. **Keepalive.** The first command goes out within 10 s, and an idle reader sends `ID` within `ClientTimeout`.

## 10. Open questions

**For the binary-canticle owners:**

- **Q-B1.** bc#130 leaves lane (c), raw frames, out of scope. frond-ear's reader needs it, to verify again at read
  time. Can lane (c) become the machine lane frond-ear reads, with §3.2's envelope? Lane (b) carries the bridge's
  JSON projection of an item, which is never signed (RFC:902), and lane (e) carries markers (RFC:2746). A reader can
  verify neither.
- **Q-B2.** Can the stream id be hex, `BC_<key>_<stream>/CANTICLE`, rather than `<NET>_<STA>_<stream>/CANTICLE`? That
  avoids ringserver's 63-byte limit and the naming table.
- **Q-B3.** Should the writer live inside the daemon, after its write-ahead save (W2, preferred), or in a sidecar that
  reads record v1? A sidecar can't produce lane (c): record v1 carries only the frame's digest and size, not its bytes
  (RFC:2195).
- **Q-B4.** Is W1 workable: append on surfacing, held items only on release, `resurfaced` re-hearings flagged,
  control-class items never?
- **Q-B5.** The writer key would be a dedicated Ed25519 key in the daemon's state directory. How do readers learn its
  public key, and how is it rotated?
- **Q-B6.** Version 1 writes no beacons. Should a later version write occasional beacons, so ring readers get
  `head_seq` and `trail_seq` to check for censorship (RFC:598)?
- **Q-B7.** Should there be a reliable binding (station to ring, or relay to ring) for high-rate signed streams that
  can't go by reference? It would need an RFC amendment alongside §11.
- **Q-B8.** Should control frames (MUTE, §10.6) go in the ring, so readers on other hosts can honour them?

**For 🍃 frond-gloss:**

- **Q-G1.** Do you agree there should be no automatic content fallback when the ring is down (§7)?
- **Q-G2.** On a gap, should the reader hide and confirm against the host socket's live set or a join snapshot (this
  note), or clear its live set as `records.ts` does? Confirming needs the socket consumer to keep `frame.sha256`, and
  to be able to reconnect on demand.
- **Q-G3.** Expired retained packets never reach a session. Or should there be a pull tool (a `canticle_replay`, with
  custody path `replay` and each item labelled expired)?
- **Q-G4.** Should the mute for catch-up records apply at take-in, as for join snapshots today, or at hearing time?
- **Q-G5.** Are custody's origin and `run:seq` fields worth the schema change?

**For 🌫 silas:**

- **Q-S1.** ringserver always listens on every address (`rs:src/config.c:2675-2677`). Are `AcceptIP 127.0.0.1/32` and
  a host firewall enough for the canticle instance?
- **Q-S2.** Is gating writes through `AuthCommand` workable: `WriteIP` set to an address nothing connects from, and
  write granted to the daemon's credential alone? A failed `AUTH` doesn't disconnect, and a successful one replaces
  the permissions granted by IP (`rs:src/auth.c:222`).
- **Q-S3.** A crash rolls the ring back to its last clean shutdown, losing everything since (E3;
  `rs:src/ring.c:595-606`). Should the fork write its header periodically? Which should silas and ronan run: a
  memory-mapped ring, `MemoryMapRing 0`, or a volatile one? Who owns the systemd unit, and what ring size (§6)?
- **Q-S4.** Lanes (b) and (e) stay as RFC §18.3 has them, for dashboards, on their own instance. Does anything here
  conflict with `bc:spike/silas-seedlink-mapping.md`?

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
| E1  | Latency to a caught-up reader                                              | 500 to 501 ms, six times, at one write per 1.5 s. When it has nothing to send, the server waits for up to 1 s (`rs:src/clients.c:382-385`).                                                                                                                     |
| E1  | A 1 281-byte payload on a 1 280 ring                                       | `ERROR 0 … Error adding packet to ring`, then disconnected                                                                                                                                                                                                      |
| E2  | 811 packets into 746 slots                                                 | `EarliestPacketID` 66                                                                                                                                                                                                                                           |
| E2  | `POSITION SET 3 <pkttime>` after the wrap                                  | `ERROR … Packet not found`                                                                                                                                                                                                                                      |
| E2  | `STREAM` sent anyway, then one new write                                   | The first packet is 812, the new one: the 746 packets still held (66 to 811) were skipped silently                                                                                                                                                              |
| E2  | A streaming reader paused about 4 s while 20 000 packets were written      | 1 272 packets (69 to 1340) arrived, then the ids jumped to 20737 with no message, then 77 more (to 20813). Packets 20068 to 20736 were still in the ring and were skipped too.                                                                                  |
| E3  | Clean restart of a memory-mapped ring                                      | Ids carry on (latest 5, next 6), and `POSITION SET 5 <pkttime>` still succeeds                                                                                                                                                                                  |
| E3  | `kill -9` after a clean restart and 3 more writes (B-1 to B-3, ids 6 to 8) | Restarted with latest 5. `READ 6` and `READ 8` were not found. The next writes C-1 to C-3 **got ids 6 to 8 again**.                                                                                                                                             |
| E3  | `kill -9` of a ring never shut down cleanly                                | `Packet buffer signature mismatch` and `Resetting ring packet buffer, contents are discarded`; ids start at 1                                                                                                                                                   |
| E3  | Volatile ring restart                                                      | Empty; ids start at 1                                                                                                                                                                                                                                           |
| E3  | `MemoryMapRing 0`, then a clean cycle, 3 writes and `kill -9`              | Rolled back to latest 3. The next write got id 4 again, with a different payload.                                                                                                                                                                               |
| E3  | `RingSize` changed from 1M to 2M across a restart                          | The packets were loaded from `.version3` with their ids kept. The pkttime changed (`…311328259` to `…311850677` µs). `POSITION SET 3 <old pkttime>` passed only because both fell in the same second (the check is to the second, `rs:src/dlclient.c:509-527`). |

What the experiment settles for the design: a packet id can't serve as a cursor on its own (E3). pkttime is checked
only to the second (`rs:src/dlclient.c:509-527`), so it can't tell a reused id from the original when both fall in
the same second. And a careless resume or a slow reader loses data with no message (E2). Hence the signed (run, seq)
envelope, validating the cursor by `READ`, treating a seq hole as the only loss signal, and keeping what was read in
frond-ear's own store.
