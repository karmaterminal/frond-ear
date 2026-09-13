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

| Executable file | Tests | Existing asserted properties |
|---|---:|---|
| copilot-sidecar.test.ts | 12 | first binding/restart resume; v0 migration; conversation isolation; authorized new; policy-reload command replay; rotation fencing; busy enqueue/rejection; ambiguous timeout; setup lease expiry; setup timeout; pause/unavailable; redaction |
| gateway.test.ts | 7 | persisted resume; fatal close; missed ACK; stale socket; invalid session; replay; persistence failure leaves cursor |
| http-adapter.test.ts | 5 | loopback; timeout below lease; no-shell bounded stdin; SIGTERM-resistant child timeout; lease/ack/release/bind/pause/rotate/capability API |
| service.test.ts | 2 | shutdown drains; recovered lease loses ack |
| store-policy.test.ts | 11 | restart dedupe; priority overrides; policy validation; suppression/allowlists/self; priority-first burst; max delay; overflow; stale lease; bounded failures; kill/pause; log redaction |

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

| Released file in package/dist | SHA-256 |
|---|---|
| client.d.ts | 976ef43b72913a493696ad229449231edb0625891b64eff3356be00e77419945 |
| client.js | 23be6340fabd555ccd8f0c9fc20786bcb743902f73e0a30e26157a1c55c36abf |
| session.d.ts | 645c3f06dc0206a2963eb6874fd09a0db612a0c00637a0da48cb9462695ad720 |
| session.js | e0bcdd68532f4108906af199531359f422cf192f1e5d61124b82e734ea0f5546 |
| types.d.ts | 6b5d15d17d9445b12479dfb9e34e5194397818ec190fa308f8fe9c5b05d5e63f |
| generated/rpc.d.ts | f262cd7e036ea1c862e17f90a72340d918943761413552e6019a96f4aee33c3c |
| generated/session-events.d.ts | c9bde505b270207f6015a83af7e8a6054352f17699ef0c380dc6417433edbc98 |

## Released SDK capability matrix

| Operation/evidence | Exact declaration/implementation | Design consequence |
|---|---|---|
| start | client.d.ts:124; client.js:595 starts/handshakes/verifies protocol | Ready only after successful awaited start; no inferred readiness from process existence |
| stop | client.d.ts:126–149; releases resources, returns Error[], preserves data | Nonempty errors recorded; stop not proof of completion |
| create | types.d.ts:2440–2449 accepts custom ID; client.js:1056+ uses it | Preallocate ID and owner intent; compare returned ID; cloud off |
| metadata | client.d.ts:351; client.js:1747–1756 targeted session.getMetadata | Undefined means absent in that namespace, not permission to overwrite a previously active generation |
| resume | client.d.ts:214–237; types.d.ts:2455–2473 | Explicit ID and safe config; suppressResumeEvent true, continuePendingWork false; interrupted work needs reconciliation |
| isolated storage | types.d.ts:247–277, 345–350 | empty mode plus explicit baseDirectory for spawned runtime; forUri ignores baseDirectory and is forbidden |
| send | session.js:448–460 returns response.messageId | Successful RPC response establishes assigned message identity, not completed work or fsync/durable exactly-once guarantee |
| message modes | types.d.ts:2733–2789 | enqueue default; immediate distinct; no source setter in released public MessageOptions |
| sendAndWait | session.js:462–504; session.d.ts:144–167 | Subscribes before send; waits session.idle/non-autopilot or error; timeout begins after send returns, does not abort; no acceptance ID exposed |
| disconnect | session.d.ts:252–272 | Releases handlers/resources; retains history; handle invalid afterward |
| history | session.d.ts:250 | getEvents returns events; not documented as linearizable negative-acceptance oracle |
| user.message | generated/session-events.d.ts:3387–3463 | optional messageId matches returned send ID; optional turnId correlates consumption; event ID is a different identity |
| turn end | generated/session-events.d.ts:5056–5064 | turnId correlates end, not semantic work completion |
| idle | generated/session-events.d.ts:1324–1332 | global idle may be aborted and has no message ID; never alone proves a particular send completed |
| reject/timeout | send throws on disconnected/connection failure | Exception after invocation is not proof of non-acceptance; quarantine unless pinned explicit pre-acceptance rejection contract |
| idempotent send | no caller message/idempotency ID in public MessageOptions | Stable envelope ID detects duplicates; cannot prevent runtime duplication or authorize retry on history absence |

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

| Sol section | Finding | Disposition in this lane |
|---|---|---|
| 6.2 | trusted host continuation envelope contradicts workorder | both ingress and heartbeat render untrusted user-source envelopes |
| 11 | absence after reconciliation horizon permits retry | absence never authorizes retry; explicit reconciliation required |
| 19 | owner epoch purportedly prevents two SDK drivers | single host process/OS lock and confirmed old-runtime termination; no lease-only takeover |
| 14 | prints canonicalized sensitive paths | only redacted assertion codes and tenant-scoped opaque references |
| 12 | priority stays separate instead of nearby-context merge intent | add bounded same-generation nearby merge with member accounting |
| 9, 23 | checkpoint tool and broad lanes become mandatory | no new tool ecosystem; constrained continuation request is optional future decision, not shipped/assumed SDK feature |
| 17 | incomplete states and accepted-work retry arrows | explicit split delivery/completion states; no accepted-to-retry transition |
| 2 | candidate safety claims stronger than source | corrections above; no inherited proof laundering |

## Proof boundary

The fake harness specified by the design is **not implemented or executed in
this lane**. Existing tests do not validate the proposed schema or scheduler.
Their results, exact command/SHA receipts, future scenario matrix, independent
review and final identities are recorded in subsequent sections/journal entries.
