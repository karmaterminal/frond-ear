# Review: frond-ear#124 — wake-class gate

**Verdict: REQUEST CHANGES.** The core gate, alarm capability, grant authority, TTL, restart behavior, and regression negatives are largely implemented, but a manifest capability can be bypassed by an owed local-omission note that wakes on the configured-class cadence. The forward-clock behavior also lacks an explicit forward-step/correction regression and should not be treated as fully proved.

## Named refs

| Ref category | Value | Local SHA | Tracking / server SHA | Equality |
| --- | --- | --- | --- | --- |
| Product/base ref | `main` plus the required merge point | `885e597e45f06470f415157391048db340c08c24` | origin/main / PR base SHA: `885e597e45f06470f415157391048db340c08c24` | Equal |
| Safe lane branch ref | `codeagent/fe124-review` | `44a4801fc2305187383a63b49447b50b2f795c91` | origin/codeagent/fe124-review: `44a4801fc2305187383a63b49447b50b2f795c91` | Equal |
| Candidate/head ref | PR `#124` head `codeagent/fe-wake-class-gate` | `44a4801fc2305187383a63b49447b50b2f795c91` | GitHub API head SHA: `44a4801fc2305187383a63b49447b50b2f795c91` | Equal |
| CI/workflow ref | N/A — workorder requires this repo's `pnpm check` | N/A | N/A | N/A |
| Presentation ref | N/A — no PR/comment posting requested | N/A | N/A | N/A |
| Docs/proof ref | `docs/runbook.md` in the candidate | Candidate blob; review evidence at `44a4801` | Candidate server branch at `44a4801` | Equal |

The lane was published before evidence: `origin/codeagent/fe124-review` is unchanged at the candidate SHA.

## Blocking

### 1. Owed coverage cadence can wake without re-running the manifest capability gate

**Evidence**
- The record gate is centralized in `Boundary.gate()`: it checks manifest capability first, then configured/granted class, in `src/canticle/delivery.ts:925-940`.
- `#passOver()` calls that gate for live and waiting records in `src/canticle/delivery.ts:1306-1317` and `src/canticle/delivery.ts:1228-1238`.
- The owed-note cadence in `#noteCadence()` is separate: it checks only that a key is allowlisted and the station is in a pushing mode, in `src/canticle/delivery.ts:1486-1518`.
- `#owes()` is also separate and checks only configured class membership, not manifest capability or an active grant, in `src/canticle/delivery.ts:2088-2094`.
- A waiting item that becomes `not_capable` is removed and recorded as a local omission in `src/canticle/delivery.ts:1228-1238`; `#miss()` creates that omission and its `owed` flag in `src/canticle/delivery.ts:2119-2145`.
- `#passOver()` has already removed the record itself, but a coverage push can still be scheduled solely through `#noteCadence()` and `#owes()`.
- Existing tests cover a capability-negative live alarm and host capability rejection, at `test/canticle-wake-class.test.ts:94-129`, but do not build the coverage-only wake / capability-change sibling case.

**Exact invariant.** A wake is receiver-local and gated: every push/turn start for canticle content, including an owed coverage or fold note, must satisfy current manifest capability and class policy. A configured alarm/advisory that is no longer manifest-capable must not turn a local-omission note into a wake.

**Risk.** If a waiting record is later judged `not_capable` and `#owes()` still sees the key/class in configured policy, the local-omission note may self-schedule a canticle push even though the record is incapable of waking. This is a turn-start bypass around the centralized gate.

**Concrete fix.**
- Pass the current `Boundary`/manifest view into `#owes()` and `#noteCadence()`, or add a shared `canOweNote()` helper that explicitly applies key allowlist, delivery mode, manifest capability, and whether the note reason is itself eligible.
- Make capability/withheld notes never owe a push of their own; only the existing next push may carry them.
- Add a deterministic test where a configured key/class first waits, then capability removal/revocation makes `#passOver()` return `not_capable`; assert no push is sent, `ear_status` has `not_capable`/no unsolicited coverage wake, and a later legitimate alarm push carries the local omission only.

## Should

### 2. Forward-clock and forward-correction cases are under-specified by tests

**Evidence**
- Grant expiry is stored as `now + ttlMs`, and the high-water mark is set to `grantedAt`, in `src/store.ts:2153-2178`.
- The judge discards a grant whenever `now < max(grantedAt, seenAt)`, in `src/canticle/delivery.ts:2097-2127`.
- A held grant is marked seen at the newest observed `now`; the mark never moves down, in `src/store.ts:2179-2185`.
- The mid-run and restart backward-step tests exist, at `test/canticle-wake-class.test.ts:386-435` and `:456-508`, but there is no test for making a grant under a stepped-forward clock followed by correction (forward or backward).
- The runbook documents the one-poll and downtime-step limits but does not prove the forward correction sibling, at `docs/runbook.md:756-773`.

**Exact invariant.** Grant duration must remain bounded by the TTL and never become broader on a clock jump or correction.

**Concrete fix.**
- Add tests for: grant at a stepped-forward clock, immediate correction to real time, and then no wake past/near the real-time TTL; a grant whose grant/expiry values were injected beyond 24 hours remains discarded.
- If wall-clock jumps must have defined behavior, persist an explicit monotonic/clock-revision rule rather than relying only on `seenAt`; at minimum fail closed for a grant whose creating/evaluated clock is incompatible with the corrected clock.
- Record the result in ear status/logging and runbook so the existing honest-limits text matches the implementation.

### 3. `wake_withheld:<class>` coverage is complete in the normal gate but not every unknown-class/folded overflow edge was shown in a dedicated negative

**Evidence**
- Unknown classes are sanitized to `unknown` in `classToken()`, in `src/canticle/delivery.ts:127-136`.
- Per-class counting and local omission rendering are implemented in `src/canticle/delivery.ts:127-128` and `:2832-2850`.
- `ear_status` exposes counts, `docs/runbook.md:904-913`.
- Tests cover ambient, advisory, alarm, and live overflow, but an unknown/unregistered class should be rejected earlier by receiver config/fixture or is not admitted; the no-unbounded-counter property follows from `CLASS_BY_NAME` sanitization.

**Concrete fix.** This is not a merge blocker, but retain a dedicated test for an unregistered station-supplied class and assert both that it cannot be granted/wake and that it counts as `wake_withheld:unknown` once, rather than growing one key per station/text.

## Nits

### 4. Review lane has one unrelated untracked file

`launch.sh` is untracked and is not part of the candidate diff. It must remain out of named staging and the commit. The branch also has ignored `console.log` and `node_modules`; neither is changed by this review.

## Wake path audit

1. **Immediate push, report/digest, refresh/dedupe.** All pass through `CanticleDelivery.poll()` and `#passOver()` before waiting/push, in `src/canticle/delivery.ts:1120-1265` and `:1306-1317`.
2. **Owed held/folded/budget/off-air notes.** Folded owed-note cadence is scheduled in `#noteCadence()`, `src/canticle/delivery.ts:1486-1518`. Coverage rendering is centralized, but its cadence must re-run the full record gate (see Blocking 1).
3. **Live overflow/coverage.** Live overflow notes never wake from their own unknown/counted line; a drop is represented as a local omission and rides an existing push, in `src/canticle/delivery.ts:1330-1340` and `:1468-1490`.
4. **Join snapshot/reconnect/resurfaced replay.** These records enter the same live view and `poll()`/`#passOver()` path; no separate push bypass was found.
5. **Catch-up/reconnect Discord delivery.** The shim does not directly infer canticle wake eligibility: canticle pushes are claimed and sent from `CanticleDelivery` and `pushCanticle()`, `src/daemon.ts:756-816`, then revert/offer state is managed in `src/daemon.ts:1570-1595`. It is same lane, with no bypass found.
6. **Letters.** Letters create their own session notifications in `src/letters.ts:218-315`, but no canticle record or wake key/class is carried; there is no canticle wake gate bypass.
7. **Schedules/wakes.** GitHub/schedule wakes are separate persisted wake notifications in `src/wakes.ts`; they do not carry canticle record classes or invoke canticle delivery.
8. **Coverage-only pushes.** A coverage-only push is sent only through the centralized delivery renderer and batch claim path, `src/canticle/delivery.ts:2474-2485`; the cadence issue in Blocking 1 remains.

## Decision 1 checks

- **Every wake path:** no separate direct canticle wake path was found. Normal records and reconnect replay go through `CanticleDelivery`; owed notes have a partial-gate concern documented above.
- **Alarm capability:** implemented in `Boundary.gate()` and the receptor manifest capability view. The listener refuses a class not in the manifest before delivery, `src/canticle/listener.ts:690-697`; the host admits only verified capability. A real manifest negative test passes at the candidate.
- **Grant authority:** `wake_grant` requires the ear holder and a known session ID, and only stores daemon-side grant rows. Station text cannot create a grant. TTL, class, stream, and 24-hour bounds are enforced in `src/daemon.ts:4794-4873`.
- **Seat/stream scope:** grants are keyed by ear, station, stream, and class in `src/store.ts:858-865` and `:2153-2178`; rebind discards another session's grant.
- **Restart and clock:** persisted high-water marks reject a backward clock at restart and mid-run. The 1-poll and downtime-lower-than-stepback limits match `docs/runbook.md:756-773`, but forward/correction behavior lacks a dedicated test.
- **Counting:** `wake_withheld:<class>` is counted for gate rejection and visible in `ear_status`; delivery remains via `hear` and no custody row is written. Normal withheld records do not wake or wait.
- **Migration:** bare `wakeKeys` is alarm-only and migration is documented in `docs/runbook.md:726-736`; existing scribes/listed classes that relied on ambient/advisory now need explicit class entries/grants.
- **Tests:** candidate `pnpm check` passed with 849 tests. Focused wake suite passed 18/18. Capability proof passed 36/36 in its affected SHA. Pre-fix gate negative at `137724b` had 11 failures. Pre-fix clock negative at `4a7ad7e` had 2 failures.

## Regression completeness

The gate negative at `137724b` fails for exactly the old behavior (ambient wakes, manifest-negative alarm wakes, class entries/grants absent). The candidate is green on the same `canticle-wake-class.test.ts` suite. The capability-test SHA `4166418` is green 36/36 for the embedded manifest and real listener.

The clock negative at `4a7ad7e` fails on both restart and mid-run backward steps. It proves the successor rejects clock regressions; persistence, rebind, TTL-lapse, and session-scope cases are covered by the candidate file.

The missing deterministic case is explicitly Blocking 1: capability changes while a record waits, followed by coverage-only cadence. It cannot be called complete until that test proves no turn is started.
