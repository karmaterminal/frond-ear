// The channel shim against a stand-in daemon on a loopback socket, with a PassThrough for
// Claude Code's stdio: what the shim holds for a session that is not listening yet.
import assert from "node:assert/strict";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";

import { EAR_PROTOCOL_VERSION, LineConnection } from "../src/protocol.ts";
import { ChannelShim } from "../src/shim.ts";

type Message = Record<string, unknown>;

async function waitFor<T>(
  probe: () => T | undefined,
  what: string,
  ms = 5_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("events held while the session is not listening are dropped with the daemon connection, and the daemon's own push arrives once (#70)", async (t) => {
  // Each connection gets its welcome and one event in a single write, so the shim holds the
  // event before it answers initialize. The daemon numbers the batch anew after a reconnect.
  const connections: Array<{ socket: Socket; received: Message[] }> = [];
  const server = createServer((socket) => {
    const entry = { socket, received: [] as Message[] };
    connections.push(entry);
    const batchId = connections.length === 1 ? 7 : 8;
    new LineConnection(
      socket,
      (message) => {
        entry.received.push(message as Message);
        if ((message as Message).type === "hello") {
          socket.write(
            [
              {
                type: "welcome",
                protocol: EAR_PROTOCOL_VERSION,
                attached: true,
                instructions: "",
              },
              {
                type: "event",
                batchId,
                content: `batch ${batchId}`,
                meta: { kind: "mention" },
              },
            ]
              .map((line) => `${JSON.stringify(line)}\n`)
              .join(""),
          );
        }
      },
      () => undefined,
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  const input = new PassThrough();
  const output = new PassThrough();
  const written: Message[] = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      written.push(JSON.parse(buffer.slice(0, newline)) as Message);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  const shim = new ChannelShim({
    input,
    output,
    connect: () => connect(port, "127.0.0.1"),
    ear: "scribe",
    log: () => undefined,
    reconnectMs: 20,
    channelSettleMs: 300,
  });
  t.after(() => {
    shim.stop();
    for (const connection of connections) {
      connection.socket.destroy();
    }
    server.close();
  });
  shim.start();

  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })}\n`,
  );
  await waitFor(
    () => written.find((message) => message.id === 1),
    "the initialize response",
  );
  // Within the settle period after initialized, the daemon goes away (a restart, say).
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  connections[0]?.socket.destroy();

  const pushed = () =>
    written
      .filter((message) => message.method === "notifications/claude/channel")
      .map((message) => (message.params as { content: string }).content);
  await waitFor(
    () => (pushed().includes("batch 8") ? true : undefined),
    "the event the daemon pushed after the reconnect",
  );
  assert.deepEqual(pushed(), ["batch 8"]);
  const offered = () =>
    connections.flatMap((connection) =>
      connection.received
        .filter((message) => message.type === "offered")
        .map((message) => message.batchId),
    );
  await waitFor(
    () => (offered().length > 0 ? true : undefined),
    "the offered report",
  );
  assert.deepEqual(offered(), [8]);
});
