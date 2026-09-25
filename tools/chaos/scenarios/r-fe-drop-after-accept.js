/**
 * R-FE-DROP-AFTER-ACCEPT — Discord accepts a reply but the HTTP response is
 * lost. The tool reports failure; the session retries the identical text.
 * Required: no duplicate Discord message, and the tool error says the send is
 * ambiguous rather than failed.
 * Class: ambiguous external send.
 */
import {
  api,
  expect,
  IDS,
  rowOptions,
  saveLedger,
  summaryWriter,
  waitFor,
} from "../lib/controller.js";

export const options = rowOptions();
const ROW = "R-FE-DROP-AFTER-ACCEPT";

export default function () {
  api("POST", "/reset");
  api("POST", "/daemon/start");
  api("POST", "/session/attach");
  waitFor({ kind: "attach" });
  api("POST", "/discord/post", {
    channel: IDS.channel,
    author: IDS.principal,
    content: "ping",
    mention: true,
  });
  waitFor({ kind: "mention" });
  api("POST", "/discord/fault", { dropAfterAccept: 1 });
  const first = api("POST", "/session/call", {
    tool: "reply",
    args: { chat_id: IDS.channel, text: "pong" },
  });
  expect("first attempt reports an error", first.ok === false, first);
  expect(
    "the error says the send may have happened",
    /may (already )?have been (sent|posted)/iu.test(String(first.text)),
    first.text,
  );
  const retry = api("POST", "/session/call", {
    tool: "reply",
    args: { chat_id: IDS.channel, text: "pong" },
  });
  expect("retry succeeds", retry.ok === true, retry);
  const ledger = saveLedger(ROW);
  expect(
    "no duplicate Discord message",
    ledger.summary.duplicatePosts === 0,
    ledger.outbound,
  );
  expect(
    "the post is receipted",
    ledger.summary.ambiguous === 0,
    ledger.outbound,
  );
}

export const handleSummary = summaryWriter(ROW, "ambiguous-external-send");
