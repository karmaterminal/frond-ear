// Picks how frond-ear hears canticle (binary-canticle#65, RFC-0001 §14, §23.2 q23):
// - `embedded`: its own listener, allowed only while it is the host's one listener.
//   If a host daemon answers on the host socket, the embedded listener refuses to
//   bind (rather than race the daemon for the UDP port) and says so in ear_status.
// - `host-daemon`: no UDP socket; read record v1 from the daemon's host socket.

import { connect } from "node:net";

import type { CanticleConfig } from "../config.ts";
import type { StructuredLogger } from "../logger.ts";
import type { Manifest } from "./manifest.ts";
import { RecordClient } from "./record-client.ts";
import {
  CanticleReceptor,
  type HearView,
  type StateStore,
} from "./receptor.ts";

export interface CanticleSource {
  start(): void;
  stop(): void;
  status(): object;
  hearView(ear: string): HearView;
}

/** Does something accept connections on the host socket? Resolves within `timeoutMs`. */
export function hostDaemonPresent(
  path: string,
  timeoutMs = 1_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (present: boolean) => {
      socket.destroy();
      resolve(present);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/** An embedded receptor that first checks it would be the host's one listener. */
export class GuardedEmbedded implements CanticleSource {
  readonly #receptor: CanticleReceptor;
  readonly #config: CanticleConfig;
  readonly #logger: StructuredLogger;
  readonly #probe: (path: string) => Promise<boolean>;
  #refused = false;
  #started = false;

  constructor(
    receptor: CanticleReceptor,
    config: CanticleConfig,
    logger: StructuredLogger,
    probe: (path: string) => Promise<boolean> = hostDaemonPresent,
  ) {
    this.#receptor = receptor;
    this.#config = config;
    this.#logger = logger;
    this.#probe = probe;
  }

  /** Resolves once decided; start() calls it without awaiting. */
  async decide(): Promise<void> {
    if (await this.#probe(this.#config.hostSocket)) {
      this.#refused = true;
      this.#logger.log("warn", "canticle.embedded_refused", {
        hostSocket: this.#config.hostSocket,
      });
      return;
    }
    this.#started = true;
    this.#receptor.start();
  }

  start(): void {
    void this.decide();
  }

  stop(): void {
    if (this.#started) this.#receptor.stop();
  }

  status(): object {
    if (this.#refused) {
      return {
        source: "embedded",
        state: "refused",
        reason: `a canticle host daemon answers on ${this.#config.hostSocket}, so this ear is not the host's one listener; set canticle.source to host-daemon`,
      };
    }
    return { source: "embedded", ...this.#receptor.status() };
  }

  hearView(ear: string): HearView {
    const view = this.#receptor.hearView(ear);
    return this.#refused
      ? { ...view, listening: false, blind: true, items: [] }
      : view;
  }
}

export function createCanticleSource(
  config: CanticleConfig,
  deps: {
    manifest: () => Manifest;
    store: StateStore;
    logger: StructuredLogger;
  },
): CanticleSource {
  if (config.source === "host-daemon") {
    return new RecordClient({
      socketPath: config.hostSocket,
      tune: config.tune,
      logger: deps.logger,
    });
  }
  return new GuardedEmbedded(
    new CanticleReceptor({
      config,
      manifest: deps.manifest(),
      store: deps.store,
      logger: deps.logger,
    }),
    config,
    deps.logger,
  );
}
