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
