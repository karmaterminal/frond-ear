/**
 * R-FE-CRASH-UNSEEN — a crash after an event was delivered but before the
 * session acted on it: the event is not replayed as a fresh notification, the
 * reattached session gets a digest, and inbox still returns it.
 * Class: guaranteed recovery.
 */
import {
  api,
  barrier,
  expect,
  IDS,
  rowOptions,
  saveLedger,
  summaryWriter,
  waitFor,
} from "../lib/controller.js";

export const options = rowOptions();
const ROW = "R-FE-CRASH-UNSEEN";

export default function () {
  api("POST", "/reset");
  api("POST", "/daemon/start");
  api("POST", "/session/attach");
  waitFor({ kind: "attach" });
  const posted = api("POST", "/discord/post", {
    channel: IDS.channel,
    author: IDS.principal,
    content: "please look later",
    mention: true,
  });
  expect("mention delivered", waitFor({ kind: "mention" }).found === true);
  if (
    !barrier("shim confirmed the batch", "batch-confirmed", {
      messageId: posted.id,
    })
  )
    return;
  api("POST", "/daemon/stop", { signal: "SIGKILL" });
  api("POST", "/session/detach");
  api("POST", "/daemon/start");
  api("POST", "/session/attach");
  const digest = waitFor({ kind: "digest" });
  expect("reattach digest announces the unseen event", digest.found === true);
  const inbox = api("POST", "/session/call", { tool: "inbox", args: {} });
  expect(
    "inbox still returns the event",
    inbox.ok === true && String(inbox.text).includes("please look later"),
    inbox,
  );
  const ledger = saveLedger(ROW);
  expect(
    "event notified once (digest, not replay)",
    ledger.summary.maxNotificationsPerEvent === 1,
    ledger.inbound,
  );
  expect(
    "event now seen",
    ledger.inbound[0] && ledger.inbound[0].state === "seen",
    ledger.inbound,
  );
}

export const handleSummary = summaryWriter(ROW, "guaranteed");
