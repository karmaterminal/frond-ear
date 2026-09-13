# Continuation v2 — offline evidence and decision receipt

Status: evidence in progress; design only. **No live-readiness claim.**
Live-canary status: **NOT RUN — REQUIRES SEPARATE OPT-IN**.

## Immutable inputs and authority

Repository `karmaterminal/frond-ear`; source branch
`codeagent/frond-ear-copilot-sidecar-v1`.
Source/base/fetched origin SHA:
`36fd00980eda5f89a8fd3d1ef7c963a9bf03550d`.
Source tree: `8d9471005ba210b3bf2195c9b1b5ea1018803923`.
Design branch: `design/frond-ear-continuation-astra-v2`.
Initial local HEAD, tracking and server branch all equalled source, with empty
porcelain, before the first journal mutation. Dispatcher approved Phase 0 on
2026-09-13T04:01:41Z. Transport public identity was `scribe-dandelion-cult`;
no credential material was inspected. Journal records governing blobs and
Phase 0 issue/Project 92 retrievals.

Public repository main contained README only; source has no AGENTS, CLAUDE,
CI workflow or special review policy. Exact-worktree local GitNexus review
skill governs this lane. OpenClaw deployment/presentation ceremonies are not
executed. No inferred upstream autoreview requirement.

## Exact source inventory

30 tracked files; 11 source TypeScript files; six test TypeScript files,
including one helper and five executable modules; **37 top-level tests**.
Executable inventory is statically enumerated, not itself an execution result.

```text
.gitignore
Dockerfile
README.md
deploy/frond-ear-copilot-sidecar.service
deploy/frond-ear.service
docs/architecture.md
output.md
package.json
pnpm-lock.yaml
policy.example.json
scripts/demo.mjs
scripts/scan-credentials.mjs
src/adapters.ts
src/cli.ts
src/config.ts
src/gateway.ts
src/http.ts
src/logger.ts
src/main.ts
src/policy.ts
src/service.ts
src/store.ts
src/types.ts
test/copilot-sidecar.test.ts
test/gateway.test.ts
test/helpers.ts
test/http-adapter.test.ts
test/service.test.ts
test/store-policy.test.ts
tsconfig.json
```

| Executable file         | Tests | Existing asserted properties                                                                                                                                                                                                                   |
| ----------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| copilot-sidecar.test.ts |    12 | first binding/restart resume; v0 migration; conversation isolation; authorized new; policy-reload command replay; rotation fencing; busy enqueue/rejection; ambiguous timeout; setup lease expiry; setup timeout; pause/unavailable; redaction |
| gateway.test.ts         |     7 | persisted resume; fatal close; missed ACK; stale socket; invalid session; replay; persistence failure leaves cursor                                                                                                                            |
| http-adapter.test.ts    |     5 | loopback; timeout below lease; no-shell bounded stdin; SIGTERM-resistant child timeout; lease/ack/release/bind/pause/rotate/capability API                                                                                                     |
| service.test.ts         |     2 | shutdown drains; recovered lease loses ack                                                                                                                                                                                                     |
| store-policy.test.ts    |    11 | restart dedupe; priority overrides; policy validation; suppression/allowlists/self; priority-first burst; max delay; overflow; stale lease; bounded failures; kill/pause; log redaction                                                        |

## Current architecture: facts, not upgraded guarantees

`gateway.ts` synchronously invokes ingress before saving sequence. Event commit
and cursor save are **separate** SQLite writes: crash between them replays,
rather than an atomic event+cursor transaction. Failed ingress leaves cursor
unchanged. Gateway ACK heartbeat is not a Copilot continuation heartbeat.

`service.ts` consults immutable ingress disposition before current policy;
authorized `/new` rotates, unauthorized text stays content. `policy.ts` checks
guild/channel/self before priority overrides. Guild-less DMs still need an
allowed channel. `store.ts` owns WAL, BEGIN IMMEDIATE admission/rotation,
count/UTF-8 weight bounds, overflow dead letters, generation-specific leases
and immutable lineage. Routine rows coalesce; priority currently leases alone
and does **not** merge nearby context. The issue's silent/mentions/room modes
are intent, not implemented policy fields.

Important proposed additions must not be called existing strengths:

- `ack` lacks an explicit expiry-time predicate: recovery must already have
  cleared the claim for the existing late-ack test to reject it.
- `isLeaseActive` checks active generation/time but not binding/global pause.
- `recoverExpiredLeases` cannot distinguish pre-send from post-send: every
  expired leased row becomes pending.
- `CopilotSdkAdapter` has no durable attempt ledger; malformed/empty result
  requests retry, and a generic transport rejection follows ordinary retry.
- Metadata existence alone is treated as ownership; returned session ID is
  not independently checked. Cached handles have no durable driver fence.
- `maxQueueCount/Weight` bound pending/leased content, not all retained
  dispositions, terminal rows or disk. Summaries may truncate entire member
  content while acknowledging all members.
- Logs redact sensitive field names and configured secret values but expose
  raw source/session identifiers in other fields. HTTP is loopback-restricted
  at config loading, not a tenant authorization boundary.
- Graceful service stop drains automatic delivery before adapter close;
  HTTP closes afterward, so future shutdown fencing must cover manual claims.
- `docs/architecture.md` says prune occurs only at startup; actual service
  also schedules maintenance. Source outranks that stale sentence.

The live factory is deliberately unavailable. Its `systemSource` requirement
is the false blocker; removing that requirement alone cannot repair the real
ownership/attempt/ambiguity gaps.

## Runtime and dependency identity

Product engine: Node `>=24.0.0`; pnpm used, no packageManager version pinned.
Lockfile format 9.0. Direct development pins: TypeScript 5.9.3,
Prettier 3.6.2, @types/node 24.10.0; transitive undici-types 7.16.0.
Observed executable versions: Node v25.9.0, pnpm 10.32.1.
Existing same-host TypeScript/Prettier packages match those pins.
**No SDK is dependency- or lockfile-resolved by this product.**
No SDK exists at the inspected product checkout's standard SDK package path.
That is not a claim about all machine installations.

Published package examined without installing or executing:
`@github/copilot-sdk@1.0.13`, bundled CLI version declaration `1.0.83`,
Node range `^20.19.0 || >=22.12.0`.
Registry and tarball retrieved 2026-09-13, byte-verified:

```text
https://registry.npmjs.org/@github/copilot-sdk/-/copilot-sdk-1.0.13.tgz
SHA256 238147f38bb7597bdd6864445e27137475ec034c831efb555655f3db28d50b3b
integrity sha512-/j6/tGc9HOtcupuYFloOKk0fpScdpy65EVF1LKg2Z2VQOojCGPgBGkhgVGVDaqW7UB6TV2qbQZa9rKJimJ0wWQ==
```

| Released file in package/dist | SHA-256                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| client.d.ts                   | 976ef43b72913a493696ad229449231edb0625891b64eff3356be00e77419945 |
| client.js                     | 23be6340fabd555ccd8f0c9fc20786bcb743902f73e0a30e26157a1c55c36abf |
| session.d.ts                  | 645c3f06dc0206a2963eb6874fd09a0db612a0c00637a0da48cb9462695ad720 |
| session.js                    | e0bcdd68532f4108906af199531359f422cf192f1e5d61124b82e734ea0f5546 |
| types.d.ts                    | 6b5d15d17d9445b12479dfb9e34e5194397818ec190fa308f8fe9c5b05d5e63f |
| generated/rpc.d.ts            | f262cd7e036ea1c862e17f90a72340d918943761413552e6019a96f4aee33c3c |
| generated/session-events.d.ts | c9bde505b270207f6015a83af7e8a6054352f17699ef0c380dc6417433edbc98 |

## Released SDK capability matrix

| Operation/evidence | Exact declaration/implementation                                         | Design consequence                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| start              | client.d.ts:124; client.js:595 starts/handshakes/verifies protocol       | Ready only after successful awaited start; no inferred readiness from process existence                                                        |
| stop               | client.d.ts:126–149; releases resources, returns Error[], preserves data | Nonempty errors recorded; stop not proof of completion                                                                                         |
| create             | types.d.ts:2440–2449 accepts custom ID; client.js:1056+ uses it          | Preallocate ID and owner intent; compare returned ID; cloud off                                                                                |
| metadata           | client.d.ts:351; client.js:1747–1756 targeted session.getMetadata        | Undefined means absent in that namespace, not permission to overwrite a previously active generation                                           |
| resume             | client.d.ts:214–237; types.d.ts:2455–2473                                | Explicit ID and safe config; suppressResumeEvent true, continuePendingWork false; interrupted work needs reconciliation                        |
| isolated storage   | types.d.ts:247–277, 345–350                                              | empty mode plus explicit baseDirectory for spawned runtime; forUri ignores baseDirectory and is forbidden                                      |
| send               | session.js:448–460 returns response.messageId                            | Successful RPC response establishes assigned message identity, not completed work or fsync/durable exactly-once guarantee                      |
| message modes      | types.d.ts:2733–2789                                                     | enqueue default; immediate distinct; no source setter in released public MessageOptions                                                        |
| sendAndWait        | session.js:462–504; session.d.ts:144–167                                 | Subscribes before send; waits session.idle/non-autopilot or error; timeout begins after send returns, does not abort; no acceptance ID exposed |
| disconnect         | session.d.ts:252–272                                                     | Releases handlers/resources; retains history; handle invalid afterward                                                                         |
| history            | session.d.ts:250                                                         | getEvents returns events; not documented as linearizable negative-acceptance oracle                                                            |
| user.message       | generated/session-events.d.ts:3387–3463                                  | optional messageId matches returned send ID; optional turnId correlates consumption; event ID is a different identity                          |
| turn end           | generated/session-events.d.ts:5056–5064                                  | turnId correlates end, not semantic work completion                                                                                            |
| idle               | generated/session-events.d.ts:1324–1332                                  | global idle may be aborted and has no message ID; never alone proves a particular send completed                                               |
| reject/timeout     | send throws on disconnected/connection failure                           | Exception after invocation is not proof of non-acceptance; quarantine unless pinned explicit pre-acceptance rejection contract                 |
| idempotent send    | no caller message/idempotency ID in public MessageOptions                | Stable envelope ID detects duplicates; cannot prevent runtime duplication or authorize retry on history absence                                |

Public upstream `github/copilot-sdk@f45c46fd1812f8bed5b4cbc250f47177c83068f0`
has `nodejs/src/session.ts:715–730` forwarding `source`, unlike published bytes.
That capability is **unreleased relative to the verified artifact**. Do not
infer published behavior from main. Standalone installed CLI version not
queried; no live client/session instantiated.

Acceptance has two proof classes: positive observed RPC/event evidence permits
an acceptance ledger record; durable nonduplicating restart requires local
write-ahead attempts and fail-closed quarantine. There is no claim of exactly
once execution. Unknown remains unknown. A canary must independently establish
multiple sends/restart/enqueue behavior before live activation.

## Sol review input: independent dispositions

Commit `8dcd6698d0696943b518c11b560f0eaf167abf31`, blob
`1f9d47addb4ce0614c52e63d315b2450e34b4a81`, SHA-256
`8afd70f1958055f0c6094975437ee65a18f7b6489269dd380ebeb50d77cdf315`;
49,049 bytes, independently verified. Branch unchanged.

| Sol section | Finding                                                        | Disposition in this lane                                                                                             |
| ----------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 6.2         | trusted host continuation envelope contradicts workorder       | both ingress and heartbeat render untrusted user-source envelopes                                                    |
| 11          | absence after reconciliation horizon permits retry             | absence never authorizes retry; explicit reconciliation required                                                     |
| 19          | owner epoch purportedly prevents two SDK drivers               | single host process/OS lock and confirmed old-runtime termination; no lease-only takeover                            |
| 14          | prints canonicalized sensitive paths                           | only redacted assertion codes and tenant-scoped opaque references                                                    |
| 12          | priority stays separate instead of nearby-context merge intent | add bounded same-generation nearby merge with member accounting                                                      |
| 9, 23       | checkpoint tool and broad lanes become mandatory               | no new tool ecosystem; constrained continuation request is optional future decision, not shipped/assumed SDK feature |
| 17          | incomplete states and accepted-work retry arrows               | explicit split delivery/completion states; no accepted-to-retry transition                                           |
| 2           | candidate safety claims stronger than source                   | corrections above; no inherited proof laundering                                                                     |

## Proof boundary

The fake harness specified by the design is **not implemented or executed in
this lane**. Existing tests do not validate the proposed schema or scheduler.
Their results, exact command/SHA receipts, future scenario matrix, independent
review and final identities are recorded in subsequent sections/journal entries.

## Deterministic fake SDK harness specification

**Specification only — not a newly executed harness.** Implement with a virtual
clock (UTC and monotonic channels), seeded jitter, ordered scripted SDK
operations/events, explicit before/after-commit failpoints, and a persistent
fake runtime store separate from plugin SQLite. Restart clears client handles
but preserves chosen runtime/DB facts. Crash can independently remove process,
transport response or event notification. Do not model every rejection as
pre-acceptance. Support history omission/truncation and duplicate events.

Expose ordered transcript entries `(step,time,operation,tenant,generation,
attempt,event-type,result-class)` without content, durable snapshots after
each failpoint, and an assert-no-send-after-fence oracle. A test must assert
queue/attempt/binding/disposition state and evidence, not just spy call counts.
Replay the same seed to reproduce schedule ordering.

| Scenario                                          | Required assertion / invariant coverage                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| metadata absent → create                          | creation intent predates call; returned ID/marker match before active; I01,I13                    |
| metadata present → resume                         | same owned ID, safe options, history reconciled; I02,I15                                          |
| persisted-ID restart between sends                | no original replay, new delivery distinct; I03,I15                                                |
| multiple isolated conversations/tenants           | no cross lookup/DB/coalescing/metrics/replay; I01,I14                                             |
| busy enqueue accepted                             | bounded outstanding real messages; accepted≠completed; I05,I19                                    |
| synchronous explicit local validation reject      | no send-started effect; bounded safe retry; I04,I07                                               |
| delayed rejection before/after runtime acceptance | only proved pre-acceptance retries; generic rejection quarantines; I06,I07                        |
| accepted message ID                               | durable positive evidence before ack; I05,I06,I18                                                 |
| empty/malformed acceptance                        | ambiguous; no retry or ack; I06,I07                                                               |
| timeout before send begins                        | setup cancelled; late setup cannot initiate; I04                                                  |
| timeout after invocation                          | quarantine survives expiry/restart; I07,I15                                                       |
| late acceptance after timeout                     | evidence retained, stale ack denied, reconciler no resend; I16,I18                                |
| completion before acceptance persistence          | durable event buffered; no premature complete; I05,I06                                            |
| completion after persistence                      | exact message→turn join; separate timestamps; I05                                                 |
| no completion/aborted idle                        | accepted/unknown or failed, not success; I05,I20                                                  |
| duplicate lifecycle events                        | unique event evidence, one budget reservation; I03,I09                                            |
| session disappears after active                   | recovery-required; no same-generation create; I02,I15                                             |
| session-ID mismatch                               | no cache/send; binding blocked; I13                                                               |
| permission request                                | deny, blocked work, no approve-all retry; I21                                                     |
| client crash during create/resume/send            | respective §11 states; no optimistic retry; I07,I15                                               |
| disconnect/stop failure                           | runtime ownership remains uncertain; no successor start; I17                                      |
| rotation during setup/invocation                  | setup cannot send if rotation won; old invoked evidence retained only for old generation; I02,I04 |
| lease expiry during setup                         | no invocation; I04,I18                                                                            |
| lease expiry after invocation                     | no stale ack or lease recovery to pending; I07,I18                                                |
| heartbeat no-progress/exhaustion                  | finite reservations/time across restart; I09,I11                                                  |
| real work supersedes scheduled/due HB             | suppression, no duplicate budget reset; I10,I11                                                   |
| foreign/primary-like synthetic ID                 | rejected before metadata/resume/send or outside-root read; I13                                    |
| ownership lease expiry while old runtime lives    | new driver cannot acquire SDK authority; I17                                                      |
| process suspension at final pre-send boundary     | either launcher proves serialized boundary or activation blocked; I04,I17                         |
| key/hash collision, envelope delimiter injection  | quarantine conflict; round-trip string remains nested; I08,I12                                    |
| every source disposition/coalesced member         | exactly one retained disposition/membership, no omitted member ack; I08                           |
| quota/full disk/retention pressure                | explicit overflow or withheld cursor/ACK; I19                                                     |
| fair scheduling sustained priority load           | bounded streak gives routine progress across tenants; I10,I14,I19                                 |
| shutdown with HTTP/manual lease request           | claim denied after draining fence; DB closes last; I22                                            |
| readiness without canary                          | liveness not live-proven; I20                                                                     |
| forged model disposition/budget request           | no authority/tenant/budget escalation; I11,I21                                                    |

### Invariant-to-proof mapping

I01–I04: unique constraints, migration, creation/rotation and driver-boundary
tests; source's binding tests are partial precedent, not proof of v2.
I05–I07: independent acceptance/event/error script and crash table.
I08: admission/member/tombstone conservation under overflow and failure.
I09–I11: heartbeat finite-state, virtual clock/jitter and real-work races.
I12: canonical serialization round-trip with malicious newlines/delimiters.
I13–I14: foreign-root/ID and adversarial tenant-principal access matrix.
I15–I18: fresh-process recovery snapshots, late events and runtime-exit fencing.
I19: count/UTF-8/retention/disk and fairness stress.
I20: readiness vector without live receipts.
I21: model output cannot change control principal or quotas.
I22: ordered source/control/pump/runtime/DB shutdown transcript.

### State-machine consistency review

- Every state in the workorder has a table entry or explicit terminal
  subdisposition; source delivery and completion are orthogonal.
- Every durable record has an owner and unique transition key; all T changes
  include audit reason, no SDK call executes inside a DB transaction.
- Retry edges require proved no invocation/no acceptance. Accepted and
  ambiguous have no ordinary pending edge. Late evidence is not stale authority.
- Each terminal retains an explicit operator-visible result; replay creates
  new lineage, never erases a result. Unresolved rows cannot silently expire.
- Budgets are reserved transactionally and do not reset after cancellation,
  policy change, pause or restart.
- OS/runtime lifetime exclusion is separate from DB CAS. Implementation
  activation is blocked if process-suspension safety cannot be proved.

These are checklist checks over a design, not model checking or execution of
the proposed state machine.

## Existing repository validation

At exact lane HEAD `65f1c1ea9f17160bb482d65d486d1031d41f777a`:

1. `node <existing-product-node_modules>/typescript/bin/tsc -p tsconfig.json
--typeRoots <existing-product-node_modules>/@types` — **exit 0**.
2. `node --test --test-concurrency=1 dist/test/*.test.js` — **exit 0**,
   **37 passed, 0 failed, 0 skipped, 0 cancelled**.

Both run in the isolated design worktree under `env -i`, with only PATH and
project-local isolated HOME/TMPDIR supplied. Existing tests use synthetic
credentials and fake SDK/Gateway; the HTTP test connects only to its own
ephemeral loopback server. No inherited credential values are read.
Scratch/build outputs are under ignored `dist/`, not system temporary paths.

Adaptation: use the already installed matching TypeScript package directly
and explicit typeRoots, instead of installing/symlinking dependencies into
the new worktree. This is the same tsconfig/compiler/test runner as package
scripts, with resolution pointed to existing types. No manifest, lock or
dependency tree was modified. Repository script inventory:
`pnpm format:check`, `pnpm typecheck`, `pnpm test`,
`pnpm scan:credentials`; `pnpm check` chains these. Formatting and scanner
receipts are appended at the final candidate. No claim `pnpm check` itself ran.

No source/test/dependency/policy/deployment/workflow file changed. No network
connection to Discord, Teams or a live Copilot session. No credential file,
credential value or primary-session storage/transcript/process was accessed.

## Exact-diff GitNexus and independent review

Review freeze: `e14e717dc2f3baaea5e3b80c66a56c5fe7e6daa9`.
Local HEAD, origin tracking and server `ls-remote` agree. Exact base is source.
`git diff --name-only BASE HEAD` returns exactly four permitted files.

Installed fork CLI 1.6.5, source checkout commit
`3c1e686edfc1acaac882927cada121ddd7c47bcc`;
wrapper SHA-256 `8309aeb6858023f5cb3ff4ae8416b64c1989e4fe04d82dd822964127ed1355ca`;
compiled CLI SHA-256 `00f67e34c0ef3a7ea5f1665247699f47e7e2eab2dc233a504fe95d9aa11d8590`.
No stock npm/npx tool used. Exact worktree invocation:
`gitnexus analyze --index-only --skip-git --workers 0` — exit 0, 8.9s.

Index meta recorded exact lane repoPath, lastCommit equal review freeze,
indexedAt `2026-09-13T04:13:58.893Z`, graph and FTS available, no vectors.
31 indexed files (not the 34-file tracked inventory; different indexing scope),
696 nodes, 1,899 edges, 34 clusters, 45 flows; lbug 53,161,984 bytes.
`detect_changes(scope:"compare",base_ref:BASE,repo:EXACT_WORKTREE,
worktree:EXACT_WORKTREE)` returned four changed files, 54 Markdown Section
nodes, **zero changed code symbols, zero affected processes, low graph risk**.
Code-symbol impact/context are N/A, not fabricated. Limitation: graph mapping
does not prove architecture correctness; checklist review does that separately.

Independent model explicitly selected: **Claude Sonnet 5**, code-reviewer,
distinct from requested Astra authoring pass. Reviewer read only workorder,
exact four-file diff/documents and supplied evidence; no credentials/primary
session/live services or broad rediscovery. It independently verified base tree,
local/tracking head and clean worktree. SDK package citations were assessed
from supplied evidence, **not independently re-fetched** by reviewer.

| Finding                                                                                                         | Disposition                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: heartbeat table treated suppression as terminal but §7 described recently active work as rearmable deferral | Correct before declaration: real pending/accepted-outstanding/recent work is terminal suppression; non-real busy deferral gets explicit due→scheduled edge with same reservation |
| F2: three journal indentation lines and estimated timestamp correction                                          | Accepted-as-disclosed by reviewer; no deleted reasoning, original commits preserved                                                                                              |
| F3: SDK citations not independently re-fetched                                                                  | Evidence limitation retained; author verified released tarball/hashes; no second verification falsely claimed                                                                    |
| F4: busy/ambiguity induction may be unavailable in future canary                                                | Correct explicit NOT PROVEN/NOT RUN behavior, not converted to pass                                                                                                              |

Initial checklist: 26 PASS, heartbeat consistency CONDITIONAL. Reviewer's
summary called F1 nonblocking but closing section called it a design blocker;
the stricter reading is applied: repair and re-review, not waive. D12 remains
open until exact amended review receipt. All D01–D11 future proof gates remain.

### Amended exact review — D12 closed

Amended reviewed HEAD:
`72ff2a2c43ab4a2c19b05fd146dded87b52ffd7e`;
tree `a1c96a6d4a8ff2b7c6a5dedc0be1b1fcfca83f31`.
Local/tracking/server equality verified again at 2026-09-13T04:25:05Z.
Fresh exact-worktree index: `lastCommit` equals this HEAD,
`indexedAt=2026-09-13T04:21:47.530Z`; graph/FTS available,
698 nodes, 1,901 edges, 34 clusters, 45 flows; lbug 53,178,368 bytes.
Meta SHA-256 `8cf33ec7b542c6d71acdf1f930144d8594b89a8e4c94160c150631e2c9308867`.

Installed fork command:
`gitnexus detect-changes --scope compare --base-ref
36fd00980eda5f89a8fd3d1ef7c963a9bf03550d --repo <exact-worktree>`
returned **four files, 56 Markdown sections, zero affected flows, low risk**.
No changed code symbols; impact/context remain N/A. A first attempt to parse
human-readable CLI output as JSON failed in the output formatter, not graph
analysis; the command was rerun in its supported text form and receipt read
directly. No analysis result was invented from that parser failure.

Claude Sonnet 5 performed a bounded second pass on the exact prior→amended diff
and reconfirmed BASE→amended four-file scope, base tree, local/tracking HEAD and
clean worktree. **F1 resolved; design-level PASS; no remaining design blocker.**
It confirmed disjoint terminal real-work suppression versus same-reservation
non-real idle deferral. Original 26 PASS judgments stand; heartbeat upgrades to
PASS. D12's initial pending state in the design register is superseded by this
completed exact-head review receipt. D01–D11 remain future activation/slice
gates, not implied completed by this design.

#### Final workorder §15 checklist

| Item                                                       | Result                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| exact immutable base                                       | PASS                                                          |
| exact pushed reviewed head                                 | PASS, independent local/tracking plus author server check     |
| only four permitted files                                  | PASS                                                          |
| bounded ingress plugin, not OpenClaw                       | PASS                                                          |
| existing safety properties preserved                       | PASS; missing source guarantees explicitly distinguished      |
| missing system-source setter non-blocking                  | PASS                                                          |
| untrusted provenance-bearing user envelopes                | PASS                                                          |
| lifecycle/acceptance/completion/idle distinct              | PASS                                                          |
| no ambiguity→success/ordinary retry                        | PASS                                                          |
| finite durable suppressible fenced heartbeats              | PASS after F1 repair                                          |
| real work precedence                                       | PASS                                                          |
| transactional owners/restart rules                         | PASS                                                          |
| no silent event loss                                       | PASS as proposed contract; source gaps disclosed              |
| poison/ambiguity visible                                   | PASS                                                          |
| rotation fences all delivery phases                        | PASS                                                          |
| primary exclusion mechanical/testable                      | PASS as required future boundary; runtime proof remains gated |
| Discord/Teams identity separation                          | PASS                                                          |
| tenant storage/scheduling/session/metrics/replay isolation | PASS                                                          |
| before/during/after send crash points                      | PASS                                                          |
| offline/live proof separate                                | PASS                                                          |
| disposable opt-in non-production canary                    | PASS, NOT RUN                                                 |
| no primary/foreign rollback fallback                       | PASS                                                          |
| fake late-acceptance/duplication scenarios                 | PASS specification; not implemented                           |
| content/token/raw-ID/path-safe observability               | PASS design                                                   |
| explicit unresolved decisions/proof owners                 | PASS                                                          |
| small ordered future slices                                | PASS                                                          |
| no implied PR/deployment                                   | PASS                                                          |

### Final available repository checks at reviewed HEAD

At `72ff2a2c43ab4a2c19b05fd146dded87b52ffd7e`,
2026-09-13T04:25:28Z, clean tracked worktree:

| Command                                                                                                                                | Result                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `node <existing-product-node_modules>/prettier/bin/prettier.cjs --check .`                                                             | exit 0, all matched files formatted                                                    |
| `node <existing-product-node_modules>/typescript/bin/tsc -p tsconfig.json --noEmit --typeRoots <existing-product-node_modules>/@types` | exit 0                                                                                 |
| `node --test --test-concurrency=1 dist/test/*.test.js`                                                                                 | exit 0, 37 pass, 0 fail/skip/cancel                                                    |
| `node scripts/scan-credentials.mjs`                                                                                                    | exit 0, 34-file scan; repository files only                                            |
| `git diff --check`                                                                                                                     | exit 0                                                                                 |
| inline document inventory assertions                                                                                                   | exit 0; 18 numbered sections, I01–I22, D01–D12, four-file diff, required canary labels |

Tests use the earlier compiled output from byte-identical source at
`65f1c1ea9f17160bb482d65d486d1031d41f777a`; only documentation changed since.
Compiler/typecheck and tests retain the sanitized environment and project-local
fixture/HOME roots described above. No dependency install/update was required.
The repository credential-pattern scanner reads tracked/nonignored source
documents, not credential files, and prints finding names only.

One intermediate formatter check failed **only** on generated
`.gitnexus/meta.json` and `.gitnexus/parse-cache/index.json`; the index is
diagnostic output, not product content. Removed that lane index with installed
`gitnexus clean --force`, reran the full formatter successfully, then rebuilt
the exact index for review. After the amended review, cleaned the generated
index again before final checks. No product file was reformatted to cure it.

## Gate disposition and execution deviations

| Named gate                            | Design-lane disposition                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Source-identity                       | PASS; source/tree and initial unchanged publication verified                              |
| Direct-byte-comprehension             | PASS; inventory/source/test reads and source corrections recorded                         |
| SDK-contract-honesty                  | PASS for design; no runtime acceptance/durability claim beyond evidence                   |
| Architecture-completeness             | PASS after F1 repair and independent follow-up                                            |
| Offline-mechanical-proof              | PASS for existing checks and required harness specification, not new implementation proof |
| Primary-and-tenant-safety             | PASS as mechanically testable design; actual isolation/fencing activation remains gated   |
| Exact-diff-independent-review         | PASS on amended reviewed HEAD; code-symbol graph operations N/A with reason               |
| Origin-first-publication-and-identity | checkpoint identities PASS; terminal declaration/ref verification in journal              |

Disclosed execution deviations, not hidden as exact compliance:

1. Three indentation-only journal lines normalized by repository formatter;
   all reasoning/history retained. Independent reviewer accepted as disclosed.
2. Phase-heading timestamps were minute estimates; an ahead-of-time 04:14Z
   heading corrected by append-only exact observed-time entry.
3. Synchronous independent review exceeded the 385-second liveness interval
   by approximately seven seconds measured from index completion; disclosed
   in journal. No two-interval no-progress condition or prohibited access.

Final receipt-only commits append review/check/declaration evidence. The
substantive design and live-canary document remain byte-identical to the
amended reviewed HEAD; no architecture/invariant changes after review.
Their SHA-256 hashes:

- Design: `b84340b996a76dc511ca9a12aabf81befdc579046beccbaccb6b64e4d9251e84`
- Canary plan: `93a45c2983e72c76ec387591a78c414c60bf0176f083bbeadbda042be298ca67`

The final offline-proof hash and terminal commit/tree are captured by the
journal/publication receipt rather than a self-referential hash inside this
document. All four allowed paths are named in the inventory/declaration.

## Exact executable test names at immutable source

`test/copilot-sidecar.test.ts`:

1. first binding persists and a restarted adapter resumes its dedicated session
2. exact v0 queue rows migrate into durable generation-one bindings
3. two Discord conversations use isolated Copilot sessions
4. authorized new rotates once while unauthorized new remains untrusted content
5. new command replay keeps its original disposition across policy changes
6. rotation fences queued and leased predecessor events from successor delivery
7. busy sessions accept enqueue mode and SDK rejection releases the lease
8. ambiguous SDK timeout dead-letters rather than risking duplicate retry
9. expired lease during SDK setup prevents the delayed session send
10. SDK setup timeout cannot continue into send or cache mutation
11. binding pause and unavailable SDK capability preserve pending queue rows
12. delivery errors and untrusted content remain redacted in structured logs

`test/gateway.test.ts`:

1. disconnect/restart persists sequence and resumes the durable session
2. fatal close codes stop reconnecting and surface failure
3. heartbeat without an ACK closes the stale connection and schedules resume
4. a stale socket close cannot schedule another connection
5. non-resumable invalid session clears identity and waits before reconnect
6. Gateway replay flows through service and remains idempotent
7. failed event persistence does not advance the durable Gateway sequence

`test/http-adapter.test.ts`:

1. loopback binding accepts only explicit local addresses
2. command adapter timeout must remain shorter than the queue lease
3. command adapter writes bounded JSON to stdin without shell interpolation
4. command adapter timeout rejects even when the child ignores SIGTERM
5. loopback API leases, acknowledges, and releases through the store boundary

`test/service.test.ts`:

1. shutdown waits for in-flight delivery before the store can close
2. automatic delivery reports a lease lost before ack

`test/store-policy.test.ts`:

1. duplicate Discord message replay remains idempotent across restart
2. priority authors and direct mentions override suppressions inside allowlists
3. policy requires bot identity and bounds coalescing latency
4. ignored authors, patterns, event classes, guilds, channels, and self are rejected
5. noisy burst coalesces while priority remains an independent first lease
6. continuous channel traffic cannot postpone a burst beyond the coalesce bound
7. overflow explicitly dead-letters noise and preserves admitted priority
8. lease expiry recovers a crash before ack
9. delivery failures release then dead-letter at the configured attempt bound
10. Gateway kill switch rejects new ingestion and wake pause preserves queued work
11. structured logs redact token values and content fields
