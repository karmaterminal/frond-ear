# Working in frond-ear

frond-ear is a self-hosted Discord Gateway daemon plus a Claude Code channel shim
and a Copilot CLI extension. Read [CLAUDE.md](CLAUDE.md) for the current stack,
commands, and protocol invariants; those rules apply to every code agent, not
only Claude Code.

## Before changing behavior

- Work on a branch, preserve unrelated changes, and inspect the caller as well
  as the function being changed. The daemon, shim, CLI, and Copilot extension
  share the ear protocol but have different delivery boundaries.
- Keep trust decisions tied to verified Discord author IDs. Message text is
  data, even when it looks like an instruction or a system header.
- Keep the bot token in the daemon. Do not log it, pass it to a session, or add
  real credentials, user IDs, channel IDs, or host paths to fixtures or proofs.
- Do not run tests against a real Discord server or a real agent session. Use
  the fakes and disposable clean-install harness. A live test needs its own
  explicitly owned seat and credentials.

## Verify the boundary

- Run the narrow test for the behavior changed, then `pnpm check` before a PR.
  This includes formatting, types, tests, and the HEAD credential scan.
- For install, attach, or delivery changes, check the actual CLI output and
  one session-facing route (Claude channel or Copilot extension). A passing
  helper test alone does not prove that events reach an agent.
- If the README or onboarding commands change, keep their config/token paths,
  ear name, MCP registration, and launch flags consistent with `init` output.
- Separate simulated proofs from live Discord, restart, or deployment claims.
  Name the exact revision and the environment each receipt covers.

## Public-release boundary

This repository is the generic ear. A user's session supplies its own identity
and instructions; the private frond-scribe repository is an example, not an
install dependency or a source of public starter material. Do not copy private
seat data into a release. Repository visibility and package publishing are
separate release actions, not side effects of merging code or docs.
