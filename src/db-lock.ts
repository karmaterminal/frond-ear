import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

export interface DatabaseLock {
  readonly path: string;
  release(): void;
}

/**
 * One daemon per database (figs's 11-26 review, F1). The socket guard in listenUnix
 * runs only after the store has migrated, pruned and repaired, and it is keyed to the
 * socket, so a second daemon on another socket (or on the same one) wrote to a live
 * daemon's database before it refused, or never refused at all.
 *
 * The lock is SQLite's own POSIX advisory lock (fcntl) on a sidecar file next to the
 * database, held by an open connection inside an exclusive transaction for as long as
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
  const lockPath = databaseLockPath(databasePath);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
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
    release(): void {
      if (held.delete(connection)) {
        connection.close();
      }
    },
  };
}
