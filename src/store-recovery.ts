import { existsSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * A ledger store found corrupt when the daemon opened it, set aside whole, and replaced
 * by a fresh store (#115). Recorded in the fresh store, so ear_status keeps saying it.
 */
export interface StoreReset {
  /** When the store was set aside and the fresh one started. */
  at: number;
  /** Where the corrupt database file is kept now (never deleted). */
  keptAt: string;
  /** Every file moved, sidecars first, the database last. */
  moved: string[];
  /** What SQLite said: its error text, or quick_check's first findings. */
  error: string;
}

/**
 * SQLite's primary result codes that mean the file itself is damaged (SQLITE_CORRUPT, 11)
 * or is not a database at all (SQLITE_NOTADB, 26). Nothing else sets a store aside: BUSY
 * and LOCKED (another process holds it), CANTOPEN (permissions, a missing directory),
 * IOERR, FULL, READONLY and the rest are refused as they always were, so a healthy store
 * is never moved for a cause that would pass.
 */
const CORRUPTION_CODES = new Set([11, 26]);

/** The files SQLite keeps beside a database, which belong to it and move with it. */
const SIDECARS = ["-wal", "-shm", "-journal"] as const;

/** quick_check found damage that no statement of opening ran into. */
export class StoreCorruptError extends Error {
  public constructor(findings: string) {
    super(`quick_check: ${findings}`);
    this.name = "StoreCorruptError";
  }
}

/** A corrupt store that could not be set aside: the daemon refuses to start. */
export class StoreSetAsideError extends Error {
  public constructor(
    path: string,
    target: string,
    corruption: string,
    cause: unknown,
    moved: string[],
  ) {
    super(
      `the ledger store ${path} is corrupt (${corruption}) and could not be moved aside to ${target}: ${errorText(cause)}; ` +
        `refusing to start, nothing was deleted. ` +
        (moved.length > 0
          ? `Already moved: ${moved.join(", ")}. `
          : "Nothing was moved. ") +
        `Move ${path} and any ${SIDECARS.map((suffix) => `${path}${suffix}`).join(", ")} aside together by hand, then start again (docs/recovery.md).`,
    );
    this.name = "StoreSetAsideError";
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True only when `error` says the store file is damaged: a node:sqlite error whose
 * primary result code is SQLITE_CORRUPT or SQLITE_NOTADB (extended codes reduce to
 * these), or quick_check's own finding. Everything else is not corruption.
 */
export function isStoreCorruption(error: unknown): boolean {
  if (error instanceof StoreCorruptError) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  return (
    code === "ERR_SQLITE_ERROR" &&
    typeof errcode === "number" &&
    CORRUPTION_CODES.has(errcode & 0xff)
  );
}

/**
 * Looks at the store at `path` read-only: SQLite's quick_check over every page. Returns
 * the corruption found (an error to record), or undefined for a sound store. Throws
 * anything that is not corruption, unchanged: a locked or busy store, one it can't open.
 * Read-only on purpose: closing a read-write connection to a file SQLite can't read
 * removes its -wal and -shm (seen with node 26's SQLite on a garbage file), and closing
 * one to a sound WAL store checkpoints it. A read-only one does neither.
 */
export function probeStore(path: string): unknown {
  let probe: DatabaseSync | undefined;
  try {
    probe = new DatabaseSync(path, { readOnly: true });
    const findings = (
      probe.prepare("PRAGMA quick_check").all() as Array<{
        quick_check: string;
      }>
    ).map((row) => row.quick_check);
    if (findings.length === 1 && findings[0] === "ok") {
      return undefined;
    }
    return new StoreCorruptError(findings.join("; ").slice(0, 500));
  } catch (error) {
    if (isStoreCorruption(error)) {
      return error;
    }
    throw error;
  } finally {
    try {
      probe?.close();
    } catch {
      // Never opened: nothing holds the file.
    }
  }
}

/** 2026-11-26T14:30:05.123Z → 20261126T143005.123Z: sortable, no colons. */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/gu, "");
}

/**
 * Moves the store at `path` and its sidecars aside to `<path>.corrupt-<UTC stamp>` (plus
 * the same suffixes), in the same directory, never overwriting an earlier quarantine.
 * Sidecars move first and the database last: a crash part way leaves the corrupt
 * database in place to be found again, never a fresh database beside an old WAL that
 * SQLite would replay into it. Deletes nothing. Throws StoreSetAsideError, having moved
 * what it already moved, when a rename fails. The caller must have closed every
 * connection to the store first.
 */
export function setStoreAside(
  path: string,
  corruption: unknown,
  now: number,
): StoreReset {
  const base = `${path}.corrupt-${stamp(now)}`;
  let keptAt = base;
  for (let n = 1; taken(keptAt); n++) {
    keptAt = `${base}-${n}`;
  }
  const error = errorText(corruption);
  const moved: string[] = [];
  for (const suffix of [...SIDECARS, ""]) {
    const from = `${path}${suffix}`;
    if (suffix !== "" && !existsSync(from)) {
      continue;
    }
    const to = `${keptAt}${suffix}`;
    try {
      renameSync(from, to);
    } catch (cause) {
      throw new StoreSetAsideError(path, to, error, cause, moved);
    }
    moved.push(to);
  }
  return { at: now, keptAt, moved, error };
}

function taken(keptAt: string): boolean {
  return [...SIDECARS, ""].some((suffix) => existsSync(`${keptAt}${suffix}`));
}
