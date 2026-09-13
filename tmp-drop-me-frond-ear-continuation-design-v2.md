# FROND-EAR-CONTINUATION-DESIGN-v2 — append-only lane journal

## 2026-09-13T04:02Z — Phase 0/1: accepted readback and immutable publication

- Status: IN PROGRESS; design/evidence only. Dispatcher explicitly accepted
  Phase 0 at 2026-09-12T21:01:41-07:00. Earlier preflight responses correctly
  withheld mutation. Workorder v2 is issue #1 comment `5650993149`, read from
  the exact dispatched `files/FROND-EAR-CONTINUATION-DESIGN-v2.md`.
- Source: `codeagent/frond-ear-copilot-sidecar-v1`;
  HEAD/base `36fd00980eda5f89a8fd3d1ef7c963a9bf03550d`;
  tree `8d9471005ba210b3bf2195c9b1b5ea1018803923`.
- Created isolated worktree `.proof-work/frond-ear-continuation-astra-v2`
  and branch `design/frond-ear-continuation-astra-v2` directly from that SHA.
  Initial porcelain output was empty. Unchanged branch published before this
  journal. Local HEAD, tracking ref and `ls-remote` server ref all equalled base.
  This journal is the first lane file mutation.
- The parent source checkout was not changed: it has unrelated untracked
  dependencies and a different checked-out HEAD. All product reads used
  `git show <immutable SHA>:<path>`, not that checkout's working files.
- Read current target main tree (README only), exact source tree (30 files;
  no target AGENTS/CLAUDE/workflow rules), all 11 source modules, all six test
  files (five executable test modules, 37 top-level tests), package/lock,
  README, architecture, example policy, two units, Dockerfile, demo, scanner,
  tsconfig and prior output receipt. Old output is historical evidence, not
  a current test run.
- Governing reference blob identities, fetched 2026-09-13:
  - PRINCE-CODE-AGENT-RUNBOOK:
    `6b3fa3186f7b95096ef71c55fbce4d13d7ea8f92`.
  - PR-DRIFT-CURE-GATES-RUNBOOK:
    `e42d5eedbf52cb1d0fa307749b83c8625899c26e`.
  - HOW-TO-NAME-A-BRANCH-IN-OUR-OPENCLAW-FORK:
    `7b4a4d4d4a0cb1a37a4c3f42a634483ae63a5a24`.
  - Local `skills/gitnexus-pr-review/SKILL.md` read directly. Exact-worktree
    review required; no unrelated index substitution.
  - Issue #1 body, all four current comments, Project 92
    `PVT_kwDOAYLGvs4BjUmx` and its one issue item inspected read-only.
  Operational runbook disciplines apply; OpenClaw presentation, deployment
  and force-push procedures do not. The task-specific design branch name is
  intentional, not an OpenClaw taxonomy exception inferred silently.
- Released SDK inspected in memory from public npm, without installation:
  `@github/copilot-sdk@1.0.13`, bundled runtime `1.0.83`.
  Tarball SHA-256
  `238147f38bb7597bdd6864445e27137475ec034c831efb555655f3db28d50b3b`.
  SHA-512 verified against registry integrity. Source package/lock has no SDK
  dependency; no SDK was found at the product checkout's standard package path.
  No installed standalone CLI/session was inspected.
- Public upstream main observed at
  `f45c46fd1812f8bed5b4cbc250f47177c83068f0` (2026-09-12T06:51:52Z).
  Its source-forwarding capability is not credited to the released artifact.
- Decision: retain user-source untrusted envelopes, separate acceptance from
  completion, quarantine uncertain sends without absence-based retries.
  SDK lifecycle and isolated `baseDirectory` are released contracts.
  DB owner epochs are not remote SDK fencing. Positive event correlation is
  useful; history absence cannot prove a send was rejected.
- Sol input independently read in full and hash-verified:
  branch `design/frond-ear-continuation-v2`,
  commit `8dcd6698d0696943b518c11b560f0eaf167abf31`,
  blob `1f9d47addb4ce0614c52e63d315b2450e34b4a81`,
  SHA-256 `8afd70f1958055f0c6094975437ee65a18f7b6489269dd380ebeb50d77cdf315`.
  Retain ledger/ack distinctions. Reject trusted heartbeat envelopes (§6.2),
  retry on empty history (§11), remote fencing claimed from DB epochs (§19),
  sensitive-path printing (§14). Sol branch untouched.
- Allowed mutations: three named design/proof documents and this journal only.
  No implementation, dependencies, live source, canary, credentials, primary
  session, PR, deployment, issue/project mutation or external communication.
  Repository transport only for authorized read/publication.
- Uncertainty: live behavior remains unproved; fake tests cannot prove runtime
  acceptance durability. Exact-worktree GitNexus and independent review pending.
  Next gate: SDK matrix and offline-proof draft, then state/data design.

### Liveness, 2026-09-13T04:02Z

Phase 1; HEAD `36fd00980eda5f89a8fd3d1ef7c963a9bf03550d`.
Clean before journal; journal now sole new file. Last action: unchanged branch
identity verified on origin. Next: publish journal, map SDK and invariants.
No prohibited resource accessed; no blocker at the design-only gate.

## 2026-09-13T04:04Z — Phase 2: source and SDK contract map

HEAD `6d7c561d7a199a67f01e86297758dd6b79dc7cb0`.
Inspected references: all immutable files and released tarball declarations
listed in offline proof; local GitNexus runbook operational indexing route.
Decision: add durable acceptance attempts while preserving generation/queue
strengths. Reject source-summary assumptions about pause/expiry/ownership.
No SDK dependency exists in manifest/lock; public package was inspected in
memory, not installed. Toolchain packages already available at matching pins.
Auth public identity `scribe-dandelion-cult` confirmed without reading secrets.
Alternative rejected: adopting Sol's retry-on-empty-history protocol.
Uncertainty: runtime side-effect fencing needs exclusive process ownership,
not a DB epoch; positive acceptance does not prove durable execution.
Deviation: none in product scope. Next: state/data architecture checkpoint.

## 2026-09-13T04:08Z — Phase 3: state, data and trust boundaries

HEAD `5909150145d3393822e29d081b2c86296a51bba4`.
Authored explicit transitions, owners, transactional/repetition semantics,
22 invariants, generic native tuples/envelopes, attempt ledger, crash table,
primary exclusion and tenant isolation. Every proposed addition preserves
named source properties; source gaps remain explicit.
Rejected alternatives: trusted control envelope; optimistic expiry recovery
after send; implicit session adoption; raw-identifier metrics; lease-only SDK
takeover. Exclusive runtime fencing remains a separate implementation proof,
not supplied magically by owner epochs.
Consistency pass: terminal outcomes have no scheduling exit; accepted has no
retry edge; late evidence goes to reconciliation, not expired ack; every
durable table has an owner. §7 is an explicitly pending next-phase section.
Worktree changes confined to design and journal; no prohibited resource used.
Next bounded action: continuation/HB budgets and completion evidence.

## 2026-09-13T04:10Z — Phase 4: bounded continuation algorithm

HEAD `829c17c1c47b9a147a71fc4f8ea18b1b556147f5`.
Added §7 with independently authorized host budgets, untrusted model
dispositions, user-source heartbeat envelopes, correlated terminal evidence,
busy enqueue bounds, restart/cancellation and exact stop outcomes.
Rejected mandatory new checkpoint-tool ecosystem; optional tool remains a
future decision. Rejected idle-only completion, post-timeout resend and
“progress” based only on elapsed time or tokens. Hard total/time budgets bound
even falsely claimed model progress.
Evidence: released session.js send/sendAndWait distinction and generated
message/turn IDs; no live runtime instantiated. Fake/live independent proof
still required for follow-on behavior; no claim the apparent +1 is solved live.
All changes design/journal only. No prohibited resource accessed.
Next gate: scenario matrix, threat model, rollout, available offline checks.
