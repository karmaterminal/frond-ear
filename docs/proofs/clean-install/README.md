# Clean-install proof records

These are recorded runs of `tools/clean-install/receipt.sh` (#70). Each run installs frond-ear the
way a stranger would, in a disposable root with a fresh HOME and an emptied environment, against a
loopback stand-in for Discord and a real Claude Code session. The steps are described in
[`tools/clean-install/README.md`](../../../tools/clean-install/README.md).

Each directory is named after the commit under test and holds `transcript.md`, exactly as the
harness wrote it (Prettier leaves these files alone).

## Runs

Both runs used the harness at `92e9c43`, Node 22.22.0 and Claude Code 2.1.296.

| Commit under test                                                                                    | Product code              | Result                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`42f7f67e3ed6813fdf552a5bf10bf17acc8370b7`](42f7f67e3ed6813fdf552a5bf10bf17acc8370b7/transcript.md) | `main` before the #70 fix | Install, doctor, daemon and one reply pass. The attach canary is lost, and so is a message held while away. |
| [`92e9c43d2d9dc05d61a68cf537a794e1ecfd4e9a`](92e9c43d2d9dc05d61a68cf537a794e1ecfd4e9a/transcript.md) | the #70 fix               | Every step passes.                                                                                          |

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
- **At `92e9c43`, the shim holds events for 2 s after `notifications/initialized`.** Each notification
  arrives about 2 s after Claude Code's `Channel notifications registered` line. The session acks the
  canary, `doctor` passes all 10 checks, and the waiting message is answered once the session is back.
- **Teardown leaves nothing running.** The disposable root is deleted, and the caller's own frond-ear
  config and Claude Code registrations are the same before and after.

## Limits

- **Discord is a stand-in.** It checks the token, the intents and REST authorization. It does not
  model rate limits, permissions or the rest of the real Gateway's behavior.
- **Claude Code's login came from the hosted container.** The `claude` binary there finds it without
  HOME or any variable. A workstation run needs a login in the disposable HOME (see the harness
  README).
- **Isolation is by environment and HOME, not by permissions.** The harness runs as the caller's own
  user.
- **This is not the cold restart, resume or reboot receipt** (#70 item 5). The session leaves and comes
  back while the daemon keeps running.
