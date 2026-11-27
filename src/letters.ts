/**
 * Letters (#88): text an ear's own session leaves for a later turn of itself,
 * written before a compaction and released to it afterwards as a channel event.
 *
 * The session chooses and the daemon only delivers. A letter goes back only to
 * the session that left it (a fresh session is told letters exist, never shown
 * their text), it expires, and it is evidence from an earlier turn, never
 * permission: its banner says so, and what it rested on is listed unchecked.
 *
 * A letter names heard canticle records by reference (`heard`), never by their words, and
 * a literal-copy guard refuses one whose text copies a record already released to the
 * session that leaves it (Deep Dive No. 2 §06): heard broadcast must not cross a compaction
 * inside a letter's body with no label. Literal copies only; see `copiedRecords`.
 */
import { shownText, token } from "./canticle/hear.ts";
import { CANTICLE_STATION } from "./config.ts";
import { cleanName, cleanText, type Notification } from "./render.ts";
import type { EventStore, HeardRef, Letter } from "./store.ts";

export const LETTER_LIMITS = {
  maxBodyBytes: 8192,
  maxReasonChars: 200,
  maxAssumed: 8,
  maxAssumedChars: 200,
  /** Heard canticle references per letter. */
  maxHeard: 16,
  /** Unsettled, unexpired letters per ear. */
  maxPending: 16,
  maxPendingBytes: 24576,
  defaultTtlSeconds: 48 * 3600,
  maxTtlSeconds: 7 * 24 * 3600,
  /** How long a settled letter stays listable. */
  keepSettledMs: 24 * 3600_000,
  /** How long an expired, never-settled letter waits to be reported. */
  keepExpiredMs: 7 * 24 * 3600_000,
  /** How long a release that found no attached session stays armed. */
  armMs: 10 * 60_000,
} as const;

export interface LeaveRequest {
  reason: string;
  body: string;
  bytes: number;
  assumed: string[];
  heard: HeardRef[];
  ttlMs: number;
}

/** A stream name (RFC-0001 §5.4): up to four dot-separated segments. */
const STREAM = /^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){0,3}$/u;
const U64_MAX = 18_446_744_073_709_551_615n;

/** `station:stream epoch/seq`, the way a canticle banner and custody name a record. */
export function heardName(ref: HeardRef): string {
  return `${ref.station}:${ref.stream} ${ref.epoch}/${ref.seq}`;
}

/**
 * The `heard` argument: references to canticle records, each `{station, stream, epoch,
 * seq}` and nothing else, so a reference can never carry a record's words. seq is an
 * integer, or its decimal digits as a string for one past 2^53 (a seq is a u64).
 */
function parseHeard(raw: unknown): HeardRef[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(
      "heard must be a list of {station, stream, epoch, seq} references",
    );
  }
  if (raw.length > LETTER_LIMITS.maxHeard) {
    throw new Error(
      `heard has ${raw.length} references; the limit is ${LETTER_LIMITS.maxHeard}`,
    );
  }
  const refs: HeardRef[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const which = `heard item ${index + 1}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${which} must be {station, stream, epoch, seq}`);
    }
    const fields = item as Record<string, unknown>;
    if (
      Object.keys(fields).some(
        (key) => !["station", "stream", "epoch", "seq"].includes(key),
      )
    ) {
      throw new Error(
        `${which}: a heard reference carries station, stream, epoch and seq only, never a record's text`,
      );
    }
    const { station, stream, epoch, seq } = fields;
    if (typeof station !== "string" || !CANTICLE_STATION.test(station)) {
      throw new Error(
        `${which}: station must be a station's name as hear shows it (lowercase letters, digits and -)`,
      );
    }
    if (typeof stream !== "string" || !STREAM.test(stream)) {
      throw new Error(
        `${which}: stream must be a stream name as hear shows it (e.g. ops.fleet)`,
      );
    }
    if (
      typeof epoch !== "number" ||
      !Number.isSafeInteger(epoch) ||
      epoch < 0
    ) {
      throw new Error(`${which}: epoch must be a non-negative integer`);
    }
    let digits: string | undefined;
    if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
      digits = String(seq);
    } else if (
      typeof seq === "string" &&
      /^\d{1,20}$/u.test(seq) &&
      BigInt(seq) <= U64_MAX
    ) {
      digits = BigInt(seq).toString();
    }
    if (digits === undefined) {
      throw new Error(
        `${which}: seq must be a non-negative integer (as a string of digits past 2^53)`,
      );
    }
    const ref = { station, stream, epoch, seq: digits };
    const name = heardName(ref);
    if (!seen.has(name)) {
      seen.add(name);
      refs.push(ref);
    }
  });
  return refs;
}

/** Validates the leave_letter tool's arguments. Refuses rather than truncates. */
export function parseLeave(args: Record<string, unknown>): LeaveRequest {
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason) {
    throw new Error(
      "reason is required: say why your later self needs this, so a bare instruction can't travel alone",
    );
  }
  if (reason.length > LETTER_LIMITS.maxReasonChars) {
    throw new Error(
      `reason is ${reason.length} characters; the limit is ${LETTER_LIMITS.maxReasonChars}`,
    );
  }
  const body = typeof args.body === "string" ? args.body : "";
  if (!body.trim()) {
    throw new Error("body is required");
  }
  const bytes = Buffer.byteLength(body);
  if (bytes > LETTER_LIMITS.maxBodyBytes) {
    throw new Error(
      `body is ${bytes} bytes; the limit is ${LETTER_LIMITS.maxBodyBytes}. Leave the essentials, or point at a file`,
    );
  }
  const rawAssumed = args.assumed ?? [];
  if (
    !Array.isArray(rawAssumed) ||
    rawAssumed.some((item) => typeof item !== "string")
  ) {
    throw new Error("assumed must be a list of strings");
  }
  const assumed = (rawAssumed as string[])
    .map((item) => item.trim())
    .filter(Boolean);
  if (assumed.length > LETTER_LIMITS.maxAssumed) {
    throw new Error(
      `assumed has ${assumed.length} items; the limit is ${LETTER_LIMITS.maxAssumed}`,
    );
  }
  if (assumed.some((item) => item.length > LETTER_LIMITS.maxAssumedChars)) {
    throw new Error(
      `each assumed item is at most ${LETTER_LIMITS.maxAssumedChars} characters`,
    );
  }
  const rawTtl = args.expires_in_seconds;
  let ttlSeconds: number = LETTER_LIMITS.defaultTtlSeconds;
  if (rawTtl !== undefined && rawTtl !== null) {
    const value = Number(rawTtl);
    if (
      !Number.isInteger(value) ||
      value < 60 ||
      value > LETTER_LIMITS.maxTtlSeconds
    ) {
      throw new Error(
        `expires_in_seconds must be an integer from 60 to ${LETTER_LIMITS.maxTtlSeconds} (7 days)`,
      );
    }
    ttlSeconds = value;
  }
  const heard = parseHeard(args.heard);
  return { reason, body, bytes, assumed, heard, ttlMs: ttlSeconds * 1000 };
}

/**
 * The copy guard's floor: a letter copies a record when they share a run of at least this
 * many characters (UTF-16 units) after normalization. 40 is about seven words: longer than
 * the short stock phrases that recur in independent writing ("There is a room.", "deploy
 * finished", a status word), so those never trip it, and short enough to catch a copied
 * sentence or clause, and to stay meaningful against `reason` and `assumed` items, which
 * are capped at 200. A record shorter than the floor can't be caught at all.
 */
export const COPY_FLOOR = 40;

/** A canticle record frond-ear released to the session, with the text it was shown. */
export interface ReleasedRecord extends HeardRef {
  text: string;
}

/**
 * The form both sides are compared in: the text as a banner shows a payload (cleaned,
 * look-alikes defused), NFC, a `> ` quote marker at a line's start dropped (so a block
 * copied out of a banner, markers and all, still reads as the record), and every run of
 * whitespace one space.
 */
function copyForm(text: string): string {
  return shownText(text)
    .normalize("NFC")
    .replace(/^[ \t]*>[ \t]?/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Literal-copy detection, not provenance enforcement. Which `released` records each of
 * the letter's fields (body, reason, each assumed item) shares a run of at least
 * `COPY_FLOOR` characters with, after `copyForm`. `released` must be only what was
 * released to the leaving session (custody: pushes the host confirmed to it, its own
 * `hear` returns), never the held buffer or the live set at large: otherwise a refusal
 * would tell the session text it hasn't chosen to receive. A paraphrase, a fragment under
 * the floor, a record cut to fit, and a record frond-ear no longer holds all pass.
 */
export function copiedRecords(
  request: Pick<LeaveRequest, "body" | "reason" | "assumed">,
  released: readonly ReleasedRecord[],
  floor = COPY_FLOOR,
): Array<{ field: string; records: HeardRef[] }> {
  const owner = new Map<string, number>();
  released.forEach((record, index) => {
    const text = copyForm(record.text);
    for (let at = 0; at + floor <= text.length; at += 1) {
      const run = text.slice(at, at + floor);
      if (!owner.has(run)) {
        owner.set(run, index);
      }
    }
  });
  if (owner.size === 0) {
    return [];
  }
  const fields: Array<[string, string]> = [
    ["body", request.body],
    ["reason", request.reason],
    ...request.assumed.map((item, index): [string, string] => [
      `assumed item ${index + 1}`,
      item,
    ]),
  ];
  const found: Array<{ field: string; records: HeardRef[] }> = [];
  for (const [field, value] of fields) {
    const text = copyForm(value);
    const hits = new Set<number>();
    for (let at = 0; at + floor <= text.length; at += 1) {
      const index = owner.get(text.slice(at, at + floor));
      if (index !== undefined) {
        hits.add(index);
      }
    }
    if (hits.size > 0) {
      found.push({
        field,
        records: [...hits]
          .sort((a, b) => a - b)
          .map((index) => {
            const { station, stream, epoch, seq } = released[index]!;
            return { station, stream, epoch, seq };
          }),
      });
    }
  }
  return found;
}

/**
 * Refuses a letter that copies a released record, naming each record by `station:stream
 * epoch/seq` and offering the `heard` reference instead. Never echoes the matched text.
 */
export function refuseCopies(
  request: Pick<LeaveRequest, "body" | "reason" | "assumed">,
  released: readonly ReleasedRecord[],
): void {
  const found = copiedRecords(request, released);
  if (found.length === 0) {
    return;
  }
  const refs = new Map<string, HeardRef>();
  for (const { records } of found) {
    for (const record of records) {
      refs.set(heardName(record), record);
    }
  }
  // A released record's names come from its verified frame; banner tokens all the same.
  const seqOf = (seq: string) =>
    /^\d{1,20}$/u.test(seq) ? seq : "unavailable";
  const named = (records: HeardRef[]) =>
    records
      .map(
        (record) =>
          `${token(record.station)}:${token(record.stream)} ${record.epoch}/${seqOf(record.seq)}`,
      )
      .join(", ");
  const suggestion = [...refs.values()]
    .slice(0, LETTER_LIMITS.maxHeard)
    .map(
      (record) =>
        `{station: "${token(record.station)}", stream: "${token(record.stream)}", epoch: ${record.epoch}, seq: ${/^\d{1,15}$/u.test(record.seq) ? record.seq : `"${seqOf(record.seq)}"`}}`,
    )
    .join(", ");
  throw new Error(
    `letter not stored: ${found
      .map(
        ({ field, records }) =>
          `its ${field} copies heard canticle record${records.length === 1 ? "" : "s"} ${named(records)}`,
      )
      .join(
        "; ",
      )} (a run of ${COPY_FLOOR}+ characters, whitespace normalized). Name the record instead, heard: [${suggestion}], and say in your own words what it meant to you; hear shows it again while it is live. This is literal-copy detection, not provenance enforcement: it compares only canticle text frond-ear released to this session and still holds, so a paraphrase, a short fragment or a record gone from the live set passes.`,
  );
}

/**
 * The line the release hook adds after its result whenever the daemon answered. A
 * session gets no warning before a compaction, and stock Claude Code has nothing like a
 * letter, so a seat that is never told forgets the tool exists (the gloss went 44
 * compactions without one, 11-14). Printed at every startup and compaction, so the
 * reminder arrives even when no letter does.
 */
export const LETTER_HINT =
  "compaction gives no warning. Leave a letter to your later self (leave_letter: reason, body, assumed) whenever your threads change; this hook hands it back after the next compaction. `letters` lists, reads or drops them.";

/**
 * The session and source a hook names on stdin. Claude Code's hooks send `session_id`
 * and `source`; Copilot CLI's (preCompact, sessionStart) send `sessionId` and, for
 * preCompact, `trigger` instead of a source. Either spelling names the session; a
 * payload that isn't a JSON object names nothing. A PreCompact hook's `trigger` and
 * `transcript_path` come back too, for the compaction hold (#107).
 */
export function hookInput(raw: string): {
  sessionId?: string;
  source?: string;
  trigger?: string;
  transcriptPath?: string;
} {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }
  const fields = input as Record<string, unknown>;
  const sessionId = [fields.session_id, fields.sessionId].find(
    (value): value is string => typeof value === "string" && value !== "",
  );
  const source = typeof fields.source === "string" ? fields.source : undefined;
  const trigger =
    typeof fields.trigger === "string" ? fields.trigger : undefined;
  const transcriptPath =
    typeof fields.transcript_path === "string" && fields.transcript_path !== ""
      ? fields.transcript_path
      : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(source ? { source } : {}),
    ...(trigger ? { trigger } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
  };
}

/** How many releases (compactions or starts) the ear has had. */
export function releaseCount(store: EventStore, ear: string): number {
  const value = Number(store.runtimeState(`letters.releases.${ear}`) ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function unsettled(letter: Letter): boolean {
  return letter.ackedAt === null;
}

/** Drops settled letters past their listing window and long-expired unsettled ones. */
export function pruneLetters(
  store: EventStore,
  ear: string,
  now: number,
): void {
  const gone = store
    .letters(ear)
    .filter((letter) =>
      letter.ackedAt !== null
        ? letter.ackedAt <= now - LETTER_LIMITS.keepSettledMs
        : letter.expiresAt <= now - LETTER_LIMITS.keepExpiredMs,
    )
    .map((letter) => letter.id);
  if (gone.length > 0) {
    store.deleteLetters(ear, gone);
  }
}

export function leaveLetter(
  store: EventStore,
  ear: string,
  sessionId: string | null,
  now: number,
  request: LeaveRequest,
): string {
  pruneLetters(store, ear, now);
  const pending = store
    .letters(ear)
    .filter((letter) => unsettled(letter) && letter.expiresAt > now);
  if (pending.length >= LETTER_LIMITS.maxPending) {
    throw new Error(
      `this ear already holds ${pending.length} unsettled letters (the limit); drop one with the letters tool first`,
    );
  }
  const held = pending.reduce((sum, letter) => sum + letter.bytes, 0);
  if (held + request.bytes > LETTER_LIMITS.maxPendingBytes) {
    throw new Error(
      `this ear's unsettled letters hold ${held} bytes; adding ${request.bytes} would pass the ${LETTER_LIMITS.maxPendingBytes}-byte limit. Drop or shorten one first`,
    );
  }
  const expiresAt = now + request.ttlMs;
  const id = store.leaveLetter({
    ear,
    sessionId,
    reason: request.reason,
    body: request.body,
    bytes: request.bytes,
    assumed: request.assumed,
    heard: request.heard,
    leftAt: now,
    expiresAt,
    releasesAtLeave: releaseCount(store, ear),
  });
  const refs =
    request.heard.length === 0
      ? ""
      : `, ${request.heard.length} heard reference${request.heard.length === 1 ? "" : "s"}`;
  return `letter ${id} left (${request.bytes} bytes${refs}; expires ${iso(expiresAt)}). It comes back to this session as a kind="letter" event after its next compaction, when the seat's SessionStart hook runs frond-ear release. Ack that event's nonce to settle it; an unsettled letter comes back after the following compaction too.`;
}

export interface Release {
  /** One event per delivered letter, then one note for held and expired ones. */
  notifications: Notification[];
  delivered: number;
  held: number;
  expired: number;
  nonce?: string;
}

/**
 * What a release sends to the ear's attached session: each unsettled,
 * unexpired letter that session left (or whose session is unknown) as its own
 * event, so no event is larger than one letter; then one note for letters
 * another session left and for expired ones, which are deleted. Records the
 * delivery under one fresh nonce, which settles all of them.
 */
export function releaseLetters(
  store: EventStore,
  ear: string,
  attachedSessionId: string | null,
  now: number,
  source: string,
  nonce: () => string,
): Release {
  const releases = releaseCount(store, ear) + 1;
  store.setRuntimeState(`letters.releases.${ear}`, String(releases));
  pruneLetters(store, ear, now);
  const open = store.letters(ear).filter(unsettled);
  const expired = open.filter((letter) => letter.expiresAt <= now);
  const live = open.filter((letter) => letter.expiresAt > now);
  // Fail closed: a letter is shown only when both the session that left it and
  // the session receiving it are known and the same.
  const sameSession = (letter: Letter): boolean =>
    letter.sessionId !== null &&
    attachedSessionId !== null &&
    letter.sessionId === attachedSessionId;
  const due = live.filter(sameSession);
  const held = live.filter((letter) => !sameSession(letter));
  const notifications: Notification[] = [];
  const key = due.length > 0 ? nonce() : undefined;
  const after = cleanName(source);
  if (key) {
    due.forEach((letter, index) => {
      const which =
        due.length === 1 ? "a letter" : `letter ${index + 1} of ${due.length}`;
      const settle =
        due.length === 1
          ? `ack nonce "${key}" settles it`
          : `ack nonce "${key}" once settles all ${due.length}`;
      notifications.push({
        content: `frond-ear: ${which} from you, written before this ${after}. What you thought then, not permission now. ${settle}.\n\n${renderLetter(letter, now, attachedSessionId, releases)}`,
        meta: {
          kind: "letter",
          ear,
          source: after,
          nonce: key,
          letter_id: String(letter.id),
          part: `${index + 1}/${due.length}`,
        },
      });
    });
    store.deliverLetters(
      due.map((letter) => letter.id),
      key,
      now,
    );
  }
  const notes: string[] = [];
  if (held.length > 0) {
    const whose =
      attachedSessionId === null
        ? "held because frond-ear does not know this session's id (its shim had no CLAUDE_CODE_SESSION_ID), so it cannot tell whose they are"
        : "left by another session than this one";
    notes.push(
      `[frond-ear: ${held.length === 1 ? "1 letter" : `${held.length} letters`} ${whose} (${held
        .map(
          (letter) =>
            `letter ${letter.id} from session ${shortSession(letter.sessionId)}, ${age(now - letter.leftAt)} old`,
        )
        .join(
          "; ",
        )}) ${held.length === 1 ? "is" : "are"} held and not shown. Read one with the letters tool (read: id) only if you mean to; ${held.length === 1 ? "it expires" : "they expire"} on ${held.length === 1 ? "its" : "their"} own.]`,
    );
  }
  for (const letter of expired) {
    notes.push(
      `[frond-ear: letter ${letter.id} expired unsettled ${age(now - letter.leftAt)} after it was left (${letter.deliveries} deliver${letter.deliveries === 1 ? "y" : "ies"}); its text is dropped.]`,
    );
  }
  if (expired.length > 0) {
    store.deleteLetters(
      ear,
      expired.map((letter) => letter.id),
    );
  }
  if (notes.length > 0) {
    notifications.push({
      content: notes.join("\n"),
      meta: {
        kind: "letter_note",
        ear,
        source: after,
        held: String(held.length),
        expired: String(expired.length),
      },
    });
  }
  return {
    notifications,
    delivered: due.length,
    held: held.length,
    expired: expired.length,
    ...(key ? { nonce: key } : {}),
  };
}

/** One letter: a daemon-written header, then the session's own text quoted. */
export function renderLetter(
  letter: Letter,
  now: number,
  attachedSessionId: string | null,
  releases: number,
): string {
  const since = Math.max(0, releases - letter.releasesAtLeave);
  const by =
    letter.sessionId === null
      ? "session unknown"
      : letter.sessionId === attachedSessionId
        ? "by this session"
        : `by session ${shortSession(letter.sessionId)}`;
  const header = [
    `[letter ${letter.id}`,
    `left ${iso(letter.leftAt)} (${age(now - letter.leftAt)} ago, ${since} compaction${since === 1 ? "" : "s"} or start${since === 1 ? "" : "s"} ago)`,
    by,
    `expires ${iso(letter.expiresAt)}`,
    letter.deliveries === 0
      ? "first delivery"
      : `delivered ${letter.deliveries} time${letter.deliveries === 1 ? "" : "s"} before`,
  ].join(" · ");
  const lines = [
    `${header}]`,
    "reason:",
    quote(letter.reason),
    "letter:",
    quote(letter.body),
  ];
  if (letter.assumed.length > 0) {
    lines.push(
      "rested on (unchecked):",
      ...letter.assumed.map((item) => quote(`- ${item}`)),
    );
  }
  if (letter.heard.length > 0) {
    lines.push(
      "heard (references, not words: re-read each with hear while it is live):",
      ...letter.heard.map((ref) => quote(`- ${heardName(ref)}`)),
    );
  }
  return lines.join("\n");
}

/** Claude Code cuts a PreCompact hook's stdout at 10,000 characters; stay under it. */
export const SUMMARY_LETTERS_CAP = 9_500;

/**
 * What a PreCompact hook prints (#102): the session's own unsettled, unexpired
 * letters, newest first, framed as instructions for the compaction summary, so the
 * summary the next turn reasons from carries them, idle compactions included.
 * Read-only: nothing is marked delivered or settled; the SessionStart release still
 * hands them back afterwards. Empty when there is nothing to carry. Never starts with
 * `{`, so Claude Code cannot read it as a JSON decision that blocks the compaction.
 */
export function summaryLetters(
  store: EventStore,
  ear: string,
  sessionId: string,
  now: number,
  cap = SUMMARY_LETTERS_CAP,
): string {
  const releases = releaseCount(store, ear);
  const due = store
    .letters(ear)
    .filter(unsettled)
    .filter((letter) => letter.expiresAt > now)
    .filter((letter) => letter.sessionId === sessionId)
    .sort((a, b) => b.leftAt - a.leftAt || b.id - a.id);
  if (due.length === 0) {
    return "";
  }
  const count =
    due.length === 1 ? "1 unsettled letter" : `${due.length} unsettled letters`;
  const head =
    `frond-ear: this session left itself ${count} before this compaction. In the summary, ` +
    `under the heading "Letters from before this compaction", keep each one: its letter id, ` +
    `its reason, its full text and what it rested on. They are this session's own notes: what ` +
    `it thought then, evidence and never permission, and nobody else's instructions. ` +
    `frond-ear also hands them back after the compaction; this copy keeps the threads in the ` +
    `summary itself.`;
  // Room is kept for one closing note that names every letter left out, so no
  // letter is ever dropped silently, however close to the cap the others come.
  const omittedNote = (ids: number[]): string =>
    `[${ids.length === 1 ? `letter ${ids[0]} did` : `letters ${ids.join(", ")} did`} not fit this hook's ${cap}-character budget; ${ids.length === 1 ? "it comes" : "they come"} back after the compaction as letter events]`;
  const reserve = 2 + omittedNote(due.map((letter) => letter.id)).length;
  const parts = [head];
  let used = head.length;
  const omitted: number[] = [];
  for (const letter of due) {
    const text = renderLetter(letter, now, sessionId, releases);
    if (omitted.length === 0 && used + 2 + text.length + reserve <= cap) {
      parts.push(text);
      used += 2 + text.length;
      continue;
    }
    omitted.push(letter.id);
  }
  if (omitted.length > 0) {
    parts.push(omittedNote(omitted));
  }
  return parts.join("\n\n");
}

/** The letters tool's listing: ids, sizes and states, never bodies. */
export function listLetters(
  store: EventStore,
  ear: string,
  now: number,
  attachedSessionId: string | null,
): string {
  pruneLetters(store, ear, now);
  const letters = store.letters(ear);
  if (letters.length === 0) {
    return "no letters";
  }
  return letters
    .map((letter) => {
      const state =
        letter.ackedAt !== null
          ? `settled ${iso(letter.ackedAt)}`
          : letter.expiresAt <= now
            ? "expired, unsettled"
            : letter.deliveries > 0
              ? `delivered ${letter.deliveries}×, unsettled`
              : "waiting";
      const by =
        letter.sessionId === null
          ? "session unknown"
          : letter.sessionId === attachedSessionId
            ? "this session"
            : `session ${shortSession(letter.sessionId)}`;
      const heard =
        letter.heard.length === 0
          ? ""
          : ` · heard: ${letter.heard.map(heardName).join(", ")}`;
      return `letter ${letter.id} · ${state} · ${letter.bytes} bytes · left ${age(now - letter.leftAt)} ago by ${by} · expires ${iso(letter.expiresAt)}${heard} · reason: ${cleanName(letter.reason)}`;
    })
    .join("\n");
}

function quote(text: string): string {
  return cleanText(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function shortSession(sessionId: string | null): string {
  return sessionId === null ? "unknown" : cleanName(sessionId).slice(0, 8);
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

export function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
