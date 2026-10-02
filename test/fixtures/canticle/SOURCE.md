# Vendored binary-canticle vectors

`frame-v2-candidates.json` is copied byte for byte from
`karmaterminal/binary-canticle` at `prototype/canticle-station/vectors/frame-v2-candidates.json`,
sha256 `fce58bb800f014286d7c7318c7d8016ba6db1729a7c7680c91692969abd1e2e6`, taken from `main` at
`2254fb8c70101a697087338b1988cf8b91993bb8` (last changed in `60482766180ac3d0adee5748d824fb3bf56f62d5`, binary-canticle PR #71,
after PR #68 and #74; 46 vectors: the post-A1 `stream-entry` with `trail_seq`, the #66 map-key and null cases,
a pre-A1 8-element entry and `b_stream` = 2^60 as `bad-field`).

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
