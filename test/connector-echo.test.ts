// The claude.ai connector echo (#53): HTTP and MCP over a real loopback socket. The official
// MCP SDK client stands in for a legacy (initialize-based) Claude; raw requests play a modern
// (2026-07-28) one. Nothing here touches Discord or anything beyond loopback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  BearerAuth,
  NoAuth,
  type Authenticator,
} from "../src/connector/auth.ts";
import {
  echoTools,
  parseConnectorEchoArgs,
  readSecretFile,
} from "../src/connector/echo.ts";
import {
  createConnectorServer,
  RateLimiter,
  SourceLimiter,
} from "../src/connector/http.ts";
import {
  McpEndpoint,
  type Principal,
  type RequestFacts,
} from "../src/connector/mcp.ts";
import { StructuredLogger } from "../src/logger.ts";
import { FakeClock } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const MODERN = "2026-07-28";

interface Started {
  url: string;
  port: number;
  lines: string[];
  sessions: () => number;
}

async function start(
  t: TestContext,
  options: {
    auth?: Authenticator;
    sessions?: boolean;
    publicUrl?: string;
    rateLimitPerMinute?: number;
  } = {},
): Promise<Started> {
  const lines: string[] = [];
  const connector = createConnectorServer({
    tools: echoTools(),
    auth: options.auth ?? new NoAuth(),
    publicUrl: options.publicUrl,
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    ...(options.rateLimitPerMinute === undefined
      ? {}
      : { rateLimitPerMinute: options.rateLimitPerMinute }),
    logger: new StructuredLogger((line) => lines.push(line)),
  });
  const port = await connector.listen("127.0.0.1", 0);
  t.after(() => connector.close());
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    lines,
    sessions: () => connector.endpoint.sessionCount,
  };
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: unknown;
}

/** node:http rather than fetch, so a test can set Host and Origin itself. */
function send(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: options.method ?? "POST", headers: options.headers ?? {} },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

/** A JSON-RPC body; `id: null` makes it a notification. */
function rpc(
  method: string,
  params: Record<string, unknown> = {},
  id: number | null = 1,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    ...(id === null ? {} : { id }),
    method,
    params,
  });
}

/** A modern (2026-07-28) request: version and capabilities in _meta, method in headers. */
function modern(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  overrides: {
    headers?: Record<string, string>;
    version?: string;
    meta?: Record<string, unknown>;
  } = {},
): Promise<Answer> {
  const version = overrides.version ?? MODERN;
  const meta = overrides.meta ?? {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1" },
  };
  return send(url, {
    headers: {
      ...JSON_HEADERS,
      "mcp-protocol-version": version,
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      ...overrides.headers,
    },
    body: rpc(method, { ...params, _meta: meta }),
  });
}

function errorCode(answer: Answer): number | undefined {
  return (answer.json as { error?: { code?: number } } | undefined)?.error
    ?.code;
}

function toolText(answer: Answer): string {
  const result = (
    answer.json as { result: { content: Array<{ text: string }> } }
  ).result;
  return result.content[0]!.text;
}

async function sdkClient(
  t: TestContext,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: "sdk-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  // The SDK's own types disagree under exactOptionalPropertyTypes (sessionId may be
  // undefined on the transport, optional on the interface); the runtime contract holds.
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  t.after(() => client.close());
  return { client, transport };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

test("legacy: the MCP SDK client initializes, gets a session, lists and calls the tools", async (t) => {
  const server = await start(t);
  const { client, transport } = await sdkClient(t, server.url);
  assert.ok(transport.sessionId, "initialize answered with an Mcp-Session-Id");
  assert.equal(server.sessions(), 1);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["echo", "connection_info"],
  );
  assert.equal(tools.tools[0]!.annotations?.readOnlyHint, true);

  const echoed = await client.callTool({
    name: "echo",
    arguments: { text: "über 🌿 round trip" },
  });
  assert.equal(textOf(echoed), "über 🌿 round trip");

  const info = JSON.parse(
    textOf(await client.callTool({ name: "connection_info", arguments: {} })),
  ) as Record<string, any>;
  assert.equal(info.era, "legacy");
  assert.equal(info.protocolVersion, "2025-06-18");
  assert.equal(info.client.name, "sdk-test");
  assert.ok(info.session.requests >= 3);
  assert.deepEqual(info.auth, { mode: "none" });
  assert.ok(
    (info.http.headers as string[]).some((line) =>
      /^mcp-session-id: \[redacted, 32 chars\]$/u.test(line),
    ),
    "the session id is redacted, not echoed",
  );

  const oldSession = transport.sessionId!;
  await transport.terminateSession();
  assert.equal(server.sessions(), 0);
  const after = await send(server.url, {
    headers: { ...JSON_HEADERS, "mcp-session-id": oldSession },
    body: rpc("tools/list"),
  });
  assert.equal(
    after.status,
    404,
    "an ended session is a 404, which tells a client to initialize again",
  );
});

test("legacy: initialize negotiates the client's version when supported, else the newest", async (t) => {
  const server = await start(t);
  for (const [asked, answered] of [
    ["2025-11-25", "2025-11-25"],
    ["2025-03-26", "2025-03-26"],
    ["2099-01-01", "2025-11-25"],
  ] as const) {
    const answer = await send(server.url, {
      headers: JSON_HEADERS,
      body: rpc("initialize", {
        protocolVersion: asked,
        capabilities: {},
        clientInfo: { name: "probe", version: "1" },
      }),
    });
    assert.equal(answer.status, 200);
    assert.equal((answer.json as any).result.protocolVersion, answered);
    assert.equal(typeof answer.headers["mcp-session-id"], "string");
  }
});

test("legacy: requests need a live session; GET and a bad version are refused", async (t) => {
  const server = await start(t);
  const missing = await send(server.url, {
    headers: JSON_HEADERS,
    body: rpc("tools/list"),
  });
  assert.equal(missing.status, 400);
  const unknown = await send(server.url, {
    headers: { ...JSON_HEADERS, "mcp-session-id": "0".repeat(32) },
    body: rpc("tools/list"),
  });
  assert.equal(unknown.status, 404);

  const init = await send(server.url, {
    headers: JSON_HEADERS,
    body: rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
    }),
  });
  const session = init.headers["mcp-session-id"] as string;
  const badVersion = await send(server.url, {
    headers: {
      ...JSON_HEADERS,
      "mcp-session-id": session,
      "mcp-protocol-version": "1999-01-01",
    },
    body: rpc("tools/list"),
  });
  assert.equal(badVersion.status, 400);
  const initialized = await send(server.url, {
    headers: { ...JSON_HEADERS, "mcp-session-id": session },
    body: rpc("notifications/initialized", {}, null),
  });
  assert.equal(initialized.status, 202);
  assert.equal(initialized.text, "");
  const unknownMethod = await send(server.url, {
    headers: { ...JSON_HEADERS, "mcp-session-id": session },
    body: rpc("resources/list"),
  });
  assert.equal(
    unknownMethod.status,
    200,
    "legacy: a JSON-RPC error rides a 200",
  );
  assert.equal(errorCode(unknownMethod), -32601);

  const get = await send(server.url, {
    method: "GET",
    headers: { accept: "text/event-stream" },
  });
  assert.equal(get.status, 405, "no standalone SSE stream");
  const deleteWithout = await send(server.url, { method: "DELETE" });
  assert.equal(deleteWithout.status, 400);
});

test("legacy, sessions off: initialize mints no session and later requests need none", async (t) => {
  const server = await start(t, { sessions: false });
  const { client, transport } = await sdkClient(t, server.url);
  assert.equal(transport.sessionId, undefined);
  const info = JSON.parse(
    textOf(await client.callTool({ name: "connection_info", arguments: {} })),
  ) as Record<string, any>;
  assert.equal(info.session, null);
  assert.equal(
    info.protocolVersion,
    "2025-06-18",
    "taken from the MCP-Protocol-Version header",
  );
  const del = await send(server.url, {
    method: "DELETE",
    headers: { "mcp-session-id": "x" },
  });
  assert.equal(del.status, 405);
});

test("modern: server/discover, tools/list and tools/call work per request, with no session", async (t) => {
  const server = await start(t);
  const discover = await modern(server.url, "server/discover");
  assert.equal(discover.status, 200);
  const found = (discover.json as any).result;
  assert.equal(found.resultType, "complete");
  assert.deepEqual(found.supportedVersions, [
    "2026-07-28",
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
  ]);
  assert.equal(
    found._meta["io.modelcontextprotocol/serverInfo"].name,
    "frond-ear-connector-echo",
  );
  assert.equal(typeof found.ttlMs, "number");
  assert.equal(found.cacheScope, "private");
  assert.equal(discover.headers["mcp-session-id"], undefined);

  const list = await modern(server.url, "tools/list");
  assert.equal((list.json as any).result.resultType, "complete");
  assert.equal((list.json as any).result.tools.length, 2);
  assert.ok((list.json as any).result.ttlMs >= 0);

  const echo = await modern(server.url, "tools/call", {
    name: "echo",
    arguments: { text: "modern" },
  });
  assert.equal(echo.status, 200);
  assert.equal(toolText(echo), "modern");

  const info = JSON.parse(
    toolText(
      await modern(server.url, "tools/call", {
        name: "connection_info",
        arguments: {},
      }),
    ),
  ) as Record<string, any>;
  assert.equal(info.era, "modern");
  assert.equal(info.protocolVersion, MODERN);
  assert.equal(info.session, null);
  assert.equal(info.client.name, "modern-test");
  assert.equal(server.sessions(), 0, "modern requests never create sessions");

  const encoded = await modern(
    server.url,
    "tools/call",
    { name: "echo", arguments: { text: "b64" } },
    {
      headers: {
        "mcp-name": `=?base64?${Buffer.from("echo").toString("base64")}?=`,
      },
    },
  );
  assert.equal(
    encoded.status,
    200,
    "a base64-sentinel Mcp-Name is decoded before comparing",
  );
});

test("modern: header mismatches, unsupported versions, missing capabilities and unknown methods", async (t) => {
  const server = await start(t);
  const versionHeader = await modern(
    server.url,
    "tools/list",
    {},
    { headers: { "mcp-protocol-version": "2025-06-18" } },
  );
  assert.equal(versionHeader.status, 400);
  assert.equal(errorCode(versionHeader), -32020);

  const methodHeader = await modern(
    server.url,
    "tools/list",
    {},
    { headers: { "mcp-method": "tools/call" } },
  );
  assert.equal(methodHeader.status, 400);
  assert.equal(errorCode(methodHeader), -32020);

  const nameHeader = await modern(
    server.url,
    "tools/call",
    { name: "echo", arguments: { text: "x" } },
    { headers: { "mcp-name": "connection_info" } },
  );
  assert.equal(nameHeader.status, 400);
  assert.equal(errorCode(nameHeader), -32020);

  const future = await modern(
    server.url,
    "tools/list",
    {},
    { version: "2099-01-01" },
  );
  assert.equal(future.status, 400);
  assert.equal(errorCode(future), -32022);
  assert.deepEqual((future.json as any).error.data.requested, "2099-01-01");
  assert.ok((future.json as any).error.data.supported.includes(MODERN));

  const noCapabilities = await modern(
    server.url,
    "tools/list",
    {},
    {
      meta: { "io.modelcontextprotocol/protocolVersion": MODERN },
    },
  );
  assert.equal(noCapabilities.status, 400);
  assert.equal(errorCode(noCapabilities), -32602);

  const unknown = await modern(server.url, "resources/list");
  assert.equal(unknown.status, 404);
  assert.equal(errorCode(unknown), -32601);

  const unknownTool = await modern(server.url, "tools/call", {
    name: "post_to_discord",
    arguments: {},
  });
  assert.equal(errorCode(unknownTool), -32602);

  const toolError = await modern(server.url, "tools/call", {
    name: "echo",
    arguments: { text: "x".repeat(4_001) },
  });
  assert.equal((toolError.json as any).result.isError, true);
});

test("Host and Origin are checked on every request (DNS-rebinding protection)", async (t) => {
  const server = await start(t, { publicUrl: "https://silas.example.ts.net" });
  const init = rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
  });

  const foreignHost = await send(server.url, {
    headers: { ...JSON_HEADERS, host: "evil.example" },
    body: init,
  });
  assert.equal(foreignHost.status, 403);
  const publicHost = await send(server.url, {
    headers: { ...JSON_HEADERS, host: "silas.example.ts.net" },
    body: init,
  });
  assert.equal(
    publicHost.status,
    200,
    "the tunnel's Host is the public URL's host",
  );
  const withPort = await send(server.url, {
    headers: { ...JSON_HEADERS, host: "silas.example.ts.net:443" },
    body: init,
  });
  assert.equal(withPort.status, 200, "with or without its default port");
  const otherPort = await send(server.url, {
    headers: { ...JSON_HEADERS, host: "silas.example.ts.net:8443" },
    body: init,
  });
  assert.equal(otherPort.status, 403);

  const foreignOrigin = await send(server.url, {
    headers: { ...JSON_HEADERS, origin: "https://evil.example" },
    body: init,
  });
  assert.equal(foreignOrigin.status, 403);
  for (const origin of [
    "https://claude.ai",
    "https://claude.com",
    "https://silas.example.ts.net",
  ]) {
    const allowed = await send(server.url, {
      headers: { ...JSON_HEADERS, origin },
      body: init,
    });
    assert.equal(allowed.status, 200, origin);
  }
  const healthz = await send(`http://127.0.0.1:${server.port}/healthz`, {
    method: "GET",
    headers: { host: "evil.example" },
  });
  assert.equal(healthz.status, 403, "every path, not only /mcp");
  const loopbackOrigin = await send(server.url, {
    headers: { ...JSON_HEADERS, origin: `http://127.0.0.1:${server.port}` },
    body: init,
  });
  assert.equal(
    loopbackOrigin.status,
    200,
    "a page served on the host itself, such as the consent page",
  );
  const otherLoopbackPort = await send(server.url, {
    headers: { ...JSON_HEADERS, origin: `http://127.0.0.1:${server.port + 1}` },
    body: init,
  });
  assert.equal(otherLoopbackPort.status, 403, "only this server's own port");
});

test("bodies: size, content type, Accept, JSON and batches", async (t) => {
  const server = await start(t);
  const huge = await send(server.url, {
    headers: JSON_HEADERS,
    body: rpc("initialize", { padding: "x".repeat(300 * 1024) }),
  });
  assert.equal(huge.status, 413);
  const plain = await send(server.url, {
    headers: { ...JSON_HEADERS, "content-type": "text/plain" },
    body: rpc("initialize"),
  });
  assert.equal(plain.status, 415);
  const sseOnly = await send(server.url, {
    headers: { ...JSON_HEADERS, accept: "text/event-stream" },
    body: rpc("initialize"),
  });
  assert.equal(sseOnly.status, 406);
  const garbage = await send(server.url, {
    headers: JSON_HEADERS,
    body: "{nope",
  });
  assert.equal(garbage.status, 400);
  assert.equal(errorCode(garbage), -32700);
  const batch = await send(server.url, {
    headers: JSON_HEADERS,
    body: `[${rpc("initialize")}]`,
  });
  assert.equal(batch.status, 400);
  assert.equal(errorCode(batch), -32600);
  assert.match((batch.json as any).error.message, /batch/u);
});

test("a body that is too big gets its 413, then the connection closes without waiting for the rest", async (t) => {
  const server = await start(t);
  const head = (framing: string): string =>
    `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n${framing}\r\n\r\n`;
  const chunk = "x".repeat(64 * 1024);
  for (const [name, sent] of [
    // A declared length over the limit is refused before any of the body is read.
    ["declared", head(`Content-Length: ${10 * 1024 * 1024}`)],
    // A chunked body is refused once it passes the limit; its last chunk never comes.
    [
      "streamed",
      head("Transfer-Encoding: chunked") +
        `${chunk.length.toString(16)}\r\n${chunk}\r\n`.repeat(5),
    ],
  ] as const) {
    const socket = connect(server.port, "127.0.0.1");
    t.after(() => socket.destroy());
    socket.on("error", () => {});
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => (answer += data));
    const closed = new Promise<boolean>((resolve) => {
      // Without the close, the socket stays open until the 5 s keep-alive timeout at least.
      const timer = setTimeout(() => resolve(false), 3_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    socket.write(sent);
    assert.ok(await closed, `${name}: the server closed the connection`);
    assert.match(answer, /^HTTP\/1\.1 413 /u, name);
    assert.match(answer, /\r\nconnection: close\r\n/iu, name);
  }
});

test("sessions: when the table is full, the session used least recently gives way", async () => {
  const endpoint = new McpEndpoint({ tools: echoTools() });
  const facts: RequestFacts = {
    method: "POST",
    path: "/mcp",
    remoteAddress: "127.0.0.1",
    headers: [],
  };
  const principal: Principal = { mode: "none" };
  const open = async (): Promise<string> => {
    const reply = await endpoint.post(
      JSON.parse(
        rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} }),
      ),
      {},
      facts,
      principal,
    );
    return reply.headers["mcp-session-id"]!;
  };
  const use = async (session: string): Promise<number> =>
    (
      await endpoint.post(
        JSON.parse(rpc("tools/list")),
        { "mcp-session-id": session },
        facts,
        principal,
      )
    ).status;

  const claudes = await open();
  const idle = await open();
  // 256 fill the table (MAX_SESSIONS in mcp.ts).
  for (let opened = 2; opened < 256; opened += 1) {
    await open();
  }
  assert.equal(endpoint.sessionCount, 256);
  assert.equal(
    await use(claudes),
    200,
    "Claude's session, the oldest, is in use",
  );
  await open();
  assert.equal(endpoint.sessionCount, 256);
  assert.equal(await use(claudes), 200, "the session in use stays");
  assert.equal(await use(idle), 404, "the session used least recently went");
});

test("the rate limit is per caller, with a cap for all callers, and answers 429 with Retry-After", async (t) => {
  const clock = new FakeClock(0);
  const limiter = new RateLimiter(60, clock);
  for (let i = 0; i < 60; i += 1) {
    assert.equal(limiter.take(), 0);
  }
  assert.equal(limiter.take(), 1, "one token refills per second at 60/min");
  clock.advance(1_000);
  assert.equal(limiter.take(), 0);

  const server = await start(t, { rateLimitPerMinute: 2 });
  const healthz = (from: string, viaFunnel = true): Promise<Answer> =>
    send(`http://127.0.0.1:${server.port}/healthz`, {
      method: "GET",
      headers: {
        "x-forwarded-for": from,
        ...(viaFunnel ? { "tailscale-funnel-request": "?1" } : {}),
      },
    });
  await healthz("203.0.113.7");
  await healthz("203.0.113.7");
  const limited = await healthz("203.0.113.7");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
  assert.equal(
    (await healthz("160.79.104.10")).status,
    200,
    "each caller has its own bucket, so one busy caller can't starve Claude",
  );
  assert.equal(
    (await healthz("203.0.113.7, 160.79.104.10")).status,
    200,
    "the last forwarded address, the one Funnel added, is the caller",
  );
  assert.equal((await healthz("160.79.104.10, 203.0.113.7")).status, 429);

  // Without Funnel's mark, X-Forwarded-For is whatever the caller wrote, so the socket's
  // address is the caller: these three share one bucket.
  assert.equal((await healthz("192.0.2.1", false)).status, 200);
  assert.equal((await healthz("192.0.2.2", false)).status, 200);
  assert.equal(
    (await healthz("192.0.2.3", false)).status,
    429,
    "an X-Forwarded-For that Funnel didn't mark doesn't count",
  );
  const logged = server.lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  assert.deepEqual(
    logged.map((record) => [record.forwardedFor, record.source]).slice(-4),
    [
      ["160.79.104.10, 203.0.113.7", "203.0.113.7"],
      ["192.0.2.1", "127.0.0.1"],
      ["192.0.2.2", "127.0.0.1"],
      ["192.0.2.3", "127.0.0.1"],
    ],
    "each log line says who the server took the caller to be",
  );

  const sources = new SourceLimiter(2, clock);
  for (const from of ["a", "b", "c", "d", "e"]) {
    assert.equal(sources.take(from), 0);
    assert.equal(sources.take(from), 0);
  }
  assert.ok(
    sources.take("f") > 0,
    "all callers together get five times one caller's share",
  );
  clock.advance(60_000);
  assert.equal(sources.take("f"), 0);
});

test("bearer: a token an Authorization header can't carry is refused at startup", () => {
  assert.throws(() => new BearerAuth("x".repeat(31)), /32 characters/u);
  for (const token of [
    `${"a".repeat(32)} with spaces`,
    `${"a".repeat(32)}$dollar`,
    `${"a".repeat(32)}=inside=`,
  ]) {
    assert.throws(() => new BearerAuth(token), /letters, digits/u, token);
  }
  assert.doesNotThrow(
    () => new BearerAuth(`${"A".repeat(30)}-._~+/09==`),
    "the b64token alphabet, with = only at the end",
  );
});

test("bearer: no token or a wrong one is a 401; the right one works and is never echoed or logged", async (t) => {
  const token = "a".repeat(20) + "Bearer-test-0123456789";
  const server = await start(t, { auth: new BearerAuth(token) });
  const init = rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
  });

  const none = await send(server.url, { headers: JSON_HEADERS, body: init });
  assert.equal(none.status, 401);
  assert.equal(
    none.headers["www-authenticate"],
    'Bearer realm="frond-ear-connector"',
  );
  const wrong = await send(server.url, {
    headers: { ...JSON_HEADERS, authorization: `Bearer ${"b".repeat(42)}` },
    body: init,
  });
  assert.equal(wrong.status, 401);
  assert.match(
    String(wrong.headers["www-authenticate"]),
    /error="invalid_token"/u,
  );
  const deleteWithout = await send(server.url, { method: "DELETE" });
  assert.equal(deleteWithout.status, 401, "DELETE needs auth too");

  const { client } = await sdkClient(t, server.url, {
    Authorization: `Bearer ${token}`,
  });
  const info = JSON.parse(
    textOf(await client.callTool({ name: "connection_info", arguments: {} })),
  ) as Record<string, any>;
  assert.deepEqual(info.auth, { mode: "bearer" });
  assert.ok(
    (info.http.headers as string[]).includes(
      `authorization: [redacted, ${7 + token.length} chars]`,
    ),
  );
  assert.ok(!JSON.stringify(info).includes(token));
  assert.ok(server.lines.length > 0);
  assert.ok(
    !server.lines.join("\n").includes(token),
    "the request log never carries the token",
  );
});

test("each request leaves one connector.request log line, without tool arguments", async (t) => {
  const server = await start(t);
  const { client } = await sdkClient(t, server.url);
  await client.callTool({
    name: "echo",
    arguments: { text: "kept-out-of-the-log" },
  });
  const records = server.lines.map(
    (line) => JSON.parse(line) as Record<string, any>,
  );
  assert.ok(records.every((record) => record.event === "connector.request"));
  const call = records.find((record) => record.rpc === "tools/call");
  assert.ok(call, "the tools/call request was logged");
  assert.equal(call.tool, "echo");
  assert.equal(call.era, "legacy");
  assert.equal(call.status, 200);
  assert.equal(call.client, "sdk-test");
  assert.equal(call.source, "127.0.0.1", "the caller the limits counted");
  assert.equal(typeof call.ms, "number");
  assert.ok(Array.isArray(call.headers));
  assert.ok(!server.lines.join("\n").includes("kept-out-of-the-log"));
});

test("CLI flags: loopback only, https origin, and secrets only from 0600 files", (t) => {
  assert.throws(
    () => parseConnectorEchoArgs(["--listen", "0.0.0.0:8787"]),
    /loopback/u,
  );
  assert.throws(
    () =>
      parseConnectorEchoArgs(["--public-url", "http://silas.example.ts.net"]),
    /https origin/u,
  );
  assert.throws(
    () =>
      parseConnectorEchoArgs([
        "--public-url",
        "https://silas.example.ts.net/mcp",
      ]),
    /no path/u,
  );
  assert.throws(
    () => parseConnectorEchoArgs(["--auth", "bearer"]),
    /--token-file/u,
  );
  assert.throws(
    () =>
      parseConnectorEchoArgs([
        "--auth",
        "oauth",
        "--public-url",
        "https://a.example",
      ]),
    /--owner-secret-file/u,
  );
  assert.throws(
    () => parseConnectorEchoArgs(["--allow-origin", "https://a.example/path"]),
    /not an origin/u,
  );
  const config = parseConnectorEchoArgs([
    "--listen",
    "[::1]:9000",
    "--public-url",
    "https://silas.example.ts.net/",
    "--no-sessions",
  ]);
  assert.equal(config.host, "::1");
  assert.equal(config.port, 9000);
  assert.equal(config.publicUrl, "https://silas.example.ts.net");
  assert.equal(config.sessions, false);
  assert.equal(config.auth, "none");

  const directory = mkdtempSync(join(tmpdir(), "frond-ear-connector-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "token");
  writeFileSync(file, "x".repeat(40) + "\n");
  chmodSync(file, 0o644);
  assert.throws(() => readSecretFile(file, "token file"), /chmod 600/u);
  chmodSync(file, 0o600);
  assert.equal(readSecretFile(file, "token file"), "x".repeat(40));
  const notAFile = join(directory, "a-directory");
  mkdirSync(notAFile, { mode: 0o700 });
  assert.throws(
    () => readSecretFile(notAFile, "token file"),
    /not a regular file/u,
  );
});

test("CLI: connector-echo listens on loopback, answers /healthz, and stops on SIGTERM", async (t) => {
  const child = spawn(
    process.execPath,
    [CLI, "connector-echo", "--listen", "127.0.0.1:0"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill("SIGKILL"));
  let stdout = "";
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const found = /on (http:\/\/127\.0\.0\.1:\d+)\/mcp/u.exec(stdout);
      if (found) {
        resolve(found[1]!);
      }
    });
    child.once("exit", (code) =>
      reject(new Error(`exited early with ${code}`)),
    );
  });
  assert.match(stdout, /no --public-url/u);
  const health = await send(`${url}/healthz`, { method: "GET" });
  assert.equal(health.status, 200);
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", (exitCode) => resolve(exitCode));
    child.kill("SIGTERM");
  });
  assert.equal(code, 0);
});
