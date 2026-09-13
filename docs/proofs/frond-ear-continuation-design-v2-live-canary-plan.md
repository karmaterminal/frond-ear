# Continuation v2 — disposable live-canary plan

**NOT RUN — REQUIRES SEPARATE OPT-IN**

This is a future test plan, not a command to execute in the design lane.
No live SDK client, Discord or Teams connection is authorized here.
Source reference: `36fd00980eda5f89a8fd3d1ef7c963a9bf03550d`.
The design's offline proof and this live proof are independent classes.

## Admission gates

1. Explicit authenticated human opt-in for the exact canary artifact, SDK
   package hash, runtime version, tenant, duration/turn/cost ceilings and cleanup.
   Require both a command flag and protected control authorization; default off.
   A fixture or environment variable alone cannot authorize production use.
2. All relevant implementation slices and deterministic negative controls
   reviewed. No unresolved ownership, primary-exclusion or acceptance blocker.
3. Newly provisioned service-owned isolated persistence root and namespace,
   never the normal interactive home. Root allowlist/permissions validated
   without discovering the primary home. Runtime spawned in SDK empty mode,
   explicit baseDirectory/environment/working directory/tools, no forUri/TUI.
4. Credential provisioning, if needed, is a separate protected operation by the
   authorized human; canary/design evidence never reads, prints or describes
   credential values. No primary credential/session copying.
5. Canary generates a fresh random namespace/session ID in its own registry;
   accepts no ID argument. Marker binds tenant/generation/nonce. Proof of
   exclusion is provenance from fresh generation plus isolated namespace, not
   enumeration/comparison with the primary session. Synthetic foreign and
   primary-like IDs fail before metadata/resume/send in negative controls.
6. Source adapters hard-disabled. Injection goes only to a synthetic local
   ingress fixture. No production HTTP control, Discord, Teams, webhooks or
   outbound messages. Future SDK network is the only permitted live connection.

## Finite execution bounds

One canary namespace, one initial generation, maximum two disposable session
IDs if the rotation exercise needs a successor, maximum six real sends and
two heartbeat sends, 15-minute total horizon, one restart between sends,
15-second acceptance and 120-second completion observation deadline.
No tools with external side effects. Use deterministic synthetic tasks and
bounded output. Abort/unknown immediately stops further sends; no retry loop.
Configured count/cost ceiling may be lower; cannot be raised mid-run.

## Ordered exercise and redacted assertions

| Step | Action in the separately authorized canary                              | Required durable proof                                                                                                                                          |
| ---: | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | start owned runtime, targeted metadata absent, create generated session | runtime/package hashes; isolated-root boolean; exact returned ID match (raw ID retained only in protected canary registry)                                      |
|    2 | inject synthetic event A as ordinary user-source untrusted envelope     | admission/disposition, tenant/binding/generation, sealed hash; no source/system setter needed                                                                   |
|    3 | send A under valid lease/attempt                                        | write-ahead send-started; nonempty accepted ID digest and timestamp; no premature completed bit                                                                 |
|    4 | observe A lifecycle and final disposition                               | positive user.message messageId→turnId→successful end correlation; idle supportive only; source ack and completion separate                                     |
|    5 | replay A and inject suppressed/self/unallowed fixtures                  | original disposition/no extra attempt; suppression records; priority never overrides allowlist                                                                  |
|    6 | disconnect/stop owned runtime, restart service/runtime, resume same ID  | confirmed old process exit; persisted marker/binding; continuePendingWork=false and suppressResumeEvent=true; no primary discovery                              |
|    7 | send synthetic B after restart                                          | new stable delivery identity; history continuity and distinct acceptance from A; no duplicated A                                                                |
|    8 | deliberately keep B busy, enqueue synthetic C                           | at most two outstanding accepted real batches; accepted ID before end; correlate whether one or two turns consume them; no FIFO/one-message-one-turn assumption |
|    9 | complete B/C and authorize finite synthetic work needing another turn   | one valid untrusted disposition tied to expected work; host authorization/budget separate                                                                       |
|   10 | schedule one HB, race real D into pending before invocation             | HB suppressed/cancelled; D wins next eligible real slot; cancellation reservation not refunded                                                                  |
|   11 | on a fresh permitted continuation request, run at most two HB turns     | untrusted-user-source fixed envelope, no arbitrary source replay; accepted and terminal/progress records; finite count/time/no-progress stop                    |
|   12 | race synthetic pause/rotation and lease loss around setup/send          | pre-invocation send denied when guard fails; invoked old work retained as predecessor; no successor ack/HB; old runtime drained/stopped before successor driver |
|   13 | exercise acceptance ambiguity if safely simulatable                     | use a test transport that drops response _after_ underlying send invocation, not real source disruption; one attempt, quarantine, no retry after empty history  |
|   14 | reconcile from positive evidence or retain unknown                      | one exact evidence match permits acceptance record; absent/multiple/conflicting records remain blocked; no completion fabricated                                |
|   15 | disable wake/source admission; retire canary bindings                   | preserved queue/attempt/audit receipts, confirmed owned runtime stop, no new leases/HBs                                                                         |

If busy/enqueue cannot be reliably induced with bounded synthetic work, record
that assertion NOT PROVEN, not pass from mock evidence. If safely dropping a
send response is impossible, exercise the state machine offline and mark live
ambiguity exercise NOT RUN; do not create a hazardous real failure. The required
positive acceptance/restart/busy/follow-on assertions still need live proof.

The ambiguity exercise is last because it intentionally blocks further sends.
Never use history absence to clear it. A resumed interrupted turn with unknown
effects is not automatically completed or replayed.

## Immediate stop conditions

- Any primary/foreign ID, unsafe or inherited persistence root, external runtime
  URI, ambient tool/config leakage, unproved former-process exit.
- Unexpected source network attempt, production input, external side-effect
  tool/permission request, secret/content/path in a receipt.
- Empty/malformed acceptance, post-send timeout, transport loss or contradictory
  message/turn correlation. Record unknown and stop; no success-shaped retry.
- Generation/tenant mismatch, expired authority, late stale ack, heartbeat
  under real backlog, budget/deadline exceeded or repeated no-progress.
- Unexplained session disappearance, missing required lifecycle evidence,
  duplicate logical turn or persistence/hash mismatch after restart.
- Any runtime/SDK/config identity change from the opted-in artifact.

## Cleanup and rollback

First stop HB creation/new leases/source injection; retain all unresolved queue
and audit evidence. Drain at most the bounded cleanup timeout; disconnect
plugin-owned handles and confirm owned runtime termination. Retire namespace
and bindings. Do not delete ambiguous session data needed for reconciliation.
After explicit evidence acceptance/retention authorization, delete only
registry-listed disposable sessions/root; scope by namespace marker and exact
generated IDs, never by broad home/path glob. Failed cleanup is a red receipt
and operator-action-required, not ignored best effort.

No fallback to a primary/foreign session and no automatic source enablement
after canary. Production rollout is a separate lane and approval.

## Receipt schema and verdict

Record exact canary implementation SHA/tree, source SHA, SDK package integrity,
runtime/config digest, opt-in request digest/time, isolated-root/owned-ID
assertions, scoped generated-ID hashes, ordered synthetic attempt/event IDs,
acceptance/completion timestamps and evidence digests, restart/driver-exit
proof, dedupe/suppression/HB counters, all unknown/rejected dispositions,
cleanup/retirement proof and each assertion verdict.

Do not publish raw IDs, root paths, prompts, SDK history, model content,
credential material or environment dumps. Even synthetic payload should be
represented by its fixture name/hash in the durable receipt.

Verdict is PASS only if every required assertion has positive evidence at the
exact opted-in version and cleanup is classified. NOT PROVEN/UNKNOWN/FAIL is
not PASS. Passing this canary proves only its finite synthetic scope; it does
not prove exactly-once runtime execution or production readiness.
