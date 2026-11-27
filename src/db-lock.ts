import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** SQLITE_BUSY and SQLITE_LOCKED: someone else holds the lock. */
const HELD_ERRCODES = new Set([5, 6]);

/** Held connections stay reachable, so garbage collection can never close one. */
const held = new Set<DatabaseSync>();

/** The sidecar a daemon locks for the lifetime of its process. */
export function databaseLockPath(databasePath: string): string {
  return `${databasePath}.lock`;
}

export class DatabaseHeldError extends Error {
  public constructor(databasePath: string, lockPath: string) {
    super(
      `another frond-ear daemon already holds the database ${databasePath} ` +
        `(lock ${lockPath}); refusing to start, nothing was written`,
    );
    this.name = "DatabaseHeldError";
  }
}

/**
 * A database file with more than one name (a hard link). SQLite names a database's
 * -wal, -shm and -journal by the path it was opened by, so two names for one inode get
 * two WALs: each name reads a different ledger, and either can corrupt the other. A lock
 * can't make that safe, so the daemon refuses before it opens anything.
 */
export class DatabaseLinkedError extends Error {
  public constructor(databasePath: string, real: string, links: number) {
    super(
      `the database ${databasePath}${real === databasePath ? "" : ` (${real})`} has ${links} hard links; ` +
        `SQLite keeps a WAL per name, so another name for the same file is another ledger. ` +
        `Give the daemon a database with one name; refusing to start, nothing was written`,
    );
    this.name = "DatabaseLinkedError";
  }
}

export interface DatabaseLock {
  /** The sidecar locked, beside the database's real path. */
  readonly path: string;
  /** The database's real path: every name for it resolves here. Open the store at it. */
  readonly database: string;
  release(): void;
}

/**
 * The real path of `databasePath`, the same for every symlinked spelling of it (a
 * symlink to the file, or to a directory on the way). A database not created yet is its
 * directory's real path and its own name; a dangling symlink is followed to the file
 * SQLite would create through it. The directory is made if missing, as the store does.
 */
export function canonicalDatabasePath(databasePath: string): string {
  let path = resolve(databasePath);
  for (let hops = 0; hops <= 40; hops++) {
    try {
      return realpathSync(path);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") {
        throw error;
      }
    }
    let link: string | undefined;
    try {
      if (lstatSync(path).isSymbolicLink()) {
        link = readlinkSync(path);
      }
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") {
        throw error;
      }
    }
    if (link === undefined) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      return join(realpathSync(dirname(path)), basename(path));
    }
    path = resolve(dirname(path), link);
  }
  throw new Error(
    `the database path ${databasePath} has too many symlinks; refusing to start, nothing was written`,
  );
}

/**
 * One daemon per database (figs's 11-26 review, F1). The socket guard in listenUnix
 * runs only after the store has migrated, pruned and repaired, and it is keyed to the
 * socket, so a second daemon on another socket (or on the same one) wrote to a live
 * daemon's database before it refused, or never refused at all.
 *
 * The lock is SQLite's own POSIX advisory lock (fcntl) on a sidecar file next to the
 * database's real path (every symlinked name for it finds the same one), held by an open connection inside an exclusive transaction for as long as
 * the process lives. It is keyed to the sidecar's inode, so a symlinked or
 * bind-mounted path to the same directory finds the same lock, across network
 * namespaces and containers that share the volume. The kernel releases it when the
 * process exits, however it exits, so a crash never leaves a stale lock that blocks a
 * restart. The sidecar holds no data (journal_mode=MEMORY: no -journal file appears).
 *
 * Call it before anything opens the database. Throws DatabaseHeldError when another
 * process holds the lock, having written nothing (it may create the empty sidecar
 * only when there was none, and with it the database's directory).
 */
export function lockDatabase(databasePath: string): DatabaseLock | undefined {
  if (databasePath === ":memory:") {
    return undefined;
  }
  // Keyed to the database's real path, never to the spelling it was given (🌫's and 🕯's
  // review: a symlink to the file took its own lock). A hard link has no real path to
  // find, and is unsafe for SQLite whatever the lock, so it is refused first.
  const database = canonicalDatabasePath(databasePath);
  const links = statSync(database, { throwIfNoEntry: false })?.nlink ?? 1;
  if (links > 1) {
    throw new DatabaseLinkedError(databasePath, database, links);
  }
  const lockPath = databaseLockPath(database);
  const connection = new DatabaseSync(lockPath); // busy timeout 0: refuse at once
  try {
    connection.exec("PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE");
  } catch (error) {
    connection.close();
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number" && HELD_ERRCODES.has(errcode)) {
      throw new DatabaseHeldError(databasePath, lockPath);
    }
    throw error;
  }
  held.add(connection);
  return {
    path: lockPath,
    database,
    release(): void {
      if (held.delete(connection)) {
        connection.close();
      }
    },
  };
}
