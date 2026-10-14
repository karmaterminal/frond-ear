# Clean-install proof records

These are recorded runs of `tools/clean-install/receipt.sh` (#70). Each run installs frond-ear the
way a stranger would, in a disposable root with a fresh HOME and an emptied environment, against a
loopback stand-in for Discord and a real Claude Code session. The steps are described in
[`tools/clean-install/README.md`](../../../tools/clean-install/README.md).

Each directory is named after the commit under test and holds `transcript.md`, exactly as the
harness wrote it (Prettier leaves these files alone).

## Runs

Every run used Node 22.22.0. The first two used Claude Code 2.1.296, the last two 2.1.299.

| Commit under test                                                                                    | Product code              | Harness                                  | Result                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`42f7f67e3ed6813fdf552a5bf10bf17acc8370b7`](42f7f67e3ed6813fdf552a5bf10bf17acc8370b7/transcript.md) | `main` before the #70 fix | `92e9c43`, one step at a time, `WAIT=90` | Install, doctor, daemon and one reply pass. The attach canary is lost, and so is a message held while away. |
| [`706a168cd646b6ebcc7ed458cd29a50aa0c9c310`](706a168cd646b6ebcc7ed458cd29a50aa0c9c310/transcript.md) | the #70 fix               | `706a168`, `receipt.sh all`              | Every step passes.                                                                                          |
| [`0e51f41df25ca4cb34dc11ba4eed4dcb7a49a202`](0e51f41df25ca4cb34dc11ba4eed4dcb7a49a202/transcript.md) | `main` after #71          | `43d996c`, `receipt.sh all`, `WAIT=60`   | Every step through `away` passes. `reboot` loses the message sent while the host was down.                  |
| [`43d996c138eb293b633b0f93f14cf56f2cd5fe4c`](43d996c138eb293b633b0f93f14cf56f2cd5fe4c/transcript.md) | the stop fix              | `43d996c`, `receipt.sh all`              | Every step passes. `cold-expired` records that the message sent while the host was down is lost.            |

The first run went step by step (`receipt.sh STEP` for each step in order), so it carried on past
its failed `canary` and `away` steps, where `all` would have stopped and torn down. The run at
`0e51f41` used `all`, so it tore down after its failed `reboot` step and never ran `cold` or
`cold-expired`.

## What they show

- **The install itself works unauthenticated.** It needs no GitHub credentials, no `pnpm install`,
  and nothing from another karmaterminal repository. The one exception is the clone: while frond-ear
  is private, a bundle of the commit under test stands in for it.
- **The failures a stranger meets, each with its repair:**
  - `doctor` run before the two `export` lines fails;
  - a bot without the Message Content Intent is refused with close 4014;
  - a registration that names an ear the config lacks hears nothing.
- **At `42f7f67`, Claude Code 2.1.296 loses what the shim sends at attach.** Claude Code's own log
  shows no attach canary, so the ear stays unregistered. The session registered only when it used a
  pushed `batch_id` to answer the first message. The message that waited while the session was away
  then went to `offered`, never reached the model, and was never answered.
- **At `706a168`, the shim holds events for 2 s after `notifications/initialized`.** Each notification
  arrives about 2 s after Claude Code's `Channel notifications registered` line. The session acks the
  canary, `doctor` passes all 10 checks, and the waiting message is answered once the session is back.
- **At `0e51f41`, a daemon that stops ends its own Gateway session.** It closed the connection with
  1000, which tells Discord to invalidate the session: the stand-in's record shows
  `"ended": [{"session": "receipt-session-2", "code": 1000}]`. After the reboot the RESUME was
  refused with op 9, the daemon identified afresh, and the message sent while the host was down
  never reached the ear. It was not in the ledger, and no `rebooted` came within 60 s. A
  `systemctl restart` or an orderly reboot loses whatever is sent while the daemon is down, however
  short the outage.
- **At `43d996c`, the daemon resumes after a reboot and after a power cut.** `stop()` now closes
  with 4000, as the Gateway's two reconnect paths already did. In `reboot` and in `cold`, the
  stand-in accepted the RESUME of the session from before the outage and replayed the message sent
  while the host was down. The ledger held it for the session, `doctor` printed a
  `claude --resume` line with the session's own id, and the resumed session answered it once
  (`rebooted`, then `resumed`).
- **Once Discord has dropped the session, what was sent during the outage is lost.** In
  `cold-expired` the stand-in refuses the RESUME, as Discord does for an expired session. The
  daemon identifies afresh, and frond-ear does not read channel history, so the message never
  reaches the ledger and the session is never told of it. It is still in the channel, where
  `fetch_messages` reads.
- **Claude Code 2.1.299 keeps the 2 s margin.** Across both runs' eight launches, `--continue` and
  `--resume` included, it registered its channel handler 13 to 38 ms after the shim connected, and
  the attach canary arrived 1972 to 1997 ms after that.
- **Teardown leaves nothing running.** The disposable root is deleted, and the caller's own frond-ear
  config and Claude Code registrations are the same before and after.

## Limits

- **Discord is a stand-in.** It checks the token, the intents and REST authorization. With the
  harness at `43d996c` it also follows Discord's session rules: a client close with 1000 or 1001
  ends a session, an accepted RESUME replays what was missed, and a RESUME of a session it has been
  told to forget gets op 9. It does not model how long Discord keeps a session resumable, rate
  limits, permissions or the rest of the real Gateway's behavior.
- **Claude Code's login came from the hosted container.** The `claude` binary there finds it without
  HOME or any variable. A workstation run needs a login in the disposable HOME (see the harness
  README).
- **Isolation is by environment and HOME, not by permissions.** The harness runs as the caller's own
  user.
- **No host is rebooted.** The reboot and the power cut happen inside the disposable root: the
  harness signals the daemon and the session's processes and empties `$XDG_RUNTIME_DIR`, while HOME
  stands for the disk. The kernel, systemd, lingering and the network are not exercised, and the
  harness restarts the daemon the way its unit would. The first two runs have no restart at all:
  their session leaves and comes back while the daemon keeps running.
