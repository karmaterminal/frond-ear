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
// - The running daemon's view decides (🌿 R6, 🌫): it reads canticle.enabled and
//   canticle.tune only at its start. payload_text and the canticle state are the daemon's;
//   may_read is the tune its source says it applies (status `appliedTune`, a read-only
//   field). A daemon that doesn't say it proves only the streams it listed as tuned, so
//   may_read is those, and offline it is empty. The file's tune is kept apart as
//   basis.may_read_configured, configured intent and never proof. Any difference between
//   file and daemon is config_daemon_mismatch; an unproven scope is runtime_scope_unverified;
//   either way may_read_complete is false.
// - Known limit (🌿 round 4): the walk is checked by a re-walk and a second status read,
//   so a change that happens and reverts between those reads (a row swapped and swapped
//   back, a word flipped and flipped back) is invisible to any client re-read. Only a
//   generation token on the guide, bumped on every change to what it lists, would close
//   that; it is a frond-ear follow-up, not built here.

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
  /** The daemon's answer; null when nothing it said can tell. */
  tuned: boolean | null;
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
  streams: Map<
    string,
    {
      live: number;
      newestAgeMs: number | null;
      rowSeen: boolean;
      /** A row gave a live count or age that wasn't one. */
      countUnknown: boolean;
    }
  >;
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
      /** Rows (station:stream keys) whose live count or age wasn't a count. */
      badCounts: Set<string>;
      /** Stations a row of which gave two verification words across its sightings. */
      unsure: Set<string>;
      /** Whether the running daemon has canticle on. */
      canticleOn: boolean;
      /** The tune its source applies to this ear, when its status says so. */
      appliedTune: string[] | undefined;
    }
  | { kind: "config"; listener: "not reached" | "not asked" };

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

/**
 * Gaps that hold the board empty, or might: nothing on it is a count, so `live` is
 * unknown. A gap line it doesn't know is taken as the worst.
 */
const BOARD_EMPTY = new Set([
  "unrecognized_gap",
  "ended",
  "not_listening",
  "host_mute",
  "awaiting_landing",
]);
/** Gaps in the walk itself: the guide wasn't read whole, or didn't add up. */
const WALK_BREAKS = new Set([
  "order_violation",
  "changed_mid_walk",
  "row_unparsed",
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
  "count_changed",
  "config_daemon_mismatch",
  "runtime_scope_unverified",
  "verification_changed",
  "presence_changed",
  "presence_disagrees",
  "ear_muted",
  "row_local_omissions",
  "row_coverage_unknown",
]);

function gapName(line: unknown): string {
  if (typeof line !== "string") return "unrecognized_gap";
  return GAP_LINES.find(([re]) => re.test(line))?.[1] ?? "unrecognized_gap";
}

/** Strictly after, in the guide's one sort: (station, stream) by code unit. */
function inOrder(a: [string, string], b: [string, string]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  return a[1] < b[1];
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
  // The running daemon's own canticle state and the tune its source applies (🌿 R6): both
  // are fixed at the daemon's start, so the config file can be newer than either.
  let canticleOn = canticle !== undefined && canticle.state !== "disabled";
  const appliedRaw = obj(canticle?.appliedTune)?.[ear];
  const appliedTune =
    Array.isArray(appliedRaw) && appliedRaw.every((p) => typeof p === "string")
      ? (appliedRaw as string[])
      : undefined;
  if (canticleOn && canticle?.source !== "host-daemon")
    gap("untuned_partial_source");
  const rows: Array<Record<string, unknown>> = [];
  const rowGaps = new Set<string>();
  const untuned: Array<Record<string, unknown>> = [];
  let untunedMore = 0;
  // Only the guide's own word says the listener is listening; with no guide view, unknown.
  let listener = "unknown";
  let truncated = false;
  let broken = false;
  const guideGaps = new Map<string, number>();
  const untunedAt = new Map<string, number>();
  const countChanged = new Set<string>();
  const badCounts = new Set<string>();
  /** Every row either pass read, for the presence check: each carries its station's word. */
  const presenceRows: Array<Record<string, unknown>> = [];
  let untunedUnlisted = false;
  // Every sighting's metadata, kept apart from the identity set (🌫 at c392ded7): the same
  // row seen on several pages or passes must say the same verification word, and that word
  // must agree with the status table. First-seen never wins.
  const verificationsOf = new Map<string, Set<string>>();
  const verificationSightings: Array<{ station: string; word: string }> = [];
  const sighted = (row: Record<string, unknown>) => {
    if (typeof row.verification !== "string") return;
    const key = rowKey(row);
    let words = verificationsOf.get(key);
    if (words === undefined) verificationsOf.set(key, (words = new Set()));
    words.add(row.verification);
    verificationSightings.push({
      station: row.station as string,
      word: row.verification,
    });
  };
  let firstSignature: string | undefined;
  let changed = false;
  let disordered = false;
  /** Each pass's station:stream names in order: the walk, then its one re-walk. */
  const passKeys: string[][] = [];
  let firstPassPages = 0;
  // Two passes over the guide: the walk, then (when it took more than one page and stood)
  // one re-walk to validate it. Every reply of either pass is a page like any other (🌫 at
  // 5c7ffc65): its gaps, listener word, untuned identities and presence words go into the
  // same accumulators, and any difference between pages is changed_mid_walk. The re-walk's
  // rows are compared, not counted: the export's rows and counts are the first pass's.
  for (let pass = 0; pass < 2; pass++) {
    if (
      pass === 1 &&
      !(firstPassPages > 1 && !broken && !truncated && !changed)
    )
      break;
    const keys: string[] = [];
    passKeys.push(keys);
    const seen = new Set<string>();
    let lastPlace: [string, string] | undefined;
    let claimed: number | undefined;
    let cursor: string | undefined;
    let unreadableRows = 0;
    let passBroken = false;
    let page = 0;
    for (; ; page++) {
      if (page === MAX_PAGES) {
        truncated = true;
        break;
      }
      const result = await ask({
        type: "call",
        tool: "canticle_guide",
        args: { ear, limit: 100, ...(cursor ? { cursor } : {}) },
      }).catch((error: unknown) => {
        if (pass === 0 && page === 0) throw error;
        return { ok: false, text: "" };
      });
      if (!result.ok) {
        if (pass === 0 && page === 0)
          throw new HouseError("canticle_guide refused");
        gap("page_refused");
        broken = passBroken = true;
        break;
      }
      let view: Record<string, unknown> | undefined;
      try {
        view = obj(JSON.parse(result.text));
      } catch {
        view = undefined;
      }
      if (view === undefined || !Array.isArray(view.rows)) {
        // Two plain answers are the guide's own, and only on the walk's first page.
        if (
          pass === 0 &&
          page === 0 &&
          /^canticle is not enabled/u.test(result.text)
        ) {
          listener = "canticle off";
          canticleOn = false;
        } else if (
          !(
            pass === 0 &&
            page === 0 &&
            /^canticle: this ear tunes no station:stream/u.test(result.text)
          )
        ) {
          gap("page_unparsed");
          broken = passBroken = true;
        }
        break;
      }
      // Every page's coverage signals count, not just the first's (🌫 at f22fae03): a gap
      // line on any page is kept, by name, at the most any one page said it.
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
          if (pass === 0 && page === 0) gap("unrecognized_word");
        }
      }
      // The worst word any page gave stands: a later "listening" never hides an earlier
      // "blind".
      if (pageListener !== "none" && pageListener !== "unrecognized") {
        if (listener === "unknown" || listener === "listening")
          listener = pageListener;
      }
      const u = obj(view.untuned);
      // By identity, not by count (🌫 at 7fe187da): which gap names, which listener word,
      // and which untuned station:stream names this page lists, beside its totals.
      const untunedNames =
        u === undefined
          ? null
          : (Array.isArray(u.rows) ? u.rows : [])
              .map((raw) => {
                const row = obj(raw);
                return row === undefined ? "?" : rowKey(row);
              })
              .sort();
      const signature = JSON.stringify([
        [...pageGaps.entries()].sort(),
        pageListener,
        u === undefined
          ? null
          : [count(u.streams), count(u.more), untunedNames],
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
        // A re-walk with a different total fails its own count check, and its rows
        // differ from the walk's: both are caught there.
      } else if (streams !== claimed) gap("row_count_mismatch");
      // The untuned list comes on every page (🌿 round 2): each page's rows are kept, once
      // each, and the most any page said was past its list stands.
      if (u === undefined) {
        if (!untunedUnlisted) gap("untuned_unlisted");
        untunedUnlisted = true;
      } else {
        const listed = Array.isArray(u.rows) ? u.rows : [];
        const more = count(u.more);
        const kept = new Set<string>();
        for (const raw of listed) {
          const row = obj(raw);
          if (row === undefined || kept.has(rowKey(row))) {
            gap("untuned_count_mismatch");
            continue;
          }
          kept.add(rowKey(row));
          // The same row checks as a tuned row's (🌿 round 4): a name that isn't one, or a
          // live count or age that isn't a count, is row_unparsed, and the count unknown.
          if (
            typeof row.station !== "string" ||
            typeof row.stream !== "string"
          ) {
            gap("row_unparsed");
            continue;
          }
          const ageOk =
            row.newestAgeS === null || count(row.newestAgeS) !== null;
          if (count(row.live) === null || !ageOk) {
            gap("row_unparsed");
            badCounts.add(rowKey(row));
            rowGaps.add(row.station);
          }
          sighted(row);
          const key = rowKey(row);
          const at = untunedAt.get(key);
          if (at === undefined) {
            untunedAt.set(key, untuned.length);
            untuned.push(row);
          } else {
            // The same untuned row on a later page (🌿 R6-3): a live count that differs, or a
            // newest age that drops (a newer record), is count_changed and the count unknown.
            // An age that only grows is time passing: the latest sighting's stands.
            const prior = untuned[at]!;
            const priorAge = count(prior.newestAgeS);
            const age = count(row.newestAgeS);
            const differs =
              count(prior.live) !== count(row.live) ||
              (priorAge !== null && age !== null && age < priorAge);
            if (differs && !countChanged.has(key)) {
              countChanged.add(key);
              gap("count_changed");
              badCounts.add(key);
              rowGaps.add(row.station);
            }
            if (!differs) untuned[at] = row;
          }
        }
        if (more === null && u.more !== undefined)
          gap("untuned_count_mismatch");
        untunedMore = Math.max(untunedMore, more ?? 0);
        if (count(u.streams) !== listed.length + (more ?? 0))
          gap("untuned_count_mismatch");
      }
      for (const raw of view.rows) {
        const row = obj(raw);
        if (row === undefined) {
          gap("page_unparsed");
          continue;
        }
        // A row it can't read is counted and breaks the walk, never left out quietly.
        const unreadable =
          typeof row.station !== "string" ||
          typeof row.stream !== "string" ||
          (row.localOmissions !== undefined &&
            obj(row.localOmissions) === undefined) ||
          (row.coverageUnknown !== undefined &&
            obj(row.coverageUnknown) === undefined);
        if (unreadable) {
          gap("row_unparsed");
          unreadableRows += 1; // a row the guide gave: it counts toward its total
          continue;
        }
        sighted(row);
        if (seen.has(rowKey(row))) {
          gap("duplicate_row");
          continue;
        }
        // The guide's order is a contract (🌿 round 3): rows come in (station, stream)
        // code-unit order across every page. A row that doesn't is an inconsistent walk.
        const place: [string, string] = [
          row.station as string,
          row.stream as string,
        ];
        if (lastPlace !== undefined && !inOrder(lastPlace, place)) {
          if (!disordered) gap("order_violation");
          disordered = true;
        }
        lastPlace = place;
        seen.add(rowKey(row));
        keys.push(rowKey(row));
        presenceRows.push(row);
        // A live count or age that isn't one is unknown, never a vouched 0 (🌿 round 3).
        const liveOk = count(row.live) !== null;
        const ageOk = row.newestAgeS === null || count(row.newestAgeS) !== null;
        if (!liveOk || !ageOk) {
          gap("row_unparsed");
          badCounts.add(rowKey(row));
          rowGaps.add(row.station as string);
        }
        if (obj(row.localOmissions) !== undefined) {
          gap("row_local_omissions");
          rowGaps.add(row.station as string);
        }
        if (obj(row.coverageUnknown) !== undefined) {
          gap("row_coverage_unknown");
          rowGaps.add(row.station as string);
        }
        if (pass === 0) rows.push(row);
      }
      cursor =
        typeof view.nextCursor === "string" ? view.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    if (pass === 0) firstPassPages = page + 1;
    if (
      !passBroken &&
      !truncated &&
      claimed !== undefined &&
      keys.length + unreadableRows !== claimed
    ) {
      gap("row_count_mismatch");
    }
  }
  // The re-walk, when it stood, must name the same rows in the same order: a tuned row
  // swapped behind the cursor on any page keeps every count (🌿 round 3).
  if (
    passKeys.length === 2 &&
    !broken &&
    !changed &&
    JSON.stringify(passKeys[1]) !== JSON.stringify(passKeys[0])
  ) {
    changed = true;
    gap("changed_mid_walk");
  }
  for (const [name, n] of guideGaps) gap(name, n);
  // The presence table is read again too, and compared by station names; a changed word
  // is a reading in time, not a change in what the walk covers.
  const flipped = new Set<string>();
  // With canticle off there is no presence table to compare.
  if (canticleOn && !broken && !truncated && !changed) {
    const after = await ask({ type: "status" }).catch(() => undefined);
    let names: string[] | undefined;
    try {
      const stations = obj(
        obj(obj(after?.ok ? JSON.parse(after.text) : undefined)?.canticle)
          ?.stations,
      );
      names = stations === undefined ? undefined : Object.keys(stations).sort();
      // A word that flips between the two reads (🌿 round 4) is no answer: that station
      // reads unknown, named presence_changed, never the first word alone.
      for (const [name, word] of Object.entries(stations ?? {})) {
        const before = presence.get(name);
        if (before !== undefined && word !== before) flipped.add(name);
      }
    } catch {
      names = undefined;
    }
    if (
      names === undefined ||
      JSON.stringify(names) !== JSON.stringify([...presence.keys()].sort())
    ) {
      gap("changed_mid_walk");
    }
  }
  // A station whose guide presence word disagrees with the status table is unknown, and
  // its streams partial (🌿 round 3): "visible: yes" beside a later UNOBSERVABLE is no answer.
  const disagree = new Set<string>();
  for (const row of presenceRows) {
    const word = row.presence;
    const station = row.station as string;
    if (typeof word !== "string" || !presence.has(station)) continue;
    if (word !== presence.get(station)) disagree.add(station);
  }
  // The guide says ROOT_UNKNOWN exactly when it holds the station ROOT_UNKNOWN, and verified
  // otherwise: a sighting's word that doesn't fit the status table's is a disagreement too.
  for (const { station, word } of verificationSightings) {
    const state = presence.get(station);
    if (state === undefined || state === "unknown") continue;
    if (word !== (state === "ROOT_UNKNOWN" ? "ROOT_UNKNOWN" : "verified")) {
      disagree.add(station);
    }
  }
  // The same row with two words across its sightings: its station's verification and
  // presence are unknown, and its streams partial.
  const unsure = new Set<string>();
  for (const [key, words] of verificationsOf) {
    if (words.size > 1) unsure.add((JSON.parse(key) as [string, string])[0]);
  }
  for (const station of unsure) {
    presence.set(station, "unknown");
    rowGaps.add(station);
  }
  if (unsure.size > 0) gap("verification_changed", unsure.size);
  for (const station of flipped) {
    presence.set(station, "unknown");
    rowGaps.add(station);
  }
  if (flipped.size > 0) gap("presence_changed", flipped.size);
  for (const station of disagree) {
    presence.set(station, "unknown");
    rowGaps.add(station);
  }
  if (disagree.size > 0) gap("presence_disagrees", disagree.size);
  return {
    kind: "daemon",
    listener,
    badCounts,
    unsure,
    canticleOn,
    appliedTune,
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
  // The running daemon's view decides (🌿 R6): it reads canticle.enabled and canticle.tune
  // only at its start, so the file can be newer. The file is a cross-check.
  const configEnabled = canticle?.enabled === true;
  const configPatterns =
    configEnabled && Object.hasOwn(canticle.tune, ear)
      ? [...(canticle.tune[ear] ?? [])]
      : [];
  const live0 = daemon.kind === "daemon";
  const enabled = live0 ? daemon.canticleOn : configEnabled;
  // The scope: the daemon's applied tune when it says it; else only what its tuned rows
  // prove (a row it listed as tuned); offline, nothing (the file's tune is unverified).
  const applied = live0 && daemon.canticleOn ? daemon.appliedTune : undefined;
  const scopeBasis = !live0
    ? "none: the config's tune is unverified against a running daemon"
    : !daemon.canticleOn
      ? "none: canticle is off in the running daemon"
      : applied !== undefined
        ? "the running daemon's applied tune"
        : "the running daemon's tuned rows only (it doesn't say its tune)";
  const provenRows =
    live0 && daemon.canticleOn && applied === undefined
      ? [
          ...new Set(
            daemon.rows.map(
              (row) => `${String(row.station)}:${String(row.stream)}`,
            ),
          ),
        ].sort()
      : [];
  const patterns = applied ?? provenRows;
  let mismatch = 0;
  if (live0 && daemon.canticleOn !== configEnabled) mismatch += 1;
  if (applied !== undefined) {
    const a = new Set(applied);
    const c = new Set(configPatterns);
    for (const p of a) if (!c.has(p)) mismatch += 1;
    for (const p of c) if (!a.has(p)) mismatch += 1;
  } else if (live0 && daemon.canticleOn) {
    // Without the daemon's tune, its rows still contradict the file where they can.
    for (const row of daemon.rows) {
      if (!tunes(configPatterns, String(row.station), String(row.stream)))
        mismatch += 1;
    }
    for (const row of daemon.untuned) {
      if (tunes(configPatterns, String(row.station), String(row.stream)))
        mismatch += 1;
    }
  }
  const delivery =
    enabled && canticle !== undefined && Object.hasOwn(canticle.delivery, ear)
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
      s = { live: 0, newestAgeMs: null, rowSeen: false, countUnknown: false };
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
  const configured: string[] = [];
  for (const pattern of configPatterns) {
    const issue = patternIssue(pattern);
    if (issue !== null) {
      if (applied === undefined) withhold("reader.may_read", issue, pattern);
      continue;
    }
    configured.push(pattern);
    const at = pattern.indexOf(":");
    const name = pattern.slice(0, at);
    if (name !== "*" && nameIssue(name) === null)
      addStream(building(name), name, pattern.slice(at + 1));
  }
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
  if (mismatch > 0) gaps.set("config_daemon_mismatch", mismatch);
  if (applied === undefined && (!live0 || daemon.canticleOn))
    gaps.set("runtime_scope_unverified", 1);
  // Canticle off in the daemon: nothing is heard, so no stream is vouched for (each reads
  // unknown, as a coverage gap makes it), and the board is no count of anything.
  if (live0 && !daemon.canticleOn) gaps.set("canticle_off", 1);
  // Which list each row came back in is the daemon's own tune at work.
  const rowTuned = new Map<string, boolean>();
  if (daemon.kind === "daemon") {
    for (const row of daemon.rows) rowTuned.set(rowKey(row), true);
    for (const row of daemon.untuned) rowTuned.set(rowKey(row), false);
  }
  if (daemon.kind === "daemon") {
    // readDaemon already held every presence word to the closed list.
    for (const [name, state] of daemon.presence) {
      if (!named(name)) continue;
      building(name).presence = state;
    }
    for (const row of [...daemon.rows, ...daemon.untuned]) {
      if (!named(row.station)) continue;
      const st = building(row.station);
      if (typeof row.verification === "string") {
        if (!VERIFICATION_WORDS.has(row.verification)) {
          gaps.set(
            "unrecognized_word",
            (gaps.get("unrecognized_word") ?? 0) + 1,
          );
        } else if (daemon.unsure.has(row.station)) {
          st.verification = null; // two words across its sightings: unknown
        } else if (st.verification !== "ROOT_UNKNOWN") {
          st.verification = row.verification;
        }
      }
      const s = addStream(st, row.station, row.stream);
      if (s === undefined) continue;
      s.live += count(row.live) ?? 0;
      s.rowSeen = true;
      if (daemon.badCounts.has(rowKey(row))) s.countUnknown = true;
      const age = count(row.newestAgeS);
      if (age !== null)
        s.newestAgeMs = Math.min(s.newestAgeMs ?? Infinity, age * 1_000);
    }
  }
  const live = daemon.kind === "daemon";
  // A station-level hole (a row's, a presence word that disagreed or flipped) makes that
  // station partial whether or not any row of it was read.
  if (daemon.kind === "daemon") {
    for (const name of daemon.rowGaps) {
      const st = stations.get(name);
      if (st !== undefined) st.lost = true;
    }
  }
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
          // The daemon's own answer: the list the row came back in; else its applied tune;
          // else unknown (🌿 R6), never the file's tune.
          tuned:
            rowTuned.get(JSON.stringify([name, stream])) ??
            (applied !== undefined ? tunes(applied, name, stream) : null),
          admitted: st.manifestStreams?.has(stream) === true ? true : null,
          // A stream no row reached is 0 only when the deck vouches for the whole board;
          // otherwise it is unknown (🌿 round 2), and a row it read keeps its count.
          live:
            live && !boardEmpty && !s.countUnknown && (s.rowSeen || complete)
              ? s.live
              : null,
          newest_age_ms:
            live && !boardEmpty && !s.countUnknown && (s.rowSeen || complete)
              ? s.newestAgeMs
              : null,
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
      may_read_complete:
        mayRead.length === patterns.length &&
        applied !== undefined &&
        mismatch === 0,
      // How many tune patterns were withheld: a reader carries it, so a stream no kept
      // pattern matches reads unknown there, never outside the scope.
      may_read_withheld: patterns.length - mayRead.length,
      basis: {
        canticle: enabled ? "enabled" : "disabled",
        scope: scopeBasis,
        config_patterns: configPatterns.length,
        // The file's tune: configured intent, never proof of what the daemon reads (🌫).
        may_read_configured: configured,
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
        // How many untuned streams it did list, so a reader can say "50 shown, 10 left
        // out" apart from the walk (🌫, 07:17Z).
        untuned_listed: daemon.kind === "daemon" ? daemon.untuned.length : 0,
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
  // The manifest names the fleet's stations whatever the file says of canticle.enabled:
  // the running daemon may have canticle on.
  if (
    typeof canticle?.manifestPath === "string" &&
    canticle.manifestPath !== ""
  ) {
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
  // The daemon is asked whatever the file says: its own canticle state decides (🌿 R6).
  if (values.offline) daemon = { kind: "config", listener: "not asked" };
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
