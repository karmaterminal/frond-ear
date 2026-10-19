# Contributing

Thanks for looking. frond-ear is small, and it stays that way on purpose:

- no build step;
- no runtime dependencies;
- tests that never leave the machine.

For a security problem, don't open an issue. Follow [SECURITY.md](SECURITY.md).

## Setup

You need Node.js ≥ 22.18 (CI runs 22, 24 and 26) and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm check
```

Node runs the TypeScript directly through type stripping. So:

- imports use `.ts` extensions;
- only erasable syntax is allowed: no `enum`, no `namespace`, no constructor parameter
  properties. `tsc` enforces this.

The daemon and shim use only Node built-ins: `node:sqlite`, the global `WebSocket` and `fetch`,
and `node:net`. A change that adds a runtime dependency needs a very good reason.

## Before you push

Run `pnpm check`, the same command CI runs. In order, it:

1. checks formatting (`pnpm format` fixes it);
2. type-checks;
3. runs the tests;
4. scans every tracked file for credential shapes (`pnpm scan:credentials`).

## Tests

- **Use `node:test` and the fakes in `test/`:**
  - `FakeClock`;
  - `FakeSocket`;
  - the fake REST client;
  - a fake shim over a real socket.
- **Never call live Discord or a live Claude or Copilot session.** A test that needs a network
  peer gets a fake.
- **Use synthetic IDs only.** Fixtures use obviously fake snowflakes such as
  `100000000000000001` or `700000000000000007`. Never commit a real user, bot, guild, channel or
  message ID, and never a real token, even an expired one.
- **The bot token** only ever comes from `DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN_FILE`.
  Code must never log it or hand it to the shim.

### Chaos proofs

`tools/chaos/` drives the daemon through crashes, replays and dropped connections with
[k6](https://k6.io/), against a fake Discord. It contacts neither real Discord nor a real Claude.
Run it when you change the ledger, delivery or recovery:

```sh
# needs k6 v2.x on PATH, or K6_BIN=/path/to/k6
pnpm chaos [artifact-dir] [row ...]   # default: artifacts/chaos/<HEAD SHA>
```

[`tools/chaos/README.md`](tools/chaos/README.md) describes each row. Committed proofs live
under `docs/proofs/chaos/<sha>/`.

### Clean-install receipt

`tools/clean-install/receipt.sh` is a release proof, not a test. It installs frond-ear the way a
stranger would, with a fake Discord, but it attaches a **real** `claude` session. Run it only
when you mean to; [its README](tools/clean-install/README.md) explains how.

## Branches and pull requests

- Branch from `main` and open a pull request. One topic per pull request.
- Pull requests land as **merge commits**.
- Don't rebase or force-push a branch someone else may have pulled, `main` above all. To pick
  up `main`, merge it into your branch.
- Say in the description what you changed and how you checked it. A change to behaviour comes
  with a test.
- Keep the invariants in [CLAUDE.md](CLAUDE.md) (trust, ledger states, read-back, outbound
  IDs). They hold for any contributor, human or agent.

## Release scan

Run `scripts/release-scan.sh` before making a release or changing the repository's visibility.
Use a fresh clone, at the exact commit that will ship:

```sh
git clone https://github.com/karmaterminal/frond-ear && cd frond-ear
pnpm install --frozen-lockfile
RELEASE_SCAN_KNOWN_IDS=~/private/real-discord-ids.txt \
  scripts/release-scan.sh --expect <sha> > release-scan.md
```

`--expect` fails the scan unless both HEAD (the tree `pnpm check` tests) and `origin/main` are
that commit.

It covers everything that goes public with the repository:

- **Git.** Every ref the public will see: origin's branches and tags, plus the pull-request
  heads GitHub keeps under `refs/pull/*`. Merge commits are diffed against their first parent,
  and binary files are read as text.
- **Conversations.** Issue and pull-request titles and bodies, issue comments, review bodies and
  review line comments, read through `gh api` with your own gh login
  (set `GH_CONFIG_DIR` first if you keep more than one). If `gh` is missing or not signed in,
  the report says "not covered: PR/issue/review text" and the scan fails. To run without
  `gh` on purpose, pass `--no-conversations`. The report then says the text was skipped, and
  the scan exits 3 ("incomplete") at best, never 0, so that run can't serve as a release
  receipt.

It reports:

- `pnpm check` at HEAD (or only `scan:credentials`, with `--no-check`);
- for git history and for conversations alike, checks for:
  - Discord tokens and webhooks;
  - GitHub, Anthropic, OpenAI, Slack and AWS keys;
  - private-key headers;
  - `/home/` paths and private IPv4 addresses;
  - every 17–20-digit run that isn't shaped like a synthetic ID, and any real ID from
    `RELEASE_SCAN_KNOWN_IDS` (a file kept outside the repository);
- the binary paths in each ref's tree;
- a census of author and committer emails, masked as `abc…@domain`;
- every branch, and whether `main` contains it.

It never prints a matched secret. It exits 1 on any secret shape, real ID or unexplained
snowflake. It also exits 1 when `gh` is unavailable or any `gh api` call fails, or when the
number of pull requests listed differs from the number whose reviews were fetched. Paths, addresses, binaries and emails are
for a person to judge. Attach its output to the release issue.
