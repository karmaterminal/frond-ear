/**
 * Letters (#88): text an ear's own session leaves for a later turn of itself,
 * written before a compaction and released to it afterwards as a channel event.
 *
 * The session chooses and the daemon only delivers. A letter goes back only to
 * the session that left it (a fresh session is told letters exist, never shown
 * their text), it expires, and it is evidence from an earlier turn, never
 * permission: its banner says so, and what it rested on is listed unchecked.
 */
import { cleanName, cleanText, type Notification } from "./render.ts";
import type { EventStore, Letter } from "./store.ts";

export const LETTER_LIMITS = {
  maxBodyBytes: 8192,
  maxReasonChars: 200,
  maxAssumed: 8,
  maxAssumedChars: 200,
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
  ttlMs: number;
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
  return { reason, body, bytes, assumed, ttlMs: ttlSeconds * 1000 };
}

/**
 * The session and source a hook names on stdin. Claude Code's hooks send `session_id`
 * and `source`; Copilot CLI's (preCompact, sessionStart) send `sessionId` and, for
 * preCompact, `trigger` instead of a source. Either spelling names the session; a
 * payload that isn't a JSON object names nothing.
 */
export function hookInput(raw: string): {
  sessionId?: string;
  source?: string;
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
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(source ? { source } : {}),
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
    leftAt: now,
    expiresAt,
    releasesAtLeave: releaseCount(store, ear),
  });
  return `letter ${id} left (${request.bytes} bytes; expires ${iso(expiresAt)}). It comes back to this session as a kind="letter" event after its next compaction, when the seat's SessionStart hook runs frond-ear release. Ack that event's nonce to settle it; an unsettled letter comes back after the following compaction too.`;
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
  return lines.join("\n");
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
      return `letter ${letter.id} · ${state} · ${letter.bytes} bytes · left ${age(now - letter.leftAt)} ago by ${by} · expires ${iso(letter.expiresAt)} · reason: ${cleanName(letter.reason)}`;
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
