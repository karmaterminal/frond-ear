// Renders the `sitrep` tool (frond-ear#85): "what did I miss" on the streams a session
// names, such as distress and alerts. It reads the live set `hear` reads and renders each
// item with the same banner and wrapper, so heard text stays data. What it adds is the
// fold: one entry per (station, state_key) across the chosen streams, the newest standing
// in RFC-0001 §7.8's order (issued_at, epoch, seq). It never folds across stations
// (§6.5), and tells them apart by key id, which a manifest rename keeps. An unkeyed item
// is its own entry. The fold is display only: `hear` still reads every item.
//
// Where the live set comes from (§7.10): a relay's fill-only join would be a one-off view
// of it, but no frond-ear source talks to a relay. With `host-daemon` the ear holds the
// daemon's join snapshot (§14.18.3, D36) and every record since, the set a new snapshot
// would give; `embedded` holds what frond-ear's own listener heard while it ran.
// Absence is never a value (§6.3 item 5): an incident that isn't here may have expired,
// been plucked or gone unheard, so the sitrep never reads it as resolved, and a chosen
// stream the ear doesn't tune is named as unheard, not quiet.

import {
  digits,
  HOST_MUTE,
  joinedLate,
  onAir,
  renderItem,
  secs,
  token,
} from "./hear.ts";
import type { HearView, LiveItem } from "./receptor.ts";

export interface SitrepOptions {
  /** `station:stream` patterns (`*` for any station), in the order the session gave them. */
  streams: readonly string[];
  /** The ear's `canticle.tune`, to name a chosen stream it can't hear; undefined skips it. */
  tune: readonly string[] | undefined;
  /** `canticle.source`: where the live set comes from. */
  source: "embedded" | "host-daemon" | undefined;
  limit: number;
  maxChars: number;
}

interface Entry {
  standing: LiveItem;
  /** Older live items of the same station and state_key, newest first. */
  folded: LiveItem[];
  /** The first chosen stream the standing item answers to: the session's order. */
  rank: number;
}

/** A pattern as one token, its `*` kept. */
const shown = (pattern: string) =>
  pattern.startsWith("*:") ? `*:${token(pattern.slice(2))}` : token(pattern);

const parts = (pattern: string) => {
  const at = pattern.indexOf(":");
  return { station: pattern.slice(0, at), stream: pattern.slice(at + 1) };
};

const answers = (pattern: string, item: LiveItem) => {
  const { station, stream } = parts(pattern);
  return (
    (station === "*" || station === item.station) && stream === item.stream
  );
};

const seqOf = (seq: string) => (/^\d{1,20}$/u.test(seq) ? BigInt(seq) : -1n);

/** §7.8: the greater (issued_at, epoch, seq) is newer; then the stream, so the order is total. */
function newer(a: LiveItem, b: LiveItem): boolean {
  if (a.issuedAt !== b.issuedAt) return a.issuedAt > b.issuedAt;
  if (a.epoch !== b.epoch) return a.epoch > b.epoch;
  const sa = seqOf(a.seq);
  const sb = seqOf(b.seq);
  if (sa !== sb) return sa > sb;
  return a.stream < b.stream;
}

/** One entry per station and state_key; each unkeyed item stands alone. */
function fold(items: readonly LiveItem[], streams: readonly string[]): Entry[] {
  const groups = new Map<string, LiveItem[]>();
  for (const item of items) {
    const id =
      item.stateKey !== undefined
        ? `${item.key.toLowerCase()}\n${item.stateKey}`
        : `${item.key.toLowerCase()}\n\n${item.stream}\n${item.epoch}\n${item.seq}`;
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  return [...groups.values()]
    .map((group) => {
      const sorted = [...group].sort((a, b) => (newer(a, b) ? -1 : 1));
      const standing = sorted[0]!;
      return {
        standing,
        folded: sorted.slice(1),
        rank: streams.findIndex((pattern) => answers(pattern, standing)),
      };
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.standing.heardAt - a.standing.heardAt ||
        (newer(a.standing, b.standing) ? -1 : 1),
    );
}

/** A chosen stream the ear's tune can't hear, in whole or for some stations. */
function untuned(pattern: string, tune: readonly string[]): string | undefined {
  const { station, stream } = parts(pattern);
  const same = tune.filter((t) => parts(t).stream === stream);
  if (
    same.some((t) => parts(t).station === "*" || parts(t).station === station)
  ) {
    return undefined;
  }
  if (station !== "*" || same.length === 0) {
    return `not tuned: ${shown(pattern)} isn't in this ear's canticle.tune, so nothing on it can be heard here; that says nothing about it.`;
  }
  return `partly tuned: for ${shown(pattern)} this ear tunes only ${same.map(shown).join(", ")}; other stations' ${token(stream)} can't be heard here.`;
}

const BASIS: Readonly<Record<string, string>> = {
  "host-daemon":
    "basis: the host daemon's join snapshot and every record since (RFC-0001 §14.18.3); no relay serves this ear a fill (§7.10).",
  embedded:
    "basis: what frond-ear's own listener has heard while it ran (passive catch-up, RFC-0001 §7.10); an item that hasn't looped since it started isn't here yet.",
};

const ABSENT =
  "absent is not resolved: an incident that expired, was plucked or went unheard isn't here, and only a finding's own status=resolved says it resolved (the station's claim).";

/**
 * The whole result stays within `maxChars`, as `hear`'s does: entries are whole or
 * absent, an oversize text payload is cut inside its wrapper, and an entry whose banner
 * and wrapper alone don't fit is left out and counted.
 */
export function renderSitrep(view: HearView, options: SitrepOptions): string {
  const max = options.maxChars;
  const bounded = (text: string) =>
    text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
  const named = options.streams.map(shown).join(", ");
  if (!view.tuned) {
    return bounded(
      "canticle: this ear tunes no station:stream (config canticle.tune).",
    );
  }
  const items = view.items.filter((item) =>
    options.streams.some((pattern) => answers(pattern, item)),
  );
  const entries = fold(items, options.streams);
  const head: string[] = [
    `canticle sitrep for ${named}: ${entries.length} standing (one per station and state_key, the newest standing) from ${items.length} live item${items.length === 1 ? "" : "s"}.`,
  ];
  if (options.source !== undefined && BASIS[options.source]) {
    head.push(BASIS[options.source]!);
  }
  if (view.ended) {
    head.push(
      "canticle: the host daemon's receptor ended its run cleanly (bye); nothing is live until it starts again.",
    );
  } else if (!view.listening) {
    head.push(
      "canticle: the listener is not bound right now (see ear_status); nothing can be heard.",
    );
  } else if (view.blind) {
    head.push(
      view.lastDatagramAt === undefined
        ? "canticle: nothing heard yet since the listener started. Every station is unknown, not offline."
        : `canticle: no datagram from anyone for ${secs(view.now - view.lastDatagramAt)}. That looks like our socket or network, so every station is unknown, not offline.`,
    );
  }
  if (view.hostMute && !view.ended) head.push(HOST_MUTE);
  if (view.joinedLate && !view.ended) head.push(joinedLate(view.joinedLate));
  for (const pattern of options.tune === undefined ? [] : options.streams) {
    const note = untuned(pattern, options.tune!);
    if (note !== undefined) head.push(note);
  }
  if (view.stations.length > 0) {
    head.push(onAir(view.stations, Math.floor(max / 4)));
  }
  if (entries.length === 0) {
    return bounded(
      [...head, `nothing live on ${named} right now.`, ABSENT].join("\n"),
    );
  }
  const total = entries.length;
  const assemble = (kept: string[]) => {
    const omitted = total - kept.length;
    const body =
      omitted > 0
        ? [
            ...kept,
            kept.length === 0
              ? `(none shown: one entry's banner and wrapper alone exceed limits.maxNotificationChars (${max}); raise it, or name fewer streams)`
              : `(${omitted} more standing entr${omitted === 1 ? "y" : "ies"} not shown; name fewer streams or raise limit)`,
          ]
        : kept;
    return [...head, "", body.join("\n\n"), "", ABSENT].join("\n");
  };
  const fits = (kept: string[]) => assemble(kept).length <= max;
  const kept: string[] = [];
  for (const entry of entries.slice(0, options.limit)) {
    const render = (textChars?: number) => {
      let out: string;
      try {
        out = renderItem(entry.standing, view.now, textChars);
      } catch {
        // One malformed item must not empty the whole call.
        return `[canticle:heard] item from "${token(entry.standing.station)}" could not be rendered; not shown`;
      }
      if (entry.folded.length === 0) return out;
      const older = entry.folded
        .map(
          (item) =>
            `stream=${token(item.stream)} item=${digits(item.epoch)}/${digits(item.seq)}`,
        )
        .join(", ");
      return `${out}\nfolded: ${entry.folded.length} older live item${entry.folded.length === 1 ? "" : "s"} for this station and state_key (${older}); hear shows ${entry.folded.length === 1 ? "it" : "them"}`;
    };
    const full = render();
    if (fits([...kept, full])) {
      kept.push(full);
      continue;
    }
    // Too big whole: as much payload as fits, the frame intact.
    const length = entry.standing.text ? entry.standing.text.length : 0;
    if (length > 0 && fits([...kept, render(0)])) {
      let lo = 0;
      let hi = length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits([...kept, render(mid)])) lo = mid;
        else hi = mid - 1;
      }
      kept.push(render(lo));
    }
    break;
  }
  const out = assemble(kept);
  if (out.length <= max) return out;
  return bounded(
    `canticle sitrep for ${named}: ${total} standing; the listing doesn't fit limits.maxNotificationChars (${max}). Name fewer streams or raise it.`,
  );
}
