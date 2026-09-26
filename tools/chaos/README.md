# frond-ear chaos proof rows (Grafana k6)

These rows are deterministic crash and restart proofs for the **real** frond-ear daemon process. They follow the k6 proof-row method in `karmaterminal/karmaterminal-openclaw-docs` (`tools/k6-proofs`):

- each row is a single-VU `shared-iterations` scenario;
- every assertion is a named `check`, and `proof_failures` must stay at `count==0`;
- each row writes a receipt and a summary JSON.

Output is `PASS-candidate` or `FAIL`. Folding a result into a canonical corpus needs review.

No row touches real Discord or a real Claude session.

## Division of labour

| Piece                                   | Role                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenarios/*.js` (k6)                   | Drives the scenario over HTTP and asserts with checks. It has no sleeps: every wait is a barrier on observable state.                                    |
| `controller.ts` (the companion process) | Owns everything a k6 VU cannot do, listed in the table below.                                                                                            |
| `run-proof.sh`                          | Records the SHA and toolchain, starts the controller, runs each row with k6, and writes `RESULTS.md` along with the per-row receipt, ledger and summary. |

What `controller.ts` owns:

| Area                 | What it does                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fake Discord Gateway | A WebSocket server with a sequenced dispatch log. It replays on `RESUME`, and replay from any sequence can be forced.                                                                                                  |
| Fake Discord REST    | Fault injection: hold a send, or drop the connection after Discord accepted it. It also implements `enforce_nonce` de-duplication.                                                                                     |
| Daemon supervisor    | Starts the real daemon (`node src/cli.ts daemon`) and stops it with SIGTERM or SIGKILL. Start returns only after the gateway has completed IDENTIFY or RESUME.                                                         |
| Fake Claude session  | Runs the real shim under the official MCP SDK client and records every `<channel>` notification. It acknowledges the attach canary.                                                                                    |
| Barriers             | `event-state`, `batch-confirmed`, `counter`, `held`, `posts`, `quiescent`, and `stop … releaseOnDraining` (Discord answers only after the daemon logs `daemon.draining`). A barrier that is not reached fails the row. |
| Ledger               | One record per event, described in the next section.                                                                                                                                                                   |

## The ledger

`GET /ledger` is the evidence each row saves as `<ROW>/ledger.json`.

For each **inbound** Discord message it records:

- how many rows were accepted;
- the final ledger state;
- the batch;
- how many notifications carried it, and of which kind.

For each **outbound** post Discord actually received, it records:

- the nonce;
- whether frond-ear holds a durable receipt;
- the classification: `receipted` or `ambiguous-unreceipted`;
- a duplicate count.

It also includes the daemon's outbound intents, its counters, and gateway resumes.

## Rows

| Row                    | Scenario                                                                                       | Class                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| R-FE-REPLAY            | Discord replays already-seen dispatches (forced resume from seq 0), then SIGKILL and a restart | guaranteed: accepted once, notified once                                                 |
| R-FE-CRASH-QUEUED      | SIGKILL while events wait in the debounce window                                               | guaranteed: delivered once after restart                                                 |
| R-FE-CRASH-UNSEEN      | SIGKILL after delivery, before the session acted                                               | guaranteed: digest on reattach, not a replay; `inbox` returns the event                  |
| R-FE-SHUTDOWN-DRAIN    | SIGTERM while a reply is held at Discord                                                       | guaranteed: drained, receipted and acknowledged before SQLite closes; clean exit         |
| R-FE-REVOKE            | Channel removed from config while an event is queued for it                                    | guaranteed: never delivered to the old ear; outbound refused                             |
| R-FE-KILL-MID-SEND     | SIGKILL while Discord is accepting a reply                                                     | **ambiguous external send**: surfaced after restart; an identical retry is de-duplicated |
| R-FE-DROP-AFTER-ACCEPT | Discord accepts, the response is lost                                                          | **ambiguous external send**: the tool says so; an identical retry is de-duplicated       |

### Guaranteed vs ambiguous

Inbound events are **guaranteed**. Admission is one transaction, the cursor only advances after a durable ingest, delivery is at least once to the ledger, and each event is notified once.

An outbound post is **ambiguous** whenever Discord may have accepted it but frond-ear never saw the response: a crash, a lost response, or a drain timeout. frond-ear cannot turn that into a guarantee. What it does instead:

1. It records a write-ahead intent with a nonce **before** calling Discord.
2. It sends that nonce with `enforce_nonce`.
3. It reports unresolved intents in `ear_status.ambiguousSends` and in a `send_check` notice on reattach.
4. It reuses the pending nonce when the identical text is retried within 5 minutes, so Discord returns the original message instead of posting twice.

Outside Discord's de-duplication window, a retry can still duplicate. The session is told to check with `fetch_messages` first.

## Running

```sh
pnpm install
# k6 v2.x on PATH (or K6_BIN=/path/to/k6)
tools/chaos/run-proof.sh [artifact-dir] [row ...]   # default: artifacts/chaos/<HEAD SHA>
```

The controller can also be driven by hand:

```sh
node tools/chaos/controller.ts --port 7788
curl -XPOST localhost:7788/daemon/start
```
