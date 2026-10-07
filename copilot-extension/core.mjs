// @ts-check
// frond-ear for the GitHub Copilot CLI: the Copilot-side twin of the Claude Code channel
// shim (src/shim.ts). It runs as a Copilot CLI extension, inside the live interactive
// session it joins, and speaks the same ear protocol to the daemon (src/protocol.ts):
//
//   hello → welcome · event → session.send(source "system", mode "enqueue") → offered
//   tool call → call → result
//
// Plain JavaScript with no dependencies: the CLI forks extensions with its own Node and
// resolves only `@github/copilot-sdk`, so nothing here may import frond-ear's TypeScript.
// The tool schemas come from config.json, which `frond-ear copilot-extension` writes from
// the shim's own TOOLS so the two targets can't drift.

import { connect as netConnect } from "node:net";

export const EAR_PROTOCOL_VERSION = 1;
export const EXTENSION_VERSION = "0.1.0";
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const CALL_TIMEOUT_MS = 60_000;

/**
 * @typedef {{ type: "welcome"; protocol: number; attached: boolean; ear?: string;
 *   generation?: number; instructions: string; error?: string }} Welcome
 * @typedef {{ type: "event"; batchId: number | null; content: string;
 *   meta: Record<string, string> }} EarEvent
 * @typedef {{ type: "result"; id: number; ok: boolean; text: string }} CallResult
 * @typedef {Welcome | EarEvent | CallResult | { type: "detached"; reason: string }} DaemonMessage
 * @typedef {{ name: string; description: string; inputSchema: object }} ToolSpec
 * @typedef {{ textResultForLlm: string; resultType: "failure" | "timeout"; error: string }} ToolFailure
 * @typedef {{ ear: string; tools: ToolSpec[]; socket?: string;
 *   tcp?: { host: string; port: number }; tokenFile?: string }} ExtensionConfig
 * @typedef {{ sessionId?: string;
 *   send(options: { prompt: string; source?: string; mode?: string }): Promise<unknown>;
 *   log(message: string, options?: { level?: string; ephemeral?: boolean }): Promise<unknown> }} Session
 * @typedef {(options: { tools: object[] }) => Promise<Session>} JoinSession
 * @typedef {{ write(data: string): unknown; on(event: string, listener: (...args: any[]) => void): unknown;
 *   once(event: string, listener: (...args: any[]) => void): unknown; setEncoding(enc: string): unknown;
 *   destroy(): unknown }} Duplex
 */

/**
 * Attribute values are daemon-set, but escape them anyway: the element is ours.
 * @param {unknown} value
 */
function attr(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/**
 * The same `<channel>` element Claude Code builds from a channel notification, so the
 * daemon's instructions ("Discord activity arrives as <channel> events") hold verbatim.
 * The daemon already neutralises `<channel`/`</channel` inside message text.
 * @param {EarEvent} event
 */
export function renderChannel(event) {
  const attrs = Object.entries(event.meta)
    .filter(([key]) => /^[a-z_][a-z0-9_]*$/u.test(key))
    .map(([key, value]) => ` ${key}="${attr(value)}"`)
    .join("");
  return `<channel source="frond-ear"${attrs}>\n${event.content}\n</channel>`;
}

/**
 * Join the foreground Copilot session and attach it to a frond-ear ear.
 * @param {JoinSession} joinSession
 * @param {ExtensionConfig} config
 * @param {{ connect?: () => Duplex; readToken?: (path: string) => string; reconnectMs?: number }} [deps]
 */
export async function start(joinSession, config, deps = {}) {
  const reconnectMs = deps.reconnectMs ?? 2_000;
  const connectDaemon =
    deps.connect ??
    (() =>
      /** @type {Duplex} */ (
        config.tcp
          ? netConnect(config.tcp.port, config.tcp.host)
          : netConnect(/** @type {string} */ (config.socket))
      ));

  /** @type {Map<number, (result: { ok: boolean; text: string }) => void>} */
  const calls = new Map();
  let nextCallId = 1;
  /** @type {Duplex | undefined} */
  let socket;
  let connected = false;
  let closed = false;
  /** @type {string | undefined} */
  let instructions;
  // Each welcome is a fresh attach with its own instructions (a daemon restart or config
  // change can rewrite them), so the preamble is owed once per welcome, not once per
  // extension lifetime. `welcomes` counts them; `preambleFor` is the one last prefixed.
  let welcomes = 0;
  let preambleFor = 0;
  /** @type {Promise<void>} */
  let delivering = Promise.resolve();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let reconnectTimer;
  const state = { attached: false, generation: 0, delivered: 0, failed: 0 };

  /** @param {object} message */
  const send = (message) => {
    if (socket && connected) socket.write(`${JSON.stringify(message)}\n`);
  };

  /**
   * @param {string} tool
   * @param {Record<string, unknown>} args
   * @returns {Promise<{ ok: boolean; text: string; timedOut?: boolean }>}
   */
  const call = (tool, args) => {
    if (!socket || !connected) {
      return Promise.resolve({
        ok: false,
        text: "frond-ear daemon is not reachable; is `frond-ear daemon` running?",
      });
    }
    const id = nextCallId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        calls.delete(id);
        resolve({
          ok: false,
          text: `frond-ear: ${tool} timed out`,
          timedOut: true,
        });
      }, CALL_TIMEOUT_MS);
      calls.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      send({ type: "call", id, tool, args });
    });
  };

  const tools = config.tools.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema,
    // Success is the plain text; a failure is the SDK's ToolResultObject, so the session
    // sees a failed call rather than a success whose text happens to start with "error".
    /**
     * @param {Record<string, unknown> | undefined} args
     * @returns {Promise<string | ToolFailure>}
     */
    handler: async (args) => {
      const result = await call(spec.name, args ?? {});
      if (result.ok) return result.text;
      return {
        textResultForLlm: `error: ${result.text}`,
        resultType: result.timedOut ? "timeout" : "failure",
        error: result.text,
      };
    },
  }));

  const session = await joinSession({ tools });

  /** @param {string} message @param {string} [level] */
  const log = (message, level = "info") =>
    session.log(`frond-ear: ${message}`, { level }).catch(() => undefined);

  /**
   * Events are delivered one at a time, in order. `offered` is sent only once the
   * session accepted the message: an event the session never took stays unseen in the
   * daemon's ledger and comes back as a digest on the next attach.
   * @param {EarEvent} event
   */
  const deliver = (event) => {
    // The attach an event belongs to is the one it arrived on, not the one current when
    // its turn in the queue comes: a reconnect while a send is pending must not hand the
    // old attach's queued events the new instructions, nor offer them on the new socket.
    const owed = welcomes;
    const owedInstructions = instructions;
    const via = socket;
    delivering = delivering.then(async () => {
      const preamble =
        preambleFor < owed && owedInstructions ? `${owedInstructions}\n\n` : "";
      try {
        await session.send({
          prompt: `${preamble}${renderChannel(event)}`,
          source: "system",
          mode: "enqueue",
        });
        if (preamble !== "") preambleFor = owed;
        state.delivered += 1;
        if (event.batchId !== null && socket === via)
          send({ type: "offered", batchId: event.batchId });
      } catch (error) {
        state.failed += 1;
        await log(
          `could not deliver batch ${event.batchId ?? "-"}: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    });
  };

  /** @param {DaemonMessage} message */
  const handle = (message) => {
    switch (message.type) {
      case "welcome":
        if (message.error) {
          void log(message.error, "error");
          return;
        }
        instructions = message.instructions;
        welcomes += 1;
        state.attached = message.attached;
        state.generation = message.generation ?? 0;
        return;
      case "event":
        deliver(message);
        return;
      case "result":
        calls.get(message.id)?.({ ok: message.ok, text: message.text });
        calls.delete(message.id);
        return;
      case "detached":
        state.attached = false;
        deliver({
          type: "event",
          batchId: null,
          content: `frond-ear: this session no longer receives Discord events for its ear (${message.reason}): another session holds it now, or the config dropped it. reply still posts as the bot, but ack and inbox mark nothing and set_attention refuses. Stop replying until you know who holds the ear (ear_status shows each ear's sessionId and shimPid).`,
          meta: { kind: "detached", reason: message.reason },
        });
        return;
      default:
        return;
    }
  };

  const open = () => {
    if (closed) return;
    const s = connectDaemon();
    socket = s;
    let buffer = "";
    s.setEncoding("utf8");
    s.once("connect", () => {
      connected = true;
      const token =
        config.tokenFile && deps.readToken
          ? deps.readToken(config.tokenFile)
          : undefined;
      send({
        type: "hello",
        role: "shim",
        protocol: EAR_PROTOCOL_VERSION,
        ear: config.ear,
        pid: process.pid,
        client: {
          name: "frond-ear-copilot-extension",
          version: EXTENSION_VERSION,
        },
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        ...(token ? { token } : {}),
      });
    });
    s.on("data", (/** @type {string} */ chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_CHARS && !buffer.includes("\n")) {
        s.destroy();
        return;
      }
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        try {
          handle(JSON.parse(line));
        } catch {
          s.destroy(); // malformed: drop the connection, never half-parse
          return;
        }
      }
    });
    s.on("error", () => undefined);
    s.once("close", () => {
      if (socket !== s) return;
      const was = connected;
      connected = false;
      socket = undefined;
      state.attached = false;
      for (const resolve of calls.values()) {
        resolve({ ok: false, text: "frond-ear daemon connection lost" });
      }
      calls.clear();
      if (was) void log("daemon connection lost; reconnecting", "warning");
      if (!closed) reconnectTimer = setTimeout(open, reconnectMs);
    });
  };

  open();

  return {
    status: () => ({
      ...state,
      connected,
      preambleSent: welcomes > 0 && preambleFor === welcomes,
    }),
    stop: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.destroy();
    },
    /** Resolves once every event received so far has been handed to the session. */
    settled: () => delivering,
  };
}
