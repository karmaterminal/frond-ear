// The PreCompact hook's watchdog (#108 F2): how a killable worker's ending maps to
// what the hook tells Claude Code. Kept apart from cli.ts so tests can import it.

/**
 * What the hook says, given how its worker ended (#108 F2). Only a worker that
 * exited by itself with 2 blocks, and then stdout stays empty; only one that exited
 * with 0 has its stdout (the letters) passed on. Anything else allows, silently.
 */
export function watchdogOutcome(ended: {
  code: number | null;
  signal: string | null;
  overflow: boolean;
  out: string;
  err: string;
}): { code: 0 | 2; stdout: string; stderr: string } {
  if (ended.overflow || ended.signal !== null) {
    return {
      code: 0,
      stdout: "",
      stderr: `frond-ear precompact: the hook's worker ${ended.overflow ? "printed too much" : `ended on ${ended.signal}`}; the compaction goes ahead\n`,
    };
  }
  if (ended.code === 2) {
    return { code: 2, stdout: "", stderr: ended.err };
  }
  if (ended.code === 0) {
    return { code: 0, stdout: ended.out, stderr: ended.err };
  }
  return { code: 0, stdout: "", stderr: ended.err };
}
