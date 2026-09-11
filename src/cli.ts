const baseUrl = process.env.FROND_EAR_URL ?? "http://127.0.0.1:8791";
const [command, ...args] = process.argv.slice(2);

async function request(
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const init: RequestInit = body
    ? {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    : { method: "GET" };
  const response = await fetch(`${baseUrl}${path}`, init);
  const result = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(JSON.stringify(result));
  }
  return result;
}

let result: unknown;
switch (command) {
  case "health":
    result = await request("/health");
    break;
  case "status":
    result = await request("/queue/status");
    break;
  case "lease":
    result = await request("/queue/lease-next", {});
    break;
  case "ack":
    if (!args[0]) {
      throw new Error("usage: frond-ear ack <claim-token>");
    }
    result = await request("/queue/ack", { claimToken: args[0] });
    break;
  case "release":
    if (!args[0]) {
      throw new Error("usage: frond-ear release <claim-token> [reason]");
    }
    result = await request("/queue/release", {
      claimToken: args[0],
      error: args.slice(1).join(" ") || "released by CLI",
    });
    break;
  case "reload":
    result = await request("/policy/reload", {});
    break;
  case "bindings":
    result = await request(
      `/bindings${args[0] === "--all" ? "?includeRetired=true" : ""}`,
    );
    break;
  case "binding":
    if (!args[0]) {
      throw new Error("usage: frond-ear binding <conversation-key>");
    }
    result = await request(`/bindings/${encodeURIComponent(args[0])}`);
    break;
  case "rotate":
    if (!args[0] || !args[1]) {
      throw new Error(
        "usage: frond-ear rotate <channel-id> <guild-id|dm> [actor-id]",
      );
    }
    result = await request("/bindings/rotate", {
      channelId: args[0],
      guildId: args[1] === "dm" ? null : args[1],
      actorId: args[2] ?? "loopback-operator",
      requestId: randomUUID(),
    });
    break;
  case "pause":
  case "resume":
    if (!args[0]) {
      throw new Error(`usage: frond-ear ${command} <conversation-key>`);
    }
    result = await request(`/bindings/${command}`, {
      conversationKey: args[0],
    });
    break;
  case "capability":
    result = await request("/adapter/capability");
    break;
  default:
    throw new Error(
      "usage: frond-ear <health|status|lease|ack|release|reload|bindings|binding|rotate|pause|resume|capability>",
    );
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
import { randomUUID } from "node:crypto";
