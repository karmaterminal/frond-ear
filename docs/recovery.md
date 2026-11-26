# Recovery

The question this answers: _the session is gone, the box rebooted — how does the ear come back?_

Recovery is tiered. Most of the time the answer is "it already did", and the useful skill is
knowing which tier you are actually in before you start reinstalling things.

## What is durable, and what is not

| Thing                             | Where it lives                                                                  | Survives a reboot?                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Held and delivered messages       | `$XDG_STATE_HOME/frond-ear/frond-ear.db`                                        | yes                                                                                                                                                                                                                      |
| Canticle custody                  | the same database: what each session was shown and echoed (BC#161)              | yes; boundary unknown until the hook reports; older push ids no longer echo                                                                                                                                              |
| Room egress, derived publications | the same database: every room output's decision, every derived attempt (BC#161) | yes; an egress row a crash left `pending` becomes `unconfirmed` at startup (an identical retry within 5 minutes settles it), and a derived row left `claimed` is unknown: check the room, or `derivedQuery` the election |
| Messages sent while down          | Discord: replayed on a Gateway resume, or read back from channel history        | yes, up to `limits.catchUpMessages` per chat when the outage outlasts the resume                                                                                                                                         |
| The daemon process                | systemd `--user` unit                                                           | yes, if installed and linger is on                                                                                                                                                                                       |
| Config                            | `~/.config/frond-ear/frond-ear.json`                                            | yes, but it is yours to back up                                                                                                                                                                                          |
| Bot token                         | `~/.config/frond-ear/token` (0600)                                              | yes, but it is yours to back up                                                                                                                                                                                          |
| The socket                        | `$XDG_RUNTIME_DIR/frond-ear/daemon.sock`                                        | no, and it should not — it is recreated                                                                                                                                                                                  |
| The attached Claude session       | the session itself                                                              | **no** — always a deliberate relaunch                                                                                                                                                                                    |

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

## Tier 2a — the ledger store is corrupt (#115)

At every start the daemon reads its store read-only with `PRAGMA quick_check` (every page; about
0.1 s for 200 MB). It sets the store aside **only** when SQLite says the file itself is damaged:
`SQLITE_CORRUPT` ("database disk image is malformed"), `SQLITE_NOTADB` ("file is not a
database"), or a quick_check finding. Then it starts a fresh store and keeps going:

- `frond-ear.db` and whichever of `-wal`, `-shm` and `-journal` exist are renamed to
  `frond-ear.db.corrupt-<UTC stamp>` (with the same suffixes), in the same directory. The
  sidecars move first and the database last, so a crash part way leaves the damaged database in
  place to be found again, never a fresh database beside an old WAL. An earlier quarantine with
  the same stamp is never overwritten (`-1`, `-2` are added). **Nothing is ever deleted**, and
  nothing deletes these files later: they are yours to keep or remove.
- `frond-ear.db.lock` (one daemon per database, #130) is not the store's and stays where it is.
- The journal says it once (`"event":"store.set_aside"`, with `keptAt` and what SQLite found).
  `ear_status` (and `node src/cli.ts status`) leads with `storeReset`, whose `said` line says when,
  that owed letters and wakes from before then are not in the live store, and where the old file
  is. It keeps saying it for as long as the fresh store holds the record.
- Not in the live store after a reset: owed letters, schedules, watches and owed wakes, queued and
  held events, attention settings, chat anchors (so a long outage before the reset is not read
  back), canticle custody and tombstones (custody reads unknown before the reset). Tell the
  attached session; it can leave its letters and schedules again once it knows what they were.

Everything else refuses to start exactly as before, and moves nothing: a store another process
holds (`database is locked`), one it can't open (permissions, a directory it can't create), I/O
errors, a full disk. A healthy store is never moved. If the rename itself fails (a read-only
directory, say) the daemon refuses with `the ledger store <path> is corrupt (…) and could not be
moved aside to <target>: …; refusing to start, nothing was deleted`, naming what it had already
moved. Move the database and its sidecars aside together by hand, then start again.

To read what the old store held, work on a copy, so nothing writes to the kept file:

```sh
cd "${XDG_STATE_HOME:-$HOME/.local/state}/frond-ear"
ls -la frond-ear.db.corrupt-*
mkdir -p ~/frond-ear-recover && cp -p frond-ear.db.corrupt-<stamp>* ~/frond-ear-recover/
cd ~/frond-ear-recover                        # the -wal beside it keeps its name, so SQLite pairs them
sqlite3 frond-ear.db.corrupt-<stamp> .recover > recovered.sql
sqlite3 recovered.db < recovered.sql
sqlite3 recovered.db "SELECT id, ear, reason, left_at, acked_at FROM letters ORDER BY id"
sqlite3 recovered.db "SELECT id, ear, kind, state FROM schedules ORDER BY id"
```

Letters are the session's own notes: hand them back to that session (it can `leave_letter` them
again), not to a room. Putting a recovered database back as the live store is possible with the
daemon stopped, but it drops whatever the fresh store took in since the reset; re-leaving what
matters is usually the better road. Once that is done, and only then, the report can be cleared
with the daemon stopped: `sqlite3 frond-ear.db "DELETE FROM store_resets"`.

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
