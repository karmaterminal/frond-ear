# Vendored binary-canticle vectors

`frame-v2-candidates.json` is copied byte for byte from
`karmaterminal/binary-canticle` at `prototype/canticle-station/vectors/frame-v2-candidates.json`,
sha256 `943f77094ffc7e207a9af6de3cccd8d09741fdc997bbcc9fb489c95bfcbcfc63`, identical to binary-canticle `main` at
`95b14c4e09c3855da408f27c8042e46b5513d4f2` (PR #89 merged; verified byte for byte after the merge). 48 vectors: the post-A1 `stream-entry` with `trail_seq`, the
#66 map-key and null cases, a pre-A1 8-element entry and `b_stream` = 2^60 as `bad-field`, and the #72 pair
(`trail_seq = head_seq + 1` accepted as the empty window, `head_seq + 2` as `bad-field`). The previous copy was
sha256 `fce58bb8…`, from `main` at `2254fb8c` (binary-canticle PR #71, 46 vectors).

They are **candidate** vectors (RFC-0001 §9.13), produced by the Python spike. `test/canticle.test.ts` runs every case
against this TypeScript port, which is a second, independent implementation. Don't edit the file here; regenerate
it upstream and copy it again. Prettier ignores this directory so the bytes stay identical.

# Record v1 interop sample

`records-v1-sample.jsonl` is real output of binary-canticle's receptor (`canticle.records.Receptor`), captured from
PR #79 (`gloss/20261002/bc2-record-v1-host-daemon`) at head `6ee47865af98a46a19eaf53271603bd30295945c`, sha256
`ae5b7e469f65ef9741e2b2fe145de71a1f01e615f859aca034d25c9eb4b04ece`. It was produced by driving the `Harness` of that
commit's `prototype/canticle-station/tests/test_records.py` (manifest classes 1, 3, 6, 9 and 42) with, in order: a
named-stream item (`surface`), an item on an unnamed stream (`stream: null`), an item of unknown class 42
(`class: null`), a PLUCK that misses its held target (`pluck_mismatch`, with `class` and `hop` null), a valid PLUCK
(`retract`), and an item over its hop limit (`hop_limit`). The two refused frames carry `sha256` and `bytes` as null:
receipt pointers exist only for a `verified` admission. The run id and `pid` are those of the capture.
`test/canticle-records.test.ts` feeds every line through `RecordConsumer`. Don't edit it here; recapture it upstream.

# Join-snapshot interop sample

`join-snapshot-sample.jsonl` is real output of binary-canticle's host daemon, captured from PR #85 at head
`6c5da21` by `capture_snapshot.py`, sha256 `9bb5de50dacbc67a0f5a9a74c4ad05c9833ebf786445d9894951ed7b8e9f2b64`.
A host-socket connection that sent the join-snapshot request reads: `hello` (`join_snapshot: true`), `landing_state`,
three `snapshot` records at W = 7 whose `entry` is wrapped one level (`{"presence": …}` for station `cael`,
`{"frame": …}` for a surfaced `alarms` item and a surfaced `chatter` item), `snapshot_end` (W 7, count 3, not
truncated), then a live `frame` at rec_seq 8. This settles the entry form as the wrapped `{frame|presence}`.
`test/canticle-join-snapshot.test.ts` feeds every line through `RecordConsumer`. Don't edit it here; recapture it upstream.
