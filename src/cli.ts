const baseUrl = process.env.FROND_EAR_URL ?? "http://127.0.0.1:8791";
const [command, ...args] = process.argv.slice(2);

async function request(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
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
  default:
    throw new Error("usage: frond-ear <health|status|lease|ack|release|reload>");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
