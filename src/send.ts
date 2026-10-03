// `frond-ear send`: post one message from a script, such as seat-pulse's outage alerts (#47).
// A thin client of the daemon's `reply` tool, so the daemon still does everything a session's
// reply gets: it holds the bot token, sends only to chats an ear serves, chunks long text, and
// reuses the nonce when an unconfirmed send is retried. A CLI client is never an ear's attached
// session, so a send marks nothing seen.
import { parseArgs } from "node:util";

import { request } from "./client.ts";
import type { Io } from "./onboard.ts";

const USAGE = "usage: frond-ear send --chat <id> [--] <text…>";

/**
 * Exit 0 once Discord has confirmed every message, 1 when the daemon refused or failed the
 * send or gave no answer, 2 for bad usage (the daemon is not contacted). The receipt goes to
 * stdout; every failure goes to stderr, so a script that drops stdout still logs why.
 */
export async function runSend(
  argv: string[],
  io: Pick<Io, "stdout" | "stderr" | "env">,
): Promise<number> {
  let chat: string | undefined;
  let text: string;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { chat: { type: "string" } },
    });
    chat = values.chat;
    text = positionals.join(" ");
  } catch (error) {
    io.stderr.write(
      `frond-ear send: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`,
    );
    return 2;
  }
  if (!chat || text.trim() === "") {
    io.stderr.write(
      `frond-ear send: --chat and message text are required\n${USAGE}\n`,
    );
    return 2;
  }
  let result: { ok: boolean; text: string };
  try {
    result = await request(
      { type: "call", tool: "reply", args: { chat_id: chat, text } },
      io.env,
    );
  } catch (error) {
    io.stderr.write(
      `frond-ear send: no answer from the daemon (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return 1;
  }
  if (!result.ok) {
    io.stderr.write(`frond-ear send: ${result.text}\n`);
    return 1;
  }
  io.stdout.write(`${result.text}\n`);
  return 0;
}
