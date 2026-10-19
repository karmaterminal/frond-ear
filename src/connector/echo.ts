// `frond-ear connector-echo`: the first, disposable step of #53. A read-only MCP server for
// a claude.ai custom connector, run behind Tailscale Funnel to prove what the connector's
// transport and auth actually need before any Discord access is built. It holds no Discord
// token and posts nothing anywhere. `echo` returns its text; `connection_info` reports what
// the server saw, and each request leaves one `connector.request` log line on stderr.
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { parseArgs } from "node:util";

import { StructuredLogger } from "../logger.ts";
import type { Io } from "../onboard.ts";
import { systemClock, type Clock } from "../types.ts";
import {
  BearerAuth,
  NoAuth,
  OAuthAuthority,
  type Authenticator,
} from "./auth.ts";
import { createConnectorServer, MCP_PATH } from "./http.ts";
import type { CallContext, Principal, ToolDefinition, ToolSet } from "./mcp.ts";

export const CONNECTOR_VERSION = "0.1.0";
const ECHO_LIMIT = 4_000;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const ECHO_TOOLS: readonly ToolDefinition[] = [
  {
    name: "echo",
    title: "Echo",
    description: `Return \`text\` unchanged (up to ${ECHO_LIMIT} characters). Proves a round trip through this connector. Read-only: no Discord access, no side effects.`,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to send back" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "connection_info",
    title: "Connection info",
    description:
      "Report what this server saw on this call: MCP era and protocol version, session, the client's self-reported name and capabilities, the auth mode, and the HTTP request headers with credential values redacted. Read-only. Use it to record the connector proof on frond-ear#53.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

/** A self-reported value, kept small: it is display data from the client. */
function bounded(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  const encoded = JSON.stringify(value);
  return encoded.length <= 2_000
    ? value
    : `[${encoded.length} characters, not shown]`;
}

function describePrincipal(principal: Principal, now: number): object {
  if (principal.mode !== "oauth") {
    return { mode: principal.mode };
  }
  return {
    mode: "oauth",
    clientId: principal.clientId,
    clientName: principal.clientName ?? null,
    scope: principal.scope ?? null,
    expiresInSeconds: Math.round((principal.expiresAt - now) / 1_000),
  };
}

export function connectionInfo(context: CallContext, now: number): object {
  return {
    server: {
      name: "frond-ear-connector-echo",
      version: CONNECTOR_VERSION,
      time: new Date(now).toISOString(),
    },
    era: context.era,
    protocolVersion: context.protocolVersion,
    session: context.session
      ? {
          ageSeconds: Math.round(context.session.ageMs / 1_000),
          requests: context.session.requests,
        }
      : null,
    client: bounded(context.clientInfo),
    clientCapabilities: bounded(context.clientCapabilities),
    auth: describePrincipal(context.principal, now),
    http: context.http,
  };
}

export function echoTools(clock: Clock = systemClock): ToolSet {
  return {
    serverInfo: {
      name: "frond-ear-connector-echo",
      version: CONNECTOR_VERSION,
    },
    instructions:
      "frond-ear connector echo (frond-ear#53, first step). Read-only: `echo` returns its text and `connection_info` reports what the server saw. It has no Discord access and posts nothing anywhere.",
    tools: ECHO_TOOLS,
    call(name, args, context) {
      if (name === "connection_info") {
        return {
          text: JSON.stringify(connectionInfo(context, clock.now()), null, 2),
        };
      }
      const text = args.text;
      if (typeof text !== "string") {
        return { text: "echo needs a string `text`", isError: true };
      }
      if (text.length > ECHO_LIMIT) {
        return { text: `text is over ${ECHO_LIMIT} characters`, isError: true };
      }
      return { text };
    },
  };
}

// ---- CLI ----------------------------------------------------------------------------------

const USAGE = `usage: frond-ear connector-echo [--listen 127.0.0.1:8787] [--public-url https://<host>]
         [--auth none|bearer|oauth] [--token-file <path>] [--owner-secret-file <path>]
         [--client-id <id>]… [--no-dcr] [--allow-loopback-redirect]
         [--allow-origin <origin>]… [--no-sessions]`;

export interface ConnectorEchoConfig {
  host: string;
  port: number;
  publicUrl: string | undefined;
  auth: "none" | "bearer" | "oauth";
  tokenFile: string | undefined;
  ownerSecretFile: string | undefined;
  clientIds: string[];
  dynamicRegistration: boolean;
  loopbackRedirects: boolean;
  allowedOrigins: string[];
  sessions: boolean;
}

/** Parses and checks the flags; throws with a message for the operator. */
export function parseConnectorEchoArgs(argv: string[]): ConnectorEchoConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      listen: { type: "string", default: "127.0.0.1:8787" },
      "public-url": { type: "string" },
      auth: { type: "string", default: "none" },
      "token-file": { type: "string" },
      "owner-secret-file": { type: "string" },
      "client-id": { type: "string", multiple: true },
      "no-dcr": { type: "boolean" },
      "allow-loopback-redirect": { type: "boolean" },
      "allow-origin": { type: "string", multiple: true },
      "no-sessions": { type: "boolean" },
    },
  });
  const listen = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/u.exec(
    values.listen,
  );
  if (!listen || Number(listen[2]) > 65_535) {
    throw new Error(
      "--listen must be a loopback host:port (127.0.0.1, localhost or [::1]); expose it with Tailscale Funnel, not by binding wider",
    );
  }
  const auth = values.auth;
  if (auth !== "none" && auth !== "bearer" && auth !== "oauth") {
    throw new Error("--auth must be none, bearer or oauth");
  }
  const publicUrl = values["public-url"];
  if (publicUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(publicUrl);
    } catch {
      throw new Error("--public-url is not a URL");
    }
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search) {
      throw new Error(
        "--public-url must be an https origin with no path, e.g. https://host.example.ts.net",
      );
    }
  }
  if (auth === "bearer" && !values["token-file"]) {
    throw new Error("--auth bearer needs --token-file");
  }
  if (auth === "oauth" && (!publicUrl || !values["owner-secret-file"])) {
    throw new Error("--auth oauth needs --public-url and --owner-secret-file");
  }
  const allowedOrigins = values["allow-origin"] ?? [];
  for (const origin of allowedOrigins) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = undefined;
    }
    if (!parsed || parsed.origin !== origin) {
      throw new Error(
        `--allow-origin ${origin} is not an origin (scheme://host[:port])`,
      );
    }
  }
  return {
    host: listen[1] === "[::1]" ? "::1" : listen[1]!,
    port: Number(listen[2]),
    publicUrl: publicUrl === undefined ? undefined : new URL(publicUrl).origin,
    auth,
    tokenFile: values["token-file"],
    ownerSecretFile: values["owner-secret-file"],
    clientIds: values["client-id"] ?? [],
    dynamicRegistration: values["no-dcr"] !== true,
    loopbackRedirects: values["allow-loopback-redirect"] === true,
    allowedOrigins,
    sessions: values["no-sessions"] !== true,
  };
}

/** Reads a secret from a file only its owner can read; the value never comes from argv. */
export function readSecretFile(path: string, what: string): string {
  // One open, so the checks are about the file that is read. Non-blocking, so a FIFO
  // fails the regular-file check instead of waiting for a writer.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new Error(`${what} ${path} is not a regular file`);
    }
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `${what} ${path} is mode ${mode.toString(8)}; run chmod 600 on it first`,
      );
    }
    const value = readFileSync(fd, "utf8").trim();
    if (!value) {
      throw new Error(`${what} ${path} is empty`);
    }
    return value;
  } finally {
    closeSync(fd);
  }
}

export async function runConnectorEcho(
  argv: string[],
  io: Pick<Io, "stdout" | "stderr">,
): Promise<number> {
  let config: ConnectorEchoConfig;
  let auth: Authenticator;
  const secrets: string[] = [];
  try {
    config = parseConnectorEchoArgs(argv);
    if (config.auth === "bearer") {
      const token = readSecretFile(config.tokenFile!, "token file");
      secrets.push(token);
      auth = new BearerAuth(token);
    } else if (config.auth === "oauth") {
      const ownerSecret = readSecretFile(
        config.ownerSecretFile!,
        "owner secret file",
      );
      secrets.push(ownerSecret);
      auth = new OAuthAuthority({
        publicUrl: config.publicUrl!,
        ownerSecret,
        dynamicRegistration: config.dynamicRegistration,
        clientIds: config.clientIds,
        loopbackRedirects: config.loopbackRedirects,
      });
    } else {
      auth = new NoAuth();
    }
  } catch (error) {
    io.stderr.write(
      `frond-ear connector-echo: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`,
    );
    return 2;
  }
  const logger = new StructuredLogger(undefined, secrets);
  const connector = createConnectorServer({
    tools: echoTools(),
    auth,
    publicUrl: config.publicUrl,
    allowedOrigins: config.allowedOrigins,
    sessions: config.sessions,
    logger,
  });
  let port: number;
  try {
    port = await connector.listen(config.host, config.port);
  } catch (error) {
    io.stderr.write(
      `frond-ear connector-echo: cannot listen on ${config.host}:${config.port}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const local = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}${MCP_PATH}`;
  logger.log("info", "connector.listening", {
    local,
    publicMcpUrl: config.publicUrl ? `${config.publicUrl}${MCP_PATH}` : null,
    auth: config.auth,
    sessions: config.sessions,
    dynamicRegistration:
      config.auth === "oauth" ? config.dynamicRegistration : null,
  });
  io.stdout.write(
    `frond-ear connector echo on ${local} (auth ${config.auth}, sessions ${config.sessions ? "on" : "off"})\n` +
      (config.publicUrl
        ? `claude.ai connector URL: ${config.publicUrl}${MCP_PATH}\n`
        : `no --public-url: requests through a tunnel get 403 (Host not allowed); loopback only\n`),
  );
  return new Promise((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      void connector.close().then(() => {
        logger.log("info", "connector.stopped");
        resolve(0);
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
