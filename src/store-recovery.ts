import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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
  /**
   * Set when the start that set the store aside never recorded it (its fresh store
   * failed, or the process died) and a later start recorded it from the reset marker:
   * that marker's path, and when.
   */
  recoveredFrom?: string;
  recoveredAt?: number;
}

/**
 * What a reset marker holds: when, why, and where the store went. Written beside the
 * store before anything moves, so a start whose fresh store fails still leaves a trace
 * the next start records (Deep Dive No. 2 §08). Paths, a time and SQLite's own words:
 * never ledger content.
 */
interface ResetMarker {
  frondEar: "store-reset-marker";
  version: 1;
  at: number;
  atIso: string;
  store: string;
  keptAt: string;
  moving: string[];
  error: string;
}

/** A reset marker no live store has recorded yet, and the reset it describes. */
export interface PendingReset {
  marker: string;
  reset: StoreReset;
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
  for (let n = 1; taken(path, keptAt); n++) {
    keptAt = `${base}-${n}`;
  }
  const error = errorText(corruption);
  const suffixes = [...SIDECARS, ""].filter(
    (suffix) => suffix === "" || existsSync(`${path}${suffix}`),
  );
  // The marker first: once anything moves, a start that fails before its fresh store
  // records the reset still leaves this for the next start to find.
  const marker = markerPath(path, keptAt);
  try {
    writeMarker(marker, {
      frondEar: "store-reset-marker",
      version: 1,
      at: now,
      atIso: new Date(now).toISOString(),
      store: path,
      keptAt,
      moving: suffixes.map((suffix) => `${keptAt}${suffix}`),
      error,
    });
  } catch (cause) {
    throw new StoreSetAsideError(
      path,
      `${marker} (the reset marker, written before anything moves)`,
      error,
      cause,
      [],
    );
  }
  const moved: string[] = [];
  for (const suffix of suffixes) {
    const from = `${path}${suffix}`;
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

function taken(path: string, keptAt: string): boolean {
  const marker = markerPath(path, keptAt);
  return (
    [...SIDECARS, ""].some((suffix) => existsSync(`${keptAt}${suffix}`)) ||
    existsSync(marker) ||
    existsSync(recordedPath(marker))
  );
}

const MARKER_SUFFIX = ".json";
const RECORDED_SUFFIX = ".recorded.json";

/** `<db>.corrupt-<stamp>` → `<db>.reset-<stamp>.json`, beside it. */
function markerPath(path: string, keptAt: string): string {
  return `${path}.reset-${keptAt.slice(`${path}.corrupt-`.length)}${MARKER_SUFFIX}`;
}

function recordedPath(marker: string): string {
  return `${marker.slice(0, -MARKER_SUFFIX.length)}${RECORDED_SUFFIX}`;
}

/**
 * fsync errors that mean the file system can't sync a directory at all, as opposed to a
 * sync that failed (EIO and the rest), which refuses (🌫's review of 4723d24).
 */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

/**
 * Written whole, read back whole and synced, file and directory, before the first
 * rename; never overwrites. Throws if any of that fails, so nothing moves: a short write
 * (writeSync returns fewer bytes than asked, as under a file-size limit) is written on
 * from where it stopped, and one that makes no progress or reads back different throws.
 */
function writeMarker(marker: string, content: ResetMarker): void {
  const bytes = Buffer.from(`${JSON.stringify(content, null, 2)}\n`, "utf8");
  const fd = openSync(marker, "wx", 0o600);
  try {
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (written <= 0) {
        throw new Error(
          `the reset marker took ${offset} of ${bytes.length} bytes, then none`,
        );
      }
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const back = readFileSync(marker);
  if (!back.equals(bytes) || readMarker(marker) === undefined) {
    throw new Error(
      `the reset marker reads back ${back.length} bytes, not the ${bytes.length} written`,
    );
  }
  if (process.platform === "win32") {
    return; // A directory can't be opened to sync there; the file itself is synced.
  }
  const directory = openSync(dirname(marker), "r");
  try {
    fsyncSync(directory);
  } catch (error) {
    if (
      !DIRECTORY_SYNC_UNSUPPORTED.has(
        String((error as { code?: unknown }).code),
      )
    ) {
      throw error;
    }
  } finally {
    closeSync(directory);
  }
}

/**
 * Every reset marker beside the store at `path` that no store has recorded yet, oldest
 * first. A marker that doesn't parse whole was cut off as it was written, before
 * anything moved, so the store it names was found again where it was: it is skipped.
 * So is one whose quarantine holds no file at all (its set-aside moved nothing). Where
 * the store went is read from the marker's own name, beside the store as it is now.
 */
export function pendingResets(path: string): PendingReset[] {
  const directory = dirname(path);
  const prefix = `${basename(path)}.reset-`;
  const pending: PendingReset[] = [];
  for (const name of readdirSync(directory)) {
    if (
      !name.startsWith(prefix) ||
      !name.endsWith(MARKER_SUFFIX) ||
      name.endsWith(RECORDED_SUFFIX)
    ) {
      continue;
    }
    const marker = join(directory, name);
    const content = readMarker(marker);
    if (content === undefined) {
      continue;
    }
    const keptAt = `${path}.corrupt-${name.slice(prefix.length, -MARKER_SUFFIX.length)}`;
    const moved = [...SIDECARS, ""]
      .map((suffix) => `${keptAt}${suffix}`)
      .filter((file) => existsSync(file));
    if (moved.length === 0) {
      continue;
    }
    pending.push({
      marker,
      reset: { at: content.at, keptAt, moved, error: content.error },
    });
  }
  return pending.sort((a, b) => a.reset.at - b.reset.at);
}

function readMarker(marker: string): ResetMarker | undefined {
  try {
    const content = JSON.parse(readFileSync(marker, "utf8")) as Partial<
      Record<keyof ResetMarker, unknown>
    >;
    if (
      content.frondEar !== "store-reset-marker" ||
      content.version !== 1 ||
      typeof content.at !== "number" ||
      !Number.isFinite(content.at) ||
      typeof content.error !== "string"
    ) {
      return undefined;
    }
    return content as ResetMarker;
  } catch {
    return undefined;
  }
}

/**
 * The live store holds the reset now: the marker is kept, renamed, so it is never read
 * again (clearing the record clears the report) and nothing is deleted. Best effort: a
 * marker left pending is found again and matched to the record by where the store went.
 */
export function markRecorded(marker: string): void {
  try {
    renameSync(marker, recordedPath(marker));
  } catch {
    // Matched to its record on the next start instead.
  }
}
