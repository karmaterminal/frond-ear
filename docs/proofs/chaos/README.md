# Chaos proof records

These are the recorded runs of `tools/chaos/run-proof.sh`. It runs Grafana k6 v2.0.0 rows against the chaos controller, on Node v26.10.0. The method, the barriers and the ledger format are described in [`tools/chaos/README.md`](../../../tools/chaos/README.md).

Each directory is named after the exact candidate SHA and holds:

- `RESOLVED-SHA.md`: identity and toolchain;
- `RESULTS.md`: the verdict table;
- per row, `receipt.json` (the named checks) and `ledger.json` (the event-by-event ledger).

Every run had zero modified tracked files.

## Runs

| Candidate                                                                                         | Product code                                        | Result                    |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------- |
| [`96cd44afe9561750e9123abad7aec8d665ffaf82`](96cd44afe9561750e9123abad7aec8d665ffaf82/RESULTS.md) | identical to `5d5bbe1` (harness only)               | 4 / 7 rows PASS-candidate |
| [`4eb98ba27b3befc9d65553cfe68d9286eed6fe80`](4eb98ba27b3befc9d65553cfe68d9286eed6fe80/RESULTS.md) | crash-safe shutdown plus idempotent ambiguous sends | 7 / 7 rows PASS-candidate |
| [`8215213d519ab83ec4b5ad89700beaebb4972946`](8215213d519ab83ec4b5ad89700beaebb4972946/RESULTS.md) | identity binding and re-entry (#21); regression run | 7 / 7 rows PASS-candidate |

## What the baseline run proved

- **Recovery that is guaranteed and held at baseline:**
  - duplicate Gateway replay: accepted once, notified once;
  - a crash inside the debounce window: delivered once after restart;
  - a crash after delivery but before acting: a digest, not a replay, and `inbox` still returns the event;
  - channel revocation: never delivered, and outbound refused.
- **R-FE-SHUTDOWN-DRAIN failed: the daemon exited 1 on SIGTERM.**
  - Client sockets close asynchronously after the CLI has closed SQLite.
  - `detach()` then ran `revertUnconfirmed` on the closed database.
  - The drain was also not observable (there was no `daemon.draining` log), so the held send outlived it. It was posted to Discord without a receipt, and the event stayed `offered`.
- **R-FE-KILL-MID-SEND and R-FE-DROP-AFTER-ACCEPT failed: ambiguous external sends.**
  - Discord held the post, but the daemon had no record of it.
  - An identical retry posted a **duplicate**.
  - Nothing surfaced the ambiguity: `ear_status` showed nothing, and the tool error was a bare `fetch failed`.

## After the patch (`4eb98ba`)

- **Shutdown** reverts unconfirmed batches while the store is still open. It then stops ledger writes before connections close, and logs `daemon.draining`. The exit is clean, and the drained reply is receipted and acknowledged.
- **Every send** writes an outbound intent with a nonce _before_ calling Discord, and sends it with `enforce_nonce`.
  - An ambiguous intent is reported in `ear_status.ambiguousSends`, and as a `send_check` notice on reattach.
  - The tool error says the message may already have been posted.
  - An identical retry reuses the pending nonce. Discord returns the original message: one post, now receipted.
- **Honest limit:** an ambiguous send stays ambiguous until something resolves it. De-duplication only covers retries inside Discord's nonce window (frond-ear uses 5 minutes).
