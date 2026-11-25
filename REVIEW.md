# PR Review: frond-ear #127

## Named refs

| Ref | Value |
| --- | --- |
| Product/base | PR head `5f764ac5c90b110cc405eeb876f052e2e48cec35`; base ref `main`; base SHA `405e49183f76ed03066fe4d93bd4f75c2cdcc541` |
| Lane | `codeagent/fe127-review` at `405e49183f76ed03066fe4d93bd4f75c2cdcc541` unchanged, published to `origin`; later review docs are not part of PR |
| CI/workflow | PR CI: N/A locally under the workorder; PR diff test executed with `node --test --test-concurrency=1 test/canticle-exposure.test.ts` |
| Presentation | N/A |
| Docs/proof | `REVIEW.md` in this lane worktree |

Lane identity is anchored to the unchanged lane branch as the PR head is read-only.
Resolved equality: PR head equals `origin/pr-127`; lane branch head equals base at publication
`405e49183f76ed03066fe4d93bd4f75c2cdcc541`; the base ref resolves to `origin/main`;
lane does not track the PR head and no lane changes are pushed to the PR.

## Diff scope

The PR diff is only:

- `src/canticle/exposure.ts`: changes `ExposureReader.lifecycleRevision` from attach-generation
  (`attach:<generation>`) to Claude session identity
  (`claude-session:<sessionId>` or `claude-session:unknown`).
- `test/canticle-exposure.test.ts`: updates the existing reader expectation and adds a direct
  reattach/new-session/unknown-session regression test.

No presentation, docs, config, or presentation files are changed.

## Invariant and owner

**Invariant:** exposure custody must survive a detach/reattach only while the ear remains under
the same resumed Claude Code context. A holder change, a new Claude session id, or an unknown
holder must create a different or fail-closed reader; exposure must not be transferable to or
laundered under a different holder.

The ownership boundary is `exposureReader()` in
`src/canticle/exposure.ts:156-167`, used when a canticle push is fenced in
`src/canticle/delivery.ts:1650-1660`. `exposureReader` combines ear key
`frond-ear:<ear>`, the live session id, and a lifecycle revision derived from that session id.
The reader is attached to the ledger record at handover; `conformant()` then fails closed for
`sessionId === null || ""` at `src/canticle/exposure.ts:226-240`. Holder custody is separately
stored as `known | unknown | in-doubt` and never inferred from message text.

## Regression proof

- **Fixed/SHA `5f764ac5c90b110cc405eeb876f052e2e48cec35`:** the focused exposure test
  suite passed 18/18.
- **Rejected/base SHA `405e49183f76ed03066fe4d93bd4f75c2cdcc541`, test patch only:** the
  suite failed 2 tests. The existing fenced reader expectation saw `attach:1` instead of
  `claude-session:<session>`; the new test saw `attach:2` differ from `attach:1` for the
  same session. This is the deterministic pre-fix negative control for the expected reattach
  regression.
- **Fixed replay:** the same suite passed 18/18, including same-session generation change
  staying identical, a different session changing the revision, and no session id becoming
  `claude-session:unknown`.

## Sibling and fail-close paths

- **Shim reattach/reconnect:** the session id is preserved by the attached session object and
  attach generation changes independently. The fixed reader ignores attach generation, so
  reattach remains one reader. Existing `/clear` handling changes `sessionId` on the shim
  (`test/canticle-exposure.test.ts:379-400`) and is therefore a new reader.
- **Ear takeover:** `turnSession()` and `attachEar()` update the holder/session identity
  (`src/daemon.ts`, `src/store.ts`); a second session id produces a different
  `lifecycleRevision`, and echo validation also rejects a foreign session.
- **Daemon restart:** the disk record retains the old reader. A crash/restart test reconciles
  an unfinished fence to `unknown` and preserves it rather than clearing it
  (`test/canticle-exposure.test.ts:531-606`). A restarted same Claude session is not converted
  into a new session id merely by process restart.
- **Compaction/resume:** the PR comments and custody tests treat compaction and resume as the
  same session/context. The reader is stable for the same session id. `/clear` or a different
  resume session id is different.
- **Unknown holder:** no session id produces `sessionId: null` and
  `claude-session:unknown`. `conformant()` rejects the record; the ledger keeps it but never
  presents it as a `PayloadExposure`.
- **Persistence/rollback/partial failure:** the exposure record and reader are fenced with
  the claim. Existing tests cover offer/echo/retention atomicity and crash-durable unknown
  fences. The PR itself does not alter persistence or transaction mechanics.

## Findings

No blocking or should-fix finding in the two-file diff.

Potential nit: `exposureReader()` retains the `generation` parameter even though the fixed
implementation no longer uses it. This is not a behavioral bug; it preserves the call shape
and the direct test's ability to prove attach-generation independence. Removing it would
require a wider call/API cleanup and is not necessary for this fix.

## Verdict

**Approve.** The fix is narrowly scoped and addresses the stated lifecycle error: attach
generation treated a same-context reattach as a new reader and could produce an empty-ledger
generation. Session id now supplies the correct stable context identity, while different
session ids and unknown ids fail closed or remain distinct.

GitNexus tooling gap: no frond-ear index was available from the local installed GitNexus
inventory, so this review used direct diff, owner/caller, sibling test, and negative-control
analysis rather than GitNexus graph evidence.
