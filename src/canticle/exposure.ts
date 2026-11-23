// The exposure ledger (frond-ear#117): what canticle pushes exposed to an ear's session, as
// binary-canticle#162's `canticle-payload-exposure/1` records. RED stub: types only.

import type {
  LocalReader,
  PayloadExposure,
  PayloadSource,
} from "./exposure-v1.ts";

export type ExposureReader = Omit<LocalReader, "sessionId"> & {
  sessionId: string | null;
};

export type ExposureSource = Omit<PayloadSource, "receiver"> & {
  receiver: PayloadSource["receiver"] | null;
};

export type ExposureRecord = Omit<PayloadExposure, "reader" | "sources"> & {
  reader: ExposureReader;
  sources: readonly ExposureSource[];
};

export type ExposurePhase = "fenced" | "offered" | "echoed" | "unknown";
export type HolderIdentity = "known" | "unknown" | "in-doubt";

export interface ExposureEntry {
  pendingId: string;
  ear: string;
  batchId: number;
  phase: ExposurePhase;
  fencedAt: number;
  holder: HolderIdentity;
  offered: { at: number; sessionId: string | null } | null;
  echoed: { at: number; sessionId: string | null; by: string } | null;
  unknown: { at: number; reason: "unsent" | "reverted" } | null;
  record: ExposureRecord;
}

export function conformant(_record: ExposureRecord): PayloadExposure | null {
  return null;
}
