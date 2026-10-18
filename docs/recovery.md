# Recovery

The question this answers: _the session is gone, the box rebooted — how does the ear come back?_

Recovery is tiered. Most of the time the answer is "it already did", and the useful skill is
knowing which tier you are actually in before you start reinstalling things.

## What is durable, and what is not

| Thing                       | Where it lives                                                           | Survives a reboot?                                                               |
| --------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Held and delivered messages | `$XDG_STATE_HOME/frond-ear/frond-ear.db`                                 | yes                                                                              |
| Messages sent while down    | Discord: replayed on a Gateway resume, or read back from channel history | yes, up to `limits.catchUpMessages` per chat when the outage outlasts the resume |
| The daemon process          | systemd `--user` unit                                                    | yes, if installed and linger is on                                               |
| Config                      | `~/.config/frond-ear/frond-ear.json`                                     | yes, but it is yours to back up                                                  |
| Bot token                   | `~/.config/frond-ear/token` (0600)                                       | yes, but it is yours to back up                                                  |
| The socket                  | `$XDG_RUNTIME_DIR/frond-ear/daemon.sock`                                 | no, and it should not — it is recreated                                          |
| The attached Claude session | the session itself                                                       | **no** — always a deliberate relaunch                                            |

Two consequences worth internalising. First, the queue outlives the daemon: stopping the service
does not drop what the ear is holding for you, and neither does a reboot. What reached Discord
while the daemon was down is different: Discord replays it when the daemon resumes its Gateway
session, which Discord allows for a few minutes after the connection ends. After a longer outage
Discord refuses the resume (op 9), so the daemon identifies afresh and reads each chat's history
back from the last message it heard there. It reads one page per chat: the newest
`limits.catchUpMessages` messages (50 by default), in the `limits.catchUpChats` most recently
active chats (25). What it reads back is held and delivered like any message heard live. A
`catch_up` event tells the session what was read back, and where older messages may still be
missing, with the `fetch_messages` call that reads them. Only chats the ear had already heard
are read back: a thread created, or a DM first opened, while the daemon was down is not. Second,
nothing can reattach your Claude session for you, because the development-channel flag is only
read at launch. Every tier below ends at the same last step.

## Tier 1 — the box rebooted

Nothing to do, if the unit is installed and lingering is on. Confirm rather than assume:

```sh
systemctl --user is-active frond-ear.service        # active
node src/cli.ts status | grep -o '"state":"[a-z-]*"' # "connected"
loginctl show-user "$USER" --property=Linger        # Linger=yes
```

`Linger=no` is the failure that looks like a reboot problem: user units wait for a login, so the
ear stays down until someone opens a terminal. `loginctl enable-linger $USER` fixes it for good.

## Tier 2 — the daemon is down or wedged

```sh
systemctl --user restart frond-ear.service
journalctl --user -u frond-ear.service -n 50
```

Close code `4004` is a bad token, `4014` is Message Content Intent switched off. Neither is fixed
by restarting. A restart preserves the queue, so it is cheap to try first for anything else.

## Tier 3 — the checkout is gone

The daemon has **no runtime dependencies**, so this needs a clone and a node binary, nothing else.
`pnpm install` is only for running the tests.

```sh
git clone https://github.com/karmaterminal/frond-ear && cd frond-ear
ops/install-systemd.sh
```

The script refuses to install against a missing config or an empty token, and tells you where it
looked. It also rejects a relative node path, because systemd runs with no login shell and a
version-manager shim on `PATH` will not resolve at boot.

## Tier 4 — home is gone

Everything above assumes `~/.config/frond-ear` survived. If it did not, you need two things back:

1. **The config.** Reproducible from `frond-ear.example.json` plus the IDs — your bot, your
   principals, your peer agents, your channels. Keep those written down somewhere that is not this
   machine; they are not secret, and losing them costs more time than losing the token.
2. **The bot token.** From your credential store, or reset it in the Discord developer portal.

If your credential store is itself reachable only with a credential kept in home, you have a
bootstrap loop and recovery needs a human. That is worth discovering deliberately now rather than
during an outage: try fetching your own token on a machine that has never seen your home directory.

## Tier 5 — the session is gone

The ear keeps ingesting while nothing is attached; that is the point of it. Whatever arrived while
you were away is delivered on reattach, and anything already delivered but never acted on arrives
as one digest rather than a replay.

```sh
cd <the session's working directory>
claude --resume <session id> --dangerously-load-development-channels server:frond-ear
```

If `attachCanary` is on, the session is asked to `ack` a nonce as it attaches, and
`node src/cli.ts status` then shows `"attached": true, "registered": true`. Check it. A channel
that failed to register is silent in exactly the same way as a quiet room.
