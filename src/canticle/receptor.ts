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
import { CLASSES, SCOPE_NAMES } from "./ids.ts";
import { Listener, type ListenerEvent, type SafetyState } from "./listener.ts";
import type { Manifest } from "./manifest.ts";
import type { Identity } from "./wire.ts";

const STATE_KEY = "canticle.listener_state";
const TICK_MS = 1_000;
/** The guard journal is checkpointed into a full snapshot before it outgrows either cap. */
export const JOURNAL_MAX_RECORDS = 4_096;
export const JOURNAL_MAX_BYTES = 1 << 20;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** No datagram from anyone for this long: render stations `unknown`, not `offline`. */
const BLIND_AFTER_MS = 30_000;

/**
 * Where restart safety lives (the event store's runtime_state + runtime_journal): a snapshot,
 * plus a write-ahead journal of the guards raised since it was written.
 */
export interface StateStore {
  runtimeState(name: string): string | undefined;
  /** The journal's records, oldest first. */
  runtimeJournal(name: string): string[];
  /** Append one record; durable when it returns, as durable as a snapshot write. */
  appendRuntimeJournal(name: string, value: string): void;
  /** Replace the snapshot and empty its journal, atomically. */
  checkpointRuntimeState(name: string, value: string): void;
}

export interface LiveItem {
  station: string;
  /** Key-id hex: the station's identity as the manifest pins it. */
  key: string;
  stream: string;
  seq: string;
  epoch: number;
  class: string;
  scope: string;
  hop: number;
  /** Declared by the station; context, not authority (§14.13). */
  purpose: string | undefined;
  issuedAt: number;
  /** When this listener first heard it (receiver clock). */
  heardAt: number;
  expiresAt: number;
  /** Bytes, for a body that isn't shown (non-text ctype). */
  bodyBytes: number | undefined;
  stateKey: string | undefined;
  /** The station's principal, from the manifest or the record; never from the frame. */
  principal?: string | undefined;
  /** Lineage root as `key:epoch:stream:seq` (§14.11); undefined when not known. */
  root?: string | undefined;
  text: string | undefined;
  ctype: number | string | undefined;
  bodyRef: { url: string; sha256: string; size: string } | undefined;
  ageMs: number;
  expiresInMs: number;
  copies: number;
}

export interface HearView {
  now: number;
  /** Whether this ear tunes any station:stream at all. */
  tuned: boolean;
  listening: boolean;
  blind: boolean;
  lastDatagramAt: number | undefined;
  stations: Array<{ name: string; presence: string }>;
  items: LiveItem[];
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

/**
 * Whether every raised guard is durable. `failed` (reason `state_not_durable`) means a guard
 * the receptor has acted on isn't in the store: nothing is surfaced until a checkpoint lands.
 */
export type ReceptorHealth =
  | { state: "ok" }
  | { state: "failed"; reason: "state_not_durable"; error: string };

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

/** §14.13 `root=`: the declared lineage root, or the item itself when it has none. */
function rootOf(
  root: Identity | undefined,
  kid: string,
  self: { epoch: number; stream: number; seq: bigint },
): string {
  const r = root ?? { keyId: Buffer.from(kid, "hex"), ...self };
  return `${Buffer.from(r.keyId).toString("hex").slice(0, 16)}:${r.epoch}:${r.stream.toString(16).padStart(8, "0")}:${r.seq}`;
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
  #lastDatagramAt: number | undefined;
  #journalRecords = 0;
  #journalBytes = 0;
  /** Set while a raised guard isn't durable; cleared by the next checkpoint that lands. */
  #notDurable: string | undefined;
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
    const lines = options.store.runtimeJournal(STATE_KEY);
    const journal: SafetyState[] = [];
    lines.forEach((line, i) => {
      try {
        journal.push(JSON.parse(line) as SafetyState);
      } catch {
        // Only the last record can be torn by a crash mid-append; its datagram never
        // finished, so it was never relied on. Anything earlier is corruption: refuse.
        if (i < lines.length - 1) {
          throw new Error(
            "canticle: listener journal record is not valid JSON; refusing to start",
          );
        }
        options.logger.log("warn", "canticle.journal_torn", { record: i });
      }
    });
    this.#journalRecords = lines.length;
    this.#journalBytes = lines.reduce((n, l) => n + l.length, 0);
    this.#listener = new Listener(options.manifest, {
      tuned: streams,
      binding: options.config.binding,
      restore,
      journal,
    });
    // Fold the replayed journal into a fresh snapshot before any datagram is accepted, so a
    // torn last record is gone before anything is appended after it (🌫 #27 review).
    if (lines.length > 0) {
      try {
        this.#save();
      } catch (error) {
        this.#failDurability(error);
      }
    }
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
        this.#save(this.#notDurable !== undefined);
      } catch (error) {
        if (this.#notDurable !== undefined) this.#failDurability(error);
        else this.#saveFailed(error);
      }
      this.#scheduleTick();
    }, TICK_MS);
  }

  /** One datagram in. Public as the test seam; never throws. */
  receive(datagram: Uint8Array): void {
    this.#counts.datagrams += 1;
    this.#lastDatagramAt = this.#clock.now();
    const events = this.#listener.hear(datagram, this.#clock.now());
    this.#apply(events);
    // A raised safety guard (epoch, sticky pluck, supersession mark) must outlive a crash
    // (§7.7, §7.8), so it is journaled before this returns: one small record of just those
    // guards, not the whole snapshot. Everything else waits for the tick's checkpoint
    // (≤ TICK_MS), so neither a flood of admissions nor keyed churn serialises the state
    // per datagram. A full journal is checkpointed early, keeping it bounded.
    const record = this.#listener.takeJournal();
    if (record === undefined) return;
    // Not durable: append nothing after a possibly torn tail; the tick's checkpoint retries.
    if (this.#notDurable !== undefined) return;
    const line = JSON.stringify(record);
    try {
      this.#options.store.appendRuntimeJournal(STATE_KEY, line);
    } catch (appendError) {
      // The guard is only in memory. A full checkpoint makes it durable another way; if
      // that fails too, fail closed rather than act on a guard a restart would forget.
      this.#saveFailed(appendError);
      try {
        this.#save(true);
      } catch (error) {
        this.#failDurability(error);
      }
      return;
    }
    this.#journalRecords += 1;
    this.#journalBytes += line.length;
    if (
      this.#journalRecords >= JOURNAL_MAX_RECORDS ||
      this.#journalBytes >= JOURNAL_MAX_BYTES
    ) {
      try {
        this.#save();
      } catch (error) {
        this.#saveFailed(error); // the guard is journaled; the next tick retries the checkpoint
      }
    }
  }

  /** Enter `state_not_durable`: logged once per transition, not per datagram or tick. */
  #failDurability(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.#counts.saveFailures += 1;
    if (this.#notDurable === undefined) {
      this.#options.logger.log("error", "canticle.state_not_durable", {
        reason,
      });
    }
    this.#notDurable = reason;
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

  /** Checkpoint: the full snapshot replaces the old one and empties the journal. */
  #save(force = false): void {
    if (!force && !this.#listener.dirty && this.#journalRecords === 0) return;
    this.#options.store.checkpointRuntimeState(
      STATE_KEY,
      JSON.stringify(this.#listener.snapshot()),
    );
    this.#listener.markSaved();
    this.#journalRecords = 0;
    this.#journalBytes = 0;
    if (this.#notDurable !== undefined) {
      this.#notDurable = undefined;
      this.#options.logger.log("info", "canticle.state_durable", {});
    }
  }

  /** `failed` while a raised guard isn't durable; `live()` surfaces nothing until it clears. */
  health(): ReceptorHealth {
    return this.#notDurable === undefined
      ? { state: "ok" }
      : {
          state: "failed",
          reason: "state_not_durable",
          error: this.#notDurable,
        };
  }

  /** What one ear hears right now: live items on its tuned station:streams. */
  live(ear: string): LiveItem[] {
    if (this.#notDurable !== undefined) return [];
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
        key: h.kid,
        stream,
        seq: it.seq.toString(),
        epoch: it.epoch,
        class: CLASSES.get(it.cls)?.name ?? String(it.cls),
        scope: SCOPE_NAMES.get(it.scope) ?? String(it.scope),
        hop: it.hop,
        purpose: it.purpose,
        issuedAt: it.issuedAt,
        heardAt: h.firstHeard,
        expiresAt: it.expiresAt,
        bodyBytes:
          it.ctype !== 1 && it.body !== undefined ? it.body.length : undefined,
        stateKey: it.stateKey,
        root: rootOf(it.root, h.kid, it),
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
        ageMs: Math.max(
          0,
          now - it.issuedAt - this.#listener.clockOffset(h.kid),
        ),
        expiresInMs: Math.max(0, h.localExpiry - now),
        copies: h.copies,
      });
    }
    return out;
  }

  /**
   * What one ear hears now, plus who's on air. If this listener has heard no
   * datagram at all for `BLIND_AFTER_MS`, every station reads `unknown`: silence
   * from everyone at once is more likely our own socket or network than every
   * station going quiet together (station silence ≠ transport blindness).
   */
  hearView(ear: string): HearView {
    const now = this.#clock.now();
    const blind =
      this.#state !== "listening" ||
      this.#lastDatagramAt === undefined ||
      now - this.#lastDatagramAt > BLIND_AFTER_MS;
    const tune = this.#options.config.tune;
    const patterns = Object.hasOwn(tune, ear) ? (tune[ear] ?? []) : [];
    const stations = [...this.#listener.stations.keys()]
      .map((kid) => {
        const name =
          this.#options.manifest.entry(Buffer.from(kid, "hex"))?.name ?? kid;
        return {
          name,
          presence: blind ? "unknown" : this.#listener.presenceState(kid, now),
        };
      })
      .filter((s) =>
        patterns.some((p) => p.startsWith("*:") || p.startsWith(`${s.name}:`)),
      );
    return {
      now,
      tuned: patterns.length > 0,
      listening: this.#state === "listening",
      blind,
      lastDatagramAt: this.#lastDatagramAt,
      stations,
      items: this.live(ear),
    };
  }

  status(): object {
    const now = this.#clock.now();
    return {
      state: this.#state,
      bind: `${this.#options.config.bindHost}:${this.#options.config.port}`,
      binding: this.#options.config.binding,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      health: this.health(),
      onAir: this.#listener.current.size,
      journal: this.#journalRecords,
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
