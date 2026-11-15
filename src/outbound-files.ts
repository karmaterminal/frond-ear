// Files a reply carries to Discord (frond-ear#99). The daemon reads them, so it decides
// what may leave this host: only regular files under one of the ear's configured roots
// (`ears.<name>.sendFileRoots`), never through a dot-named directory or file below a
// root, never the daemon's own config, database or token, within one size budget per
// reply. Every check happens before anything is posted, so a refused file posts nothing.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";

/** Discord accepts at most 10 attachments on one message. */
export const MAX_FILES_PER_REPLY = 10;

export interface OutboundFile {
  name: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface OutboundFilePolicy {
  /** The ear whose roots apply, for error messages. */
  ear: string;
  /** Absolute directories files must resolve under. Empty: sending files is off. */
  roots: readonly string[];
  /** Total bytes one reply may carry, across all its files. */
  maxBytes: number;
  /** Paths that never leave, whatever the roots (the daemon's config, database, token). */
  protectedPaths: readonly string[];
}

function inside(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
  );
}

async function resolved(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** Parses the tool's `files` argument: absent, or 1 to 10 absolute paths. */
export function filesArg(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("files must be an array of absolute paths");
  }
  if (value.length > MAX_FILES_PER_REPLY) {
    throw new Error(
      `files: at most ${MAX_FILES_PER_REPLY} per reply (got ${value.length})`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry === "") {
      throw new Error(`files[${index}] must be a non-empty string`);
    }
    if (!isAbsolute(entry)) {
      throw new Error(`files[${index}] must be an absolute path: ${entry}`);
    }
    return entry;
  });
}

/**
 * Reads every file or refuses the whole set. The path is resolved (symlinks followed)
 * before the root check, and the resolved path is what gets opened, with O_NOFOLLOW, so
 * a link cannot point the read outside the roots.
 */
export async function loadOutboundFiles(
  paths: readonly string[],
  policy: OutboundFilePolicy,
): Promise<OutboundFile[]> {
  if (paths.length === 0) {
    return [];
  }
  if (policy.roots.length === 0) {
    throw new Error(
      `sending files is off for ear ${policy.ear}: set ears.${policy.ear}.sendFileRoots in the daemon config`,
    );
  }
  const roots = (
    await Promise.all(policy.roots.map((root) => resolved(root)))
  ).filter((root): root is string => root !== undefined);
  // Checked after resolution: a root that is, or links to, `/` would allow every
  // file on the host. Fail closed for the whole reply rather than skip the root.
  if (roots.some((root) => root === sep)) {
    throw new Error(
      `ears.${policy.ear}.sendFileRoots has a root that resolves to /; refusing to send files`,
    );
  }
  const guarded = (
    await Promise.all(policy.protectedPaths.map((path) => resolved(path)))
  ).filter((path): path is string => path !== undefined);
  const files: OutboundFile[] = [];
  let total = 0;
  for (const path of paths) {
    const real = await resolved(path);
    if (!real) {
      throw new Error(`file not found: ${path}`);
    }
    const root = roots.find((candidate) => inside(real, candidate));
    if (!root) {
      throw new Error(
        `${path} is not under any of ears.${policy.ear}.sendFileRoots`,
      );
    }
    const below = relative(root, real);
    if (below.split(sep).some((part) => part.startsWith("."))) {
      throw new Error(
        `${path} is in or is a dot-named file or directory below its root; those are never sent`,
      );
    }
    if (guarded.some((protectedPath) => inside(real, protectedPath))) {
      throw new Error(`${path} is part of frond-ear's own state; never sent`);
    }
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error(`${path} is not a regular file`);
      }
      total += stat.size;
      if (total > policy.maxBytes) {
        throw new Error(
          `files total more than ${policy.maxBytes} bytes (limits.maxSendFileBytes)`,
        );
      }
      const buffer = Buffer.alloc(stat.size);
      let read = 0;
      while (read < stat.size) {
        const { bytesRead } = await handle.read(
          buffer,
          read,
          stat.size - read,
          read,
        );
        if (bytesRead === 0) {
          break;
        }
        read += bytesRead;
      }
      if (read !== stat.size) {
        throw new Error(`${path} changed size while it was read`);
      }
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, read);
      files.push({
        name: basename(path),
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } finally {
      await handle.close();
    }
  }
  return files;
}
