# Review: frond-ear #121 - Exposure Ledger

**Verdict: changes requested**

## Named refs

| Ref | Name / value | Resolved SHA | Local / tracking / server |
| --- | --- | --- | --- |
| Product/base | `karmaterminal/frond-ear` base `main` | `a8e2e5ba1b16adf5ce700265f25a0d210c569608` | local `main`, `origin/main`, PR base: equal |
| Lane/safe branch | `codeagent/fe121-review` | `049bfeaf01d8c5b71513634220b5848e2c974710` | lane, `origin/codeagent/fe121-review`, PR head: equal |
| CI/workflow | `.github/workflows/ci.yml` at PR head | blob `034869da4410914e20dcc19a0e190965865a8d42` | local PR head |
| Presentation | `N/A` | `N/A` | N/A |
| Docs/proof | `docs/runbook.md` exposure section | blob `1e340fc5b0d099224a3c130b0f59cb0756b0d6` | PR head |
| #162 derived ledger | `karmaterminal/binary-canticle` PR 162 head | `452c54336d05048b3e0e2fd83bafb16d98065891` | server: resolved |

The presentation ref is a PR/documentation category; the exact worktree evidence is recorded below. The PR head stayed fixed at `049bfeaf01d8c5b71513634220b5848e2c974710` during review.

## Blocking findings

### 1. Flag-off still creates the new ledger table

**Evidence:** `src/store.ts:594-614` and `src/store.ts:891` unconditionally expand the database schema with `CREATE TABLE IF NOT EXISTS canticle_exposure` and an index, even when `canticle.exposure.enabled === false`. The constructor also executes this DDL in `src/store.ts:603-891`.

The flag-off test at `test/canticle-exposure.test.ts:581-619` only verifies zero rows and absent status fields. It explicitly acknowledges the table remains via `SELECT COUNT(*)`, but it does not compare bytes or schema before/after and does not detect table/index creation.

**Concrete fix:** Make the ledger table creation conditional on the enabled flag or prove byte-identical base behavior without any new migration/DDL in `off` mode. Since `EventStore` currently has no config in its constructor, pass the flag in explicitly or separate ledger initialization from general store construction. Update the test to snapshot the base schema and file bytes for an equivalent run with the flag off.

### 2. Offered writes are not atomic

**Evidence:** `src/store.ts:1615-1633` implements `offerCanticleCustody` as separate statements:

1. `DELETE FROM canticle_claims`
2. `offerCanticleExposure(...)`
3. an update of every `canticle_custody` row

The method has no `transaction()` wrapper. An injected throw after step 1 or 2 can leave the claim, custody and exposure ledger disagreeing. `echoCanticleCustody` is atomic at `src/store.ts:1701-1730`, and the echo test at `test/canticle-exposure.test.ts:407-449` proves that boundary, but it does not cover offered writes.

**Concrete fix:** Wrap the complete offered operation in `this.transaction(...)`, including claim deletion, custody offered fields and ledger phase update. Add deterministic injected-throw tests for both directions of the offered boundary and for a push containing more than one custody row.

### 3. The echo injected-throw test does not exercise a multi-row push

**Evidence:** `test/canticle-exposure.test.ts:407-449` creates one `host.sing(1)` exposure and then installs a trigger on `canticle_custody.e echoed_at`. The trigger aborts the custody update, but only one custody row is present. An SQL trigger or update covering three rows could behave differently, and the test never asserts multi-row atomicity.

**Concrete fix:** Modify the test to push at least two/three sourced records in one batch, assert all custody rows start unechoed, inject the throw on the multi-row custody `UPDATE`, and assert all ledger/custody rows roll back together. Keep the post-fix success assertion for every row.

### 4. Exposure age/count retention does not match custody's window

**Evidence:** `src/config.ts:148-189` gives the ledger `maxAgeMs` default `7 days`, independently of custody. Custody is described in `docs/runbook.md:860-863` as retained for `limits.retentionMs`, default 14 days, and status summaries use a separate one-hour custody window at `src/daemon.ts:395-396`. The ledger default therefore does not match custody's 1-hour view or custody's 14-day store retention.

**Concrete fix:** Name one custody-retention policy and use it for ledger eviction, or document and enforce a concrete relation. The implementation must not silently offer independent age windows. `#162` and custody need to agree on the same retention window.

## Should findings

### 5. Ledger and custody receipts can diverge for offered delivery

**Evidence:** `src/store.ts:1615-1633` is not transactionally composed with `canticle_custody` and `canticle_claims`; `offerCanticleExposure` only updates its own table. This is the same boundary as finding 2 and can leave a partially admitted offered state after process interruption or a SQLite throw.

**Concrete fix:** Covered by finding 2.

### 6. #162 shape has fields that frond-ear cannot know, but the implementation correctly confines or marks unknown ones

**Evidence:** `src/canticle/exposure.ts:226-249` refuses records with no session id, no receiver, no numeric stream id, or no ctype as `PayloadExposure`, rather than inventing values. `src/canticle/exposure-v1.ts:1-83` is a vendored field-for-field type copy. `test/canticle-exposure.test.ts:845-869` proves missing `ctype` stays null and is non-conformant.

No invented `modelSeen` field exists. `echoed` means a session named the whole tokenized batch ID, not payload content or model-seen: `src/canticle/exposure.ts:6-14` and `src/store.ts:1864-1881`. The `sessionId` may be null and holder is separate, as intended for unknown context.

Potential shape concern: `sessionKey: frond-ear:<ear>` is documented as continuing-reader but #162 is described as admitting sub-agent keys. The implementation does not widen or invent a sub-agent identity; it persists exactly `frond-ear:<ear>`. It is not a field invention, but should remain a noted compatibility boundary.

### 7. Ledger growth can exceed `maxRecords` indefinitely for fenced/unknown records

**Evidence:** `src/store.ts:1934-1993` deliberately never evicts fenced or unknown rows and counts over-bound state, while `test/canticle-exposure.test.ts:875-919` proves it. The bound is therefore an alert/retention bound for confirmed rows, not a hard ledger row cap.

**Concrete fix:** If the exposure ledger is required to be bounded absolutely, evict or archive fenced/unknown rows under a separately specified safety rule. Otherwise keep the explicit over-bound warning and document that fence/unknown growth is unbounded until attach churn stops. The current behavior is honest but may violate "ledger growth is bounded."

## Fence ordering and push call-site enumeration

All canticle session-push admission goes through `CanticleDelivery.#push` and `Daemon.pushCanticle`.

- `src/canticle/delivery.ts:1490-1516`: builds `fence` and passes it to `#claim`.
- `src/canticle/delivery.ts:1595-1616`: `#claim` calls `claimCanticlePush`.
- `src/store.ts:1516-1570`: the claim transaction inserts batch/custody/cursor rows and fences the exposure record before `#push` returns to the session connection.
- `src/daemon.ts:784-805`: `pushCanticle` is the sole `CanticleDelivery` session send. It sends only after claim/fence.
- Unsent/released pushes: `src/canticle/delivery.ts:1537-1545` plus `src/store.ts:1520-1545` reconcile to `unknown/unsent`.
- Revert/replay: `src/store.ts:3061-3120` and `src/store.ts:1898-1905` mark reverts unknown and re-admit records under a new push/fence.
- Crash/first attach: tests and `revertUnconfirmed` use the same unknown reconciliation.
- Coverage-only pushes: no record source row is fenced; there is no exposure payload to ledger.

No bypassed canticle push call site was found. The patch-revert negative control removing the fence insert made the "fence then offer" suite fail at handover with `0` ledger rows; restored code passed.

## Five claimed fixes: patch-revert proof

1. **Fence ordering:** pre-fix negative control removed the fence insert from `claimCanticlePush`; the focused suite failed, including `atHandover.length: 0` instead of one. Restored and passed `16/16`.
2. **Atomic echo:** with the successor test, `echo is atomic` passed and a pre-fix-style no-transaction control would leave ledger/custody disagreement. The test currently uses only one custody row; see blocking finding 3.
3. **No invented ctype:** focused test passed for `ctype: null` and no conformant record. Its pre-fix claim can be tested by reverting `sourceBody.ctype` normalization to a synthetic `1`; the candidate assertion fails.
4. **Over-bound warning:** the focused test passed and counts repeated prune warnings. Patch-reverting over-bound detection makes it fail because no warn/counter/reason is recorded.
5. **Flag off:** focused test passed for default config, zero rows and absent `ear_status` field. It does not detect new table creation; see blocking finding 1.

## Secrets

No key material, bot token, delivery token or issuer secret is persisted in the ledger implementation. Search and credential scan found no credential pattern in the candidate. The ledger stores hashes, provenance and envelope fields only. The `echo_kind` and session IDs are identity metadata, not secrets.

## Validation

- `pnpm typecheck`: passed.
- `pnpm test`: passed at full suite completion.
- `pnpm scan:credentials`: passed.
- `pnpm check`: blocked at the `format:check` gate because pre-existing lane artifact `BRIEF.md` fails Prettier; no source format change from this review is implicated.
- Focused exposure suite: `16/16` passed.
- Patch-revert fence control: failed on rejected behavior and was restored.
- Live service: not attached/restarted.

## Untracked or ignored files

- Untracked: `launch.sh`, `BRIEF.md`, `console.log`
- Ignored: `node_modules/`
- No untracked/ignored PR-branch file is included in the candidate diff.
