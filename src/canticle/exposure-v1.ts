// A vendored copy of binary-canticle#162's exposure record types (frond-ear#117). Types only:
// frond-ear never imports across repos, and nothing here signs, holds a key or calls an issuer.
//
// Source: karmaterminal/binary-canticle at 452c54336d05048b3e0e2fd83bafb16d98065891 (PR #162):
// - prototype/openclaw-canticle/src/exposure.ts (blob f2d675ea29888f4779bba379e856d5347b3ecc5d):
//   `PayloadSource`, `PayloadExposure`;
// - prototype/openclaw-canticle/src/config.ts (blob 5e5015cfb59bd8dfd53d9371143a51687541545f):
//   `LocalReader`;
// - prototype/openclaw-canticle/src/records.ts (blob 97786131fa28480cba6ab28ab611a7ee536f3808):
//   `Tuple`, and the `flags`, `times` and `body_ref` members of `HeardFrame` (`BodyRef`),
//   inlined below so this file stands alone.
//
// Copied as written, field for field. Change it only by copying a newer source, with its sha.

export type LocalReader = {
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
};

export type Tuple = {
  key_id: string;
  epoch: number;
  stream_id: number;
  seq: number | string;
};

export type BodyRef = { url: string; sha256: string; size: number };

/** `HeardFrame["flags"]`. */
export type HeardFrameFlags = {
  refresh: boolean;
  wake_derived: boolean | null;
  exercise: boolean;
};

/** `HeardFrame["times"]`. */
export type HeardFrameTimes = {
  issued_at: number;
  expires_at: number;
  received_at: number | null;
  heard_at: number;
  offset_ms: number;
  local_expiry_at: number;
};

/** `HeardFrame["body_ref"]`. */
export type HeardFrameBodyRef = BodyRef | null;

export type PayloadSource = {
  item: Tuple;
  idem: string;
  root: Tuple | null;
  hop: number;
  class: string;
  scope: string | null;
  lens: number | null;
  station: string;
  principal: string | null;
  stream: string;
  stateKey: string | null;
  flags: HeardFrameFlags;
  times: HeardFrameTimes;
  sourceBody: {
    ctype: string | number;
    size: number;
    sha256: string;
    textSha256: string | null;
  } | null;
  bodyRef: HeardFrameBodyRef;
  /** Hash the exact rendered entry, including its host banner and defanged payload. */
  renderedSha256: string;
  renderedBytes: number;
  receiver: {
    run: string;
    source: "live" | "snapshot";
    journalSequence: number | null;
    recordSequence: number | null;
  };
};

export type PayloadExposure = {
  version: "canticle-payload-exposure/1";
  binding: string;
  reader: LocalReader;
  toolCallId: string;
  /** This is the complete text returned by the plugin, before any host wrapping or transformation. */
  resultSha256: string;
  resultBytes: number;
  /** Actual output order, not selected-parent-only lineage or a deduplicated maximum-hop summary. */
  sources: readonly PayloadSource[];
};
