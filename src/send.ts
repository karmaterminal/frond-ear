// `frond-ear send`: post a message from a script, such as seat-pulse's outage alerts (#47).
// A thin client of the daemon's `reply` tool, so the daemon still does everything a session's
// reply gets: it holds the bot token, sends only to chats an ear serves, chunks long text, and
// reuses the nonce when an unconfirmed send is retried. A CLI client is never an ear's attached
// session, so a send marks nothing seen.
import { parseArgs } from "node:util";

import { DaemonTimeoutError, request } from "./client.ts";
import type { Io } from "./onboard.ts";

const USAGE = "usage: frond-ear send --chat <id> [--] <text…>";
/**
 * Long enough for Discord's rate-limit retries (the daemon's REST client retries a 429 up
 * to three times, each after Discord's retry_after); short enough that a wedged daemon fails
 * the send with a reason before a caller's own timeout kills it without one (seat-pulse
 * allows 60 s).
 */
const SEND_TIMEOUT_MS = 30_000;

/**
 * Exit 0 once Discord has confirmed every message, 1 when the daemon refused or failed the
 * send or gave no answer, 2 for bad usage (the daemon is not contacted). The receipt goes to
 * stdout; every failure goes to stderr, so a script that drops stdout still logs why.
 */
export async function runSend(
  argv: string[],
  io: Pick<Io, "stdout" | "stderr" | "env">,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<number> {
  let chats: string[];
  let text: string;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { chat: { type: "string", multiple: true } },
    });
    chats = values.chat ?? [];
    text = positionals.join(" ");
  } catch (error) {
    io.stderr.write(
      `frond-ear send: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`,
    );
    return 2;
  }
  const [chat] = chats;
  if (chats.length > 1) {
    io.stderr.write(
      `frond-ear send: one --chat per send (got ${chats.length})\n${USAGE}\n`,
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
      timeoutMs,
    );
  } catch (error) {
    io.stderr.write(
      error instanceof DaemonTimeoutError
        ? `frond-ear send: ${error.message}; it may still post the message\n`
        : `frond-ear send: ${error instanceof Error ? error.message : String(error)}\n`,
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
