// The HTTP side of the claude.ai connector (#53): one node:http server that answers the MCP
// endpoint (/mcp) and, in OAuth mode, the authorization server routes beside it. It listens
// on loopback only; Tailscale Funnel (or any HTTPS tunnel) is what makes it public.
//
// Every request, in order: rate limit, Host check, Origin check (DNS-rebinding protection,
// which Streamable HTTP requires), then the route. /mcp also needs auth before its body is
// read. Every request gets one `connector.request` log line with no credential in it.
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { StructuredLogger } from "../logger.ts";
import { systemClock, type Clock } from "../types.ts";
import type { Authenticator, OAuthAuthority } from "./auth.ts";
import {
  McpEndpoint,
  parseFailure,
  protocolFailure,
  type McpReply,
  type RequestFacts,
  type ToolSet,
} from "./mcp.ts";

export const MCP_PATH = "/mcp";
const MCP_BODY_LIMIT = 256 * 1024;
const FORM_BODY_LIMIT = 16 * 1024;
/** Origins a claude.ai request may carry, besides the public URL's own. */
const CLAUDE_ORIGINS = ["https://claude.ai", "https://claude.com"];
/** Header names whose values are never echoed or logged. */
const CREDENTIAL_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|key|auth|password|session/iu;

export interface ConnectorServerOptions {
  tools: ToolSet;
  auth: Authenticator;
  /** The public origin a tunnel serves this at, e.g. https://silas.example.ts.net. */
  publicUrl?: string | undefined;
  /** Extra Origin values to accept, besides the public URL and claude.ai's. */
  allowedOrigins?: readonly string[];
  sessions?: boolean;
  logger: StructuredLogger;
  clock?: Clock;
  /** Requests per minute across all callers; default 120. */
  rateLimitPerMinute?: number;
}

export interface HttpReply {
  status: number;
  headers: Record<string, string>;
  body: string | undefined;
  /** What an OAuth step did, for this request's log line. Never a secret. */
  note?: Record<string, unknown> | undefined;
}

/** A token bucket: `capacity` requests at once, refilled to that over a minute. */
export class RateLimiter {
  private readonly capacity: number;
  private readonly clock: Clock;
  private tokens: number;
  private updatedAt: number;

  public constructor(perMinute: number, clock: Clock = systemClock) {
    this.capacity = perMinute;
    this.clock = clock;
    this.tokens = perMinute;
    this.updatedAt = clock.now();
  }

  /** Takes one token; returns 0 when allowed, else the seconds until one is free. */
  public take(): number {
    const now = this.clock.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.updatedAt) * this.capacity) / 60_000,
    );
    this.updatedAt = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.max(
      1,
      Math.ceil(((1 - this.tokens) * 60_000) / this.capacity / 1_000),
    );
  }
}

export function json(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): HttpReply {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  };
}

function text(status: number, value: string): HttpReply {
  return {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: value,
  };
}

function firstHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** "name: value" lines with every credential-bearing value replaced by its length. */
export function sanitizeHeaders(headers: IncomingHttpHeaders): string[] {
  return Object.entries(headers)
    .filter(
      (entry): entry is [string, string | string[]] => entry[1] !== undefined,
    )
    .map(([name, value]) => {
      const joined = Array.isArray(value) ? value.join(", ") : value;
      return CREDENTIAL_HEADER.test(name)
        ? `${name}: [redacted, ${joined.length} chars]`
        : `${name}: ${joined.slice(0, 200)}`;
    })
    .sort();
}

class BodyTooLarge extends Error {}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > limit) {
    request.resume();
    return Promise.reject(new BodyTooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        request.removeAllListeners("data");
        request.resume();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function mcpReplyToHttp(reply: McpReply): HttpReply {
  return reply.body === undefined
    ? { status: reply.status, headers: reply.headers, body: undefined }
    : json(reply.status, reply.body, reply.headers);
}

export interface ConnectorServer {
  server: Server;
  endpoint: McpEndpoint;
  /** Resolves with the bound port. */
  listen(host: string, port: number): Promise<number>;
  close(): Promise<void>;
}

export function createConnectorServer(
  options: ConnectorServerOptions,
): ConnectorServer {
  const clock = options.clock ?? systemClock;
  const endpoint = new McpEndpoint({
    tools: options.tools,
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    clock,
  });
  const limiter = new RateLimiter(options.rateLimitPerMinute ?? 120, clock);
  const publicUrl = options.publicUrl ? new URL(options.publicUrl) : undefined;
  const allowedOrigins = new Set([
    ...CLAUDE_ORIGINS,
    ...(publicUrl ? [publicUrl.origin] : []),
    ...(options.allowedOrigins ?? []),
  ]);
  const oauth: OAuthAuthority | undefined = options.auth.oauth;
  let boundPort = 0;

  // The public host, with and without its default port: a client may send either.
  const publicHosts = publicUrl
    ? [
        publicUrl.host,
        ...(publicUrl.port === ""
          ? [
              `${publicUrl.hostname}:${publicUrl.protocol === "https:" ? 443 : 80}`,
            ]
          : []),
      ]
    : [];

  function hostAllowed(host: string | undefined): boolean {
    if (!host) {
      return false;
    }
    return [
      ...publicHosts,
      `127.0.0.1:${boundPort}`,
      `localhost:${boundPort}`,
      `[::1]:${boundPort}`,
    ].includes(host.toLowerCase());
  }

  async function route(
    request: IncomingMessage,
    path: string,
    query: URLSearchParams,
    facts: RequestFacts,
    log: Record<string, unknown>,
  ): Promise<HttpReply> {
    const method = request.method ?? "GET";
    if (path === MCP_PATH) {
      return mcp(request, facts, log);
    }
    if (path === "/healthz" && method === "GET") {
      return text(200, "ok\n");
    }
    if (oauth) {
      if (method === "GET" && oauth.isMetadataPath(path)) {
        return json(200, oauth.metadata(path));
      }
      if (path === "/authorize" && method === "GET") {
        return oauth.authorizeGet(query);
      }
      if (
        (path === "/authorize" || path === "/token" || path === "/register") &&
        method === "POST"
      ) {
        const raw = await readBody(request, FORM_BODY_LIMIT);
        const type = firstHeader(request.headers, "content-type") ?? "";
        if (path === "/register") {
          return oauth.register(raw, type);
        }
        if (
          !type.toLowerCase().startsWith("application/x-www-form-urlencoded")
        ) {
          return json(400, {
            error: "invalid_request",
            error_description: "send application/x-www-form-urlencoded",
          });
        }
        const form = new URLSearchParams(raw);
        return path === "/authorize"
          ? oauth.authorizePost(form)
          : oauth.token(form, firstHeader(request.headers, "authorization"));
      }
    }
    return text(404, "not found\n");
  }

  async function mcp(
    request: IncomingMessage,
    facts: RequestFacts,
    log: Record<string, unknown>,
  ): Promise<HttpReply> {
    const method = request.method ?? "GET";
    if (method === "GET") {
      // No standalone SSE stream (legacy) and no GET at all (2026-07-28).
      return {
        status: 405,
        headers: { allow: "POST, DELETE" },
        body: undefined,
      };
    }
    if (method !== "POST" && method !== "DELETE") {
      return {
        status: 405,
        headers: { allow: "POST, DELETE" },
        body: undefined,
      };
    }
    const check = options.auth.check(
      firstHeader(request.headers, "authorization"),
    );
    if (!check.ok) {
      log.auth = check.reason;
      return json(
        401,
        { error: "invalid_token", error_description: check.reason },
        { "www-authenticate": check.challenge },
      );
    }
    log.auth = check.principal.mode;
    if (method === "DELETE") {
      return record(endpoint.delete(request.headers), log);
    }
    const type = (
      firstHeader(request.headers, "content-type") ?? ""
    ).toLowerCase();
    if (!type.startsWith("application/json")) {
      return record(
        protocolFailure(415, -32600, "Content-Type must be application/json"),
        log,
      );
    }
    const accept = (
      firstHeader(request.headers, "accept") ?? "*/*"
    ).toLowerCase();
    if (!/application\/json|application\/\*|\*\/\*/u.test(accept)) {
      return record(
        protocolFailure(406, -32600, "Accept must allow application/json"),
        log,
      );
    }
    const raw = await readBody(request, MCP_BODY_LIMIT);
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return record(parseFailure(), log);
    }
    return record(
      await endpoint.post(message, request.headers, facts, check.principal),
      log,
    );
  }

  function record(reply: McpReply, log: Record<string, unknown>): HttpReply {
    for (const key of [
      "era",
      "rpc",
      "tool",
      "version",
      "session",
      "client",
    ] as const) {
      if (reply[key] !== undefined) {
        log[key] = reply[key];
      }
    }
    return mcpReplyToHttp(reply);
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const started = clock.now();
    const url = new URL(request.url ?? "/", "http://localhost");
    const facts: RequestFacts = {
      method: request.method ?? "GET",
      path: url.pathname,
      remoteAddress: request.socket.remoteAddress,
      headers: sanitizeHeaders(request.headers),
    };
    const log: Record<string, unknown> = {
      method: facts.method,
      path: facts.path.slice(0, 120),
      remote: facts.remoteAddress,
      forwardedFor: firstHeader(request.headers, "x-forwarded-for"),
      origin: firstHeader(request.headers, "origin"),
      ua: firstHeader(request.headers, "user-agent")?.slice(0, 120),
      mcpProtocolVersion: firstHeader(request.headers, "mcp-protocol-version"),
      headers: facts.headers,
    };
    let reply: HttpReply;
    try {
      const wait = limiter.take();
      const origin = firstHeader(request.headers, "origin");
      if (wait > 0) {
        reply = {
          ...text(429, "rate limited\n"),
          headers: { "retry-after": String(wait) },
        };
      } else if (!hostAllowed(firstHeader(request.headers, "host"))) {
        reply = forbidden(facts.path, "Host not allowed");
      } else if (origin !== undefined && !allowedOrigins.has(origin)) {
        reply = forbidden(facts.path, "Origin not allowed");
      } else {
        reply = await route(
          request,
          url.pathname,
          url.searchParams,
          facts,
          log,
        );
        if (reply.note) {
          log.oauth = reply.note;
        }
      }
    } catch (error) {
      reply =
        error instanceof BodyTooLarge
          ? mcpReplyToHttp(protocolFailure(413, -32600, "Body too large"))
          : mcpReplyToHttp(protocolFailure(500, -32603, "Internal error"));
      if (!(error instanceof BodyTooLarge)) {
        log.failure = error instanceof Error ? error.name : "unknown";
      }
    }
    response.writeHead(reply.status, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...reply.headers,
    });
    response.end(reply.body);
    options.logger.log(
      reply.status >= 500 ? "error" : "info",
      "connector.request",
      {
        ...log,
        status: reply.status,
        ms: clock.now() - started,
      },
    );
  }

  function forbidden(path: string, reason: string): HttpReply {
    return path === MCP_PATH
      ? mcpReplyToHttp(protocolFailure(403, -32600, reason))
      : text(403, `${reason}\n`);
  }

  const server = createServer((request, response) => {
    void handle(request, response);
  });
  // Slow or idle clients don't get to hold sockets for long.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    endpoint,
    listen(host: string, port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          boundPort = (server.address() as AddressInfo).port;
          resolve(boundPort);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
