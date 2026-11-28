// `frond-ear house-export --ear <name> [--offline]`: one JSON document that ews-concept-new's
// house card (frond-house §3.C.1) renders from, for this ear, instead of its SYNTHETIC demo.
//
// - The reader profile comes from the ear's own config, read with the daemon's own parser
//   (FROND_EAR_CONFIG): `reader` is the ear, `may_read` is its `canticle.tune` list as it
//   stands (tune.ts's patterns: `station:stream`, the station may be `*`), and
//   `payload_text` is whether `hear` shows this ear payload text at all: yes whenever
//   canticle is enabled, since delivery gates only what is pushed, never what `hear` reads.
//   `basis` keeps the push side apart (mode, style, mute) so neither stands in for the other.
// - The deck is the stations and streams this ear knows: the manifest's (names and stream
//   names only), the stations its tune names, and, from the daemon's existing local
//   interface as a CLI client, every station in `status`'s presence table and every row
//   `canticle_guide` lists, tuned and untuned. Each stream says `tuned` (tune.ts),
//   `admitted` (named in its station's manifest entry; unknown otherwise, never no) and
//   what is `live` on air now. No beacon age and no window start exist here, so none is given.
// - Names and state words only, built field by field: no payload, purpose or state key
//   (the guide never reads them), no key ids, public keys, Discord ids, paths or tokens.
//   Every name that reaches it (station, stream, tune pattern, push station) is checked for
//   an identity shape (`identityShape`); one that has one is withheld, and `withheld` says
//   how many, where and why, never what. A withheld tune pattern marks `may_read` incomplete.
//   An identity-shaped ear name refuses the export, and a last pass over every output string
//   (`identityIn`) refuses it whole if anything slipped past, printing nothing.
// - Read-only. It reads two files and asks the daemon `status` and `canticle_guide`, both
//   looks (the guide's read of delivery modes purges attention rows whose TTL had already
//   lapsed, as every such read does); it starts, stops and writes nothing itself.
//   `--offline` skips the daemon.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { request as daemonRequest, type CliRequest } from "../client.ts";
import {
  loadConfigFile,
  runtimeOptions,
  type CanticleConfig,
} from "../config.ts";
import { Manifest } from "./manifest.ts";
import { tunes } from "./tune.ts";

export interface HouseIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
  /** One exchange with the daemon; the real client by default. */
  request?: (message: CliRequest) => Promise<{ ok: boolean; text: string }>;
  /** This checkout's short commit (and `+dirty`); git by default. */
  revision?: () => string;
  now?: () => number;
}

const USAGE = "usage: frond-ear house-export --ear <name> [--offline]\n";

export const HOUSE_EXPORT_KIND = "frond-house-export/0";

const LOOK =
  "names and state words only: no payload text, item content, key, Discord id, path or token";

/** A station or stream name the export will print: identifier-safe, and no identity shape. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** A closed state word (presence, verification, delivery mode, listener). */
const WORD = /^[A-Za-z][A-Za-z_: -]{0,39}$/u;

/** Why a name was withheld: the shape it had, never its value. */
export type Withheld =
  | "discord-id shape"
  | "key-id shape"
  | "path shape"
  | "not an identifier";

/**
 * The identity shapes no export string may carry, anywhere in it: a 17-20 digit run (a
 * Discord id), 16 hex digits in a row (a station key id, or part of a public key), and a
 * path separator or home prefix. A name that fits a parser's grammar can still hold one: a
 * tune's `f6eecf2f43082a97:ops.fleet`, a manifest station named by a Discord id (🌫, #147).
 */
export function identityShape(text: string): Withheld | null {
  if (/[0-9]{17,20}/u.test(text)) return "discord-id shape";
  if (/[0-9a-f]{16}/iu.test(text)) return "key-id shape";
  if (/[\\/]|^~/u.test(text)) return "path shape";
  return null;
}

/** Why a station or stream name can't be printed, or null when it can. */
function nameIssue(name: string): Withheld | null {
  return identityShape(name) ?? (NAME.test(name) ? null : "not an identifier");
}

/** Why a tune pattern can't be printed, or null when it can (its station may be `*`). */
function patternIssue(pattern: string): Withheld | null {
  const at = pattern.indexOf(":");
  if (at < 0) return "not an identifier";
  const station = pattern.slice(0, at);
  return (
    (station === "*" ? null : nameIssue(station)) ??
    nameIssue(pattern.slice(at + 1))
  );
}

/** The export's own fixed strings, which carry no identity: the kind holds a `/`. */
const CONSTANTS = new Set<string>([HOUSE_EXPORT_KIND, LOOK]);

/**
 * The backstop: every string and number in `doc` (keys too) that holds an identity shape,
 * by place and reason, never by value. The export is refused whole if any is found, so a
 * field a future change forgets to check fails closed instead of printing.
 */
export function identityIn(
  doc: unknown,
): Array<{ at: string; reason: Withheld }> {
  const found: Array<{ at: string; reason: Withheld }> = [];
  const walk = (value: unknown, at: string) => {
    if (typeof value === "string") {
      if (CONSTANTS.has(value)) return;
      const reason = identityShape(value);
      if (reason !== null) found.push({ at, reason });
    } else if (typeof value === "number" || typeof value === "bigint") {
      const reason = /[0-9]{17,}/u.test(
        typeof value === "number" ? value.toFixed(0) : String(value),
      )
        ? "discord-id shape"
        : null;
      if (reason !== null) found.push({ at, reason });
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${at}[${i}]`));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        // An identity-shaped key is its own finding, and its place never names it.
        const reason = identityShape(key);
        const name = reason === null ? key : "<withheld key>";
        const place = at === "" ? name : `${at}.${name}`;
        if (reason !== null) found.push({ at: place, reason });
        walk(item, place);
      }
    }
  };
  walk(doc, "");
  return found;
}

/** The most guide pages read (100 rows each); past it the deck is marked truncated. */
const MAX_PAGES = 20;
const DAEMON_TIMEOUT_MS = 5_000;

interface StreamOut {
  stream: string;
  tuned: boolean;
  admitted: boolean | null;
  live: number | null;
  newest_age_ms: number | null;
}

interface StationOut {
  name: string;
  presence: string | null;
  verification: string | null;
  in_manifest: boolean;
  streams_known: "complete" | "partial";
  streams: StreamOut[];
}

interface Building {
  presence: string | null;
  verification: string | null;
  manifestStreams: Set<string> | undefined;
  streams: Map<string, { live: number; newestAgeMs: number | null }>;
  /** A stream of this station was withheld, so its list is partial. */
  lost: boolean;
}

const obj = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

/**
 * The source's revision word from `git rev-parse --short` and `git status --porcelain`: at
 * most 12 hex digits, since a longer one would read as a key id; anything else is unknown.
 */
export function revisionWord(sha: string, porcelain: string): string {
  return /^[0-9a-f]{7,12}$/u.test(sha)
    ? `${sha}${porcelain === "" ? "" : "+dirty"}`
    : "unknown";
}

function gitRevision(): string {
  const repo = join(import.meta.dirname, "..", "..");
  try {
    const sha = execFileSync(
      "git",
      ["-C", repo, "rev-parse", "--short", "HEAD"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const dirty = execFileSync(
      "git",
      ["-C", repo, "status", "--porcelain", "--untracked-files=no"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return revisionWord(sha, dirty);
  } catch {
    return "unknown";
  }
}

type DaemonView =
  | {
      kind: "daemon";
      listener: string;
      presence: Map<string, string>;
      rows: unknown[];
      untuned: unknown[];
      untunedMore: number;
      truncated: boolean;
    }
  | { kind: "config"; listener: "not reached" | "not asked" | "canticle off" };

/** `status`'s canticle presence table and every page of `canticle_guide`, as a CLI client. */
async function readDaemon(
  ear: string,
  ask: NonNullable<HouseIo["request"]>,
): Promise<DaemonView> {
  const status = await ask({ type: "status" });
  if (!status.ok) throw new Error("status refused");
  const canticle = obj(obj(JSON.parse(status.text))?.canticle);
  const presence = new Map<string, string>();
  for (const [name, state] of Object.entries(obj(canticle?.stations) ?? {})) {
    if (typeof state === "string") presence.set(name, state);
  }
  const rows: unknown[] = [];
  let untuned: unknown[] = [];
  let untunedMore = 0;
  // Only the guide's own word says the listener is listening; with no guide view, unknown.
  let listener = "unknown";
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) {
      truncated = true;
      break;
    }
    const result = await ask({
      type: "call",
      tool: "canticle_guide",
      args: { ear, limit: 100, ...(cursor ? { cursor } : {}) },
    });
    if (!result.ok) throw new Error("canticle_guide refused");
    let view: Record<string, unknown> | undefined;
    try {
      view = obj(JSON.parse(result.text));
    } catch {
      // "canticle: this ear tunes no station:stream", with nothing untuned on air.
      view = undefined;
    }
    if (view === undefined) {
      if (/not enabled/u.test(result.text)) listener = "canticle off";
      break;
    }
    if (typeof view.listener === "string") listener = view.listener;
    if (Array.isArray(view.rows)) rows.push(...view.rows);
    const u = obj(view.untuned);
    if (page === 0 && u !== undefined) {
      untuned = Array.isArray(u.rows) ? u.rows : [];
      untunedMore = count(u.more) ?? 0;
    }
    cursor = typeof view.nextCursor === "string" ? view.nextCursor : undefined;
    if (cursor === undefined) break;
  }
  return {
    kind: "daemon",
    listener,
    presence,
    rows,
    untuned,
    untunedMore,
    truncated,
  };
}

/** The export, field by field, from the config, the manifest and what the daemon said. */
export function houseExport(input: {
  ear: string;
  revision: string;
  now: number;
  canticle: CanticleConfig | undefined;
  manifest: Manifest | "unreadable" | "none";
  daemon: DaemonView;
}): object {
  const { ear, canticle, manifest, daemon } = input;
  const enabled = canticle?.enabled === true;
  const patterns =
    enabled && Object.hasOwn(canticle.tune, ear)
      ? [...(canticle.tune[ear] ?? [])]
      : [];
  const delivery =
    enabled && Object.hasOwn(canticle.delivery, ear)
      ? canticle.delivery[ear]
      : undefined;
  const pushStations = Object.entries(delivery?.stations ?? {});

  // Every name that reaches the export is checked here first. One that can't be printed is
  // withheld: counted once per distinct value, under its field and its shape, never kept.
  const withheld = new Map<string, Set<string>>();
  const withhold = (field: string, reason: Withheld, value: string) => {
    const key = `${field}\u0000${reason}`;
    let values = withheld.get(key);
    if (values === undefined) withheld.set(key, (values = new Set()));
    values.add(value.toLowerCase());
  };
  const stations = new Map<string, Building>();
  const named = (name: unknown): name is string => {
    if (typeof name !== "string") return false;
    const issue = nameIssue(name);
    if (issue !== null) withhold("deck.stations", issue, name);
    return issue === null;
  };
  const building = (name: string): Building => {
    let st = stations.get(name);
    if (st === undefined) {
      st = {
        presence: null,
        verification: null,
        manifestStreams: undefined,
        streams: new Map(),
        lost: false,
      };
      stations.set(name, st);
    }
    return st;
  };
  const addStream = (st: Building, name: string, stream: unknown) => {
    if (typeof stream !== "string") return undefined;
    const issue = nameIssue(stream);
    if (issue !== null) {
      withhold("deck.streams", issue, `${name}:${stream}`);
      st.lost = true;
      return undefined;
    }
    let s = st.streams.get(stream);
    if (s === undefined) {
      s = { live: 0, newestAgeMs: null };
      st.streams.set(stream, s);
    }
    return s;
  };

  if (manifest instanceof Manifest) {
    for (const entry of manifest) {
      if (!named(entry.name)) continue;
      const st = building(entry.name);
      st.manifestStreams = new Set(entry.streams);
      for (const stream of entry.streams) addStream(st, entry.name, stream);
    }
  }
  // A tune pattern that can't be printed is withheld from the reader's scope, which then
  // says it is incomplete, so a card never reads its absence as a definite no. It adds
  // nothing to the deck: it is counted once, under the reader.
  const mayRead: string[] = [];
  for (const pattern of patterns) {
    const issue = patternIssue(pattern);
    if (issue !== null) {
      withhold("reader.may_read", issue, pattern);
      continue;
    }
    mayRead.push(pattern);
    const at = pattern.indexOf(":");
    const name = pattern.slice(0, at);
    if (name !== "*") addStream(building(name), name, pattern.slice(at + 1));
  }
  if (daemon.kind === "daemon") {
    for (const [name, state] of daemon.presence) {
      if (!named(name)) continue;
      building(name).presence = WORD.test(state) ? state : "unknown";
    }
    for (const raw of [...daemon.rows, ...daemon.untuned]) {
      const row = obj(raw);
      if (row === undefined || !named(row.station)) continue;
      const st = building(row.station);
      if (typeof row.verification === "string" && WORD.test(row.verification)) {
        if (st.verification !== "ROOT_UNKNOWN")
          st.verification = row.verification;
      }
      const s = addStream(st, row.station, row.stream);
      if (s === undefined) continue;
      s.live += count(row.live) ?? 0;
      const age = count(row.newestAgeS);
      if (age !== null)
        s.newestAgeMs = Math.min(s.newestAgeMs ?? Infinity, age * 1_000);
    }
  }
  const live = daemon.kind === "daemon";
  const complete = live && !daemon.truncated && daemon.untunedMore === 0;
  const out: StationOut[] = [...stations.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, st]) => ({
      name,
      presence: st.presence,
      verification: st.verification,
      in_manifest: st.manifestStreams !== undefined,
      streams_known: complete && !st.lost ? "complete" : "partial",
      streams: [...st.streams.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([stream, s]) => ({
          stream,
          tuned: tunes(patterns, name, stream),
          admitted: st.manifestStreams?.has(stream) === true ? true : null,
          live: live ? s.live : null,
          newest_age_ms: live ? s.newestAgeMs : null,
        })),
    }));

  const listener = daemon.listener;
  return {
    kind: HOUSE_EXPORT_KIND,
    source: `frond-ear ${input.revision} ear ${ear}`,
    ear,
    at: new Date(input.now).toISOString(),
    now_ms: input.now,
    look: LOOK,
    reader: {
      reader: ear,
      payload_text: enabled,
      may_read: mayRead,
      may_read_complete: mayRead.length === patterns.length,
      // How many tune patterns were withheld: a reader carries it, so a stream no kept
      // pattern matches reads unknown there, never outside the scope.
      may_read_withheld: patterns.length - mayRead.length,
      basis: {
        canticle: enabled ? "enabled" : "disabled",
        hear: enabled ? "payload text of tuned streams" : "off",
        push: {
          mode: delivery?.mode ?? "off",
          style: delivery?.style ?? "records",
          muted: canticle?.muted === true,
          stations: pushStations.flatMap(([station, mode]) => {
            const issue = nameIssue(station);
            if (issue === null) return [{ station, mode }];
            withhold("push.stations", issue, station);
            return [];
          }),
        },
      },
    },
    deck: {
      view: daemon.kind,
      listener: WORD.test(listener) ? listener : "unknown",
      connected: daemon.kind === "daemon" && listener === "listening",
      window_start_ms: null,
      manifest: manifest instanceof Manifest ? "read" : manifest,
      stations: out,
      left_out: {
        untuned_more: daemon.kind === "daemon" ? daemon.untunedMore : 0,
        truncated: daemon.kind === "daemon" && daemon.truncated,
      },
    },
    withheld: [...withheld.entries()]
      .map(([key, values]) => {
        const [field, reason] = key.split("\u0000") as [string, Withheld];
        return { field, reason, count: values.size };
      })
      .sort((a, b) =>
        a.field !== b.field
          ? a.field < b.field
            ? -1
            : 1
          : a.reason < b.reason
            ? -1
            : a.reason > b.reason
              ? 1
              : 0,
      ),
  };
}

export async function runHouseExport(
  argv: string[],
  io: HouseIo,
): Promise<number> {
  let values: { ear?: string; offline?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { ear: { type: "string" }, offline: { type: "boolean" } },
    }));
  } catch (error) {
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return 1;
  }
  const ear = values.ear;
  if (!ear) {
    io.stderr.write(`--ear is required\n${USAGE}`);
    return 1;
  }
  let config;
  try {
    config = loadConfigFile(
      runtimeOptions(io.env, { dryRun: false }).configPath,
    );
  } catch (error) {
    io.stderr.write(
      `frond-ear house-export: the config could not be read: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  if (!Object.hasOwn(config.ears, ear)) {
    io.stderr.write(`frond-ear house-export: unknown ear ${ear}\n${USAGE}`);
    return 1;
  }
  // The ear's name is the reader and the source: it can't be withheld, so an
  // identity-shaped one refuses the export whole.
  const earIssue = nameIssue(ear);
  if (earIssue !== null) {
    io.stderr.write(
      `frond-ear house-export: refused: the ear's name is identity-shaped (${earIssue}), and every export names its ear; nothing was printed\n`,
    );
    return 1;
  }
  const canticle = config.canticle;
  let manifest: Manifest | "unreadable" | "none" = "none";
  if (canticle?.enabled) {
    try {
      manifest = Manifest.fromJson(
        JSON.parse(readFileSync(canticle.manifestPath, "utf8")),
      );
    } catch {
      manifest = "unreadable";
      io.stderr.write(
        "frond-ear house-export: the canticle manifest could not be read\n",
      );
    }
  }
  let daemon: DaemonView;
  if (!canticle?.enabled) daemon = { kind: "config", listener: "canticle off" };
  else if (values.offline) daemon = { kind: "config", listener: "not asked" };
  else {
    const ask =
      io.request ??
      ((message: CliRequest) =>
        daemonRequest(message, io.env, DAEMON_TIMEOUT_MS));
    try {
      daemon = await readDaemon(ear, ask);
    } catch (error) {
      io.stderr.write(
        `frond-ear house-export: daemon not reached (${error instanceof Error ? error.message : String(error)}): config and manifest only\n`,
      );
      daemon = { kind: "config", listener: "not reached" };
    }
  }
  const doc = houseExport({
    ear,
    revision: (io.revision ?? gitRevision)(),
    now: (io.now ?? Date.now)(),
    canticle,
    manifest,
    daemon,
  });
  const found = identityIn(doc);
  if (found.length > 0) {
    io.stderr.write(
      `frond-ear house-export: refused: identity-shaped output at ${found.map((f) => `${f.at} (${f.reason})`).join(", ")}; nothing was printed\n`,
    );
    return 1;
  }
  io.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  return 0;
}
