/**
 * R-FE-SHUTDOWN-DRAIN — SIGTERM while a reply is still in flight to Discord:
 * shutdown drains it, so the post, its receipt and the acknowledgement are all
 * durable before SQLite closes.
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
const ROW = "R-FE-SHUTDOWN-DRAIN";

export default function () {
  api("POST", "/reset");
  api("POST", "/daemon/start");
  api("POST", "/session/attach");
  waitFor({ kind: "attach" });
  api("POST", "/discord/post", {
    channel: IDS.channel,
    author: IDS.principal,
    content: "answer me",
    mention: true,
  });
  const mention = waitFor({ kind: "mention" });
  barrier("mention batch confirmed", "batch-confirmed", {
    messageId: mention.notification.meta.message_id,
  });
  api("POST", "/discord/fault", { holdSends: 1 });
  api("POST", "/session/call", {
    tool: "reply",
    async: true,
    args: {
      chat_id: IDS.channel,
      text: "drained reply",
      batch_id: mention.notification.meta.batch_id,
    },
  });
  if (!barrier("reply is in flight, held at Discord", "held", { count: 1 }))
    return;
  // SIGTERM; Discord answers only once the daemon has logged it is draining.
  const stop = api("POST", "/daemon/stop", {
    signal: "SIGTERM",
    releaseOnDraining: true,
  });
  expect(
    "Discord answered only after the drain began",
    stop.releasedAfterDrainStarted === true,
    stop,
  );
  expect(
    "daemon exited cleanly after draining",
    stop.exit && stop.exit.code === 0,
    stop,
  );
  api("POST", "/daemon/start");
  const ledger = saveLedger(ROW);
  expect(
    "exactly one post reached Discord",
    ledger.summary.posts === 1,
    ledger.outbound,
  );
  expect(
    "the post has a durable receipt",
    ledger.summary.ambiguous === 0,
    ledger.outbound,
  );
  expect(
    "the answered event is seen",
    ledger.inbound[0] && ledger.inbound[0].state === "seen",
    ledger.inbound,
  );
}

export const handleSummary = summaryWriter(ROW, "guaranteed");
