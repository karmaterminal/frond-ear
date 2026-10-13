// Loopback stand-in for Discord's Gateway and REST API, for the clean-install receipt (#70).
//
// The daemon under test reaches it only through DISCORD_GATEWAY_URL and DISCORD_API_BASE;
// nothing here talks to real Discord. It runs from the development checkout (it needs `ws`),
// never inside the disposable environment it serves. It never logs the bot token: it records
// only whether what the daemon presented equals the token file the receipt gave it.
//
//   node tools/clean-install/fake-discord.ts --port-file F --log F --bot ID --token-file F
//     [--guild ID] [--message-content-intent on|off]
//
// Control endpoints (plain HTTP, loopback only):
//   GET  /control/state     everything it saw: identifies, closes, dispatches, posts, reactions
//   POST /control/intent    {"enabled": bool}: the portal's Message Content Intent switch
//   POST /control/inbound   {"channel", "author", "username", "content", "mention"}: one
//                           MESSAGE_CREATE to every connected Gateway client
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { parseArgs } from "node:util";

import { WebSocketServer, type WebSocket } from "ws";

const { values } = parseArgs({
  options: {
    "port-file": { type: "string" },
    log: { type: "string" },
    bot: { type: "string" },
    guild: { type: "string", default: "600000000000000006" },
    "token-file": { type: "string" },
    "message-content-intent": { type: "string", default: "on" },
  },
});
function required(flag: "port-file" | "log" | "bot" | "token-file"): string {
  const value = values[flag];
  if (!value) {
    throw new Error(`--${flag} is required`);
  }
  return value;
}
const PORT_FILE = required("port-file");
const LOG = required("log");
const BOT = required("bot");
const TOKEN = readFileSync(required("token-file"), "utf8").trim();
const GUILD = values.guild ?? "600000000000000006";
const MESSAGE_CONTENT_INTENT = 1 << 15;

interface Dispatch {
  op: 0;
  t: string;
  s: number;
  d: Record<string, unknown>;
}

interface Post {
  id: string;
  channel_id: string;
  content: string;
  replyTo: string | null;
  nonce: string | null;
  timestamp: string;
}

const state = {
  messageContentIntent: values["message-content-intent"] === "on",
  seq: 0,
  connections: 0,
  identifies: [] as Array<{
    intents: number;
    tokenMatches: boolean;
    asksMessageContent: boolean;
  }>,
  resumes: [] as Array<{ from: number; tokenMatches: boolean }>,
  closes: [] as number[],
  dispatches: [] as Dispatch[],
  posts: [] as Post[],
  reactions: [] as Array<{ channel: string; message: string; emoji: string }>,
  restCalls: [] as Array<{ method: string; path: string; authOk: boolean }>,
};
const sockets = new Set<WebSocket>();
let nextId = 1_400_000_000_000_000_000n;
let port = 0;

function log(kind: string, detail: Record<string, unknown> = {}): void {
  appendFileSync(
    LOG,
    `${JSON.stringify({ at: new Date().toISOString(), kind, ...detail })}\n`,
  );
}

function dispatch(t: string, d: Record<string, unknown>): Dispatch {
  const payload: Dispatch = { op: 0, t, s: ++state.seq, d };
  if (t !== "READY") {
    state.dispatches.push(payload);
  }
  return payload;
}

function onGatewayMessage(socket: WebSocket, raw: string): void {
  const payload = JSON.parse(raw) as {
    op: number;
    d?: { token?: unknown; intents?: unknown; seq?: unknown };
  };
  if (payload.op === 1) {
    socket.send(JSON.stringify({ op: 11 }));
    return;
  }
  if (payload.op === 2) {
    const intents = Number(payload.d?.intents ?? 0);
    const tokenMatches = payload.d?.token === TOKEN;
    const asksMessageContent = (intents & MESSAGE_CONTENT_INTENT) !== 0;
    state.identifies.push({ intents, tokenMatches, asksMessageContent });
    log("gateway.identify", { intents, tokenMatches, asksMessageContent });
    if (!tokenMatches) {
      state.closes.push(4004);
      log("gateway.close", { code: 4004, reason: "Authentication failed." });
      socket.close(4004, "Authentication failed.");
      return;
    }
    if (asksMessageContent && !state.messageContentIntent) {
      state.closes.push(4014);
      log("gateway.close", { code: 4014, reason: "Disallowed intent(s)." });
      socket.close(4014, "Disallowed intent(s).");
      return;
    }
    socket.send(
      JSON.stringify(
        dispatch("READY", {
          v: 10,
          user: { id: BOT, username: "receipt-bot", bot: true },
          guilds: [{ id: GUILD, unavailable: true }],
          session_id: `receipt-session-${state.connections}`,
          resume_gateway_url: `ws://127.0.0.1:${port}/gateway`,
        }),
      ),
    );
    return;
  }
  if (payload.op === 6) {
    const from = Number(payload.d?.seq ?? 0);
    const tokenMatches = payload.d?.token === TOKEN;
    state.resumes.push({ from, tokenMatches });
    log("gateway.resume", { from, tokenMatches });
    for (const item of state.dispatches.filter((entry) => entry.s > from)) {
      socket.send(JSON.stringify(item));
    }
    socket.send(JSON.stringify({ op: 0, t: "RESUMED", s: state.seq, d: {} }));
  }
}

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
  state.connections += 1;
  sockets.add(socket);
  log("gateway.connect", { path: request.url });
  socket.on("close", (code: number) => {
    sockets.delete(socket);
    log("gateway.closed", { code });
  });
  socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41_250 } }));
  socket.on("message", (raw: Buffer) => onGatewayMessage(socket, String(raw)));
});

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        done(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch {
        done({});
      }
    });
  });
}

function send(response: ServerResponse, status: number, value?: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

function rest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  body: Record<string, unknown>,
): void {
  const method = request.method ?? "GET";
  const authOk = request.headers.authorization === `Bot ${TOKEN}`;
  state.restCalls.push({ method, path, authOk });
  log("rest.call", { method, path, authOk });
  if (!authOk) {
    send(response, 401, { code: 0, message: "401: Unauthorized" });
    return;
  }
  const messages = /^\/channels\/(\d+)\/messages$/u.exec(path);
  if (messages?.[1] && method === "POST") {
    const reference = body.message_reference as
      | { message_id?: unknown }
      | undefined;
    const post: Post = {
      id: String(nextId++),
      channel_id: messages[1],
      content: String(body.content ?? ""),
      replyTo:
        typeof reference?.message_id === "string" ? reference.message_id : null,
      nonce: typeof body.nonce === "string" ? body.nonce : null,
      timestamp: new Date().toISOString(),
    };
    state.posts.push(post);
    log("rest.post", {
      channel: post.channel_id,
      content: post.content,
      replyTo: post.replyTo,
    });
    send(response, 200, {
      id: post.id,
      channel_id: post.channel_id,
      content: post.content,
      nonce: post.nonce,
      author: { id: BOT, username: "receipt-bot", bot: true },
      timestamp: post.timestamp,
    });
    return;
  }
  if (messages?.[1] && method === "GET") {
    const channel = messages[1];
    const inbound = state.dispatches
      .filter(
        (item) => item.t === "MESSAGE_CREATE" && item.d.channel_id === channel,
      )
      .map((item) => item.d);
    const outbound = state.posts
      .filter((post) => post.channel_id === channel)
      .map((post) => ({
        id: post.id,
        channel_id: post.channel_id,
        author: { id: BOT, username: "receipt-bot", bot: true },
        content: post.content,
        timestamp: post.timestamp,
      }));
    send(response, 200, [...inbound, ...outbound].reverse());
    return;
  }
  const reaction =
    /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/u.exec(path);
  if (reaction?.[1] && reaction[2] && reaction[3] && method === "PUT") {
    const entry = {
      channel: reaction[1],
      message: reaction[2],
      emoji: decodeURIComponent(reaction[3]),
    };
    state.reactions.push(entry);
    log("rest.react", entry);
    send(response, 204);
    return;
  }
  send(response, 404, {
    code: 0,
    message: `fake discord: no route ${method} ${path}`,
  });
}

function control(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  body: Record<string, unknown>,
): void {
  if (path === "/control/state" && request.method === "GET") {
    send(response, 200, { ...state, port });
    return;
  }
  if (path === "/control/intent" && request.method === "POST") {
    state.messageContentIntent = body.enabled === true;
    log("control.intent", { messageContentIntent: state.messageContentIntent });
    send(response, 200, { messageContentIntent: state.messageContentIntent });
    return;
  }
  if (path === "/control/inbound" && request.method === "POST") {
    const id = String(nextId++);
    const mention = body.mention === true;
    const payload = dispatch("MESSAGE_CREATE", {
      id,
      channel_id: String(body.channel),
      guild_id: GUILD,
      author: {
        id: String(body.author),
        username: String(body.username ?? "tester"),
      },
      content: mention ? `<@${BOT}> ${String(body.content)}` : body.content,
      timestamp: new Date().toISOString(),
      mentions: mention
        ? [{ id: BOT, username: "receipt-bot", bot: true }]
        : [],
    });
    for (const socket of sockets) {
      socket.send(JSON.stringify(payload));
    }
    log("control.inbound", {
      id,
      seq: payload.s,
      channel: payload.d.channel_id,
      content: payload.d.content,
      sockets: sockets.size,
    });
    send(response, 200, { id, seq: payload.s, sockets: sockets.size });
    return;
  }
  send(response, 404, {
    message: `no control route ${request.method} ${path}`,
  });
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  void readBody(request).then((body) => {
    if (url.pathname.startsWith("/api/v10/")) {
      rest(request, response, url.pathname.slice("/api/v10".length), body);
    } else if (url.pathname.startsWith("/control/")) {
      control(request, response, url.pathname, body);
    } else {
      send(response, 404, { message: "not found" });
    }
  });
});
server.on("upgrade", (request: IncomingMessage, socket, head: Buffer) => {
  if (!(request.url ?? "").startsWith("/gateway")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) =>
    wss.emit("connection", client, request),
  );
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  writeFileSync(PORT_FILE, `${port}\n`);
  log("listening", { port, messageContentIntent: state.messageContentIntent });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log("stopping", { signal });
    for (const socket of sockets) {
      socket.close(1001);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}
