# frond-ear v1 sidecar receipt

## Outcome

Implemented the durable Discord conversation-to-Copilot session registry and
sidecar boundary for `karmaterminal/frond-ear#1`.

- Guild channel/thread and DM channel identities receive persistent immutable
  binding generations and dedicated Copilot session IDs.
- Authorized Discord `/new` and direct loopback rotation atomically retire the
  predecessor, dead-letter its pending/leased events, and create the successor.
  Durable ingress dispositions keep replay behavior stable across policy
  changes.
- Lease selection and acknowledgement are generation-fenced. Global wake pause
  and per-binding pause preserve pending work.
- The SDK adapter owns a bounded session cache, create/resume lifecycle,
  end-to-end setup/enqueue deadline, pre-send lease check, explicit retry or
  ambiguity dead-letter behavior, and structured redacted delivery logs.
- Loopback API/CLI operations cover list, inspect, rotate, pause, resume, and
  capability status. A hardened dedicated systemd sidecar unit was added.
- The service does not send Discord messages.

## Named refs

Evidence was frozen before this receipt-only commit.

| Category | Named ref | Full SHA | Local / tracking / server |
| --- | --- | --- | --- |
| Product/base | workorder exact v0 | `08b1b0245360d9ad27b153e62f7fa3f6fd8681fb` | local object verified; required immutable base |
| Safe lane | `codeagent/frond-ear-copilot-sidecar-v1` | `cbe04e737b68d2d62e251b91c2fde39c98403459` | equal / equal / equal |
| CI/workflow | N/A | N/A | Workorder requires no GitHub Actions |
| Presentation | N/A | N/A | No PR or presentation ref requested |
| Docs/proof | `codeagent/frond-ear-copilot-sidecar-v1` evidence freeze | `cbe04e737b68d2d62e251b91c2fde39c98403459` | equal / equal / equal |

## SDK capability evidence

- Installed Copilot CLI: `1.0.84-4`.
- Public npm SDK inspected: `@github/copilot-sdk@1.0.13`.
- SDK tarball SHA-256:
  `238147f38bb7597bdd6864445e27137475ec034c831efb555655f3db28d50b3b`.
- The SDK package bundles Copilot CLI `1.0.83`.
- Released `MessageOptions` supports `mode: "enqueue"` but does not expose
  `source: "system"`. Upstream `main` documentation describes `source`, but the
  released package types are authoritative for deployment.
- Production capability therefore reports unavailable and takes no lease. It
  never downgrades to user provenance or fakes acceptance.
- No live SDK smoke was run: sending without the required released
  system-source contract would not be a valid or safe proof.
- GitNexus was invoked through the installed MCP integration, but `frond-ear`
  has no fork index in that installation. The implementation used the explicit
  direct-source fallback; no stock npm/npx GitNexus was substituted.

## Validation

Acceptance path: **focused-only**. This repository has no shard configuration,
and the workorder explicitly prohibits GitHub Actions.

- Focused owner proof:
  `pnpm build >/dev/null && node --test --test-concurrency=1 dist/test/copilot-sidecar.test.js dist/test/http-adapter.test.js`
  — 17 passed, 0 failed.
- Repository regression run (supporting evidence, not broad acceptance):
  `pnpm test` — 37 passed, 0 failed.
- `pnpm format:check` — passed.
- `pnpm typecheck` — passed.
- `pnpm scan:credentials` — passed.
- `git diff --check` — passed.
- Internal P1 review of `15d4e9973423190271c0d711989ac2b5ce7ae451`
  found no P1 and two P2 races. Both were repaired in
  `cbe04e737b68d2d62e251b91c2fde39c98403459`.

## Repair evidence

| Finding | Owning invariant/boundary | Rejected-SHA negative control | Successor proof | Sibling/failure coverage |
| --- | --- | --- | --- | --- |
| SDK setup could outlive a recovered lease and then send | `CopilotSdkAdapter.deliver` must cover setup and enqueue with one deadline; `EventStore.isLeaseActive` must confirm generation and sufficient remaining lease immediately before send | On `15d4e9973423190271c0d711989ac2b5ce7ae451`, delayed client startup followed by lease recovery sent once (`1 !== 0`) | `expired lease during SDK setup prevents the delayed session send`; `SDK setup timeout cannot continue into send or cache mutation` | Enqueue while busy, rejection retry, ambiguous send timeout dead-letter, shutdown cleanup, rotation while leased |
| Replayed `/new` changed meaning after authorization policy reload | `EarService.ingest` must consult an immutable SQLite ingress disposition before current policy; rotation records it in the same transaction | On `15d4e9973423190271c0d711989ac2b5ce7ae451`, authorized replay after policy removal returned `inserted` instead of `duplicate_control` | `new command replay keeps its original disposition across policy changes` | Unauthorized-to-authorized replay, duplicate event replay, idempotent rotation request, restart persistence |

The negative controls ran from an isolated detached worktree at the exact
rejected SHA with the same-host dependency tree. Both failed for the expected
reasons; the successor focused tests pass.

## Scope and uncertainty

Sixteen files differ from v0. No PR was opened, no service was deployed, no
live Discord/Copilot process or MCP configuration was touched, and no message
was posted to the continuation room. Automatic Copilot delivery remains
intentionally unavailable until a released SDK exposes and supports both
system-source provenance and enqueue delivery.
