/**
 * R-FE-CRASH-QUEUED — a crash while events wait in the debounce window loses
 * nothing: after SIGKILL + restart, the queued room chatter is delivered once.
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
const ROW = "R-FE-CRASH-QUEUED";

export default function () {
  api("POST", "/reset");
  api("POST", "/daemon/start");
  api("POST", "/session/attach");
  waitFor({ kind: "attach" });
  api("POST", "/discord/post", {
    channel: IDS.room,
    author: IDS.ambient,
    content: "queued alpha",
  });
  const beta = api("POST", "/discord/post", {
    channel: IDS.room,
    author: IDS.ambient,
    content: "queued beta",
  });
  // Kill the instant both rows are durably queued, i.e. inside the quiet window.
  if (
    !barrier("both rows durably queued", "event-state", {
      messageId: beta.id,
      state: "queued",
    })
  )
    return;
  api("POST", "/daemon/stop", { signal: "SIGKILL" });
  const early = saveLedger(`${ROW}/at-kill`);
  expect(
    "nothing was flushed before the kill",
    early.notifications.every((item) => item.meta.kind !== "room"),
    early.notifications,
  );
  api("POST", "/session/detach");
  api("POST", "/daemon/start");
  api("POST", "/session/attach");
  const room = waitFor({ kind: "room" }, 15000);
  expect("queued chatter delivered after crash", room.found === true);
  expect(
    "both queued messages in the batch",
    room.found &&
      room.notification.content.includes("queued alpha") &&
      room.notification.content.includes("queued beta"),
    room.notification?.content,
  );
  barrier("quiescent", "quiescent");
  const ledger = saveLedger(ROW);
  expect(
    "no event notified twice",
    ledger.summary.maxNotificationsPerEvent === 1,
    ledger.inbound,
  );
}

export const handleSummary = summaryWriter(ROW, "guaranteed");
