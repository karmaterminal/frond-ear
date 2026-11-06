import { realpathSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/**
 * Calls `onChange` whenever the config file at `path` may have changed, and keeps
 * doing so after the file is replaced.
 *
 * A watch on the file itself is tied to its inode: an atomic replace (temp file
 * renamed over the path, as `os.replace`, `sed -i` and most safe-write editors do)
 * fires once, and every later edit lands on a new inode the watch never sees
 * (frond-ear#89). So this watches the directory and filters on the name. When the
 * path is a symlink, the target's directory is watched too, as the file watch used
 * to follow the link.
 */
export function watchConfigFile(
  path: string,
  onChange: () => void,
): { close(): void } {
  const watched = new Map<string, Set<string>>();
  const add = (file: string) => {
    const names = watched.get(dirname(file)) ?? new Set<string>();
    watched.set(dirname(file), names.add(basename(file)));
  };
  add(resolve(path));
  try {
    add(realpathSync(path));
  } catch {
    // A missing file is reported when the daemon loads it, not here.
  }
  const watchers: FSWatcher[] = [];
  for (const [directory, names] of watched) {
    watchers.push(
      watch(directory, (_event, filename) => {
        // Some platforms give no filename; then any change in the directory counts.
        if (filename === null || names.has(filename.toString())) {
          onChange();
        }
      }),
    );
  }
  return {
    close() {
      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}
