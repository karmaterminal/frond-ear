/**
 * R-FE-REVOKE — a channel removed from the config while it has queued
 * events: after the live reload the old ear never receives them, and outbound
 * to the revoked chat is refused.
 * Class: guaranteed (revocation is authoritative).
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
const ROW = "R-FE-REVOKE";

export default function () {
  api("POST", "/reset");
  api("POST", "/daemon/start");
  const posted = api("POST", "/discord/post", {
    channel: IDS.channel,
    author: IDS.principal,
    content: "revoked soon",
    mention: true,
  });
  if (
    !barrier("event durably queued (no session attached)", "event-state", {
      messageId: posted.id,
      state: "queued",
    })
  )
    return;
  api("POST", "/config", { channels: { [IDS.room]: { mode: "room" } } });
  if (
    !barrier("reload revoked the queued event", "event-state", {
      messageId: posted.id,
      state: "dropped",
    })
  )
    return;
  api("POST", "/session/attach");
  expect("canary delivered", waitFor({ kind: "attach" }).found === true);
  barrier("quiescent", "quiescent");
  const leaked = saveLedger(`${ROW}/after-attach`);
  expect(
    "revoked chat is never delivered",
    leaked.inbound[0] && leaked.inbound[0].notified === 0,
    leaked.inbound,
  );
  const reply = api("POST", "/session/call", {
    tool: "reply",
    args: { chat_id: IDS.channel, text: "hello?" },
  });
  expect("outbound to the revoked chat is refused", reply.ok === false, reply);
  const ledger = saveLedger(ROW);
  expect(
    "queued event dropped, not delivered",
    ledger.inbound[0] && ledger.inbound[0].state === "dropped",
    ledger.inbound,
  );
  expect(
    "nothing posted to Discord",
    ledger.summary.posts === 0,
    ledger.outbound,
  );
}

export const handleSummary = summaryWriter(ROW, "guaranteed");
