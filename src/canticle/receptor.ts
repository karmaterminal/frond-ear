// The binary-canticle receptor: one UDP listener per host, owned by the daemon,
// fanning heard items out to the ears that tune them (frond-ear#24).
//
// Listen-only and silent: nothing here wakes a session or writes the Discord
// event ledger. What's on air lives in the listener's in-memory live set (it
// refills as stations loop); only the restart-safety state is persisted. P3
// adds the `hear` tool that reads `live()`.

import { createSocket, type Socket } from "node:dgram";

import type { CanticleConfig } from "../config.ts";
import type { StructuredLogger } from "../logger.ts";
import type { Clock, Timers } from "../types.ts";
import { systemClock, systemTimers } from "../types.ts";
import { CLASSES } from "./ids.ts";
import { Listener, type ListenerEvent, type SafetyState } from "./listener.ts";
import type { Manifest } from "./manifest.ts";

const STATE_KEY = "canticle.listener_state";
const TICK_MS = 1_000;
/** At most one synchronous safety save per this interval; the rest ride the tick. */
const URGENT_SAVE_MIN_MS = 250;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** Where the restart-safety snapshot lives (the event store's runtime_state). */
export interface StateStore {
  runtimeState(name: string): string | undefined;
  setRuntimeState(name: string, value: string): void;
}

export interface LiveItem {
  station: string;
  stream: string;
  seq: string;
  class: string;
  stateKey: string | undefined;
  text: string | undefined;
  ctype: number | string | undefined;
  bodyRef: { url: string; sha256: string; size: string } | undefined;
  ageMs: number;
  expiresInMs: number;
  copies: number;
}

export interface ReceptorOptions {
  config: CanticleConfig;
  manifest: Manifest;
  store: StateStore;
  logger: StructuredLogger;
  clock?: Clock;
  timers?: Timers;
  /** Test seam: a socket factory. Defaults to a real UDPv4 socket. */
  socket?: () => Socket;
}

type ReceptorState = "starting" | "listening" | "backoff" | "stopped";

/** "station:stream" tune patterns → does this item belong to this ear? */
function tuned(
  patterns: readonly string[],
  station: string,
  stream: string,
): boolean {
  return patterns.some((p) => {
    const at = p.indexOf(":");
    const s = p.slice(0, at);
    return (s === "*" || s === station) && p.slice(at + 1) === stream;
  });
}

export class CanticleReceptor {
  readonly #options: ReceptorOptions;
  readonly #listener: Listener;
  readonly #clock: Clock;
  readonly #timers: Timers;
  #socket: Socket | undefined;
  #state: ReceptorState = "starting";
  #lastError: string | undefined;
  #attempt = 0;
  #tickHandle: unknown;
  #retryHandle: unknown;
  #lastUrgentSaveAt = Number.NEGATIVE_INFINITY;
  readonly #counts = {
    datagrams: 0,
    items: 0,
    withdrawn: 0,
    superseded: 0,
    expired: 0,
    evidence: 0,
    saveFailures: 0,
  };

  constructor(options: ReceptorOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#timers = options.timers ?? systemTimers;
    const streams = new Set<string>();
    for (const pairs of Object.values(options.config.tune)) {
      for (const p of pairs) streams.add(p.slice(p.indexOf(":") + 1));
    }
    const saved = options.store.runtimeState(STATE_KEY);
    let restore: SafetyState | null = null;
    if (saved !== undefined) {
      try {
        restore = JSON.parse(saved) as SafetyState;
      } catch {
        // A corrupt snapshot must not be silently discarded into a fresh listener:
        // that would forget plucks and supersessions (§7.7). Refuse to start.
        throw new Error(
          "canticle: saved listener state is not valid JSON; refusing to start",
        );
      }
    }
    this.#listener = new Listener(options.manifest, {
      tuned: streams,
      binding: options.config.binding,
      restore,
    });
  }

  start(): void {
    this.#state = "starting";
    this.#bind();
    this.#scheduleTick();
  }

  stop(): void {
    this.#state = "stopped";
    this.#timers.clearTimeout(this.#tickHandle);
    this.#timers.clearTimeout(this.#retryHandle);
    try {
      this.#save();
    } catch (error) {
      this.#saveFailed(error); // a failing store must not stop the rest of shutdown
    }
    try {
      this.#socket?.close();
    } catch {
      // already closed
    }
    this.#socket = undefined;
  }

  #bind(): void {
    const { bindHost, port } = this.#options.config;
    const socket = (this.#options.socket ?? (() => createSocket("udp4")))();
    this.#socket = socket;
    socket.on("message", (buf) => this.receive(buf));
    socket.on("error", (error) => {
      this.#lastError = error.message;
      this.#options.logger.log("warn", "canticle.socket_error", {
        reason: error.message,
      });
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (this.#state !== "stopped") this.#retry();
    });
    socket.bind(port, bindHost, () => {
      this.#state = "listening";
      this.#attempt = 0;
      this.#lastError = undefined;
      this.#options.logger.log("info", "canticle.listening", {
        bindHost,
        port,
      });
    });
  }

  /** Same curve as the Discord gateway reconnect: min(30 s, 1 s·2^min(n,5)) + jitter. */
  #retry(): void {
    this.#state = "backoff";
    const delay =
      Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(this.#attempt, 5)) +
      Math.floor(Math.random() * 1_000);
    this.#attempt += 1;
    this.#retryHandle = this.#timers.setTimeout(() => {
      if (this.#state !== "stopped") this.#bind();
    }, delay);
  }

  #scheduleTick(): void {
    this.#tickHandle = this.#timers.setTimeout(() => {
      if (this.#state === "stopped") return;
      try {
        this.#apply(this.#listener.tick(this.#clock.now()));
        this.#save();
      } catch (error) {
        this.#saveFailed(error);
      }
      this.#scheduleTick();
    }, TICK_MS);
  }

  /** One datagram in. Public as the test seam; never throws. */
  receive(datagram: Uint8Array): void {
    this.#counts.datagrams += 1;
    const events = this.#listener.hear(datagram, this.#clock.now());
    this.#apply(events);
    // Only a raised safety guard (epoch, sticky pluck, supersession mark) is written now; it
    // must outlive a crash (§7.7). Everything else waits for the tick's save (≤ TICK_MS), so a
    // flood of admissions can't serialise the whole snapshot per datagram.
    // Urgent saves are coalesced (≤ 1 per URGENT_SAVE_MIN_MS) so keyed churn at line rate
    // can't serialise per datagram either; a coalesced one is written by the next tick.
    if (!this.#listener.urgent) return;
    const now = this.#clock.now();
    if (now - this.#lastUrgentSaveAt < URGENT_SAVE_MIN_MS) return;
    this.#lastUrgentSaveAt = now;
    try {
      this.#save();
    } catch (error) {
      this.#saveFailed(error);
    }
  }

  #saveFailed(error: unknown): void {
    this.#counts.saveFailures += 1;
    this.#options.logger.log("error", "canticle.save_failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  #apply(events: ListenerEvent[]): void {
    for (const e of events) {
      if (e.event === "item") this.#counts.items += 1;
      else if (e.event === "withdrawn") this.#counts.withdrawn += 1;
      else if (e.event === "superseded") this.#counts.superseded += 1;
      else if (e.event === "expired") this.#counts.expired += 1;
      else if (e.event === "evidence") {
        this.#counts.evidence += 1;
        this.#options.logger.log("debug", "canticle.evidence", {
          station: e.station,
          reason: e.data.reason,
        });
      }
    }
  }

  #save(): void {
    if (!this.#listener.dirty) return;
    this.#options.store.setRuntimeState(
      STATE_KEY,
      JSON.stringify(this.#listener.snapshot()),
    );
    this.#listener.markSaved();
  }

  /** What one ear hears right now: live items on its tuned station:streams. */
  live(ear: string): LiveItem[] {
    const tune = this.#options.config.tune;
    const patterns = Object.hasOwn(tune, ear) ? (tune[ear] ?? []) : [];
    const now = this.#clock.now();
    const out: LiveItem[] = [];
    for (const h of this.#listener.current.values()) {
      const station =
        this.#options.manifest.entry(Buffer.from(h.kid, "hex"))?.name ?? h.kid;
      const stream = this.#options.manifest
        .entry(Buffer.from(h.kid, "hex"))
        ?.streamNames.get(h.item.stream);
      if (stream === undefined || !tuned(patterns, station, stream)) continue;
      const it = h.item;
      out.push({
        station,
        stream,
        seq: it.seq.toString(),
        class: CLASSES.get(it.cls)?.name ?? String(it.cls),
        stateKey: it.stateKey,
        text:
          it.ctype === 1 && it.body !== undefined
            ? Buffer.from(it.body).toString("utf8")
            : undefined,
        ctype: it.ctype,
        bodyRef: it.bodyRef && {
          url: it.bodyRef.url,
          sha256: Buffer.from(it.bodyRef.sha256).toString("hex"),
          size: it.bodyRef.size.toString(),
        },
        ageMs: Math.max(0, now - h.firstHeard),
        expiresInMs: Math.max(0, h.localExpiry - now),
        copies: h.copies,
      });
    }
    return out;
  }

  status(): object {
    const now = this.#clock.now();
    return {
      state: this.#state,
      bind: `${this.#options.config.bindHost}:${this.#options.config.port}`,
      binding: this.#options.config.binding,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      onAir: this.#listener.current.size,
      counts: { ...this.#counts },
      evidence: Object.fromEntries(this.#listener.evidenceCounts),
      stations: Object.fromEntries(
        [...this.#listener.stations.keys()].map((kid) => [
          this.#options.manifest.entry(Buffer.from(kid, "hex"))?.name ?? kid,
          this.#listener.presenceState(kid, now),
        ]),
      ),
    };
  }
}
