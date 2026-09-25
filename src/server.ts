import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import type { Daemon } from "./daemon.ts";
import { LineConnection } from "./protocol.ts";

function socketInUse(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

function attach(daemon: Daemon, socket: Socket, requireToken: boolean): void {
  let handlers: ReturnType<Daemon["connect"]> | undefined;
  const connection = new LineConnection(
    socket,
    (message) => handlers?.onMessage(message),
    () => handlers?.onClose(),
  );
  handlers = daemon.connect(connection, { requireToken });
}

/**
 * Listens on a unix socket inside a 0700 directory; the socket itself is
 * 0600, so only the owning user can attach a shim or drive the CLI.
 */
export async function listenUnix(
  daemon: Daemon,
  path: string,
): Promise<Server> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  if (existsSync(path)) {
    if (await socketInUse(path)) {
      throw new Error(
        `another frond-ear daemon is already listening on ${path}`,
      );
    }
    unlinkSync(path);
  }
  const server = createServer((socket) => attach(daemon, socket, false));
  // Create the socket 0600 atomically rather than chmod-ing after the fact.
  const previousUmask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(previousUmask);
  }
  chmodSync(path, 0o600);
  return server;
}

/**
 * TCP for containers where unix sockets cannot cross (e.g. macOS Docker).
 * Every TCP client must present the shared token in its hello; publish the
 * port to the host's loopback only.
 */
export async function listenTcp(
  daemon: Daemon,
  host: string,
  port: number,
): Promise<Server> {
  const server = createServer((socket) => attach(daemon, socket, true));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
