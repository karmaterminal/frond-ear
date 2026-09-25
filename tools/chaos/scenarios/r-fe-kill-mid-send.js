/**
 * R-FE-KILL-MID-SEND — SIGKILL while Discord is accepting a reply: the post
 * exists, but the daemon never learned its id. This is the unavoidable
 * ambiguous window. Required: the restarted daemon surfaces the ambiguity,
 * and an identical retry does not create a second Discord message.
 * Class: ambiguous external send.
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
const ROW = "R-FE-KILL-MID-SEND";

export default function () {
  api("POST", "/reset");
  api("POST", "/daemon/start");
  api("POST", "/session/attach");
  waitFor({ kind: "attach" });
  api("POST", "/discord/post", {
    channel: IDS.channel,
    author: IDS.principal,
    content: "status?",
    mention: true,
  });
  waitFor({ kind: "mention" });
  api("POST", "/discord/fault", { holdSends: 1 });
  api("POST", "/session/call", {
    tool: "reply",
    async: true,
    args: { chat_id: IDS.channel, text: "status: all green" },
  });
  if (!barrier("reply is in flight, held at Discord", "held", { count: 1 }))
    return;
  api("POST", "/daemon/stop", { signal: "SIGKILL" });
  api("POST", "/discord/release"); // Discord accepts the post after the daemon died
  barrier("Discord recorded the orphaned post", "posts", { count: 1 });
  api("POST", "/session/detach");
  api("POST", "/daemon/start");
  api("POST", "/session/attach");
  const before = saveLedger(`${ROW}/after-crash`);
  expect(
    "Discord holds the post from the killed daemon",
    before.summary.posts === 1,
    before.outbound,
  );
  const status = api("POST", "/session/call", { tool: "ear_status", args: {} });
  expect(
    "restarted daemon surfaces the ambiguous send",
    status.ok === true &&
      /"ambiguousSends":\s*\[\s*\{/u.test(String(status.text)),
    status.text,
  );
  // The session, unsure whether its reply went out, retries it verbatim.
  const retry = api("POST", "/session/call", {
    tool: "reply",
    args: { chat_id: IDS.channel, text: "status: all green" },
  });
  expect("retry succeeds", retry.ok === true, retry);
  const ledger = saveLedger(ROW);
  expect(
    "identical retry does not duplicate the Discord message",
    ledger.summary.duplicatePosts === 0,
    ledger.outbound,
  );
  expect(
    "the surviving post is receipted after the retry",
    ledger.summary.ambiguous === 0,
    ledger.outbound,
  );
}

export const handleSummary = summaryWriter(ROW, "ambiguous-external-send");
