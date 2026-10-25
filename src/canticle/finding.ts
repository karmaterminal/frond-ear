// A finding: what a probe or watcher sings about a seat on `alerts` or `distress`
// (binary-canticle#112's profile, RFC-0001 amendment FP-1, proposed; frond-ear#85).
//
// Content type 11, `application/vnd.canticle.finding+cbor`: a CBOR map with small integer
// keys. 1 incident (equal to the item's state_key), 2 subject, 3 voice (`self` or
// `observer`), 4 status (`open`, `resolved` or `ended`), 5 severity (CAP's words, present
// exactly when status is `open`), 6 summary, 7 not_proved. Keys 8 and up are ignored.
// Only an `advisory` is a finding; anything malformed is not one, and its body stays
// opaque, never shown with a status or a severity.
//
// The signer is always the speaker: the key that signed the frame, under the name the
// manifest pins to it. `voice` and `subject` are the signer's own claims, so a finding
// reads as the signer speaking for itself only when its subject is the signer's own
// station; anything else is the signer's report about the subject, never the subject
// speaking.

import { decode, type CborMap } from "./cbor.ts";

export const FINDING_CTYPE = 11;
export const FINDING_CTYPE_NAME = "application/vnd.canticle.finding+cbor";

export type FindingStatus = "open" | "resolved" | "ended";
export type FindingSeverity =
  | "extreme"
  | "severe"
  | "moderate"
  | "minor"
  | "unknown";

export interface Finding {
  incident: string;
  subject: string;
  voice: "self" | "observer";
  status: FindingStatus;
  /** Set exactly when `status` is `open`. */
  severity: FindingSeverity | undefined;
  summary: string;
  notProved: string;
}

const VOICES: ReadonlySet<string> = new Set(["self", "observer"]);
const STATUSES: ReadonlySet<string> = new Set(["open", "resolved", "ended"]);
const SEVERITIES: ReadonlySet<string> = new Set([
  "extreme",
  "severe",
  "moderate",
  "minor",
  "unknown",
]);

/** One line: no C0, DEL or C1 control, and no line or paragraph separator. */
const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** Content type 11, by its id or its registered name (record v1 shows either). */
export function isFindingCtype(ctype: unknown): boolean {
  return ctype === FINDING_CTYPE || ctype === FINDING_CTYPE_NAME;
}

/**
 * The finding an item's body holds, or undefined when the item isn't one: another
 * content type or class, a body that isn't the profile's map, or an incident that isn't
 * the item's state_key.
 */
export function parseFinding(
  item: { class: string; ctype: unknown; stateKey: string | undefined },
  body: Uint8Array | undefined,
): Finding | undefined {
  if (
    body === undefined ||
    item.class !== "advisory" ||
    !isFindingCtype(item.ctype)
  ) {
    return undefined;
  }
  let map: CborMap;
  try {
    const value = decode(body);
    if (!(value instanceof Map)) return undefined;
    map = value;
  } catch {
    return undefined;
  }
  for (const key of map.keys()) {
    if (typeof key !== "bigint" || key < 1n) return undefined;
  }
  const text = (key: bigint, max: number): string | undefined => {
    const value = map.get(key);
    return typeof value === "string" &&
      value !== "" &&
      Buffer.byteLength(value) <= max &&
      !NOT_ONE_LINE.test(value)
      ? value
      : undefined;
  };
  const word = (key: bigint, words: ReadonlySet<string>) => {
    const value = map.get(key);
    return typeof value === "string" && words.has(value) ? value : undefined;
  };
  const incident = text(1n, 32);
  const subject = text(2n, 64);
  const voice = word(3n, VOICES) as Finding["voice"] | undefined;
  const status = word(4n, STATUSES) as FindingStatus | undefined;
  const severity = word(5n, SEVERITIES) as FindingSeverity | undefined;
  const summary = text(6n, 280);
  const notProved = text(7n, 160);
  if (
    incident === undefined ||
    incident !== item.stateKey ||
    subject === undefined ||
    voice === undefined ||
    status === undefined ||
    summary === undefined ||
    notProved === undefined ||
    // A severity exactly when open, and a well-formed one.
    (status === "open") !== map.has(5n) ||
    (map.has(5n) && severity === undefined)
  ) {
    return undefined;
  }
  return {
    incident,
    subject,
    voice,
    status,
    severity,
    summary,
    notProved,
  };
}

/**
 * Who speaks: the signer, always. It speaks for itself only when the subject is its own
 * station, as the manifest names it; any other `self` is a claim the signer made about
 * someone else, so it reads as the signer's observation.
 */
export function voiceOf(
  finding: Finding,
  station: string,
): "self" | "observer" {
  return finding.voice === "self" && finding.subject === station
    ? "self"
    : "observer";
}
