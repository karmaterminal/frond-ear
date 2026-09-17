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

## 2026-09-13T04:14Z — Phase 5: proof, threats, rollout and slices

HEAD `65f1c1ea9f17160bb482d65d486d1031d41f777a`.
Completed observability, threat-boundary/prevention/detection/recovery/residual
matrix, rollout/rollback, twelve dependency-ordered future slices, twelve
explicit decisions, fake SDK scenario specification and separate disposable
canary plan. Live status remains NOT RUN — REQUIRES SEPARATE OPT-IN.
Existing source tests executed under sanitized environment and project-local
fixture root: compiler exit 0; 37/37 pass, no skips. Same installed pinned
compiler/types used without dependencies in lane worktree or installation.
This validates unchanged current behavior, not proposed v2 implementation.
Decision: output-based bounded untrusted disposition avoids requiring new
custom tools; its semantics and runtime correlation remain explicit proof gates.
Uncertainty: lifetime/suspension fence and live continuation unproved; future
activation blocked until relevant proofs, not hidden under offline success.
No product/dependency mutation, credential/primary access or live sources.
Next bounded action: formatting/scanner, exact-worktree GitNexus, independent
second-model design review. Worktree currently dirty only in allowed documents.

### 2026-09-13T04:13:08Z — validation and journal precision

Phase 5; HEAD `65f1c1ea9f17160bb482d65d486d1031d41f777a`.
Earlier phase-heading times were minute estimates; Phase 5 heading 04:14Z
was ahead of actual command time 04:12:51Z. This exact observed-time entry
corrects that timestamp, without changing prior reasoning entries.
Repository formatter passed all source/proof files but found three indentation
lines in the journal's first nested list. Apply only that formatter indentation;
no words or prior reasoning are removed. This is a disclosed mechanical
deviation from byte-literal append-only, retaining semantic append-only history
and every original committed entry in git. No broader journal rewrite.
Next: publish proof/checkpoint and exact index. No prohibited resources used.

## 2026-09-13T04:20:30Z — Phase 6: independent exact-diff review

HEAD `e14e717dc2f3baaea5e3b80c66a56c5fe7e6daa9`; local/tracking/server equal;
clean before review repair. Exact-worktree fork GitNexus has fresh matching
meta, graph/FTS, nonempty lbug. detect_changes: 54 markdown sections, four
files, zero changed code symbols/affected flows. No unrelated-index fallback.
Claude Sonnet 5 reviewed exact diff: 26 PASS, heartbeat consistency conditional.
F1 is repaired before declaration: terminal real-work suppression is distinct
from same-reservation non-real idle deferral. F2 whitespace/timestamp deviation
accepted as disclosed; F3 independent SDK re-fetch not claimed; F4 future
canary unknowns remain explicitly unproved. Offline proof holds full receipt.
Synchronous review occupied the interval after index (04:13:58Z) until
04:20:30Z; this exceeded the 385-second in-agent liveness ceiling by about seven
seconds using that evidence-action anchor. Disclosed watchdog cadence deviation;
no prohibited action or two-interval stall occurred. Future review should return
with a bounded cadence. No uncertainty laundered as successful runtime proof.
Next bounded action: publish corrected diff, reindex and narrowly re-review F1
plus exact amended checklist. No prohibited resources touched.

## 2026-09-13T04:25:28Z — Phase 6 closure and Phase 7 checks

HEAD `72ff2a2c43ab4a2c19b05fd146dded87b52ffd7e`,
tree `a1c96a6d4a8ff2b7c6a5dedc0be1b1fcfca83f31`; clean;
local/tracking/server equality reverified. Claude Sonnet 5 follow-up: F1
resolved, design-level PASS, prior 26 PASS unchanged. Updated index meta matches
HEAD; 56 markdown sections, four changed files, zero affected flows/code symbols.
Offline proof now records exact amended index/review/checklist and D12 closure.
Existing tests 37/37 pass again; exact noEmit/format/scanner/scope checks pass.
Generated index caused one intermediate formatter failure; removed diagnostic
index and reran without changing product source. Proof states that failure.
No further substantive design/canary edits; remaining commits are receipts only.
No prohibited resources used. Next: publish receipts, capture hashes, append
declare-done, final local/tracking/server equality. Future D01–D11 gates remain.

## 2026-09-13T04:26:53Z — Phase 7 declare-done

**Lane: FROND-EAR-CONTINUATION-DESIGN-v2. Status: COMPLETE (design/evidence
scope only), with disclosed execution deviations below.**

Evidence-freeze HEAD `cd67f74a867be3c0bc4c232679f7b6b27e2ad473`;
tree `53b110e872d3116cf1a8455601a2b998bd455f03`.
Local HEAD, origin tracking and server branch all equal that full SHA;
porcelain empty before this declaration. This final journal-only commit is the
terminal declaration; its own commit/tree identities are resolved from git
objects and returned in the dispatch receipt, not self-referential text.
Final push must again verify local/tracking/server equality and clean worktree.

Source `codeagent/frond-ear-copilot-sidecar-v1` remains
`36fd00980eda5f89a8fd3d1ef7c963a9bf03550d`,
source tree `8d9471005ba210b3bf2195c9b1b5ea1018803923`.
Output branch `design/frond-ear-continuation-astra-v2`.
Exact base→tip changed paths:

1. `docs/frond-ear-continuation-design-v2.md`
2. `docs/proofs/frond-ear-continuation-design-v2-offline.md`
3. `docs/proofs/frond-ear-continuation-design-v2-live-canary-plan.md`
4. `tmp-drop-me-frond-ear-continuation-design-v2.md`

Final document SHA-256 values (unchanged by this journal-only declaration):

| Document         | SHA-256                                                            |
| ---------------- | ------------------------------------------------------------------ |
| Design           | `b84340b996a76dc511ca9a12aabf81befdc579046beccbaccb6b64e4d9251e84` |
| Offline proof    | `541fb10ec30d1ae8cb7d0d9664e224cb7c7c5c230f1acc159ae6881454dc58dd` |
| Live-canary plan | `93a45c2983e72c76ec387591a78c414c60bf0176f083bbeadbda042be298ca67` |

Checkpoint commit list, in order (this declaration adds the final commit):

```text
6d7c561d7a199a67f01e86297758dd6b79dc7cb0 phase 0/1 journal
5909150145d3393822e29d081b2c86296a51bba4 phase 2 byte/SDK map
829c17c1c47b9a147a71fc4f8ea18b1b556147f5 phase 3 state/trust
65f1c1ea9f17160bb482d65d486d1031d41f777a phase 4 continuation
e14e717dc2f3baaea5e3b80c66a56c5fe7e6daa9 phase 5 proof/rollout
72ff2a2c43ab4a2c19b05fd146dded87b52ffd7e phase 6 review repair
cd67f74a867be3c0bc4c232679f7b6b27e2ad473 amended review/check receipts
```

Phase summary: immutable source/unchanged-origin publication proved; all current
source/tests and released SDK mapped; explicit state/data/tenant/trust design
authored; finite untrusted heartbeat protocol defined; independent offline and
live proof classes separated; Claude Sonnet 5 exact-diff review and follow-up
passed after F1 repair; final artifact hashes and publication identities checked.

Checks: existing 37 tests passed with no skips/failures; TypeScript build and
noEmit passed using existing matching dependencies; repository Prettier,
credential-pattern scanner, diff whitespace and document structure/scope checks
passed. Exact commands, tested SHAs, output limitations and the intermediate
generated-index formatting failure are in offline proof. No dependency mutation.
Offline mechanical status: PASS for existing checks and design specification;
the proposed v2 fake harness is not implemented or claimed executed.

SDK: released `@github/copilot-sdk@1.0.13`, bundled CLI 1.0.83; tarball SHA-256
`238147f38bb7597bdd6864445e27137475ec034c831efb555655f3db28d50b3b`;
verified integrity
`sha512-/j6/tGc9HOtcupuYFloOKk0fpScdpy65EVF1LKg2Z2VQOojCGPgBGkhgVGVDaqW7UB6TV2qbQZa9rKJimJ0wWQ==`.
Public types/implementation support user-source sends; no installed live
runtime was inspected. Acceptance identity ≠ completed turn ≠ durable
exactly-once execution. Ambiguity remains fail-closed.

Review: Claude Sonnet 5, two bounded exact-diff passes; amended review
`72ff2a2c43ab4a2c19b05fd146dded87b52ffd7e`, checklist all 27 PASS after repair.
Exact-worktree fork index matched that head; 56 Markdown section nodes across
four changed files, zero changed code symbols/affected flows, low graph risk.
Code impact/context N/A; graph is not architecture proof. Subsequent commits
change only review/check/declaration receipts, not substantive design/canary.

Live-canary status: **NOT RUN — REQUIRES SEPARATE OPT-IN**.
No implementation/canary/production readiness implied.
Unresolved future decisions: D01 acceptance durability; D02 runtime/suspension
fence; D03 completion correlation; D04 disposition interface; D05 isolation
settings; D06 tenant control auth; D07 Teams API; D08 priority/context merge;
D09 bounds/retention; D10 legacy ownership migration; D11 live version
compatibility. D12 exact-index/independent review is closed by offline receipt.
Each future gate has owner/default/proof in the design. Any failure blocks the
relevant implementation activation/canary/production stage, never fallback.

Ordered future slices: (1) generic types/envelope, (2) tenant migration,
(3) attempts/ambiguity ledger, (4) user-source SDK adapter, (5) ownership and
primary exclusion, (6) continuation/HB, (7) deterministic lifecycle harness,
(8) Discord migration, (9) Teams skeleton, (10) disposable canary command,
(11) observability/reconciliation, (12) separately gated rollout/cutover.

Execution deviations: three journal indentation lines normalized without
word/history deletion (independent review accepted); estimated phase-heading
time corrected by append-only observed-time receipt; one synchronous-review
liveness gap about seven seconds beyond the 385-second ceiling. These remain
visible in proof/journal; no claim of perfect procedural compliance.

Confirmed: no product implementation, dependency mutation, deployment, PR,
cutover, live Discord/Teams connection, credential-value/file read,
primary-session access, issue/project/chat changes, force-push, rebase or squash.
Only authorized source/public SDK reads and origin checkpoint publication.
Sol branch/artifact never mutated. Final verification remains bounded to the
lane refs/documents/checks; no new design work or external action.

## 2026-09-17T04:20:10Z — detached-review successor repair

Status: IN PROGRESS, design/evidence only. The rejected immutable input is
`d949d3dd0521b3797155a2868173d6cc18c6f41f`, tree
`2ad44bba4d7361ebacd7c5ee598e2562b29c4bf3`. The isolated successor branch is
`cael/20260916/p92-frond-ear-design-successor`; its worktree was clean at that
base before the first edit. The reviewed design branch itself remains untouched.

The non-author exact-head review returned REQUEST CHANGES — HIGH risk despite
37/37 repository checks passing. This successor closes only the three recorded
defects: normative `silent`/`mentions`/`room` collection-versus-wake policy;
exact `Control` ownership and atomic source-disposition/rotation-request
binding; and restoration/retention of this required append-only journal so the
final evidence contract no longer cites a deleted artifact.

The journal bytes through the prior declaration were restored exactly from
commit `2914efe829c619e0cec93933645989df87431806` and this entry was appended.
No earlier journal entry was rewritten. The offline proof now records the
rejected object and bounded repair without claiming the old independent review
accepts this successor. A fresh non-author exact-head review is still required.

No product source, tests, dependency, policy, deployment or workflow file is
being changed. No credentials, primary session, live Discord/Teams source,
canary, deployment, cutover, issue/project mutation, force-push, rebase or
squash is authorized. Next: format/check the three changed design/evidence
paths plus restored journal, run full repository checks, freeze exact commit
and tree, publish the successor branch, then append the final identity receipt.

### 2026-09-17T04:20:56Z — repaired-byte validation

The restored 292-line journal prefix is byte-identical to commit
`2914efe829c619e0cec93933645989df87431806`; `RESTORED_PREFIX_EXACT` passed.
Only the design, offline proof and restored journal differ from rejected base
`d949d3dd0521b3797155a2868173d6cc18c6f41f`; the canary plan is unchanged.

`pnpm check` passed: Prettier, TypeScript noEmit/build, 37/37 tests and the
34-file credential-pattern scan. `git diff --check` passed. No dependency or
lockfile changed; project-local `node_modules` is ignored tool state only.

Pre-freeze document SHA-256 values:

- design: `6a17a1c0d1c75b9fb69b7a2622b72ee9fd0c396feeca8e2d585203c46a89c28b`
- offline proof: `61ac6769c70af8533da5fd4c812c274685b5d1f61cdb2c901f525e0118306b8a`
- unchanged live-canary plan: `93a45c2983e72c76ec387591a78c414c60bf0176f083bbeadbda042be298ca67`

Next: freeze the repair commit, re-run exact-head checks, publish the branch,
then append a final journal-only identity declaration and request independent
successor-bound review. No review acceptance is claimed by this author entry.
