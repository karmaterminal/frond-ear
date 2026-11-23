# Design: a ringserver-backed canticle reader for frond-ear

**Status:** design note, no code (2026-11-22). Revised the same day after 🍃 frond-gloss's review and 🌫 silas's
cuts on #118. Reviewers: 🍃 frond-gloss (co-owner), 🌫 silas.

On 2026-11-22 figs asked how frond-ear can sustain a high degree of content IO without the ringserver, and why
using it was put off. 🌿 answered that it was deferred, not a wrong fit. Today, short-lived signed UDP cues are
verified by binary-canticle's host daemon and pushed by frond-ear with custody. Durable replay and volume belong to
RFC-0001's ringserver tier (§18), which nobody has built. The proposed shape: **the daemon verifies, then appends
verified records to a ring; ears read the ring by cursor, check expiry at read time, and keep custody in
frond-ear.** This note designs frond-ear's half of that before any code.

Citations are `path:line` at these refs. A path starting `bc:` is in binary-canticle, `rs:` is in ringserver, and
anything else is in frond-ear. `RFC` means `bc:rfc/0001-binary-canticle.md`. `#116` is frond-ear#116 and its
amendments, which bind this design as acceptance criteria.

| Source                                          | Ref                                     |
| ----------------------------------------------- | --------------------------------------- |
| frond-ear                                       | `43dab0e` (main)                        |
| binary-canticle                                 | `08c1112` (main)                        |
| ringserver (karmaterminal fork of EarthScope's) | `2df558c` (v4.5.4, the RFC's proof SHA) |

## Decisions at a glance

| #     | Question                    | Decision                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Who writes                  | The host daemon, after it has verified a frame and saved the state that frame implies. It appends each frame its receptor surfaces, and mirrors each retraction. Stations never write the canticle lane.                                                                                                                                                                                         |
| 1     | What a reader may assume    | Only that something with write access appended these bytes. The reader re-verifies each station signature against its own manifest and checks expiry on its own clock. It trusts order, completeness and retractions only when the writer's signature on the envelope verifies, under a writer key the owner-signed manifest names.                                                              |
| 1     | Which ring                  | A ringserver instance of the canticle lane's own, one per retention class. It listens on IPv4, accepts only loopback peers, and grants no address write or trusted access. Write is granted by `AUTH` to the daemon alone and revoked only by disconnecting. No host firewall.                                                                                                                   |
| 1     | Stream axes                 | Every lane declares #116's three axes. The canticle lane is shape per stream, time `replay`, loss `tolerated`: the station → daemon hop is lossy, and the ring detects loss only from the writer on. Recovered streams need a spool binding, not this lane.                                                                                                                                      |
| 2     | Packet                      | One ring packet per surfaced frame per writer run, plus one per retraction and a few control packets. Each packet is a 48-byte envelope, a body (for a frame, the station's canonical frame byte for byte) and a 64-byte Ed25519 writer signature, under `BC_<key_id>_<stream_id>/CANTICLE`.                                                                                                     |
| 2     | Identity                    | A record is identified by its frame tuple, as today. A position in the ring is identified by the signed pair (writer run, writer seq). Completeness is judged per station key, by a signed per-key subsequence. ringserver's packet id only locates a packet; the same id can later name a different packet.                                                                                     |
| 3     | Cursor                      | Kept in frond-ear's SQLite store, in the same transaction as the listener's safety state. The live frames and the hidden items' watermarks are kept there too, so a restart needs nothing from the ring. On resume the reader reads the cursor's packet back and checks that it is the one recorded.                                                                                             |
| 3     | Gaps                        | A hole in one key's subsequence is loss for that key alone, and it is reported. The reader first re-reads what the ring still holds to fill it. Whatever stays missing hides that key's items heard before it, until a sound witness confirms each or it expires. Other keys keep flowing.                                                                                                       |
| 3     | Loss counts                 | Graded: exact, at least, at most, or unknown. A run whose tail went missing with no `bye` read (a ringserver crash and a writer restart, say) is reported as an unknown tail, bounded where a witness allows, never as an exact count.                                                                                                                                                           |
| 3     | Runs                        | Monotonic: a lower run is refused, unless its `hello` or a `tick` names the daemon run that the live host socket reports, which binds it to the current daemon incarnation. A ring that can deliver nothing new, for want of a bound run or with two writers bound, is health `degraded` (`ring_blind`) with an exit path.                                                                       |
| 3     | Receiver caps               | `tune` maps to DataLink `MATCH`, so untuned packets never reach the reader. Per-key queue and byte caps and a fair verification budget bound the reader's memory and work before anything reaches admission, long before delivery's token budget. A key over its caps has packets skipped, counted and refilled later from the ring, which affects that key alone. The flood test is acceptance. |
| 3     | Backpressure                | The reader never waits for the session. The cursor advances as packets are processed. Keeping pace with the session stays delivery's job: digests, and drops that are counted.                                                                                                                                                                                                                   |
| 4     | Expiry                      | Checked at read time on the reader's clock. The clock offset may only move expiry earlier. A retained packet that has expired is never pushed, live or late; it is counted.                                                                                                                                                                                                                      |
| 4     | Landing                     | Ring items are shown and pushed only while the host socket's state is deliverable (connected, holding the writer's daemon run's `landing_state`, no MUTE), and only once the socket has caught up to the record each ring packet mirrors. The ring never runs ahead of the socket.                                                                                                               |
| 4     | Custody                     | Unchanged: the same identities, tombstones, offered and echoed rows, and compaction-boundary stamps. Rows gain an origin and a ring position.                                                                                                                                                                                                                                                    |
| 5     | Volume                      | The ring buys reliability and replay, not throughput. The carousel's budgets cap what comes in and the session caps what goes out. Anything bigger than one frame, or continuous, goes by reference. Ring sizes here are experiment candidates, not an install decision.                                                                                                                         |
| 6     | ringserver down             | Report it. Never fall back to the socket for content automatically.                                                                                                                                                                                                                                                                                                                              |
| 6     | Wrap, reset, crash          | Ring acceptance isn't durable: ringserver saves its header and stream index only at clean shutdown. Version 1 runs `MemoryMapRing 0`, which comes back as the last clean shutdown left it; a memory-mapped ring comes back with packet ids out of order. The reader validates the envelope at the cursor and assumes no id order.                                                                |
| 6     | Station with a skewed clock | Fail closed: items may expire early, never late.                                                                                                                                                                                                                                                                                                                                                 |
| 7     | Migration                   | `canticle.ring.mode`: `off` (the default), then `shadow` (compare only, in a bounded time window), then `primary` (content comes from the ring; control still comes from the host socket). It needs the daemon's manifest, which also names the writer key.                                                                                                                                      |
| Scope | Where it runs               | Version 1 is same-host: the ringserver runs on the daemon's host, and the reader runs beside the record v1 socket. Readers on other hosts are an open question.                                                                                                                                                                                                                                  |

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
- **Resume by cursor** across a restart of either side. Loss after the daemon's writer is detected and reported:
  exactly within a run, and as a bound or an explicit unknown across crashes (§4.4). Loss before the writer, on the
  station's UDP hop, stays invisible to the ring (§1.1).
- **Many readers on one append.** frond-ear, an OpenClaw binding, bc#130's tool and dashboards each keep their own
  cursor, with no per-peer queue in the daemon.
- **It is the RFC's chosen tier.** Binding (d) (RFC:1178), decision D10 ("Clean-path snapshots, replay, dashboards"
  over TCP, RFC:1193), and §18.

It does not add throughput (§6).

**Why version 1 is same-host.** The ring is a content bus, not a control plane. The receptor's landing state (MUTE,
breaker, modulation), presence and health invert when they arrive late, and the staleness rule puts such signals on
the no-replay plane (RFC:368). So they stay on the live host socket, and the ring is ordered against it by record v1's
`rec_seq` (§5.2). A reader on another host would need MUTE and the other control frames in the ring (§10.6), and
frond-ear implements neither (Q-B8).

### 1.1 What the lane declares: the three axes

#116 has every stream declare three independent axes, and the carriage follows from them, not from what the content
is. The canticle lane declares:

| Axis  | Values                       | The canticle lane                                                                                                                                                                                                                                                                               |
| ----- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shape | latest-state, ordered events | Per stream and class. Live-state items supersede by key (RFC §6.1), so a stream of them is latest-state; other items are events, each heard in order. The lane stores every surfaced frame in the daemon's order, so both shapes read correctly from it. Declaring the axes per stream is Q-B9. |
| time  | live, replay                 | Replay: retained, and read by cursor. The live, no-replay plane stays on the host socket: landing state, presence and health (RFC:368).                                                                                                                                                         |
| loss  | tolerated, recovered         | Tolerated (below).                                                                                                                                                                                                                                                                              |

**The first hop is declared lossy** (#116 amendment 1 §2).

- Frames reach the daemon over UDP, which loses them by design: Canticle is a lossy broadcast, and repetition heals
  loss within an item's TTL (RFC:16). A ring downstream can't recover a frame the daemon never heard.
- So the lane promises less than end-to-end delivery. Every packet the writer numbers is either read or reported
  missing (§4.4). Nothing is promised about frames lost before the daemon, and `ear_status` labels the lane
  `loss: tolerated`.
- A **recovered** stream needs a publisher that keeps each item until a named acknowledgement, retries, and is
  deduplicated on ingest by signed item id. Its spool needs a byte cap and a time cap, and overflow or expiry is
  reported as such, never as delivered (#116 amendments 1 §2 and 4 §1). That is a different binding: a station or
  relay writing to a ring of its own (Q-B7), not this lane.

**Four events, never conflated** (#116 amendment 4 §1). Each is reported on its own, and none implies the next.

| Event               | What proves it                            | In this design                                                                                       |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Ring acceptance     | ringserver's `OK` to the writer's `WRITE` | W4. `tick` counts it as `accepted`. A ringserver crash can take it back (§7; Appendix A, E3 and E4). |
| Durable retention   | Nothing ringserver provides               | ringserver saves its state only at clean shutdown (§7). Not claimed.                                 |
| Ear receipt         | frond-ear's checkpoint                    | §4.2                                                                                                 |
| Model-input custody | The session's echo (#112)                 | §5.3                                                                                                 |

**One ring per retention class.** #116 asks for isolated retention per service class, never one ring for the fleet.
The canticle lane is one class, sized to bridge the longest reader outage it should cover (§6); retention under the
longest class TTL matters only at a cold start. A later lane (content with hours of retention, say) gets its own
ringserver instance, writer and reader state (`canticle.ring.<lane>`), for the reasons §2 gives against a shared
ring. The reader's config takes one lane in version 1 and a list later. Which lane carries a stream would come from
axes the manifest declares for it (Q-B9).

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
- **Loops must already be deduplicated.** RFC:2738 asks the bridge for one ring packet per identity tuple, which only
  a receptor can do. This design keeps one per surfaced frame per writer run (W1).

**What the writer does.** These requirements are for the binary-canticle owners:

| #   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W1  | **What to append.** Append an ITEM when the receptor first emits a deliverable `frame` record for it (`verified` and `surface`, RFC:2213); for an item held in warm-up, that is its release (RFC:2215). Also append a `resurfaced` re-hearing after a daemon restart (flag bit 0), each PLUCK the receptor admits, the second byte string of an equivocation once, and **a `retract` packet for every record v1 `retract`** except reason `expired` (RFC:2182). Retractions cover what never surfaces but still changes state: a plucked item that moves a supersession mark (RFC:579), a held item retracted before release (RFC:2216), a quarantine (RFC:2232). Append nothing else: no control-class items (class 8), no refusals, no benign repeats, nothing `ringbuffer_only`, no BEACONs (§4.1). |
| W2  | **After the save.** Append only after the daemon's write-ahead save for that datagram (`bc:prototype/canticle-station/canticle/daemon.py:32-33`), and after the record v1 record the packet mirrors has been emitted, so no ring packet ever precedes the guard or the record it implies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| W3  | **Never block, and bound the queue.** Keep a first-in, first-out writer queue capped by count, bytes and age: 4 096 packets, 4 MiB and 5 s [PROPOSED]. Assign `seq` and `key_seq` when a packet is queued, and never reuse them. A packet dropped at the writer, because the queue is full or because it waited too long, leaves a hole, as record v1's `rec_seq` does (RFC:2161), and `tick` counts it by reason. A dropped packet is never counted as accepted.                                                                                                                                                                                                                                                                                                                                      |
| W4  | **Retry in order, with the same bytes.** Every `WRITE` error disconnects (`rs:src/dlclient.c:120-124`). After a disconnect, resend in order from the first unacked packet, with the same run, seq, `key_seq` and bytes, so the reader can recognise the retries as duplicates (ringserver doesn't deduplicate). A deterministic error, such as an oversize write (E1), is a dropped packet; don't retry it. An `OK` proves ring acceptance only: a ringserver crash can take back packets it acknowledged (E3, E4).                                                                                                                                                                                                                                                                                    |
| W5  | **Runs only grow, and leave a bound.** `run` is persisted and strictly increasing: `max(previous + 1, unix ms at start)`, written durably before the first packet. This is RFC §5.2's epoch rule (RFC:312). The writer also persists a sequence reservation: before it assigns a `seq` past the reserved bound, it durably raises the bound by a block of 4 096 [PROPOSED], one `fsync` per block. `hello` names the previous run and that run's last reserved bound (`prev_run`, `prev_reserved_through`), an upper bound on how many packets the previous run wrote.                                                                                                                                                                                                                                 |
| W6  | **Control packets.** Write `hello` at run start (seq 1), `bye` on clean stop (its seq is the run's last), and `tick` every 10 s. `hello` and every `tick` carry the daemon's record v1 `run` (random hex per daemon start, RFC:2176), the manifest SHA-256 its own `hello` reports (RFC:2180) and the tick interval. `tick` also carries the counts accepted and dropped (by reason), the queue depth, and **per-key heads**: the latest `key_seq` of up to 48 keys, in rotation, so that every key active in the run comes round.                                                                                                                                                                                                                                                                     |
| W7  | **Sign.** Sign each packet with a dedicated Ed25519 writer key. Never use a station key: a canticle key "MUST NOT be used to sign anything outside this protocol" (RFC:784). The owner-signed manifest names the writer's public keys by epoch, and envelope byte 7 says which one signed the packet (Q-B5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| W8  | **Header times.** Set the DataLink header's datastart to `issued_at` and dataend to the effective expiry, in µs. This serves dashboards and `POSITION AFTER`. Readers never trust these times.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| W9  | **Per-key subsequence.** Number each packet a second time, per station key within the run: `key_seq`, from 1. A packet's key is the key whose items it can change: a frame's own key, a retract's target key. Control packets have a sequence of their own, under key zero. A reader that takes some keys only (§4.6) can then judge each key's completeness on its own.                                                                                                                                                                                                                                                                                                                                                                                                                               |

**What a reader may assume about a ring packet.** Only what it checks itself:

| Property                                        | What the reader trusts on the ring path                                                              | Why it is checked again                                                                                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content and author                              | The station's signature, resolved through the reader's own manifest (`src/canticle/wire.ts:445-560`) | ringserver accepts any bytes from any client allowed to write. A revocation applies to retained packets once frond-ear has loaded the manifest that makes it (§7).                                       |
| Freshness                                       | The signed `expires_at`, read on the reader's clock (§5.1)                                           | The ring evicts by size, not by TTL (RFC:2752), so retained packets outlive their items.                                                                                                                 |
| Identity                                        | The frame's own tuple, never the ring stream id or the packet id                                     | Stream ids are text the writer chooses. Packet ids are handed out again after a crash (Appendix A, E3 and E4).                                                                                           |
| Order and completeness                          | The (run, seq) and `key_seq` under the writer's signature                                            | A lapped reader is skipped forward without notice (E2), crash recovery reuses ids and can serve them out of order (E3, E4), and any client allowed to write can plant ids (`rs:src/dlclient.c:916-933`). |
| Admission (dedup, plucks, supersession, quotas) | The reader's own listener, plus the writer's signed retractions                                      | The daemon's decisions are not carried in the ring; only its frames and its retractions are.                                                                                                             |

**Why verify again when the writer already did.** It costs one Ed25519 verification per new frame, not per loop
copy, at a few frames a second at most (§6). In return, the ringserver process, its ACLs, its other writers and the
ring file all drop out of what must be trusted for content.

**What the writer is trusted for:**

- **Availability and completeness.** The writer controls what reaches the ring and in what order.
- **Retractions.** These only ever remove items, so a lying writer can hide content but never show it.
- **Hearing time and clock offset, within bounds.** Admission uses both: `heard_at` is clamped to no later than now,
  and `offset_ms` to between −60 s and 0 (§5.1).

**Why the envelope is signed, not tagged with a shared key.**

- **Anything that can write could otherwise fake completeness.** ringserver cannot bind loopback only: it listens on
  every address (`getaddrinfo(NULL, …, AI_PASSIVE)`, `rs:src/config.c:2674-2677`). Without the signature, anything
  that can write could forge control or retract packets, or fabricate a clean-looking sequence. It could never forge
  a station's content (station signatures stop that), but it could fake completeness.
- **A shared key would let readers forge for one another.** Several readers would hold an HMAC key (frond-ear, an
  OpenClaw binding, bc#130's tool), and each could forge for the others. A verify-only public key lets none of them
  forge.
- **It works from any host,** so readers on other hosts stay possible later.
- **The key comes from the owner-signed manifest,** by epoch, with an overlap when it rotates (🍃's pick on Q-B5).
  frond-ear's config never carries one.

**Decision: the canticle lane gets a ringserver instance of its own, with writes gated to the daemon.**

- **One ring can't hold bc#130's line between human and machine lanes.** `READ <pktid>` bypasses `AllowedStreamsIP`
  and `ForbiddenStreamsIP` (`RingRead` checks neither, `rs:src/ring.c:952-992`), and `AuthRequiredForStreams` gates
  only `STREAM` (`rs:src/dlclient.c:164-171`).
- **A shared ring invites interference.** Any writer to it could evict canticle packets, or plant packet ids with
  `WRITE` flag `I` (`rs:src/dlclient.c:916-933`).
- **Retention is sized for one lane** (§1.1).
- **How access is set.** These are 🍃's and 🌫's picks on Q-S1 and Q-S2, checked in Appendix A (E5, E6).
  - **Listener.** `ListenPort <port> DataLink IPv4` and `AcceptIP 127.0.0.1/32`. ringserver still binds every IPv4
    address (`rs:src/config.c:2641-2677`), so a nonlocal peer completes a TCP handshake and is then closed, before
    any DataLink exchange (`rs:src/ringserver.c:1145-1153`; E6). No host firewall: figs ruled out LAN firewalls on
    2026-11-15.
  - **No access by address.** `WriteIP` and `TrustedIP` are set to an address nothing connects from
    (`192.0.2.1/32`). Left empty, each defaults to localhost (`rs:src/config.c:810-828`), which is every local
    process. Every connection then starts with connect permission only (`rs:src/ringserver.c:1241-1266`): `ID`
    shows no `WRITE`, and a `WRITE` is refused and the client disconnected (`rs:src/dlclient.c:113-118`, `342-347`;
    E5).
  - **Write by `AUTH`.** `AuthCommand` grants write to the daemon's credential alone. Its helper returns no stream
    patterns, and it is configured with at least one argument: at the pinned ref, an `AuthCommand` with none crashes
    the server on the first `AUTH` (E5; Q-S2).
  - **A failed `AUTH` is not revocation.** A helper that times out, exits non-zero or prints malformed JSON fails
    before the permissions are reset (`rs:src/auth.c:122-129` and `215-219`, against `222`), and the error reply
    leaves them as they were (`rs:src/dlclient.c:430-438`). So a fresh connection still has none, but an authorized
    one keeps write (E5). A stream pattern that fails to compile errors after write has been set
    (`rs:src/auth.c:240-243`, against `250-321`), so the client gets `ERROR` and write. Revocation is disconnecting
    the session, or restarting the server; never a failed `AUTH`. The daemon never re-authenticates a live
    connection: a new credential means a new connection.
  - **Readers stay anonymous.** With `TrustedIP` unused, `INFO CONNECTIONS`, which lists each client's id string and
    position, is refused (`rs:src/dlclient.c:1261-1272`), while `INFO STATUS` still gives the packet id range
    (`rs:src/infoxml.c:579-594`). The reader identifies as `ID frond-ear`, naming no seat or session.
- **The two controls do different jobs.** The signature decides what a reader accepts; the write gate protects
  availability. Any local process can still read every packet, and can hold connections against `MaxClients` (§7).

## 3. Packet identity and mapping

### 3.1 Ring stream id

The stream id is `BC_<key_id, 16 hex>_<stream_id, 8 hex>/CANTICLE`: 37 bytes, under ringserver's limit of 63
(`rs:src/ring.h:58`; a longer id gets `ERROR` and a disconnect, `rs:src/dlclient.c:876-884`). A retract packet goes
under its target item's stream id, so `MATCH` selects it with its item (§4.6). Writer control packets use the
all-zero id `BC_0000000000000000_00000000/CANTICLE`.

This departs from RFC §18.3 lane (c), which names the stream `<NET>_<STA>_<stream>/CANTICLE` (RFC:2744). A stream name
alone can be 64 bytes (RFC:327), so that form can exceed the limit, and it needs §18.5's NET/STA table
(RFC:2756-2764). Hex ids need no table, and names stay a manifest lookup at the reader (RFC:341). See Q-B2.

### 3.2 Payload

| Offset | Size | Field                                                                                                                                                                                                                                                        |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0      | 4    | magic `BCRP`                                                                                                                                                                                                                                                 |
| 4      | 1    | version `1`                                                                                                                                                                                                                                                  |
| 5      | 1    | kind: `1` frame, `2` hello, `3` bye, `4` tick, `5` retract                                                                                                                                                                                                   |
| 6      | 1    | flags: bit 0 `resurfaced` (a re-hearing after the daemon restarted, RFC:2218); other bits zero                                                                                                                                                               |
| 7      | 1    | `writer_epoch`: the manifest epoch of the writer key that signed this packet (W7)                                                                                                                                                                            |
| 8      | 8    | `run`: strictly increasing across writer starts (W5)                                                                                                                                                                                                         |
| 16     | 8    | `seq`: within the run, starts at 1 (the `hello`) and rises by 1 for each packet assigned                                                                                                                                                                     |
| 24     | 8    | `heard_at`: ms since the epoch; the daemon's receive time for a frame, its send time otherwise                                                                                                                                                               |
| 32     | 8    | `rec_seq`: the daemon's record v1 `rec_seq` of the `frame` or `retract` record this packet mirrors; for a control packet, the last `rec_seq` emitted when it was written                                                                                     |
| 40     | 4    | `offset_ms`: signed; the daemon's δ̂ (its clock minus the station's) for this frame's key when it heard this frame; zero otherwise                                                                                                                            |
| 44     | 4    | `key_seq`: within the run and the packet's key (W9), starts at 1. Control packets count under key zero                                                                                                                                                       |
| 48     | n    | body. For a frame, the canonical frame byte for byte (at most 1 100 B, RFC:750). For a retract, a deterministic CBOR map `{idem, reason, by}` as record v1 carries them (RFC:2182). For a control packet, a deterministic CBOR map with W5's and W6's fields |
| 48 + n | 64   | Ed25519 signature by the writer key over `"binary-canticle/ring/v1" ‖ 0x00 ‖ bytes 0 to 48 + n`                                                                                                                                                              |

The largest packet is 1 212 B. Use `MaxPacketSize 1280`. Every slot then costs 1 400 B: `MaxPacketSize` plus the
120-byte `RingPacket` header (`rs:src/ring.h:87-98`, `rs:src/ringserver.c:106`). The server logs it as
`pktsize: 1400 (1280 payload)` (Appendix A). A `tick`'s 48 per-key heads (W6) are sized to fit a control body within
that limit.

### 3.3 Ordering and identity across reconnects

- **Order.** Writes are totally ordered under the server's ring lock and delivered in write order
  (`rs:src/ring.c:709-742`), except after a crash of a memory-mapped ring (E4). With one writer, packet id order is
  seq order. Across stations the order is the daemon's, and with the retract packets, plucks, supersessions and
  retractions apply on the ring path as the daemon applied them.
- **Completeness.** frond-ear streams only the keys it tunes (§4.6), so `seq` has holes for it by design. It judges
  completeness per key by `key_seq`, and for control packets by their own sequence. `seq` stays the run's total, for
  the writer's tail bound (W5) and for readers that take every packet.
- **Order against the socket.** Each packet's `rec_seq` places it in the daemon's record v1 stream. §5.2 uses this to
  keep the ring from running ahead of the socket.
- **Record identity.** The tuple (key_id, epoch, stream_id, seq) is record v1's `idem` (RFC:2196) and delivery's
  `identity()` (`src/canticle/delivery.ts:101`, with the stream named). Both paths produce the same string when they
  use the same manifest, so tombstones, custody and dedup work across them. §8 requires the same manifest.
- **Byte identity.** The SHA-256 of the frame is record v1's `frame.sha256` (RFC:2195). Shadow mode and the witness
  compare the paths with it (§4.4, §8).
- **Position.** A position is (run, seq). A packet id locates it within one ring generation and nothing more. Packet
  ids are handed out again after a `kill -9`, can come back out of order after a crash of a memory-mapped ring,
  restart at 1 after a reset or with a volatile ring, and keep their number with a new pkttime after a resize
  (Appendix A, E3 and E4). ringserver has no generation marker to tell these apart: its saved header holds only
  format, sizes and offsets (`rs:src/ring.h:70-81`).
- **Writer-supplied packet ids were considered and rejected.** DataLink 1.1 lets a writer submit its own ids
  (`rs:doc/ringserver.md:354-362`, flag `I` at `rs:src/dlclient.c:916-933`). But the server checks them neither for
  uniqueness nor for order, so a reader would have to validate them anyway. (run, seq) under the writer's signature
  does that without depending on the server.

## 4. Reader semantics

### 4.1 Shape in frond-ear

A third `CanticleSource` (`src/canticle/source.ts:19-24`), `RingSource`, combines two parts:

- **The existing `RecordClient` on the host socket.** It supplies `landing_state` (and with it the breaker that
  delivery holds on, `delivery.ts:676-677`), presence and health, and the live daemon run that ring runs are bound to
  (§4.3). It is also the witness that confirms hidden items (§4.4). In `shadow` mode it is the comparison too.
- **A `RingReader`.** It keeps one DataLink TCP connection (`node:net`, no dependencies) and selects the tuned keys
  with `MATCH`. It applies the receiver caps before any cryptography (§4.6), checks each packet's writer signature,
  and feeds each frame into the existing `Listener` (`src/canticle/listener.ts`), with `warmup: false`
  (`listener.ts:337`) and no beacons. Reusing the listener brings the verification, dedup, plucks, supersession,
  quotas and journaled guards that the embedded path already proves (`src/canticle/receptor.ts:335-376`). The ring
  path then adds transport, a cursor and the retract packets, not a second admission implementation.

**Feeding at hearing time.** Each frame is fed at `h = min(envelope heard_at, now)`, with that frame's clamped
offset (§5.1) in place of the listener's beacon samples (which it reduces to their minimum, `listener.ts:140-141`).
The guards (epoch high-water mark, sticky plucks, supersession marks) are then raised in the daemon's order and at its
hearing times; not identically, since retain horizons use the clamped offset (`listener.ts:818`). Liveness is judged
against `now` afterwards (§5.1).

This matters when one key's items have different TTLs: after a restart, a supersessor that has expired must still
block its predecessor that hasn't. The listener has so far seen only forward-moving time, so the code must run
`tick(now)` after each `hear(…, h)` and test that purges still hold (§9, case 2).

**Retract packets** remove their item from the live set and from hidden items, by identity. They are failsafe: they
only remove, never admit or show.

**Warm-up off, no beacons.**

- **Warm-up can be off.** §6.3 item 4's warm-up (RFC:400) stops an older value from landing as current before the
  newer one is heard after a restart. The daemon applies warm-up itself, appends a held item only on release (W1), and
  mirrors the retractions that held items cause.
  - The ring keeps the daemon's order.
  - A writer restart hides the previous run's items until they are confirmed (§4.4).
  - The persisted marks cover a reader restart.
- **With warm-up on it would block.** With no beacons, the listener would hold live-state items forever, since
  `#warm` needs a beacon (`listener.ts:1123-1130`).
- **No beacons in the ring** (🍃's pick on Q-B6). Beacons loop at the station's cadence and each is a new identity,
  so at cue rates they would fill most of the ring. What they carry is live-only: presence comes from the host
  socket, and δ̂ travels in the envelope. The sequence heads a beacon would give come from `tick`'s per-key heads
  instead (W6).

### 4.2 Persistence

- **The cursor and safety state.** These live in frond-ear's SQLite store, as one `runtime_state` value named
  `canticle.ring`. It holds:
  - the listener's `SafetyState`;
  - the cursor `{pktid, pkttime, run, seq, digest}`: the packet below which every packet has been processed, or
    dropped and counted (§4.6);
  - for each run tracked (§4.3): the daemon run it names, its `hello`'s packet id, the last `seq` and control
    sequence read, and how it ended (its `bye` read, retired, or tail unknown);
  - for each key in the current run: its last `key_seq`, its missing ranges, and the packet ids skipped over its
    caps and not yet refilled (§4.6);
  - for each hidden group (one key and one hole, or one ended run): the hole, the reason and its watermark `W`
    (§4.4), so confirmation carries on after a restart;
  - the socket witness: for each daemon run, the `rec_seq`s of records W1 mirrors that the socket has shown and the
    ring hasn't yet delivered, at most 1 024 (§4.4);
  - the latest daemon run and `rec_seq` the writer named;
  - the counters.
- **The live frames.** These live in a table of their own: one row per live or hidden item, holding the whole signed
  packet, its local expiry and a hidden flag. At most `MAX_LIVE` rows, about 5 MB. When the table is full, hidden rows
  are evicted first, oldest first, and counted; §4.6 says what happens when only live rows are left.
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
  checkpoint (the receptor's `state_not_durable` rule, `src/canticle/receptor.ts:439-441`). The first checkpoint after
  recovery rewrites every in-memory live row in the same transaction, so no row the outage failed to write is lost
  behind the new cursor.
- **A corrupt saved state stops the reader.** It is refused, as the receptor refuses one
  (`src/canticle/receptor.ts:211-219`), rather than treated as a cold start.

### 4.3 Resume, runs and holes: the client rules ringserver forces

1. **Send `ID frond-ear` at once, and again every 60 s.** ringserver drops a client that has sent nothing within 10 s
   of connecting (`rs:src/clients.c:395-404`), and an idle one after `ClientTimeout`, 3 600 s by default
   (`rs:doc/ring.conf:154`). `ID` doesn't end streaming. Send `MATCH` (§4.6) straight after the first `ID`; it
   filters `STREAM`, not `READ` (`rs:src/ring.c:940-942`).
2. **Read `INFO STATUS`:** `EarliestPacketID` and `LatestPacketID`. No trust is needed (`rs:src/infoxml.c:579-594`).
3. **Validate the cursor with `READ <cursor.pktid>`.** Go on only if that packet authenticates and its run, seq and
   digest match the cursor's. Then send `STREAM`, which delivers from pktid + 1 (E1).
   - **Send `STREAM` only straight after a `READ` that succeeded on this connection.** A `READ` that misses leaves
     the position where it was: `RingRead` returns before it moves it (`rs:src/ring.c:968-971` against `:987-990`).
     A failed `POSITION SET` likewise (`rs:src/ring.c:1233-1236`; on a pkttime mismatch `rs:src/dlclient.c:513-527`
     puts the old position back).
   - **What that costs depends on the connection's history.** A new connection has no position
     (`rs:src/clients.c:113-116`). `STREAM` then starts at the next new packet, so the backlog is skipped and nothing
     says so (`rs:src/dlclient.c:173-177`, `rs:src/ring.c:1045-1056`; E2). A connection that had a position
     resumes from the old one: duplicates, not a skip. Neither is announced, so the reader never streams after a
     miss.
   - **Don't start from `POSITION SET EARLIEST` or `POSITION AFTER`.** Both skip their first packet (E1).
4. **If validation fails,** the cursor's packet has been evicted, rolled back or replaced. That alone hides nothing:
   an evicted cursor packet whose successors survive loses nothing.
   - Report `ring_overrun` if the cursor is below `EarliestPacketID`. Report `ring_reset` if it is above
     `LatestPacketID`, if another packet now holds it, or whenever `EarliestPacketID` exceeds `LatestPacketID`, as a
     crashed memory-mapped ring shows (E4).
   - Then `READ <EarliestPacketID>` and process the packet it returns. If that `READ` misses (the earliest packet can
     be evicted in between), query `INFO STATUS` again and retry.
   - Then `STREAM`, and read everything the ring holds. Loss is counted, and items hidden, only from the holes and run
     boundaries this re-read shows.
   - **After a crash, packet ids say nothing about order.** A memory-mapped ring can still serve packets the crash
     lost, then hand their ids to new packets. A `STREAM` from its earliest packet can wait for the next write and
     then deliver ids out of order (E4). The reader validates by (run, seq, digest) and orders by (run, seq) and
     `key_seq`, never by packet id.
5. **Runs.** These rules answer 🌫's replay cut and 🍃's H2.
   - **A run is bound to a daemon incarnation.** Its `hello` and `tick`s name the daemon's record v1 `run`, which is
     random hex chosen at each daemon start (RFC:2176). The host socket's latest `hello` gives the live one.
   - **Monotonic by default.** The highest run seen is the current one. A higher run ends every lower run: a writer
     restart, which must start with its `hello`, control packet 1. Each key first seen in it past `key_seq` 1 lost
     exactly that many of its packets, a `ring_gap` for that key. If the `hello` itself was lost, whether whole runs
     went by in between is unknown, and is reported so. Packets of a lower run are skipped and counted as
     `stale_run`: already-processed history, the leftovers of a rollback, or a replay.
   - **The only exception is a recovery binding.** A lower run becomes current only when its `hello` or a `tick`
     names the daemon run the live host socket reports, and the current run's latest names another. That is a writer
     that lost its saved run with its clock behind, reported as `run_regressed`.
     - **Nothing depends on freshness.** A replayed `hello` or `tick` names an earlier incarnation and is refused
       however recent it is: two writer starts 10 s apart give the first `hello` no window after the second. A
       genuine regressed run is accepted however late it is read.
     - **Nothing binds while the host socket is down.** The reader remembers the lower run's `hello` packet id.
       Once the socket reports its daemon run, it rewinds there and decides.
   - **Two writers.** A lower run's packets still arriving after a higher run began, or two runs that name the same
     live daemon run, raise `two_writers`, an alert in `ear_status`. If exactly one of them is bound to the live
     daemon run, it is current and the other is skipped as `foreign_run`. If both are, neither run's new items are
     shown (next point).
   - **Blind states have health and an exit.** The reader can be connected and reading, yet able to show nothing
     new:
     - `run_unbound`: the current run hasn't named the live daemon run for three tick intervals while the socket is
       connected;
     - `two_writers`: two runs are bound to the live daemon run;
     - `manifest_mismatch`, in `primary` (§8).

     Each makes health `degraded` with reason `ring_blind`, adds a header line to `hear`, and logs once. They clear,
     respectively: when a run bound to the live daemon run appears (by the exception above, or a writer restart);
     when one writer has sent nothing for three tick intervals; and at a frond-ear restart with the daemon's
     manifest. A counter is never the only signal.

   - **At most 16 runs are tracked.** Beyond that the oldest is retired. Its tail is reported as unknown if no `bye`
     was read (§4.4), its items stay hidden until confirmed or expired, and its later packets are `stale_run`.

6. **Holes and refills, per key.** This rule answers 🍃's H1.
   - For each key in the current run, the reader tracks the `key_seq`s it is missing, as at most 8 ranges per key,
     and the same for the control sequence. A packet that fills one is processed: canticle admission is built for
     packets arriving in any order, since UDP reorders.
   - A `key_seq` at or below its key's last that isn't missing is a duplicate.
   - **Over the limit, ranges merge; they are never dropped.** A ninth range merges the two oldest into one span, so
     a late fill is still processed, and a packet inside the span that was already processed is processed again
     harmlessly (§4.2's invariant). The key's loss count is then graded `at_most` (§4.4).
   - **A quiet key's lost tail** shows when a `tick` carries a head above the key's last `key_seq` (W6). It is a hole
     for that key from then on.
   - On a hole, the reader first rewinds to fill it from whatever the ring still holds. It ends the stream, sends
     `READ <max(last processed pktid + 1, EarliestPacketID)>` and streams forward from there. Packets already
     processed are skipped as duplicates by their `key_seq` (§4.5).
   - **A lap is silent.** When the next slot is newer than the latest packet, ringserver moves the reader to the
     earliest packet without a word (`rs:src/ring.c:1072-1075`, `1090-1109`). A slot overwritten while it is being
     copied is dropped after the position has moved past it (`rs:src/ring.c:1113-1116`, `1179-1183`). A lap
     typically leaves retained packets behind the jump (E2: 20068 to 20736). A hole filled completely is no loss.
     What stays missing is a `ring_gap` for its key, and the hiding below applies to that key.
   - **At most 4 096 keys are tracked** [PROPOSED]. A key with no live or hidden items is forgotten first; if it
     comes back, it is joined where it starts, with nothing of it to hide.
7. **Cold start.** This means no saved state at all: the first enable, or state an operator cleared.
   - The reader starts with `READ <EarliestPacketID>` and reads everything the ring holds.
   - The first run it meets is joined wherever it starts, and each key wherever it first appears.
   - Live items whose packets were already evicted are missing, so the reader reports `ring_joined_late`, blind and
     saying so, as `joined_late` does. It clears that when a complete join snapshot (§4.4) lists nothing the ring path
     lacks, or once the ring holds a full longest class TTL of history.
   - The retained part is internally complete. The ring is first-in, first-out, and every PLUCK, superseder or
     retract the daemon applied to a retained frame came after it.
   - A key tuned since the last start is joined the same way: `key_joined_late` for that key until a complete
     snapshot lists nothing of it that the ring path lacks.
8. **While streaming,** a packet whose writer signature fails is dropped and changes no state. A jump in packet ids
   is not loss on its own, and with `MATCH` it is routine; only a hole in a `key_seq` or in the control sequence is.

### 4.4 Gap detection and reporting: never silently skip

| Signal                                                                                   | Meaning                                                                                                                                         | Reported as                                                                                        | Live items                                                   |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| one key's `key_seq` jumps, after a refill                                                | That key's packets were lost: dropped at the writer (W3), skipped over a reader cap and not yet refilled (§4.6), a lap (E2) or a crash (E3, E4) | `ring_gap` for that key, `exact`; health `degraded` while anything stays hidden                    | That key's items heard before the hole are hidden; no others |
| a `tick` head above a key's last `key_seq`                                               | That key's last packets were lost                                                                                                               | `ring_gap` for that key, `exact`                                                                   | As above                                                     |
| a hole in the control sequence                                                           | Control packets were lost: a `tick`, or a `hello` or `bye`                                                                                      | `ring_gap` (control); a lost `bye` leaves its run's end unknown                                    | Unchanged                                                    |
| a higher run's key first seen past `key_seq` 1; a higher run first seen past its `hello` | That key's first packets in the run were lost; the `hello` was lost                                                                             | `ring_gap` for that key, `exact`; if the `hello` was lost, whether whole runs went by is `unknown` | As for a run's end                                           |
| a run ends: a higher run begins, or a bound lower run                                    | A writer restart, clean (its `bye` read) or not                                                                                                 | `writer_restarted`, or `writer_restarted_without_bye` with `run_tail_unknown`                      | The ended run's items are hidden until confirmed             |
| a `hello` names a previous run the reader never saw                                      | Whole runs were lost                                                                                                                            | `runs_absent`, count unknown                                                                       | As for a run's end                                           |
| cursor validation fails                                                                  | Eviction, rollback or a reset (§4.3)                                                                                                            | `ring_overrun` or `ring_reset`                                                                     | Only what the re-read's holes hide                           |
| a lower run; interleaved runs                                                            | History, rollback leftovers, a replay, or two writers                                                                                           | `stale_run`; `two_writers` and `foreign_run`                                                       | Unchanged; a blind state if nothing is bound (§4.3, rule 5)  |
| a lower run bound to the live daemon run                                                 | A regressed writer                                                                                                                              | `run_regressed`                                                                                    | As for a run's end                                           |
| a writer signature fails                                                                 | Not from the writer                                                                                                                             | `unauthenticated` (a count)                                                                        | Unchanged                                                    |
| a packet over its key's cap                                                              | §4.6                                                                                                                                            | `over_cap` for that key                                                                            | As for that key's hole                                       |
| no `tick` for three intervals                                                            | The writer is silent, or the ring is unreachable                                                                                                | `writer_silent`: blind, and saying so                                                              | Kept; expiry carries on                                      |

**Loss counts are graded** (🌫's crash cut). A report never states a count more precisely than its grade:

- `exact`: a hole with a packet of the same key, or a `tick` head, above it in the same run;
- `at_least`: the socket witness below;
- `at_most`: merged ranges (§4.3, rule 6), or a tail bounded by the next `hello`'s `prev_reserved_through` (W5);
- `unknown`: anything else, such as whole runs absent.

**Unknown tails.** Say the reader has read run R up to seq 10, a ringserver crash takes R's 11 to 20 before the
reader reads them, and the writer restarts as run S. S starts at 1, so no hole in any sequence shows that anything was
lost, and S's `hello` names R but not R's last seq.

- A run that ends without the reader having read its `bye` gets `run_tail_unknown`, with the last seq read.
- It is bounded where a witness allows. Above, by S's `hello`'s `prev_reserved_through` (W5). Below, by the
  **socket witness**: the record v1 consumer keeps, for each daemon run, the `rec_seq`s of records W1 mirrors that
  the socket has shown and the ring hasn't yet delivered (at most 1 024, persisted, §4.2). When a run's tail is
  unknown, those above the last packet read were lost to the ring path, at least. The socket drops records too
  (`records_lost`), so it never makes a count exact.
- `tick` heads (W6) don't help here: the ticks in 11 to 20 went with the packets. They witness tails lost at the
  writer or in transit, not tails lost in a ring rollback.
- R's items are hidden until confirmed (below), as for any run's end.

**Why hide.**

- **Gaps.** A lost packet may have been a PLUCK or a retract for its key. `records.ts` clears its whole live set on
  any gap (`:644-647`). The ring reader hides only that key's items, since a packet's effects stay within its key
  (W9). Hidden items are absent from `hear` and from delivery's view, but they keep their rows. One burst for one key
  no longer blinds every quiet tuned stream.
- **Writer restarts.** Record v1 drops a run's items at `bye` and at a new run, because nothing from that run can
  retract them any more (`src/canticle/records.ts:387-394`, `:818-824`). The ring path hides them for the same reason.

**What confirms a hidden item.** Within one run the daemon appends a surfaced frame only once (an equivocation copy
aside), so nothing later in that run can confirm a hidden item. Waiting for expiry could hide a key for up to
86 400 s, for `finding-ref` (RFC:383). So a hidden item is shown again only when a sound witness confirms it, or it
leaves at its local expiry. Let `W` be the envelope `rec_seq` of the packet that revealed the hole (the key's next
packet, or the `tick`), or of the new run's `hello`. Three things confirm:

- **The host socket's consumer.** It holds the item (not `carried`) with the same `idem` and `frame.sha256`
  (RFC:2195), has had no `rec_seq` gap on its current connection, and has read up to at least `W`. Every retract the
  daemon emitted before `W`, including one for a PLUCK lost in the hole, has then reached it. The consumer must keep
  `frame.sha256` and expose its last `rec_seq` for this.
- **A complete join snapshot with watermark of at least `W`** that lists the item (RFC:2282). When the consumer can't
  confirm, `RingSource` asks for a snapshot on a separate, short-lived host-socket connection (the daemon allows 16,
  `bc:prototype/canticle-station/canticle/daemon.py:64`). One request is in flight at a time, at most one per hidden
  group, and at most one every 30 s [PROPOSED].
  - It never reconnects the connection that carries `landing_state`. A rejoin there would itself be loss
    (`records_lost`, RFC:2267), and in `shadow` mode a loss on the production path.
- **A `resurfaced` re-append of the same frame in a later run** (flag bit 0). After a normal daemon restart these
  arrive within a loop period as the daemon hears the stations again.

**What removes a hidden item.** A retract packet removes it. So does absence from a complete snapshot with
watermark of at least `W`, which is not a `retract` and settles no custody (RFC:2286).

**Socket retracts remove too.** A ring item isn't shown while the host socket's consumer holds a `retract` for its
`idem` from the same daemon run. Within a run a retraction is final (plucks stick, supersession holds), and the
consumer keeps its latest 4 096 retracts by `idem` for this. Removing
is always safe, and it covers a retract the ring lost but the socket didn't, before a `tick` reveals the hole.

**Hidden items and delivery.** Delivery already treats a record that leaves the view like one whose link is down: it
"waits for its return or its local expiry, and is never pushed from memory" (`src/canticle/delivery.ts:703-704`). So:

- a hidden item that expires while hidden counts as `off_air_unpushed`, and as `hidden_expired` in the ring's counters;
- a confirmed item returns to the view and is pushed under the usual rules, marked late if it is older than
  `maxAgeMs`;
- delivery's `seen` map is unaffected.

Every one of these signals is reported, each count with its grade: in `ear_status` (`canticle.ring`), in a header
line in `hear` (as `joinedLate` does, `src/canticle/hear.ts:324-334`), in a footer line on the next report ("ring: N
records lost since the last report", or "an unknown number"), and in a log line carrying counts, never payload.

### 4.5 Duplicates and idempotence

- **The same (run, seq) twice** comes from a writer retry after a disconnect (W4), or from re-reading. A `key_seq`
  that is neither missing nor new for its key is skipped and counted as `ring_duplicate`. Bytes are compared only
  for the cursor's own packet, at validation.
- **The same frame identity in another packet** comes from a `resurfaced` re-append in a later run. Identical bytes
  are a harmless repeat (RFC:481); different bytes are an equivocation.
- **Across paths and restarts,** delivery's identity tombstones (`docs/runbook.md:757-775`) keep a record from being
  pushed twice, within §14.18.5's bound. A tombstone lasts until the record's local expiry plus 5 s, and is lengthened
  when the record is heard again with a later expiry (`delivery.ts:545-550`). Once it has lapsed, a record heard again
  can be pushed once more (`docs/runbook.md:769-771`).

### 4.6 Backpressure and receiver caps

**Decision: the cursor advances when a packet has been processed into the reader's state, never when a session
consumes it.** Keeping pace with the session stays delivery's job: per-ear caps, digest windows, oldest-first drops
from `bufferPerStream` counted as `dropped`, `off_air_unpushed`, and `maxPushesPerHour` (`docs/runbook.md:704-717`).

Why not hold the cursor until the session catches up:

- Holding it turns a slow session into ring lag, and ring lag into a lap. A lap skips a ring's worth of packets
  without notice (E2), retractions along with content.
- Delivery already keeps the durable dedup and custody that make a push at-most-once. A session can't take records
  faster than delivery shows them, so holding the ring gains it nothing.
- An item held past its expiry is worth nothing (§5.1).

The reader judges no content. Every authenticated packet of a tuned key goes through the listener so that the guards
stay complete.

**Receiver caps come before the token budget** (#116 amendment 4 §2). Delivery's budgets keep context small; they
don't stop a flood from exhausting the reader. So, in this order, before anything reaches the listener:

1. **Selection at the server.** `tune` names station:stream pairs, which the manifest turns into (key, stream) pairs.
   The reader sends `MATCH` with exactly their stream ids and the control id, a regex of up to 1 MiB
   (`rs:src/dlclient.h:45`). ringserver applies it while streaming (`rs:src/ring.c:1133-1137`), so untuned packets
   never reach the reader.
2. **A header check before any cryptography.** Each packet's stream id is parsed into its claimed key and stream. An
   untuned one, should `MATCH` be missing, is dropped and counted as `untuned`.
3. **Per-key queues, capped.** Packets wait for verification in a queue per claimed key: at most 256 packets and
   256 KiB per key, and 8 MiB in all [PROPOSED]. The reader keeps reading past a full queue, so one key's backlog
   never holds up another's packets behind it in the stream.
4. **A verification budget, shared fairly.** Writer signatures, then station signatures for new frames, are checked
   at most 2 000 times a second in all [PROPOSED], round-robin across the keys with packets waiting. A noisy key
   can't starve a quiet one of verification.
5. **Over the caps, skip and refill.** A packet that finds its key's queue full (or the total full, charged to the
   key holding the most) is skipped unverified and counted as `over_cap` for that key. The reader can't tell a real
   packet from a forged one without verifying it, so the skip is a hole for that key (§4.4), and its earlier items
   are hidden until confirmed. The reader keeps the skipped packet ids per key, and refills them from the ring as the
   queue drains, on a second connection whose `MATCH` names that key alone. What the ring evicts first is lost for
   that key. A flood claiming key K keeps K's queue full and so blinds K, never another key; a legitimate backlog
   (a catch-up after an outage) is only delayed.
6. **Then admission:** the listener's per-key quotas (RFC:484-493), the live caps below, and only then delivery's
   budgets.

The cursor is the newest packet id below which every packet has been processed, or skipped and recorded for refill.
No rate is capped per second: the reader pulls, so a legitimate backlog arrives as fast as it reads, and a
per-second cap would cut it.

**This is defence in depth in version 1.** Only the daemon can write (§2), and it admits each station only within
its per-key quotas, so no station can push the ring past its carousel budget (§6). A line-rate flood needs write
access. The caps are there for when that fails, and the flood test proves them.

**The flood test is acceptance** (#116 amendment 4 §2; §9, case 22). Under an untuned flood at line rate and a forged
flood under one tuned key's stream id, a quiet tuned key's items are admitted on time, verification stays within its
budget, memory stays bounded, and only the forged key is hidden, and reported.

| Where                 | Bound                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The connection        | One DataLink connection with TCP flow control. ringserver keeps no per-client queue; a send stalled for `NetIOTimeout` (10 s) disconnects (`rs:src/clients.c:823-899`).                                                                                       |
| Selection             | `MATCH` on the tuned keys and the control id                                                                                                                                                                                                                  |
| Queues                | 256 packets and 256 KiB per key, 8 MiB in all [PROPOSED]; over them, skipped and refilled                                                                                                                                                                     |
| Verification          | 2 000 a second in all, round-robin by key [PROPOSED]                                                                                                                                                                                                          |
| The listener          | Per-key dedup and mark quotas (RFC:484-493)                                                                                                                                                                                                                   |
| Live and hidden items | `MAX_LIVE` 4 096 rows, as in `records.ts:46`, and at most 512 per key. Hidden rows are evicted first. When only live rows are left, a new item is refused and counted as `live_overflow`, as `records.ts:663-668` does, and health reports `live_table_full`. |
| Runs, keys and holes  | 16 runs; 4 096 keys; 8 missing ranges per key, merged beyond                                                                                                                                                                                                  |
| Snapshot requests     | One extra host-socket connection at a time, one per hidden group, at most one every 30 s                                                                                                                                                                      |
| Delivery              | `MAX_WAITING` 4 096 (`src/canticle/delivery.ts:74`), and `bufferPerStream` up to 256 (`src/config.ts:464`)                                                                                                                                                    |

**Lag.** The reader reports `lag_packets` (`LatestPacketID` minus the cursor, from `INFO STATUS`, which ringserver
answers mid-stream) and `lag_ms` (now minus the last frame's `heard_at`). It warns `ring_lag_high` when the lag passes
half of the ring's span, estimated from the earliest and latest creation times. After a crash of a memory-mapped ring
the ids are out of order, and `lag_packets` is reported as unknown until they are in order again.

### 4.7 Restart rebuild

On start, the reader loads the checkpoint, replays the journal, and reloads the live and hidden rows from the store,
with the hidden groups' watermarks, so confirmation carries on (§4.4). It checks each row's writer and station
signatures again; items that expired meanwhile are dropped and counted, and so are items whose key the manifest no
longer lists. Restored items surface with `origin: "replay"`, and tombstones stop them being pushed again. Then the
reader resumes from the cursor (§4.3).

The rebuild reads nothing from the ring, so it survives a wrap, a ringserver crash or a reset. A list of packet ids to
re-read would not: a crash can roll the ring back by days (§7), and a single `finding-ref` item lives up to
86 400 s (RFC:383).

## 5. Expiry, landing and custody

### 5.1 Expiry at read time

```
expires_eff        = min(expires_at, issued_at + class max TTL)          (wire.ts:421-437, RFC:1780)
δ̂r                 = max(min(envelope offset_ms, 0), −60 000)            (never positive; per frame)
h                  = min(envelope heard_at, read time)
local_expiry_ring  = min(expires_eff + δ̂r, h + (expires_eff − issued_at))
```

- **The clock offset may only move expiry earlier.** RFC §14.6.3 lets δ̂ move expiry later, bounded only by first
  hearing plus TTL (RFC:1781-1784). On a ring, "first hearing" would be the read, so a writer, or simply a late read,
  could stretch a replayed item to a full TTL from now. The reader therefore uses only the non-positive part of the
  daemon's δ̂, which moves expiry earlier (`wire.ts:435`). With δ̂r ≤ 0, nothing on the ring path outlives the
  station's signed `expires_at` on the reader's clock.
- **Why carry δ̂ at all.** A station whose clock runs ahead (δ̂ < 0) would otherwise have every frame refused as
  `not-yet-valid` (`wire.ts:546-547`, which subtracts the offset and adds 5 s). Carrying it keeps such a station heard,
  up to 65 s ahead.
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

Ring items are shown in `hear` and pushed only when all three of these hold:

- **The host socket's consumer is deliverable.** It is connected, its receive health is neither `failed` nor
  `stopped`, it has the run's `landing_state`, and `mute` is null (`src/canticle/records.ts:917-919`). `RingSource`'s
  view carries the consumer's `breaker`, so delivery holds on it as it does today (`delivery.ts:676-677`).
- **The writer's latest `hello` or `tick` names that same daemon run.** Nothing from a run is deliverable before
  that run's first `landing_state` (RFC:2251). The latest run the writer named is checkpointed, so a frond-ear restart
  doesn't wait for the next `tick`. This is the same binding that orders runs (§4.3, rule 5).
- **The ring doesn't run ahead of the socket.** The consumer has read up to at least the item's envelope `rec_seq`.
  The daemon emits a record before appending its packet (W2), so this costs almost nothing. It means a MUTE or
  retract the daemon emitted before the item has always been applied first.

So a daemon MUTE empties `hear` of ring items too, as it does today. During a socket reconnect nothing from the ring
is pushed under a stale state. While the reader is still catching up on an older run, nothing is shown until it
reaches the current one, which takes a local read of the backlog.

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
copy per frame, so it is written at the new-item rate, not the loop rate. Retract packets add at most one per
retraction. Two rates matter:

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

**Sizing rule.** The restart rebuild reads frond-ear's store, not the ring (§4.7), so retention has to cover only:

- the longest reader outage the ring should bridge without loss;
- whatever dashboards want.

A 1 GiB ring bridges more than 3 hours even at six stations' first-copy ceiling; about 8 GiB covers a day.
Retention shorter than the longest TTL in use only matters at a cold start (§4.3, rule 7).

**These sizes are candidates for the shadow experiment, not an install decision** (🌫's S3). With `MemoryMapRing 0`
(§7) the whole ring lives in memory (`rs:src/ring.c:278`) and is rewritten at every clean stop
(`rs:src/ring.c:637`), so its size costs RAM and stop time as well as disk. 🌫 sets the installed size after
measuring.

**Demand is capped by the session.**

- **The caps.** A push carries at most `maxItems` records (5 by default, up to 10) and `limits.maxNotificationChars`
  characters (6 000 by default, with no maximum; `docs/runbook.md:802`, `src/config.ts:719-723`). It happens at most
  `maxPushesPerHour` times an hour (60 by default, up to 360; `docs/runbook.md:715-717`).
- **What they allow.** By default, about 300 records and 360 000 characters an hour, roughly 90 k tokens at four
  characters a token. At the outer push limits and the default character limit, 3 600 records and 2.16 million
  characters an hour.
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

| Failure                                           | Detected by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Behaviour                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ringserver down or unreachable                    | A connect error, a send timeout, or no `tick` for three intervals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Back off as the receptor does (1 s·2ⁿ up to 30 s, plus jitter, `receptor.ts:309-318`). Health `degraded`, reason `ring_unavailable`. `hear` says content since T may be missing, and live items keep expiring. Resume from the cursor afterwards; holes from writer drops show as `ring_gap`. |
| Ring wrap while the reader is stopped             | Cursor validation: below `EarliestPacketID`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `ring_overrun`. The re-read counts holes exactly within a run and key, and at least otherwise.                                                                                                                                                                                                |
| Lap while streaming                               | A `key_seq` hole, or a `tick` head ahead of what was read (E2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | A refill from what the ring still holds, then `ring_gap` for what stays missing, with hiding for each key affected.                                                                                                                                                                           |
| Clean ringserver restart, persistent ring         | `READ` at the cursor validates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Nothing to report.                                                                                                                                                                                                                                                                            |
| ringserver crash (`kill -9`)                      | Validation fails: the packet id is above `LatestPacketID`, another packet now holds it, or `EarliestPacketID` exceeds `LatestPacketID`. ringserver saves its header and its stream index only at clean shutdown (`rs:src/ring.c:544-580`, `595-606`), and nothing in `ring.c` calls `msync` or `fsync`. With `MemoryMapRing 0`, version 1's choice, the ring comes back exactly as the last clean shutdown left it (E3, E4). A memory-mapped ring keeps its newer slot bytes behind the old header: startup checks only the boundary slots (`rs:src/ring.c:432-474`), packets the crash lost stay readable, their ids then go to new packets in place (`rs:src/ring.c:725-736`), and a ring that was full serves ids out of order (E4). | `ring_reset`. The re-read counts the holes, graded. Only packets frond-ear hadn't read yet are lost to it; what it read is in its store. If the writer restarted too, the lost tail is reported as unknown, with whatever bounds the witnesses give (§4.4).                                   |
| Power loss                                        | Untested. Neither mode syncs: the unmapped ring's file is written at clean stop with no `fsync` (`rs:src/ring.c:637`), and a mapped ring's pages reach disk when the kernel writes them back                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Whatever comes back is validated as a reset. A torn slot fails the writer signature and counts as `unauthenticated`, expected after a reset rather than an alarm. Proving this is Q-S3's.                                                                                                     |
| Ring reset, volatile restart, or corrupt files    | `LatestPacketID` below the cursor, or another packet at the cursor's id (ids start again at 1). Not `StartTime`, which changes on every restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `ring_reset`, and the counts come from the holes. With `AutoRecovery 1` (the default) corrupt files are set aside and the ring starts empty.                                                                                                                                                  |
| Ring resized                                      | Packet ids are kept but their pkttimes are reset (E3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Envelope validation passes. Never rely on pkttime alone.                                                                                                                                                                                                                                      |
| Writer (daemon) restart                           | A higher run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The previous run's items are hidden until a `resurfaced` re-append or the witness confirms them. Without its `bye` read, its tail is unknown (§4.4). A key first seen in it past `key_seq` 1 is a `ring_gap` for that key.                                                                    |
| Writer lost its run state, clock behind           | A lower run whose `hello` or `tick` names the live daemon run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Accepted and reported as `run_regressed`, however late it is read: it is bound to the daemon incarnation, not to a freshness window (§4.3, rule 5).                                                                                                                                           |
| A replayed `hello` or `tick`                      | It names an earlier daemon run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `stale_run`; it changes nothing, however recent it is.                                                                                                                                                                                                                                        |
| Two writers on one ring                           | Interleaved runs, or two runs naming the live daemon run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A `two_writers` alert. If exactly one is bound to the live daemon run, it stays current and the other is `foreign_run`. If both are, `ring_blind` (health `degraded`) until one has sent nothing for three tick intervals.                                                                    |
| Station clock ahead                               | The daemon's negative δ̂ travels in `offset_ms`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Heard as on the socket path, up to 65 s ahead. Beyond that, frames are refused as `not-yet-valid` on the ring path only, and the daemon's `health` reports `clock_skew` (RFC:2185).                                                                                                           |
| Station clock behind                              | `expired_on_read` for that key; `expiry_delta` in shadow mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Items expire early by the skew, on the ring path only. Fail closed.                                                                                                                                                                                                                           |
| Unauthenticated packets                           | The writer signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Dropped and counted. They never move the seq accounting.                                                                                                                                                                                                                                      |
| A flood, untuned or forged                        | `MATCH`, then the per-key queues and the verification budget (§4.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Untuned packets cost nothing. Packets over their key's queue are skipped unverified, counted as `over_cap` and refilled later; the key they claim is hidden and reported meanwhile, and no other key is touched.                                                                              |
| Manifest change or mismatch                       | The manifest SHA-256 in `hello` and `tick`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | A mismatch is reported (`manifest_mismatch`), and `primary` shows nothing from the ring until the manifests match (`ring_blind`, §8). frond-ear reads its manifest once at start, so a change on the daemon's side silences `primary` until frond-ear restarts with the new file.             |
| A key revoked in the manifest                     | frond-ear's own manifest, at its next start                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Until frond-ear restarts with the new file, the key's retained packets are still accepted on the ring path, while the daemon's `manifest_mismatch` blanks `primary`. At the restart, its packets and live rows are refused (§4.7).                                                            |
| A local `AUTH` against a helper without arguments | Any local client sending `AUTH` when `AuthCommand` was configured with none (the pinned ref)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The server crashes with SIGSEGV: `posix_spawn` gets a null argument vector (`rs:src/auth.c:483`; `rs:src/config.c:3428` builds one only when there are arguments; E5). Configure the helper with an argument (§2). Should it happen anyway, it is a crash as above.                           |
| Local connection exhaustion                       | Any local process can hold connections up to `MaxClients` (600); `MaxClientsPerIP` exempts only `WriteIP` addresses, which here are none (`rs:src/ringserver.c:1165-1192`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Availability only: `ring_unavailable` for the reader, and the writer's drops show as holes. Q-S1.                                                                                                                                                                                             |

**Why there is no automatic fallback to the socket for content.**

- **The two paths lose data differently.** Record v1 drops `frame` records and clears its live set on gaps; the ring
  keeps everything and reports holes. With both behind one view, "never silently skip" can't be stated for the moments
  of switching.
- **`primary` exists for exactly the case where the socket path does worse.** Falling back silently would bring that
  case back in the middle of a session.
- **The socket stays a witness and a gate, not a second content source.** It confirms hidden items (§4.4), gates
  landing (§5.2), binds runs (§4.3) and may remove an item it saw retracted. It never supplies content on the ring
  path.
- **An outage is visible, and its loss is bounded and counted, or reported as unknown.** A clean ringserver restart
  loses nothing. A crash loses only what frond-ear hadn't read yet, and the holes say how many, or the report says
  the number is unknown.
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
- **The writer key** comes from the manifest, which names the writer's public keys by epoch (W7, Q-B5). frond-ear's
  config never carries one.
- **The manifests must match.** The socket path takes station and stream names from the daemon's manifest
  (`src/canticle/records.ts:750-752`), and the ring path from frond-ear's. Different names would give different
  identities, breaking tombstones across the paths.
  - **The hash.** Both sides hash the manifest file's bytes with SHA-256, as record v1's `hello` reports its
    `manifest_sha256` (RFC:2180).
  - **On a mismatch** in the hash carried by `hello` and `tick`, the reader reports `manifest_mismatch`. `shadow`
    counts it, and `primary` shows nothing from the ring until the manifests match, a blind state (§4.3, rule 5).
- **`credentialFile`.** This is optional: a 0600 file, for an `AuthCommand` that also gates streaming
  (`AuthRequiredForStreams`, which gates `STREAM` but not `READ`).
- **The caps** (§4.6) have defaults, which `ring.caps` may override.
- **The tick interval** comes from the writer's `hello` and `tick`, not from config.
- **`shadow`.** `RingSource` runs with its own cursor and listener state and feeds nothing to `hear` or delivery. It
  compares, by identity, what it reads against what the socket consumer reports:

  | Counter             | Meaning                                                                                                         |
  | ------------------- | --------------------------------------------------------------------------------------------------------------- |
  | `both`              | Seen on both paths with the same frame SHA-256 (record v1's `frame.sha256`, RFC:2195)                           |
  | `digest_mismatch`   | The same identity with different bytes: a bug, or an equivocation one path missed                               |
  | `ring_only`         | The socket lost it (`records_lost`). This is the ring's value.                                                  |
  | `socket_only`       | The ring lost it or the writer skipped it. An unexplained one blocks promotion.                                 |
  | `expiry_delta`      | The ring's local expiry minus the socket's `local_expiry_at`. Expected to be negative for stations whose δ̂ > 0. |
  | `latency`           | The ring's read time minus the socket's receive time, p50 and p99                                               |
  | `shadow_incomplete` | Periods when the comparison window was full and comparison paused                                               |

  The comparison window is bounded by time, not TTL. An identity seen on one path and not on the other within 10
  minutes [PROPOSED] is a divergence, since both paths see a frame within seconds (`latency`). An entry leaves when
  both paths have seen it or its window has passed. At most 65 536 entries [PROPOSED], about 6 MB at about 100 B
  each, hold 60 frames a second for the full window. If the cap is reached anyway, comparison pauses and counts
  `shadow_incomplete`, rather than evicting entries into false `socket_only` counts. The window shows in `ear_status`
  as `canticle.ring.shadow`, with one log line per divergence giving the identity only. Shadow mode never touches the
  production socket connection: snapshot requests go on their own connection (§4.4).

- **Promotion to `primary` (proposed).** N days of shadow on one seat with no unexplained `socket_only` or
  `digest_mismatch`, no `shadow_incomplete`, every `ring_gap` explained, and latency p99 under 2 s; and the flood test
  and the conformance script (§9) passing against the installed build.
- **`primary`.** The ring feeds `hear` and delivery. The socket still feeds `landing_state`, presence and health,
  gates the ring (§5.2), binds its runs (§4.3), confirms hidden items, and keeps the shadow counters with the roles
  reversed.
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
  `LATEST`), `MATCH`, `STREAM` and `ENDSTREAM`, using fixed slots. It reproduces the real server's quirks from
  Appendix A:
  - `POSITION SET N` or a good `READ N`, then `STREAM`, delivers from N + 1;
  - after a missed `READ` or a failed `POSITION SET`, `STREAM` starts at the next new packet on a connection that
    never had a position, and from the old position on one that had;
  - `EARLIEST` and `AFTER` skip their first match;
  - a lapped reader is skipped forward without notice;
  - `MATCH` filters `STREAM`, not `READ`;
  - an unmapped ring's crash rolls back to the last clean shutdown and hands ids out again;
  - a mapped ring's crash keeps the newer slots behind the old header: earliest id above latest, lost packets
    readable and then reissued in place, a `STREAM` from the earliest waiting for the next write and then out of id
    order (E4);
  - a reset starts ids at 1, and a resize resets pkttimes;
  - a caught-up reader waits up to 1 s, and a client silent for its first 10 s is dropped;
  - every `WRITE` error disconnects.

  It can also inject faults: a drop in mid-packet, a stall, a refused connection.

- **`FakeWriter`.** Builds signed envelopes with a test writer key around frames signed with the station fixture keys
  (`test/fixtures/canticle/frame-v2-candidates.json`, as `test/canticle-listener.test.ts` does). It keeps its
  `rec_seq` in step with the fake host daemon in `canticle-host.ts`, and names that daemon's run. It has switches for
  holes in `seq`, `key_seq` or the control sequence, queue drops by reason, retries, bad signatures, run numbers,
  `prev_reserved_through`, `tick` heads, a second writer, retract packets, the `resurfaced` flag, `offset_ms`, and
  runs with or without `bye`.
- **A conformance script,** outside `pnpm check` like `tools/chaos`, that runs the same scenarios against a real
  ringserver 4.5.4 built in a temp dir. It keeps the fake's quirks true to the server. Appendix A is its first run:
  E1 to E3, then `kill -9` after a wrap in both ring modes (E4), the write gate and every `AUTH` failure (E5), and
  nonlocal refusal (E6).

Each case asserts the counters, what `hear` shows and what is pushed:

1. **Cursor.** Process N packets, checkpoint, restart: the reader resumes at N + 1, nothing is pushed twice, and no
   gap is reported.
2. **Crash between the journal and the checkpoint.** Replay changes nothing: a PLUCK stays sticky, live rows are not
   duplicated, and a predecessor stays superseded even when its supersessor has expired by the time of the replay
   (TTLs that differ). Purges still hold although `hear(…, h)` runs behind `tick(now)`.
3. **Rebuild from the store.** With the ring wiped, items come back from the live rows. Items that expired meanwhile
   are dropped and counted, and the others show `late: … (replay)`.
4. **Store failure.** While the store fails, the connection stays open, nothing surfaces and no checkpoint moves. The
   first checkpoint after recovery rewrites the live rows, and a later restart rebuilds every live item.
5. **A gap for one key.**
   - One `ring_gap` for that key with the exact count; that key's items heard before it are hidden, and other keys'
     stay shown.
   - The witness confirms an item only once the consumer has read up to `W`. With a retract still queued on the
     socket for a PLUCK lost in the hole, the item stays hidden, and the retract then removes it.
   - When the consumer can't confirm, a snapshot is requested on a second connection. The main connection sees no
     rejoin, and in `shadow` the production path loses nothing.
   - Absence from a complete snapshot removes an item.
   - An unconfirmed item leaves at expiry, counted as `off_air_unpushed` and `hidden_expired`; a confirmed one is
     pushed late.
6. **Laps and refills.** After a lap (the fake skips forward), the reader refills from what the ring still holds; a
   fully refilled hole reports no loss. A retry after a disconnect that arrives behind later packets fills its
   missing `key_seq` rather than being taken as a duplicate.
7. **Writer restarts.**
   - With or without `bye`, the previous run's items are hidden until `resurfaced` re-appends confirm them.
   - Without `bye`, `writer_restarted_without_bye` is reported, with the tail unknown (case 23).
   - In a higher run, a key first seen at `key_seq` 5 is a `ring_gap` of exactly 4 for that key; a run first seen
     past its `hello` reports that whether runs went by is unknown.
8. **Runs.**
   - Replayed packets of a lower run, ended or not, count as `stale_run` and change nothing, and nothing goes blank.
   - Two interleaved writers raise `two_writers`, and the bound run's content still flows (case 27).
   - A lower run bound to the live daemon run is accepted as `run_regressed`, read early or late (case 25).
9. **Cold start.** The reader joins the first run anywhere. `ring_joined_late` lasts until a complete snapshot lists
   nothing the ring path lacks.
10. **A wrap while the reader is stopped.** `ring_overrun`, a hole counted from the re-read, then
    `READ EarliestPacketID` and `STREAM`. A `READ` that misses is retried after `INFO STATUS`, never followed by
    `STREAM`. An evicted cursor whose successors survive reports no loss.
11. **Ids handed out again after a crash, and resets** (the fake rolls back). `ring_reset`; known (run, seq) pairs are
    skipped and holes are counted; ids planted with flag `I` cause no hiding on their own. Out-of-order ids are
    case 24.
12. **Duplicates.** The same (run, seq) twice (a writer retry) is admitted once and counted as `ring_duplicate`. The
    same identity in two runs is pushed once.
13. **Retract packets.**
    - A mirrored retract removes a live or hidden item.
    - A held item that is retracted before release never appears.
    - A plucked item that moved a mark retracts the older value.
    - A quarantine retracts the key's items.
14. **Expiry.**
    - A packet expired on read never reaches the live set, `hear` or a push, and counts as `expired_on_read`.
    - One with 2 s left is gone after 2 s (test EM-01, RFC:1788).
    - A `heard_at` in the future is clamped to now. A positive `offset_ms` is used as 0, and one below −60 s as −60 s.
    - An old frame replayed with `heard_at` set to now can't outlive its `expires_at`.
    - A station 30 s ahead is heard; one 90 s ahead is refused and counted.
15. **Trust.**
    - A bad writer signature is dropped and moves no sequence.
    - A stream label that doesn't match its frame is dropped.
    - A bad station signature or unknown key is refused.
    - A packet signed by a writer key the manifest doesn't name for its `writer_epoch` is dropped.
    - After a key is removed from the manifest, its retained packets and live rows are accepted until frond-ear
      restarts with the new file, and refused after it (§7).
16. **Landing state.**
    - A daemon MUTE empties `hear` of ring items and holds pushes.
    - A ring item whose `rec_seq` is above what the consumer has read stays unshown until the consumer catches up, so
      a MUTE emitted before it always wins.
    - During a host socket reconnect nothing is pushed.
    - A writer `tick` naming another daemon run holds everything.
    - An open breaker holds pushes.
17. **Backpressure.**
    - With no session attached, delivery holds; the reader keeps reading, its cursor advances, and memory stays
      bounded.
    - Drops from `bufferPerStream` are counted.
    - 100 000 packets from one key over the listener's quota are refused as `over-quota`, and memory stays bounded.
      (The flood is case 22.)
    - Hidden rows are evicted before live ones.
18. **Ring unavailable.** `ring_unavailable`, backoff, and a line in `hear`. Recovery from the cursor; holes from
    writer drops show as `ring_gap`.
19. **Custody.** A push from the ring writes claimed, offered and echoed rows with the same identity and digest as the
    socket path, plus the origin and `run:seq`. A `hear` exposure does the same.
20. **Shadow.**
    - The same frames through `canticle-host.ts` and the fake ring count as `both`.
    - An injected socket drop gives `ring_only`, and an injected writer skip gives `socket_only`.
    - A station with a positive δ̂ gives `expiry_delta`.
    - Different manifests give `manifest_mismatch`.
21. **Keepalive.** The first command goes out within 10 s, and an idle reader sends `ID` within `ClientTimeout`.
22. **The flood test (acceptance; #116 amendment 4).** Against the fake, and in the conformance script against the
    real build: an untuned key writes at line rate, and forged packets (bad writer signatures) arrive at line rate
    under one tuned key F's stream id, while a quiet tuned key Q writes one item a second.
    - Every one of Q's items is admitted within 2 s of being written, and Q reports no gap.
    - Verifications per second stay within the budget, and memory stays bounded.
    - The untuned packets cost no verification: never sent under `MATCH`, counted as `untuned` without it.
    - F counts `over_cap`, its earlier items are hidden and reported, and no other key is hidden.
    - Run with and without `MATCH`, with retention sized for the flood; a lap, if one happens, shows as Q's counted
      loss, never as silence.
23. **A crash with an unknown tail** (🌫).
    - The reader reads run R to seq 10; the fake ring loses 11 to 20 in a crash; the writer restarts as S, whose
      `hello` names R. The report is `writer_restarted_without_bye` with `run_tail_unknown` (R, last read 10), never
      an exact count, and R's items are hidden.
    - With `prev_reserved_through` 4 096 the tail is `at_most` 4 086. With the socket having shown the records that
      11 to 20 mirrored, it is `at_least` their number.
    - A `hello` naming a run the reader never saw reports `runs_absent`.
    - Repeated with a frond-ear restart between the crash and S's `hello`: the persisted witness gives the same
      report.
    - Alongside case 5's within-run holes, which stay `exact`.
24. **Out of order after a wrap** (🍃).
    - The fake reproduces E4: a crash of a full memory-mapped ring, after a lap and without one.
    - Earliest id above latest is reported as `ring_reset`. A cursor packet that is still readable validates.
    - A `STREAM` that waits, then delivers ids out of order, is accounted by (run, seq) and `key_seq` with no false
      hole, duplicate or confirmation.
    - Packets later reissued under the same ids fail digest validation at the next resume.
    - The conformance script repeats `kill -9` after a wrap with `MemoryMapRing 1` and `0`, and checks that `0` rolls
      back cleanly.
25. **A fresh `hello` replayed** (🌫).
    - The writer starts twice, 10 s apart: runs R1 < R2, naming daemon runs D1 and D2. A replay of R1's `hello`, or
      a `tick`, 5 s after R2 started (inside the 30 s freshness window an earlier draft had) is `stale_run` and
      changes nothing.
    - A regressed run R3 < R2 whose `hello` names the live D3 is accepted as `run_regressed` when read 1 s late and
      when read 10 minutes late.
    - With the host socket down, R3 waits, and is decided once the socket reports D3.
26. **One key's gap while other keys flow** (🍃's H1).
    - With keys A, B and C live, one of A's packets is lost. Only A's earlier items are hidden; B's and C's stay
      shown, and their new items are pushed on time.
    - A quiet key D's lost last packet shows as a hole when the next `tick` carries D's head.
    - A `retract` lost on the ring but seen on the host socket hides its item at once.
27. **Blind states** (🍃's H2).
    - A second writer with a higher run naming another daemon run: the bound lower run stays current, `two_writers`
      and `foreign_run` are reported, and health is `degraded`.
    - A current run that hasn't named the live daemon run for three intervals is `ring_blind` (`run_unbound`) in
      `ear_status` and `hear`, and clears when a bound run appears.
    - Two runs bound to the same daemon run are blind until one has sent nothing for three tick intervals.
    - In each, health never reads `ok` while nothing new can be shown.
28. **The write gate and `AUTH`** (🌫's Q-S2; conformance script, E5 and E6).
    - Without `AUTH`, `ID` shows no `WRITE`, and a `WRITE` is refused and disconnected.
    - On a fresh connection, a helper timeout, a non-zero exit or malformed JSON leaves no write.
    - On an authorized connection, each of those leaves write in place, so revocation is by disconnecting.
    - A stream pattern that fails to compile replies `ERROR`, with write granted.
    - An `AuthCommand` without arguments crashes the pinned build on the first `AUTH`.
    - A nonlocal peer is closed before any reply, and `INFO CONNECTIONS` is refused to an untrusted local client.
29. **Caps over their limits.**
    - A ninth missing range for a key merges the two oldest, a late fill inside the span is processed, and the count
      becomes `at_most`.
    - A seventeenth run retires the oldest, with its tail unknown.
    - A live table full of live rows refuses new items as `live_overflow`, with health `degraded`; no key holds more
      than 512 rows.
    - After an outage, one busy key's backlog overflows its queue: the excess is skipped, then refilled on the second
      connection, and nothing is lost while the ring still holds it.
30. **Hidden items across a restart.** frond-ear restarts with items hidden; their watermarks reload, and the witness
    confirms them as before.
31. **Shadow window.** At 60 frames a second for an hour the window holds without overflow; at its cap, comparison
    pauses as `shadow_incomplete`, and no false `socket_only` is counted.
32. **Writer queue** (with the binary-canticle owners' writer). Drops by queue cap and by age leave per-key holes, and
    `tick` counts them by reason; `accepted` never includes a dropped packet.

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
  (RFC:2195). Nor could it bind runs to the daemon's incarnation as §4.3 needs.
- **Q-B4.** Are W1 to W9 and §3.2 workable? 🍃 finds them workable once the per-key subsequence lands and the first
  hop is declared lossy; both are now in (W9, §1.1). The asks:
  - append on surfacing, and held items only on release;
  - `resurfaced` re-hearings flagged;
  - retract packets mirroring record v1, under the target item's stream id;
  - control-class items never;
  - each packet carrying the `rec_seq` of the record it mirrors, and its `key_seq`;
  - `tick`'s per-key heads, and the daemon run in `hello` and `tick`;
  - W3's queue caps, and W5's sequence reservation with `prev_reserved_through`.
- **Q-B5.** 🍃's pick is now the proposal: the owner-signed manifest names the writer's public keys by epoch, rotated
  with an overlap, and envelope byte 7 names the epoch. Open: the manifest schema, and how the daemon gets its
  writer key.
- **Q-B6. Answered by 🍃:** no beacons in the ring; `tick` carries per-key heads instead (W6). They witness tails lost
  at the writer or in transit, not in a ring rollback (§4.4).
- **Q-B7.** Should there be a reliable binding (station to ring, or relay to ring) for high-rate signed streams that
  can't go by reference? It would need an RFC amendment alongside §11. It is also where recovered streams would go
  (§1.1).
- **Q-B8.** Should control frames (MUTE, §10.6) go in the ring, so readers on other hosts can honour them?
- **Q-B9.** Should the manifest declare each stream's axes (shape, time, loss) and its retention class, so that a
  reader knows which lane carries it (§1.1)?

**For 🍃 frond-gloss:**

- **Q-G1.** Do you agree there should be no automatic content fallback when the ring is down (§7)?
- **Q-G2. Answered by 🍃:** hide and confirm, now per key, with the blind state in health. It still needs the socket
  consumer to keep `frame.sha256`, expose its last `rec_seq`, keep its recent retracts and the witness set (§4.4),
  and a second, short-lived connection for snapshots.
- **Q-G3.** Expired retained packets never reach a session. Or should there be a pull tool (a `canticle_replay`, with
  custody path `replay` and each item labelled expired)?
- **Q-G4.** Should the mute for catch-up records apply at take-in, as for join snapshots today, or at hearing time?
- **Q-G5.** Are custody's origin and `run:seq` fields worth the schema change?
- **Q-G6.** Are §4.6's cap defaults right (256 packets and 256 KiB queued per key, 8 MiB in all, 2 000
  verifications a second), and should an over-cap skip hide its key until refilled, as here, or only be counted?

**For 🌫 silas:**

- **Q-S1. Decided:** an IPv4 listener, `AcceptIP 127.0.0.1/32`, `WriteIP` and `TrustedIP` unused, no host firewall
  (🍃's pick; figs ruled out LAN firewalls on 2026-11-15). Nonlocal refusal and refusal of an unauthenticated local
  `WRITE` are shown in E5 and E6, and are conformance cases (§9, case 28). Your S1 candidate included a firewall.
  Open: is the residual acceptable for a same-host shadow? ringserver binds every IPv4 address, so the port completes
  a nonlocal handshake before closing it (E6), and any local process can hold connections against `MaxClients` (§7).
- **Q-S2. Answered by 🌫, and confirmed in E5:** start from no write, test helper failures and re-`AUTH`, and never
  revoke by a failed `AUTH` (§2). Open, for the fork's owner: an `AuthCommand` without arguments crashes the server
  on the first `AUTH`, and a stream pattern that fails to compile replies `ERROR` while granting write. Patch the
  fork, or keep the workaround (an argument, and no patterns)?
- **Q-S3. Decided for version 1:** `MemoryMapRing 0`, which rolls back cleanly (E4). No periodic-header patch: on its
  own it doesn't establish crash durability (🌫); packet, header and stream-index consistency and flush ordering
  would each need their own proof. Open: power loss, since nothing syncs (§7); RAM and stop time at size; the
  installed ring size after the shadow experiment (1 GiB is a candidate, not a decision); and who owns the systemd
  unit.
- **Q-S4.** Lanes (b) and (e) stay as RFC §18.3 has them, for dashboards, on their own instance. Does anything here
  conflict with `bc:spike/silas-seedlink-mapping.md`?

## Appendix A. Local experiments (2026-11-22)

The experiments were throwaways, run on loopback only, and touched no live system. ringserver 4.5.4 was built from
the karmaterminal fork at `2df558c` in a temp dir. The first run (E1 to E3) was configured with
`AcceptIP 127.0.0.1/32`, `WriteIP 127.0.0.1/32`, `ListenPort <free port> DataLink IPv4`, `RingSize 1M` and
`MaxPacketSize 1280`, which gives 746 slots of 1 400 B. The client was a zero-dependency DataLink client in about 100
lines of Node.

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

E3's `kill -9` cases all ran on a ring that had never filled. A second run, for this revision, used the same build
(aarch64, glibc 2.39) and a new client, one fresh temp dir per scenario. E4 used the first run's settings with
`MemoryMapRing` set per row. E5 and E6 used `MemoryMapRing 0`, `WriteIP 192.0.2.1/32`, `TrustedIP 192.0.2.1/32`,
`AuthCommand <helper> canticle` and `AuthTimeout 2`, with a throwaway helper whose reply depends on the password.

```sh
node crash.mjs build/ringserver <dir> 1|0 <scenario>   # E4: write, TERM, restart, write, kill -9, restart
                                                      #     scenario: full_wrap, full_nowrap or notfull_wrap
node auth.mjs build/ringserver <dir> <helper> <addr>  # E5, E6; addr: a non-loopback address of this host
```

| #   | What was checked                                                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E4  | A full ring (255 to 1000) stopped cleanly, then 1 000 more (1001 to 2000, past a lap) and `kill -9`; memory-mapped | `EarliestPacketID` 1747, `LatestPacketID` 1746. Every slot still answered `READ`, 1255 to 2000, including the 254 packets the crash lost (1747 to 2000). A `STREAM` after `READ 1747` got nothing until the next write. The next 5 writes got ids 1747 to 1751 again, in place. A `STREAM` from 1752 then delivered 1753 to 2000, then 1255 to 1751: out of id order. |
| E4  | A full ring stopped cleanly, then 50 more (1001 to 1050, no lap) and `kill -9`; memory-mapped                      | Earliest 1001, latest 1000: the same pattern without a lap. A `STREAM` from 1006 delivered 1007 to 1050, then 305 to 1005.                                                                                                                                                                                                                                            |
| E4  | 100 packets stopped cleanly, then 1 000 more (101 to 1100) and `kill -9`; memory-mapped                            | Earliest 747, latest 846: in order, but a window the clean stop never held (it held 1 to 100). Packets 847 to 1100 were still in their slots, unseen, and were reissued from 847.                                                                                                                                                                                     |
| E4  | The same three with `MemoryMapRing 0`                                                                              | Each came back exactly as its clean stop left it (255 to 1000, 255 to 1000, 1 to 100), in order. The next ids were 1001, 1001 and 101, again.                                                                                                                                                                                                                         |
| E4  | `READ` of every id across each crashed ring                                                                        | Every packet present was found. With earliest above latest, the id search scans back from the latest instead of bisecting (`rs:src/ring.c:1887-1954`), so the binary-search miss 🍃 inferred didn't occur in these runs. The disorder showed in `STREAM` instead.                                                                                                     |
| E5  | No `AUTH`                                                                                                          | `ID` without `WRITE`; `WRITE` → `ERROR`, and disconnected                                                                                                                                                                                                                                                                                                             |
| E5  | `AUTH` on a fresh connection: accepted, denied, helper exit 1, helper timeout, malformed JSON                      | `OK` and write for the first; `ERROR` and no write for each of the other four                                                                                                                                                                                                                                                                                         |
| E5  | The same failures as a second `AUTH` on an authorized connection                                                   | `ERROR`, and write kept: the next `WRITE` succeeded each time. A valid reply without write (denied, or connect only) did clear it.                                                                                                                                                                                                                                    |
| E5  | A reply granting write with a stream pattern that fails to compile                                                 | `ERROR … Error performing authentication`, and write granted, on a fresh connection and on a re-`AUTH`                                                                                                                                                                                                                                                                |
| E5  | `AuthCommand <helper>` with no arguments                                                                           | The server crashed (SIGSEGV) on the first `AUTH`. Under gdb, `posix_spawn` had a null argument vector (`rs:src/auth.c:483`; `rs:src/config.c:3428` builds one only when there are arguments).                                                                                                                                                                         |
| E6  | A connection from this host's non-loopback address                                                                 | TCP connected, then closed before any reply; logged `Denying connection not in accept list`                                                                                                                                                                                                                                                                           |
| E6  | `INFO STATUS` and `INFO CONNECTIONS` from an untrusted local client                                                | The status carried the packet id range, without the thread list. `CONNECTIONS` → `ERROR`, and disconnected.                                                                                                                                                                                                                                                           |

What the experiments settle for the design:

- A packet id can't serve as a cursor on its own (E3), and after a crash of a memory-mapped ring it says nothing
  about order either (E4). pkttime is checked only to the second (`rs:src/dlclient.c:509-527`), so it can't tell a
  reused id from the original when both fall in the same second.
- A careless resume or a slow reader loses data with no message (E2); after a successful `READ`, a careless resume
  gives duplicates instead.
- `MemoryMapRing 0` rolls back cleanly; the memory-mapped ring doesn't (E4).
- Write can be gated by `AUTH` from a start with no write, but a failed `AUTH` revokes nothing (E5).

Hence the signed (run, seq) envelope with a per-key subsequence, validating the cursor by `READ`, treating a hole in a
signed sequence as the only loss signal, refilling holes from what the ring still holds, ordering by the envelope and
never by packet id, and keeping what was read in frond-ear's own store.
