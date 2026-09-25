/**
 * R-FE-REPLAY — duplicate Gateway replay is idempotent.
 * Discord replays already-seen dispatches (forced resume from seq 0, then a
 * SIGKILL + restart that resumes from the persisted cursor). Every inbound
 * message must be accepted exactly once and notified exactly once.
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
const ROW = "R-FE-REPLAY";

export default function () {
  api("POST", "/reset");
  api("POST", "/daemon/start");
  api("POST", "/session/attach");
  expect("canary delivered", waitFor({ kind: "attach" }).found === true);
  for (const text of ["one", "two", "three"]) {
    const posted = api("POST", "/discord/post", {
      channel: IDS.channel,
      author: IDS.principal,
      content: `replay ${text}`,
      mention: true,
    });
    expect(
      `mention "${text}" notified`,
      waitFor({ kind: "mention", contains: `replay ${text}` }).found === true,
    );
    barrier(`"${text}" batch confirmed`, "batch-confirmed", {
      messageId: posted.id,
    });
  }
  // Discord replays everything from the start of the session: all three
  // arrive again and must be recognised as duplicates.
  api("POST", "/discord/reconnect", { resumeFrom: 0 });
  barrier("replayed dispatches seen as duplicates", "counter", {
    name: "duplicates",
    min: 3,
  });
  // Crash and restart; the daemon resumes from its persisted cursor.
  api("POST", "/daemon/stop", { signal: "SIGKILL" });
  api("POST", "/daemon/start");
  const four = api("POST", "/discord/post", {
    channel: IDS.channel,
    author: IDS.principal,
    content: "replay four",
    mention: true,
  });
  barrier(
    "post-restart event delivered",
    "batch-confirmed",
    { messageId: four.id },
    15000,
  );
  barrier("quiescent", "quiescent");
  const ledger = saveLedger(ROW);
  expect(
    "every inbound event accepted exactly once",
    ledger.summary.acceptedUnique === true,
    ledger.inbound,
  );
  expect(
    "no event notified twice",
    ledger.summary.maxNotificationsPerEvent === 1,
    ledger.inbound,
  );
  expect(
    "Discord replay actually happened",
    ledger.gateway.resumes.length >= 1,
    ledger.gateway,
  );
  expect(
    "post-restart event accepted",
    ledger.inbound.every((item) => item.acceptedRows === 1),
    ledger.inbound,
  );
}

export const handleSummary = summaryWriter(ROW, "guaranteed");
