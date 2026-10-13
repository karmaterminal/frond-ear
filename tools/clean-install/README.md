# Clean-install receipt

`receipt.sh` installs frond-ear the way a stranger would and records every command, its output and
its exit status in a Markdown transcript. It was written for #70, the release gate's clean-install
check (#35). It works in a disposable root:

- HOME is a fresh directory;
- every command runs under `env -i`, with only the variables the transcript lists: no GitHub
  token, no git or gh config, no proxy, no frond-ear or Claude Code config;
- the bot token is a synthetic one, written by a stand-in `$EDITOR`;
- Discord is a loopback stand-in (`fake-discord.ts`), so no real bot, channel or prince takes part.

The one real outside party is Claude Code: a real `claude` session attaches the ear, acks the
attach canary and answers a message.

## What it runs

| Step          | What it proves                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isolation`   | What the environment holds, and what GitHub answers without credentials                                                                            |
| `fetch`       | The README's clone line, as written. While the repository is private it fails, and a bundle of the commit under test stands in                     |
| `init`        | The person writes the 0600 token file; `init --non-interactive` writes the config                                                                  |
| `doctor-pre`  | Failure and repair: `doctor` without, then with, the two `export` lines                                                                            |
| `daemon-fail` | Failure and repair: Discord refuses the Message Content Intent (close 4014), the daemon exits 1, and `doctor` says so                              |
| `daemon`      | The daemon, started exactly as `init` printed it, connects                                                                                         |
| `doctor-post` | Every required check passes                                                                                                                        |
| `register`    | `claude mcp add`, exactly as `init` printed it, and the tool allow rule                                                                            |
| `wrong-ear`   | Failure: a registration that names an ear the config does not have                                                                                 |
| `launch`      | Claude Code with the channel flag; the harness answers its startup prompts as a person would                                                       |
| `canary`      | The session acks the attach canary: `attached` and `registered` are both true, and `doctor` passes                                                 |
| `event`       | One inbound mention reaches the session and one reply reaches Discord                                                                              |
| `away`        | The session leaves, a message arrives, and the session comes back (`--continue`): it gets the canary and the message. Not a cold restart or resume |
| `teardown`    | The session exits, the registration is removed, the daemon stops on SIGTERM, nothing is left running, and the root is deleted                      |

## Run it

It needs Node ≥ 22.18, `pnpm install` in this checkout (the stand-in uses `ws`), and `git`, `tmux`,
`curl` and `claude` on PATH.

```sh
PIN=$(git rev-parse HEAD) tools/clean-install/receipt.sh all
```

`PIN` is the commit under test (the default is this checkout's HEAD). The receipt lands in
`${FE_RECEIPT:-${TMPDIR:-/tmp}/frond-ear-receipt}/receipt/`: `transcript.md`, whose teardown
section quotes Claude Code's own log of the shim's MCP traffic, and the daemon and stand-in logs.
The next `setup` deletes it, so copy it out first. The script sources a state file from that
workspace and deletes directories in it, so it refuses one that is not yours, that others can
write, or that holds files `setup` did not make. `all` tears everything down, even when a step
fails; `KEEP=1` leaves a failed run up to look at, and `receipt.sh screen` prints the session's
pane.

A step passes on what the person asked for, not on any activity: `event` and `away` each wait
for the one-word answer their message asks for (`pong`, then `backlog`).

**Claude Code's login.** The session needs a working `claude` login, which frond-ear never sees.
Where `claude` is set up outside HOME, as in the hosted container the first records came from, it
starts logged in. Where it keeps its login in HOME, the fresh HOME has none: `launch` then stops,
leaves everything up, and prints how to attach to the pane, log in, and go on with
`receipt.sh all launch`. That path has not been run yet.

## Records

`docs/proofs/clean-install/` holds the transcripts, named after the commit under test.
