// A CLI-side client of the daemon: one request/response exchange over the
// unix socket (or TCP with the shared token). Shared by `status`, `inject`,
// `send` and `doctor`.
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";

import { defaultSocketPath } from "./config.ts";
import type { ClientMessage, DaemonMessage } from "./protocol.ts";
import { EAR_PROTOCOL_VERSION, LineConnection } from "./protocol.ts";

export function tcpTarget(
  env: NodeJS.ProcessEnv,
): { host: string; port: number } | undefined {
  const value = env.FROND_EAR_TCP;
  if (!value) {
    return undefined;
  }
  const index = value.lastIndexOf(":");
  const port = Number(value.slice(index + 1));
  if (index <= 0 || !Number.isInteger(port)) {
    throw new Error("FROND_EAR_TCP must be host:port");
  }
  return { host: value.slice(0, index), port };
}

export function tcpToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.FROND_EAR_TOKEN_FILE
    ? readFileSync(env.FROND_EAR_TOKEN_FILE, "utf8").trim()
    : undefined;
}

export function connectToDaemon(env: NodeJS.ProcessEnv): () => Socket {
  const tcp = tcpTarget(env);
  return tcp
    ? () => connect(tcp.port, tcp.host)
    : () => connect(defaultSocketPath(env));
}

type WithoutId<M> = M extends { id: number } ? Omit<M, "id"> : never;

/** The requests a CLI client may send: status, inject, call, and the ear-binding ones. */
export type CliRequest = WithoutId<
  Extract<
    ClientMessage,
    { type: "status" | "inject" | "call" | "bind" | "reentry" }
  >
>;

/**
 * `request` stopped waiting. The daemon may have taken the request and still be
 * working on it.
 */
export class DaemonTimeoutError extends Error {}

/**
 * One request/response exchange with the daemon as a CLI client. With
 * `timeoutMs`, a daemon that accepts the connection but never answers (or a
 * socket nobody is listening on) fails instead of hanging.
 */
export function request(
  message: CliRequest,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number,
): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve, reject) => {
    // Read before connecting: an unreadable token file rejects here instead of
    // throwing from the socket's connect handler.
    const token = tcpTarget(env) ? tcpToken(env) : undefined;
    const socket = connectToDaemon(env)();
    let timer: NodeJS.Timeout | undefined;
    const settle = <T>(fn: (value: T) => void) => {
      return (value: T) => {
        clearTimeout(timer);
        fn(value);
      };
    };
    const done = settle(resolve);
    const fail = settle(reject);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        socket.destroy();
        fail(
          new DaemonTimeoutError(
            `the daemon did not answer within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    }
    const connection = new LineConnection(
      socket,
      (raw) => {
        const reply = raw as DaemonMessage;
        if (reply.type === "welcome") {
          connection.send({ ...message, id: 1 });
        } else if (reply.type === "result") {
          connection.close();
          done({ ok: reply.ok, text: reply.text });
        }
      },
      () => fail(new Error("daemon closed the connection")),
    );
    socket.once("connect", () => {
      connection.send({
        type: "hello",
        role: "cli",
        protocol: EAR_PROTOCOL_VERSION,
        ...(token ? { token } : {}),
      });
    });
    socket.once("error", (error) => fail(error));
  });
}
