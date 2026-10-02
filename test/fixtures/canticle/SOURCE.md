# Vendored binary-canticle vectors

`frame-v2-candidates.json` is copied byte for byte from
`karmaterminal/binary-canticle` at `prototype/canticle-station/vectors/frame-v2-candidates.json`,
sha256 `c917ec669157a46ef9951f8021621647392ea43cecd5c10113a87c4992134d2a`, last changed in
`125f5520a7789da33103301df9482853e04b0e49` on branch `gloss/20261002/a1-trail-seq` (binary-canticle PR #71,
stacked on PR #68; 46 vectors: the post-A1 `stream-entry` with `trail_seq`, the #66 map-key and null cases,
a pre-A1 8-element entry and `b_stream` = 2^60 as `bad-field`). Re-take it from `main` once both PRs merge.

They are **candidate** vectors (RFC-0001 §9.13), produced by the Python spike. `test/canticle.test.ts` runs every case
against this TypeScript port, which is a second, independent implementation. Don't edit the file here; regenerate
it upstream and copy it again. Prettier ignores this directory so the bytes stay identical.
