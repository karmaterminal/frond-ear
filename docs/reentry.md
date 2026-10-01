# Identity binding and re-entry

This is the design for karmaterminal/frond-ear#21: _delivery should find the live scribe session by
identity, and a scribe session should survive restarts without hand work_. The goal, in figs's
words: you don't have to do crazy shit to have it work.

## The model

An ear belongs to one Claude Code **session**, named by its session id. It does not belong to the
last process that spawned a shim. The binding is a row in the daemon's SQLite database, next to the
ledger, so it survives daemon restarts and reboots.

| Who connects                                                   | What happens                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| The owner session (same id), any number of times               | Attaches. A newer shim of the same session supersedes the older    |
| The first session with an id, when the ear is unbound          | Claims the ear, then attaches                                      |
| Any other session                                              | **Standby**: read-only tools, a notice saying whose ear it is      |
| A shim with no session id                                      | Standby. It never claims the ear                                   |
| A process resuming the owner's id, while the owner is not live | Attaches, and the binding follows it (see "Resume under a new id") |

Taking the ear from its owner is always explicit: `frond-ear bind --ear <ear> --session <id>`, or
the same command run from inside the new session without `--session` (it reads
`CLAUDE_CODE_SESSION_ID`). If the new session's shim is already connected in standby, it attaches
at once, and the old owner is told `rebound to session <id>`. `frond-ear bind --release` unbinds the
ear, and the next session to attach claims it.

A standby session hears nothing pushed. It can call `inbox`, `fetch_messages` and `ear_status`.
`reply`, `react`, `edit_message`, `ack` and `set_attention` are refused, so a stray session cannot
speak as the ear. Its MCP instructions say it is not the owner, instead of telling it that it is.

## Requirements

| #21 | How it is met                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | The binding table, standby, and `bind`. `claude mcp list`, a second terminal, a `-p` run and a subagent each carry a different session id or none, so none of them can take the ear.                                                             |
| R2  | `frond-ear status` shows, per ear: `binding` (session, cwd, source), `attached`, the shim pid, the Claude pid, and `standby` (the count of other sessions waiting). "None" is `attached: false`. The daemon never guesses a session.             |
| R3  | The shim reads the Claude process's command line. Without the channel flag, `delivery` is `unconfirmed` at once, not after the 2-minute canary grace. The `SessionStart` hook tells the session at every start, resume, `/clear` and compaction. |
| R4  | Because a stray session can't take the ear, frond-ear can be registered at **user** scope. The ear no longer depends on the directory a session starts in. The binding records the session's cwd for `--resume`, which needs it.                 |
| R5  | `frond-ear rez --ear <ear>`, run by `ops/install-rez.sh`'s oneshot unit and timer. It resumes the bound session with the flag in tmux session `frond-<ear>`. It is a no-op while the session is live, and it refuses to start a second copy.     |
| R6  | Unchanged. Standby shims are never offered batches. What arrives with no owner attached waits in the ledger and is delivered once, in order, when the owner comes back. There are tests for this across a restart with a stray present.          |
| R7  | `FROND_EAR_INSTANCE=<name>` gives a daemon its own socket, database and default config path. The installers derive unit names and directories from it.                                                                                           |

### Re-entry paths

| Path                                                          | What frond-ear sees                                   | Result                                                                                                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon restart                                                | The owner's shim reconnects with the same id          | Reattaches, with a digest of what was offered but not acted on                                                                                                                                       |
| Session crash, reboot                                         | Nothing until `rez` resumes the session with the flag | Reattaches                                                                                                                                                                                           |
| `/mcp` reconnect                                              | A new shim, same id                                   | It supersedes the old shim                                                                                                                                                                           |
| Compaction                                                    | The same process and shim                             | The hook reminds the session that `inbox` holds anything it has not acted on                                                                                                                         |
| `/clear`                                                      | The same process, a new session id                    | The hook reports the new id with the Claude pid. It matches the pid the attached shim reported, so the binding moves. That process's shim still carries the old id; it is recognised by the same pid |
| `--resume` handing out a new id                               | A shim whose Claude argv is `--resume <owner id>`     | Attaches and rebinds, but only while the owner is not live                                                                                                                                           |
| Someone else's `--resume <owner id>`, while the owner is live | The same                                              | Standby                                                                                                                                                                                              |

A clean re-entry and a hostile takeover no longer look the same:

- A re-entry carries the owner's id, or proves continuity: the `/clear` pid match, or a resume while
  the owner is down.
- A takeover needs `bind`.

## Open questions from #21

**Can the development-channels flag be avoided?** No, not for a custom channel today. The channels
docs require `--dangerously-load-development-channels` for anything outside the approved list. A
plugin's `channels` entry only changes the form to `--channels plugin:<p>@<marketplace>`. Nothing
makes the flag persistent: no setting, env var, or `--resume` memory. So the flag lives in one
place, `rez`. frond-ear also detects the flag's absence at attach, so a deaf session is caught
immediately instead of by silence.

**Can Claude Code's own session registry serve R2?** Not as a delivery path, yet. `ListAgents` and
`SendMessage` are tools Claude calls. Messages travel over a per-session socket
(`CLAUDE_CODE_MESSAGING_SOCKET`, exported to hooks and Bash). There is no documented API for an
outside process to deliver into a named session, so nothing here is designed around it. frond-ear
answers R2 itself, from its own binding and the Claude pid the shim reports.

**Where does identity → session id live?** In the daemon's SQLite database (`bindings`):

- It is durable across reboots and not secret.
- It is readable through `frond-ear status`, which is what `rez` uses.
- One source of truth, next to the ledger it governs, avoids a second state file drifting.

**What does intended takeover look like?** One explicit command, `frond-ear bind`. There is no
lease expiry: an owner that is down keeps the ear, and `rez` brings it back. Expiring the lease
would hand the ear to whichever stray came next, which is the failure #21 is about.

## What only a live run can confirm

These are recorded in the #6 checklist:

1. **Session id on resume.** `CLAUDE_CODE_SESSION_ID` is the same after `claude --resume <id>`.
   The resume rule covers it if not.
2. **`/clear` hand-off.** After `/clear`, the `SessionStart` hook receives the new id and the shim
   keeps running.
3. **Flag detection.** The shim's parent chain reaches the Claude process, and its argv shows the
   flag, for both the native binary and the npm install.
4. **The channel dialog.** The exact text of the development-channel confirmation. `rez` answers it
   only when the pane says "development channel" and the highlighted choice is an accepting one;
   otherwise it leaves it for a human, and says so.
5. **Permission mode on resume.** A resumed session came back in auto mode despite
   `permissions.defaultMode: bypassPermissions`, behind a "make auto mode your default?" prompt
   (#21, 2026-09-27). `rez` now passes `--permission-mode` explicitly: the `--permission-mode`
   given to it, else the `defaultMode` the session's settings name (local project, project, user),
   else none. Still to see on a real seat: that the explicit mode suppresses that prompt, and that
   `bypassPermissions` raises no acceptance dialog on a seat that has already accepted it. `rez`
   answers neither; a session stuck there shows up as exit 5.
   A seat with its own `CLAUDE_CONFIG_DIR` or launcher resumes through it: `CLAUDE_CONFIG_DIR` in
   the unit, or `rez --launcher <script>`, which runs in place of `claude` with the same arguments.
6. **tmux under systemd.** tmux started by the rez oneshot (`KillMode=process`) survives the unit
   finishing, and the resumed session inherits a usable environment. The unit sets `PATH`, and
   `claude` finds its credentials under `$HOME`.

## Not in scope

This PR leaves these unchanged:

- trust classification, attention (#17), and ledger semantics;
- Copilot parity (#13). Nothing here is Claude-specific except launch detection and `rez`'s
  command line.
