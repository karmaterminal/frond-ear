// The MCP side of a claude.ai custom connector (#53): JSON-RPC over Streamable HTTP, with no
// dependencies. The HTTP plumbing (routing, Host and Origin checks, auth, body limits) is in
// http.ts; this file sees one parsed POST body at a time.
//
// It is dual-era (MCP 2026-07-28, basic/versioning), because which era claude.ai's client
// speaks is part of what the echo proof records:
// - legacy clients (2024-11-05 to 2025-11-25) open with `initialize`, and get a session id
//   unless sessions are off;
// - modern clients (2026-07-28) put the protocol version and client capabilities in every
//   request's `_meta`, mirror the method into headers, and have no session.
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { systemClock, type Clock } from "../types.ts";

export const MODERN_VERSIONS: readonly string[] = ["2026-07-28"];
/** Newest first: an `initialize` asking for a version not listed gets the first. */
export const LEGACY_VERSIONS: readonly string[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const META_SERVER = "io.modelcontextprotocol/serverInfo";

// JSON-RPC codes. The three -3202x codes are the ones MCP 2026-07-28 defines.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const SESSION_NOT_FOUND = -32001;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

const MAX_SESSIONS = 256;
const SESSION_IDLE_MS = 24 * 60 * 60 * 1_000;
/** How long a modern client may cache tools/list and server/discover. */
const LIST_TTL_MS = 5 * 60 * 1_000;

export interface Implementation {
  name: string;
  version: string;
}

/** Who the auth layer let in. Never derived from anything the client says about itself. */
export type Principal =
  | { mode: "none" }
  | { mode: "bearer" }
  | {
      mode: "oauth";
      clientId: string;
      clientName: string | undefined;
      scope: string | undefined;
      expiresAt: number;
    };

/** What the HTTP layer saw, for connection_info and the request log. */
export interface RequestFacts {
  method: string;
  path: string;
  remoteAddress: string | undefined;
  /** "name: value" lines; credential-bearing values are already redacted. */
  headers: string[];
}

export interface CallContext {
  era: "legacy" | "modern";
  protocolVersion: string;
  /** Self-reported by the client: for display and logs, never for decisions. */
  clientInfo: unknown;
  clientCapabilities: unknown;
  session: { ageMs: number; requests: number } | undefined;
  http: RequestFacts;
  principal: Principal;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ToolSet {
  serverInfo: Implementation;
  instructions: string;
  tools: readonly ToolDefinition[];
  call(
    name: string,
    args: Record<string, unknown>,
    context: CallContext,
  ): ToolResult | Promise<ToolResult>;
}

/** An HTTP answer, plus what the request log records about it. */
export interface McpReply {
  status: number;
  headers: Record<string, string>;
  /** A JSON value; undefined means no body (202, 204). */
  body: unknown;
  era?: "legacy" | "modern" | undefined;
  rpc?: string | undefined;
  tool?: string | undefined;
  version?: string | undefined;
  session?: string | undefined;
  client?: string | undefined;
}

interface Session {
  id: string;
  version: string;
  clientInfo: unknown;
  capabilities: unknown;
  createdAt: number;
  lastSeenAt: number;
  requests: number;
}

type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface McpEndpointOptions {
  tools: ToolSet;
  /** Mint an Mcp-Session-Id at legacy `initialize` (the default). */
  sessions?: boolean;
  clock?: Clock;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function header(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Mcp-Name and Mcp-Param-* values may arrive as =?base64?…?= (MCP 2026-07-28). */
function decodeHeaderValue(value: string): string {
  const encoded = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/u.exec(value);
  return encoded ? Buffer.from(encoded[1]!, "base64").toString("utf8") : value;
}

function clientName(info: unknown): string | undefined {
  return isObject(info) && typeof info.name === "string"
    ? info.name.slice(0, 80)
    : undefined;
}

function rpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

/** A bad request that never got as far as a JSON-RPC id (HTTP-level failures). */
export function protocolFailure(
  status: number,
  code: number,
  message: string,
): McpReply {
  return { status, headers: {}, body: rpcError(null, code, message) };
}

export function parseFailure(): McpReply {
  return protocolFailure(400, PARSE_ERROR, "Parse error: body is not JSON");
}

export class McpEndpoint {
  private readonly tools: ToolSet;
  private readonly sessionsEnabled: boolean;
  private readonly clock: Clock;
  private readonly sessions = new Map<string, Session>();

  public constructor(options: McpEndpointOptions) {
    this.tools = options.tools;
    this.sessionsEnabled = options.sessions ?? true;
    this.clock = options.clock ?? systemClock;
  }

  public get sessionCount(): number {
    return this.sessions.size;
  }

  /** One POST body. Batches are refused: MCP dropped them in 2025-06-18. */
  public async post(
    message: unknown,
    headers: IncomingHttpHeaders,
    http: RequestFacts,
    principal: Principal,
  ): Promise<McpReply> {
    if (Array.isArray(message)) {
      return protocolFailure(
        400,
        INVALID_REQUEST,
        "JSON-RPC batches are not supported",
      );
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      return protocolFailure(
        400,
        INVALID_REQUEST,
        "Not a JSON-RPC 2.0 message",
      );
    }
    const rpc = message as JsonRpcMessage;
    if (rpc.method === undefined) {
      // A client's response to a server request. This server never sends one.
      return { status: 202, headers: {}, body: undefined };
    }
    if (typeof rpc.method !== "string") {
      return protocolFailure(400, INVALID_REQUEST, "method must be a string");
    }
    const params = isObject(rpc.params) ? rpc.params : {};
    const meta = isObject(params._meta) ? params._meta : undefined;
    const modernVersion = meta?.[META_VERSION];
    if (rpc.id === undefined) {
      return this.notification(rpc.method, modernVersion, headers);
    }
    if (typeof rpc.id !== "string" && typeof rpc.id !== "number") {
      return protocolFailure(
        400,
        INVALID_REQUEST,
        "id must be a string or a number",
      );
    }
    const id = rpc.id;
    if (rpc.method === "initialize") {
      return this.initialize(id, params);
    }
    if (modernVersion !== undefined) {
      return this.modern(
        id,
        rpc.method,
        params,
        meta!,
        headers,
        http,
        principal,
      );
    }
    return this.legacy(id, rpc.method, params, headers, http, principal);
  }

  /** DELETE ends a legacy session; there is nothing else to delete. */
  public delete(headers: IncomingHttpHeaders): McpReply {
    if (!this.sessionsEnabled) {
      return {
        status: 405,
        headers: { allow: "POST" },
        body: rpcError(null, INVALID_REQUEST, "No sessions to end"),
      };
    }
    const id = header(headers, "mcp-session-id");
    if (!id) {
      return protocolFailure(
        400,
        INVALID_REQUEST,
        "DELETE needs an Mcp-Session-Id header",
      );
    }
    if (!this.sessions.delete(id)) {
      return protocolFailure(404, SESSION_NOT_FOUND, "Session not found");
    }
    return {
      status: 204,
      headers: {},
      body: undefined,
      session: id.slice(0, 8),
    };
  }

  // ---- legacy (initialize-based) -------------------------------------------------------

  private initialize(id: JsonRpcId, params: Record<string, unknown>): McpReply {
    const requested = params.protocolVersion;
    const version =
      typeof requested === "string" && LEGACY_VERSIONS.includes(requested)
        ? requested
        : LEGACY_VERSIONS[0]!;
    const replyHeaders: Record<string, string> = {};
    let sessionTag: string | undefined;
    if (this.sessionsEnabled) {
      const session = this.createSession(
        version,
        params.clientInfo,
        params.capabilities,
      );
      replyHeaders["mcp-session-id"] = session.id;
      sessionTag = session.id.slice(0, 8);
    }
    return {
      status: 200,
      headers: replyHeaders,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.tools.serverInfo,
          instructions: this.tools.instructions,
        },
      },
      era: "legacy",
      rpc: "initialize",
      version,
      ...(sessionTag ? { session: sessionTag } : {}),
      client: clientName(params.clientInfo),
    };
  }

  private async legacy(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown>,
    headers: IncomingHttpHeaders,
    http: RequestFacts,
    principal: Principal,
  ): Promise<McpReply> {
    const resolved = this.resolveLegacy(headers);
    if ("status" in resolved) {
      return { ...resolved, era: "legacy", rpc: method };
    }
    const { version, session } = resolved;
    const tag = {
      era: "legacy" as const,
      rpc: method,
      version,
      ...(session ? { session: session.id.slice(0, 8) } : {}),
      client: clientName(session?.clientInfo),
    };
    const ok = (result: unknown): McpReply => ({
      status: 200,
      headers: {},
      body: { jsonrpc: "2.0", id, result },
      ...tag,
    });
    switch (method) {
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: this.tools.tools });
      case "tools/call": {
        const context: CallContext = {
          era: "legacy",
          protocolVersion: version,
          clientInfo: session?.clientInfo,
          clientCapabilities: session?.capabilities,
          session: session
            ? {
                ageMs: this.clock.now() - session.createdAt,
                requests: session.requests,
              }
            : undefined,
          http,
          principal,
        };
        const call = await this.callTool(params, context);
        return "error" in call
          ? {
              status: 200,
              headers: {},
              body: rpcError(id, call.error.code, call.error.message),
              ...tag,
              ...call.tag,
            }
          : { ...ok(call.result), ...call.tag };
      }
      default:
        return {
          status: 200,
          headers: {},
          body: rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`),
          ...tag,
        };
    }
  }

  /**
   * The negotiated version and session for a legacy request, or the HTTP failure. With
   * sessions on, a request without a session id is a 400 and an unknown id a 404, which
   * tells the client to `initialize` again (2025-11-25 transports, Session Management).
   */
  private resolveLegacy(
    headers: IncomingHttpHeaders,
  ): { version: string; session: Session | undefined } | McpReply {
    const announced = header(headers, "mcp-protocol-version");
    if (announced !== undefined && !LEGACY_VERSIONS.includes(announced)) {
      return protocolFailure(
        400,
        INVALID_REQUEST,
        `Unsupported MCP-Protocol-Version: ${announced.slice(0, 40)}`,
      );
    }
    if (!this.sessionsEnabled) {
      // Without a session, a missing header means 2025-03-26 (2025-11-25 transports).
      return { version: announced ?? "2025-03-26", session: undefined };
    }
    const sessionId = header(headers, "mcp-session-id");
    if (!sessionId) {
      return protocolFailure(
        400,
        INVALID_REQUEST,
        "Mcp-Session-Id header is required; send initialize first",
      );
    }
    const session = this.sessions.get(sessionId);
    if (!session || this.clock.now() - session.lastSeenAt > SESSION_IDLE_MS) {
      this.sessions.delete(sessionId);
      return protocolFailure(404, SESSION_NOT_FOUND, "Session not found");
    }
    session.lastSeenAt = this.clock.now();
    session.requests += 1;
    // Keep the map in least-recently-used order, so eviction takes the idlest session.
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
    return { version: announced ?? session.version, session };
  }

  private createSession(
    version: string,
    clientInfo: unknown,
    capabilities: unknown,
  ): Session {
    const now = this.clock.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenAt > SESSION_IDLE_MS) {
        this.sessions.delete(id);
      }
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      // Each request moves its session to the end, so the first entry is the one used
      // least recently.
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.sessions.delete(oldest);
    }
    const session: Session = {
      id: randomBytes(16).toString("hex"),
      version,
      clientInfo,
      capabilities,
      createdAt: now,
      lastSeenAt: now,
      requests: 0,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private notification(
    method: string,
    modernVersion: unknown,
    headers: IncomingHttpHeaders,
  ): McpReply {
    // Modern Streamable HTTP defines no client notifications; accept and ignore any.
    if (modernVersion !== undefined) {
      return {
        status: 202,
        headers: {},
        body: undefined,
        era: "modern",
        rpc: method,
      };
    }
    const resolved = this.resolveLegacy(headers);
    if ("status" in resolved) {
      return { ...resolved, era: "legacy", rpc: method };
    }
    return {
      status: 202,
      headers: {},
      body: undefined,
      era: "legacy",
      rpc: method,
      version: resolved.version,
      ...(resolved.session ? { session: resolved.session.id.slice(0, 8) } : {}),
    };
  }

  // ---- modern (per-request _meta, 2026-07-28) ------------------------------------------

  private async modern(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown>,
    meta: Record<string, unknown>,
    headers: IncomingHttpHeaders,
    http: RequestFacts,
    principal: Principal,
  ): Promise<McpReply> {
    const version = meta[META_VERSION];
    const tag = {
      era: "modern" as const,
      rpc: method,
      ...(typeof version === "string" ? { version: version.slice(0, 40) } : {}),
      client: clientName(meta[META_CLIENT]),
    };
    const fail = (
      status: number,
      code: number,
      message: string,
      data?: unknown,
    ): McpReply => ({
      status,
      headers: {},
      body: rpcError(id, code, message, data),
      ...tag,
    });
    // Streamable HTTP, Server Validation: the mirrored headers must match the body.
    const announced = header(headers, "mcp-protocol-version");
    if (announced === undefined || announced !== version) {
      return fail(
        400,
        HEADER_MISMATCH,
        "Header mismatch: MCP-Protocol-Version must equal _meta protocolVersion",
      );
    }
    if (typeof version !== "string" || !MODERN_VERSIONS.includes(version)) {
      return fail(400, UNSUPPORTED_VERSION, "Unsupported protocol version", {
        supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
        requested: version,
      });
    }
    if (!isObject(meta[META_CAPABILITIES])) {
      return fail(400, INVALID_PARAMS, `_meta must carry ${META_CAPABILITIES}`);
    }
    if (header(headers, "mcp-method") !== method) {
      return fail(
        400,
        HEADER_MISMATCH,
        "Header mismatch: Mcp-Method must equal the request method",
      );
    }
    if (method === "tools/call") {
      const name = header(headers, "mcp-name");
      if (
        name === undefined ||
        !/^[\x20-\x7e\t]*$/u.test(name) ||
        decodeHeaderValue(name) !== params.name
      ) {
        return fail(
          400,
          HEADER_MISMATCH,
          "Header mismatch: Mcp-Name must equal params.name",
        );
      }
    }
    const complete = (result: Record<string, unknown>): McpReply => ({
      status: 200,
      headers: {},
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          ...result,
          _meta: { [META_SERVER]: this.tools.serverInfo },
        },
      },
      ...tag,
    });
    switch (method) {
      case "server/discover":
        return complete({
          supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
          capabilities: { tools: {} },
          instructions: this.tools.instructions,
          ttlMs: LIST_TTL_MS,
          cacheScope: "private",
        });
      case "tools/list":
        return complete({
          tools: this.tools.tools,
          ttlMs: LIST_TTL_MS,
          cacheScope: "private",
        });
      case "tools/call": {
        const call = await this.callTool(params, {
          era: "modern",
          protocolVersion: version,
          clientInfo: meta[META_CLIENT],
          clientCapabilities: meta[META_CAPABILITIES],
          session: undefined,
          http,
          principal,
        });
        return "error" in call
          ? { ...fail(200, call.error.code, call.error.message), ...call.tag }
          : { ...complete(call.result), ...call.tag };
      }
      default:
        // Unknown methods are a 404 with -32601 in this era (Protocol Version Header).
        return fail(404, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  // ---- shared ---------------------------------------------------------------------------

  private async callTool(
    params: Record<string, unknown>,
    context: CallContext,
  ): Promise<
    | { result: Record<string, unknown>; tag: { tool?: string } }
    | { error: { code: number; message: string }; tag: { tool?: string } }
  > {
    const name = params.name;
    if (
      typeof name !== "string" ||
      !this.tools.tools.some((tool) => tool.name === name)
    ) {
      return {
        error: {
          code: INVALID_PARAMS,
          message: `Unknown tool: ${String(name).slice(0, 80)}`,
        },
        tag: {},
      };
    }
    const args = params.arguments;
    if (args !== undefined && !isObject(args)) {
      return {
        error: { code: INVALID_PARAMS, message: "arguments must be an object" },
        tag: { tool: name },
      };
    }
    try {
      const result = await this.tools.call(name, args ?? {}, context);
      return {
        result: {
          content: [{ type: "text", text: result.text }],
          isError: result.isError === true,
        },
        tag: { tool: name },
      };
    } catch {
      return {
        error: { code: INTERNAL_ERROR, message: "Internal error" },
        tag: { tool: name },
      };
    }
  }
}
