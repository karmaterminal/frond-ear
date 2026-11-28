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

import {
  DaemonTimeoutError,
  request as daemonRequest,
  type CliRequest,
} from "../client.ts";
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
  "names and state words only: no payload text, item content, and no id-, key-, path- or token-shaped string";

/** A station or stream name the export will print: identifier-safe, and no identity shape. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** Why a name was withheld: the shape it had, never its value. */
export type Withheld =
  | "discord-id shape"
  | "key-id shape"
  | "path shape"
  | "token shape"
  | "not an identifier";

/**
 * The identity shapes no export string may carry, anywhere in it: a 17-20 digit run (a
 * Discord id), 16 hex digits in a row (a station key id, or part of a public key), and a
 * path separator or home prefix. A name that fits a parser's grammar can still hold one: a
 * tune's `f6eecf2f43082a97:ops.fleet`, a manifest station named by a Discord id (🌫, #147).
 */
export function identityShape(text: string): Withheld | null {
  // An id split by `-`, `.` or `_` is the same id (🌿 F2): judge it with those removed,
  // which finds every run the text itself has, too.
  const joined = text.replace(/[-._]/gu, "");
  if (/[0-9]{17,}/u.test(joined)) return "discord-id shape";
  if (/[0-9a-f]{16}/iu.test(joined)) return "key-id shape";
  if (tokenShaped(text)) return "token shape";
  if (/[\\/]|^~/u.test(text)) return "path shape";
  return null;
}

/**
 * Credential-shaped text (🌿 F2): the usual token prefixes, an AWS key id, a three-part
 * bot token or JWT, or a long run that mixes upper case, lower case and digits, as base64
 * keys do. The frond's names are short lowercase words, so none of them is near this.
 */
function tokenShaped(text: string): boolean {
  if (/(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/u.test(text)) return true;
  if (/(?:^|[^A-Za-z0-9])(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/u.test(text))
    return true;
  if (/xox[abposr]-/u.test(text) || /AKIA[0-9A-Z]{16}/u.test(text)) return true;
  if (/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/u.test(text))
    return true;
  for (const run of text.match(/[A-Za-z0-9_+-]{20,}/gu) ?? []) {
    if (/[A-Z]/u.test(run) && /[a-z]/u.test(run) && /[0-9]/u.test(run))
      return true;
  }
  return /[A-Za-z0-9]{32,}/u.test(text) && /[0-9]/u.test(text);
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
      rows: Array<Record<string, unknown>>;
      untuned: Array<Record<string, unknown>>;
      untunedMore: number;
      truncated: boolean;
      /** Closed gap names and how often each was seen (never the guide's prose). */
      gaps: Map<string, number>;
      /** Stations a row-level omission or coverage hole names. */
      rowGaps: Set<string>;
    }
  | { kind: "config"; listener: "not reached" | "not asked" | "canticle off" };

/** An error whose message is frond-ear's own words, safe to print. */
class HouseError extends Error {}

/** The closed presence, verification and listener words (🌿 F4): anything else is unknown. */
const PRESENCE_WORDS = new Set([
  "EQUIPPED_SPEAKING",
  "EQUIPPED_QUIET",
  "UNEQUIPPED_PRESENT",
  "ROOT_UNKNOWN",
  "UNOBSERVABLE",
  "UNOBSERVABLE:signed_off",
  "unknown",
]);
const VERIFICATION_WORDS = new Set(["verified", "ROOT_UNKNOWN"]);
const LISTENER_WORDS = new Set([
  "listening",
  "not listening",
  "ended",
  "blind",
]);

/**
 * The guide's gap lines (guide.ts `gapLines`) by their closed names: the prose never
 * leaves here. A line it doesn't know is `unrecognized_gap`, a gap all the same.
 */
const GAP_LINES: ReadonlyArray<[RegExp, string]> = [
  [/^the host daemon's receptor ended its run cleanly/u, "ended"],
  [/^the listener is not bound/u, "not_listening"],
  [/^no datagram heard lately/u, "blind"],
  [/^joined the host daemon's run late/u, "joined_late"],
  [/^the host daemon's receptor is muted/u, "host_mute"],
  [/^records were lost on the host daemon's socket/u, "records_lost"],
  [
    /^this connection to the host daemon has had no landing_state yet/u,
    "awaiting_landing",
  ],
  [/^this ear is muted/u, "ear_muted"],
  [
    /^local omission \(live_overflow\): other tuned streams/u,
    "omitted_other_tuned",
  ],
  [/^local omission \(live_overflow\): untuned streams/u, "omitted_untuned"],
  [/^coverage unknown:/u, "coverage_unknown"],
];

/** Gaps that hold the board empty: nothing on it is a count, so `live` is unknown. */
const BOARD_EMPTY = new Set([
  "ended",
  "not_listening",
  "host_mute",
  "awaiting_landing",
]);
/** Gaps in the walk itself: the guide wasn't read whole, or didn't add up. */
const WALK_BREAKS = new Set([
  "changed_mid_walk",
  "page_unparsed",
  "page_refused",
  "row_count_mismatch",
  "duplicate_row",
  "untuned_count_mismatch",
]);
/**
 * Gaps that don't make every station partial: a mute on this ear changes pushes, not the
 * board; a row's own omissions or coverage hole make only that row's station partial.
 */
const NOT_COVERAGE = new Set([
  "ear_muted",
  "row_local_omissions",
  "row_coverage_unknown",
]);

function gapName(line: unknown): string {
  if (typeof line !== "string") return "unrecognized_gap";
  return GAP_LINES.find(([re]) => re.test(line))?.[1] ?? "unrecognized_gap";
}

const rowKey = (row: Record<string, unknown>) =>
  JSON.stringify([row.station, row.stream]);

/**
 * `status`'s canticle presence table and every page of `canticle_guide`, as a CLI client.
 * The walk ends cleanly only on a page with no `nextCursor`: a page refused or unparsed
 * after the first, rows that don't add up to the guide's own `streams`, or a row repeated
 * across pages is a gap, and the deck says partial.
 */
async function readDaemon(
  ear: string,
  ask: NonNullable<HouseIo["request"]>,
): Promise<DaemonView> {
  const status = await ask({ type: "status" });
  if (!status.ok) throw new HouseError("status refused");
  let statusDoc: unknown;
  try {
    statusDoc = JSON.parse(status.text);
  } catch {
    throw new HouseError("status unparsed");
  }
  const canticle = obj(obj(statusDoc)?.canticle);
  const gaps = new Map<string, number>();
  const gap = (name: string, n = 1) =>
    gaps.set(name, (gaps.get(name) ?? 0) + n);
  const presence = new Map<string, string>();
  for (const [name, state] of Object.entries(obj(canticle?.stations) ?? {})) {
    if (typeof state !== "string") continue;
    if (PRESENCE_WORDS.has(state)) presence.set(name, state);
    else {
      presence.set(name, "unknown");
      gap("unrecognized_word");
    }
  }
  // The embedded listener's untuned list covers only streams some ear tunes.
  if (canticle?.source !== "host-daemon") gap("untuned_partial_source");
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const rowGaps = new Set<string>();
  let untuned: Array<Record<string, unknown>> = [];
  let untunedMore = 0;
  // Only the guide's own word says the listener is listening; with no guide view, unknown.
  let listener = "unknown";
  let claimed: number | undefined;
  let cursor: string | undefined;
  let truncated = false;
  let broken = false;
  const guideGaps = new Map<string, number>();
  let firstSignature: string | undefined;
  let changed = false;
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
    if (!result.ok) {
      if (page === 0) throw new HouseError("canticle_guide refused");
      gap("page_refused");
      broken = true;
      break;
    }
    let view: Record<string, unknown> | undefined;
    try {
      view = obj(JSON.parse(result.text));
    } catch {
      view = undefined;
    }
    if (view === undefined || !Array.isArray(view.rows)) {
      // Two plain answers are the guide's own, and only on a first page.
      if (page === 0 && /^canticle is not enabled/u.test(result.text)) {
        listener = "canticle off";
      } else if (
        !(
          page === 0 &&
          /^canticle: this ear tunes no station:stream/u.test(result.text)
        )
      ) {
        gap("page_unparsed");
        broken = true;
      }
      break;
    }
    // Every page's coverage signals count, not just the first's (🌫 at f22fae03): a gap
    // line on any page is kept, by name, at the most any one page said it. Pages that
    // disagree (gap names, listener word, untuned list) saw the state change under the
    // walk, which is a break of its own.
    const pageGaps = new Map<string, number>();
    if (view.gaps !== undefined) {
      if (Array.isArray(view.gaps)) {
        for (const line of view.gaps) {
          const name = gapName(line);
          pageGaps.set(name, (pageGaps.get(name) ?? 0) + 1);
        }
      } else pageGaps.set("unrecognized_gap", 1);
    }
    for (const [name, n] of pageGaps) {
      guideGaps.set(name, Math.max(guideGaps.get(name) ?? 0, n));
    }
    let pageListener = "none";
    if (typeof view.listener === "string") {
      if (LISTENER_WORDS.has(view.listener)) pageListener = view.listener;
      else {
        pageListener = "unrecognized";
        if (page === 0) gap("unrecognized_word");
      }
    }
    // The worst word any page gave stands: a later "listening" never hides an earlier
    // "blind". Two different words are a changed walk, below, and the deck stays partial.
    if (pageListener !== "none" && pageListener !== "unrecognized") {
      if (listener === "unknown" || listener === "listening")
        listener = pageListener;
    }
    const u = obj(view.untuned);
    const signature = JSON.stringify([
      [...pageGaps.entries()].sort(),
      pageListener,
      u === undefined ? null : [count(u.streams), count(u.more)],
    ]);
    if (firstSignature === undefined) firstSignature = signature;
    else if (signature !== firstSignature && !changed) {
      changed = true;
      gap("changed_mid_walk");
    }
    const streams = count(view.streams);
    if (page === 0) {
      claimed = streams ?? undefined;
      if (streams === null) gap("row_count_mismatch");
      if (u === undefined) gap("untuned_unlisted");
      else {
        const listed = Array.isArray(u.rows) ? u.rows : [];
        const more = count(u.more) ?? 0;
        const kept = new Set<string>();
        for (const raw of listed) {
          const row = obj(raw);
          if (row === undefined || kept.has(rowKey(row))) {
            gap("untuned_count_mismatch");
            continue;
          }
          kept.add(rowKey(row));
          untuned.push(row);
        }
        untunedMore = more;
        if (count(u.streams) !== listed.length + more)
          gap("untuned_count_mismatch");
      }
    } else if (streams !== claimed) gap("row_count_mismatch");
    for (const raw of view.rows) {
      const row = obj(raw);
      if (row === undefined) {
        gap("page_unparsed");
        continue;
      }
      if (seen.has(rowKey(row))) {
        gap("duplicate_row");
        continue;
      }
      seen.add(rowKey(row));
      rows.push(row);
      if (obj(row.localOmissions) !== undefined) {
        gap("row_local_omissions");
        if (typeof row.station === "string") rowGaps.add(row.station);
      }
      if (obj(row.coverageUnknown) !== undefined) {
        gap("row_coverage_unknown");
        if (typeof row.station === "string") rowGaps.add(row.station);
      }
    }
    cursor = typeof view.nextCursor === "string" ? view.nextCursor : undefined;
    if (cursor === undefined) break;
  }
  if (
    !broken &&
    !truncated &&
    claimed !== undefined &&
    rows.length !== claimed
  ) {
    gap("row_count_mismatch");
  }
  for (const [name, n] of guideGaps) gap(name, n);
  return {
    kind: "daemon",
    listener,
    presence,
    rows,
    untuned,
    untunedMore,
    truncated,
    gaps,
    rowGaps,
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
  const gaps = new Map(daemon.kind === "daemon" ? daemon.gaps : []);
  if (daemon.kind === "daemon") {
    // readDaemon already held every presence word to the closed list.
    for (const [name, state] of daemon.presence) {
      if (!named(name)) continue;
      building(name).presence = state;
    }
    for (const row of [...daemon.rows, ...daemon.untuned]) {
      if (!named(row.station)) continue;
      const st = building(row.station);
      if (daemon.rowGaps.has(row.station)) st.lost = true;
      if (typeof row.verification === "string") {
        if (!VERIFICATION_WORDS.has(row.verification)) {
          gaps.set(
            "unrecognized_word",
            (gaps.get("unrecognized_word") ?? 0) + 1,
          );
        } else if (st.verification !== "ROOT_UNKNOWN") {
          st.verification = row.verification;
        }
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
  // Complete only when the walk read every page whole and the guide named no coverage gap:
  // a gap the guide says is unknown stays unknown here (🌿 F1).
  const coverageGap = [...gaps.keys()].some((name) => !NOT_COVERAGE.has(name));
  const boardEmpty = [...gaps.keys()].some((name) => BOARD_EMPTY.has(name));
  const complete =
    live && !daemon.truncated && daemon.untunedMore === 0 && !coverageGap;
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
          live: live && !boardEmpty ? s.live : null,
          newest_age_ms: live && !boardEmpty ? s.newestAgeMs : null,
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
      listener,
      connected: daemon.kind === "daemon" && listener === "listening",
      window_start_ms: null,
      manifest: manifest instanceof Manifest ? "read" : manifest,
      stations: out,
      walk:
        daemon.kind === "daemon" &&
        !daemon.truncated &&
        ![...gaps.keys()].some((name) => WALK_BREAKS.has(name))
          ? "complete"
          : "partial",
      gaps: [...gaps.entries()]
        .map(([name, n]) => ({ name, count: n }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
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

/**
 * What an error line may say (🌿 F3): frond-ear's own words, a system error code, or that
 * it timed out. Never a message from elsewhere, which can carry a socket path, part of a
 * daemon reply, or a config value.
 */
function errorWord(error: unknown): string {
  if (error instanceof HouseError) return error.message;
  if (error instanceof DaemonTimeoutError) return "timed out";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/u.test(code))
    return code;
  if (error instanceof SyntaxError) return "not JSON";
  return "error";
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
      `frond-ear house-export: the config could not be read or parsed (${errorWord(error)}); FROND_EAR_CONFIG names it\n`,
    );
    return 1;
  }
  if (!Object.hasOwn(config.ears, ear)) {
    io.stderr.write(
      `frond-ear house-export: unknown ear ${nameIssue(ear) === null ? ear : "(an identity-shaped name, not repeated)"}\n${USAGE}`,
    );
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
        `frond-ear house-export: daemon not reached (${errorWord(error)}): config and manifest only\n`,
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
