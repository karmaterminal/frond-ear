// `frond-ear init` and `frond-ear doctor`. Everything runs in-process against
// temp directories; doctor talks to a real daemon over a real unix socket.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import { loadConfigFile, parseConfig, runtimeOptions } from "../src/config.ts";
import {
  doctorChecks,
  resolveConfigPath,
  runDoctor,
  runInit,
  type Check,
  type Io,
} from "../src/onboard.ts";
import { listenTcp, listenUnix } from "../src/server.ts";
import { BOT, CHANNEL, PRINCIPAL, ROOM, harness, message } from "./helpers.ts";

// Short on purpose: unix socket paths are capped at 107 bytes.
const TOKEN = "not-a-real-token-123";
/** The daemon's TCP shared token: its file's path may be advised, never its contents. */
const TCP_TOKEN = "tcp-shared-secret-456";

interface Captured {
  io: Io;
  stdout: () => string;
  stderr: () => string;
}

function capture(
  env: NodeJS.ProcessEnv = {},
  stdin: NodeJS.ReadableStream = Readable.from([]),
): Captured {
  let out = "";
  let err = "";
  const stdout = new PassThrough();
  stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  const stderr = new PassThrough();
  stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  return {
    io: { stdin, stdout, stderr, env: { PATH: "", ...env } },
    stdout: () => out,
    stderr: () => err,
  };
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), "frond-ear-onboard-"));
}

const FLAGS = [
  "--non-interactive",
  "--bot-user-id",
  BOT,
  "--principal",
  `${PRINCIPAL}:figs`,
  "--peer",
  "300000000000000003",
  "--ear",
  "scribe",
  "--channel",
  CHANNEL,
  "--channel",
  `${ROOM}:room`,
];

test("init --non-interactive writes a config parseConfig accepts and a 0600 token file, without echoing the token", async () => {
  const directory = temp();
  try {
    const configPath = join(directory, "conf", "frond-ear.json");
    const tokenPath = join(directory, "conf", "token");
    const c = capture({}, Readable.from([`${TOKEN}\n`]));
    const code = await runInit(
      [
        ...FLAGS,
        "--token-stdin",
        "--token-file",
        tokenPath,
        "--config",
        configPath,
      ],
      c.io,
    );
    assert.equal(code, 0, c.stderr());

    const config = loadConfigFile(configPath);
    assert.equal(config.botUserId, BOT);
    assert.deepEqual(config.principals, [PRINCIPAL]);
    assert.deepEqual(config.peerAgents, ["300000000000000003"]);
    assert.deepEqual(config.labels, { [PRINCIPAL]: "figs" });
    assert.deepEqual(Object.keys(config.ears), ["scribe"]);
    assert.equal(config.ears.scribe?.channels[CHANNEL]?.mode, "mentions");
    assert.equal(config.ears.scribe?.channels[ROOM]?.mode, "room");
    assert.equal(config.dmEar, "scribe");
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, "conf")).mode & 0o777, 0o700);

    assert.equal(readFileSync(tokenPath, "utf8"), `${TOKEN}\n`);
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
    const printed = c.stdout() + c.stderr();
    assert.ok(!printed.includes(TOKEN), "the token must never be printed");
    assert.ok(
      !readFileSync(configPath, "utf8").includes(TOKEN),
      "the token must never land in the config",
    );
    // The next steps carry what the operator cannot guess.
    assert.match(printed, /FROND_EAR_EAR=scribe/u);
    assert.match(
      printed,
      /--dangerously-load-development-channels server:frond-ear/u,
    );
    assert.match(printed, /DISCORD_BOT_TOKEN_FILE=/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("init refuses to overwrite an existing config or token file without --force", async () => {
  const directory = temp();
  try {
    const configPath = join(directory, "frond-ear.json");
    const tokenPath = join(directory, "token");
    writeFileSync(configPath, "{ existing }");
    writeFileSync(tokenPath, "old\n", { mode: 0o600 });

    const refusedConfig = capture();
    assert.equal(
      await runInit([...FLAGS, "--config", configPath], refusedConfig.io),
      1,
    );
    assert.match(refusedConfig.stderr(), /exists; pass --force/u);
    assert.equal(readFileSync(configPath, "utf8"), "{ existing }");

    const refusedToken = capture({}, Readable.from([`${TOKEN}\n`]));
    assert.equal(
      await runInit(
        [
          ...FLAGS,
          "--config",
          join(directory, "other.json"),
          "--token-stdin",
          "--token-file",
          tokenPath,
        ],
        refusedToken.io,
      ),
      1,
    );
    assert.match(refusedToken.stderr(), /token exists; pass --force/u);
    assert.equal(readFileSync(tokenPath, "utf8"), "old\n");
    assert.ok(
      !existsSync(join(directory, "other.json")),
      "a refusal writes nothing at all",
    );

    const forced = capture({}, Readable.from([`${TOKEN}\n`]));
    assert.equal(
      await runInit(
        [
          ...FLAGS,
          "--config",
          configPath,
          "--token-stdin",
          "--token-file",
          tokenPath,
          "--force",
        ],
        forced.io,
      ),
      0,
      forced.stderr(),
    );
    assert.doesNotThrow(() => loadConfigFile(configPath));
    assert.equal(readFileSync(tokenPath, "utf8"), `${TOKEN}\n`);
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("init rejects invalid snowflakes, ear names and modes before writing anything", async () => {
  const directory = temp();
  try {
    const configPath = join(directory, "frond-ear.json");
    const cases: Array<[string[], RegExp]> = [
      [["--bot-user-id", "abc", "--ear", "e"], /--bot-user-id/u],
      [
        ["--bot-user-id", BOT, "--ear", "e", "--principal", "12x:figs"],
        /--principal "12x:figs": not a Discord snowflake/u,
      ],
      [
        ["--bot-user-id", BOT, "--ear", "e", "--channel", `${CHANNEL}:loud`],
        /mode must be silent, mentions or room/u,
      ],
      [["--bot-user-id", BOT, "--ear", "bad name"], /--ear/u],
      [
        ["--bot-user-id", BOT, "--ear", "e", "--mention-pattern", "("],
        /invalid mention pattern/u,
      ],
    ];
    for (const [flags, expected] of cases) {
      const c = capture();
      assert.equal(
        await runInit(
          ["--non-interactive", ...flags, "--config", configPath],
          c.io,
        ),
        1,
        flags.join(" "),
      );
      assert.match(c.stderr(), expected);
      assert.ok(!existsSync(configPath), `${flags.join(" ")} wrote a config`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("init interactive: answers over a pipe, the token hidden and written 0600", async () => {
  const directory = temp();
  try {
    const configPath = join(directory, "frond-ear.json");
    const tokenPath = join(directory, "token");
    const answers = [
      "not-an-id", // rejected, asked again
      BOT,
      PRINCIPAL,
      "figs",
      "", // no more principals
      "", // no peers
      "\\bscribe\\b",
      "scribe",
      CHANNEL,
      "", // mode: default mentions
      ROOM,
      "room",
      "", // no more channels
      "n", // no DMs
      "1", // paste the token
      TOKEN,
    ];
    const c = capture({}, Readable.from(answers.map((line) => `${line}\n`)));
    const code = await runInit(
      ["--config", configPath, "--token-file", tokenPath],
      c.io,
    );
    assert.equal(code, 0, c.stderr());
    const config = loadConfigFile(configPath);
    assert.deepEqual(config.mentionPatterns, ["\\bscribe\\b"]);
    assert.equal(config.ears.scribe?.dms, false);
    assert.equal(config.ears.scribe?.channels[ROOM]?.mode, "room");
    assert.equal(readFileSync(tokenPath, "utf8"), `${TOKEN}\n`);
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
    assert.ok(!c.stdout().includes(TOKEN), "the pasted token must not echo");
    assert.match(c.stdout(), /not a Discord ID/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---- doctor -------------------------------------------------------------------------------

interface DoctorRun {
  code: number;
  ok: boolean;
  checks: Check[];
  byName: (name: string) => Check;
}

async function doctor(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<DoctorRun> {
  const c = capture(env);
  const code = await runDoctor(["--json", ...argv], c.io);
  const report = JSON.parse(c.stdout()) as { ok: boolean; checks: Check[] };
  return {
    code,
    ok: report.ok,
    checks: report.checks,
    byName: (name) => {
      const check = report.checks.find((item) => item.name === name);
      assert.ok(check, `no check named ${name} in ${JSON.stringify(report)}`);
      return check;
    },
  };
}

const CONFIG_JSON = {
  botUserId: BOT,
  principals: [PRINCIPAL],
  ears: {
    scribe: {
      target: "claude-channel",
      attachCanary: true,
      channels: { [CHANNEL]: "mentions" },
    },
  },
};

test("doctor: a healthy daemon with no session attached passes, with the attach step as advice", async () => {
  const directory = temp();
  const configPath = join(directory, "frond-ear.json");
  const tokenPath = join(directory, "token");
  writeFileSync(configPath, JSON.stringify(CONFIG_JSON));
  writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
  const socketPath = join(directory, "run", "daemon.sock");
  const h = harness(parseConfig(CONFIG_JSON), {
    gatewayStatus: () => ({ state: "connected" }),
  });
  const server = await listenUnix(h.daemon, socketPath);
  try {
    const env = { FROND_EAR_SOCKET: socketPath };
    const detached = await doctor(
      ["--config", configPath, "--token-file", tokenPath],
      env,
    );
    assert.equal(detached.code, 0);
    assert.equal(detached.ok, true);
    for (const name of [
      "node",
      "config",
      "token",
      "socket dir",
      "socket",
      "daemon",
      "gateway",
    ]) {
      assert.equal(detached.byName(name).ok, true, name);
      assert.equal(detached.byName(name).required, true, name);
    }
    const attach = detached.byName("ear scribe: attached");
    assert.equal(attach.ok, false);
    assert.equal(attach.required, false);
    assert.match(attach.hint ?? "", /FROND_EAR_EAR=scribe/u);
    assert.match(
      attach.hint ?? "",
      /--dangerously-load-development-channels server:frond-ear/u,
    );
    assert.equal(detached.byName("claude").ok, false, "PATH is empty");
    assert.match(detached.byName("claude").detail, /NOT probed/u);
    assert.ok(
      !JSON.stringify(detached.checks).includes(TOKEN),
      "doctor never prints the token",
    );

    // A shim attaches but never acks the canary: registered is false, and the
    // report says that can be a false negative.
    const shim = h.attach("scribe");
    const attached = await doctor(
      ["--config", configPath, "--token-file", tokenPath],
      env,
    );
    assert.equal(attached.code, 0);
    assert.equal(attached.byName("ear scribe: attached").ok, true);
    const registered = attached.byName("ear scribe: registered");
    assert.equal(registered.ok, false);
    assert.equal(registered.required, false);
    assert.match(registered.detail, /grace period/u);

    // Acking the canary registers the ear and flips the check.
    const ack = await h.call(shim, "ack", { nonce: "nonce-1" });
    assert.equal(ack.ok, true, ack.text);
    const proven = await doctor(
      ["--config", configPath, "--token-file", tokenPath],
      env,
    );
    const confirmed = proven.byName("ear scribe: registered");
    assert.equal(confirmed.ok, true);
    // status does not say which proof registered the ear, so neither does doctor.
    assert.match(confirmed.detail, /status does not say which/u);
    assert.equal(
      proven.checks.every((check) => check.ok || check.name === "claude"),
      true,
    );
  } finally {
    server.close();
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Starts a real daemon for `config` on a temp socket, with one ear `scribe`, and runs
 * `body` against it. Doctor talks to it over the socket; the harness drives the session.
 */
async function withDaemon(
  config: object,
  body: (
    h: ReturnType<typeof harness>,
    run: () => Promise<DoctorRun>,
  ) => Promise<void>,
  mutate: (parsed: ReturnType<typeof parseConfig>) => void = () => {},
  transport: "unix" | "tcp" = "unix",
): Promise<void> {
  const directory = temp();
  const configPath = join(directory, "frond-ear.json");
  const tokenPath = join(directory, "token");
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
  const socketPath = join(directory, "run", "daemon.sock");
  const parsed = parseConfig(config);
  mutate(parsed);
  // The daemon gets the env doctor gets, so their advice can be compared (#39). In TCP
  // mode the address is known only once listening, so the env is filled in after.
  const tcpTokenPath = join(directory, "tcp-token");
  writeFileSync(tcpTokenPath, `${TCP_TOKEN}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv =
    transport === "unix" ? { FROND_EAR_SOCKET: socketPath } : {};
  const h = harness(parsed, {
    gatewayStatus: () => ({ state: "connected" }),
    env,
    ...(transport === "tcp" ? { token: TCP_TOKEN } : {}),
  });
  const server =
    transport === "unix"
      ? await listenUnix(h.daemon, socketPath)
      : await listenTcp(h.daemon, "127.0.0.1", 0);
  if (transport === "tcp") {
    const { port } = server.address() as AddressInfo;
    env.FROND_EAR_TCP = `127.0.0.1:${port}`;
    env.FROND_EAR_TOKEN_FILE = tcpTokenPath;
  }
  try {
    await body(h, () =>
      doctor(["--config", configPath, "--token-file", tokenPath], { ...env }),
    );
  } finally {
    server.close();
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Pushes one event to `shim`, lets the delivery grace run out, returns the pushed event. */
async function pushPastGrace(
  h: ReturnType<typeof harness>,
  shim: ReturnType<ReturnType<typeof harness>["attach"]>,
) {
  h.daemon.ingest(
    message({
      author: { id: PRINCIPAL },
      mentions: [{ id: BOT }],
      content: "can you hear me?",
    }),
  );
  // Past the default max delay, so the batch has been pushed.
  h.timers.advance(60_000);
  const pushed = shim.connection.events().at(-1);
  assert.ok(pushed && pushed.batchId !== null, "an event was pushed");
  await shim.send({ type: "offered", batchId: pushed.batchId });
  h.clock.advance(2 * 60 * 1_000);
  return pushed;
}

const CLAUDE_ADVICE =
  /claude mcp|claude --|dangerously-load-development-channels/u;

/** The no-events fix in a doctor hint or in the daemon's delivery warning. */
function deafFix(text: string): string {
  const fix =
    /If no <channel> events arrive at all: (.*?)(?:\. Until then|$)/u.exec(
      text,
    )?.[1];
  assert.ok(fix, text);
  return fix;
}

/** The warning the daemon appends to `scribe`'s tool results while delivery is unconfirmed. */
function daemonWarning(h: ReturnType<typeof harness>): string {
  const status = h.daemon.status("scribe") as {
    ears: Array<{ delivery: string; hint?: string }>;
  };
  assert.equal(status.ears[0]?.delivery, "unconfirmed");
  return status.ears[0]?.hint ?? "";
}

test("doctor: a claude-channel ear with unconfirmed delivery gets #30's proofs and the channel flag; a token-form batch_id confirms it without an ack claim", async () => {
  await withDaemon(CONFIG_JSON, async (h, run) => {
    // The canary is never acked (lost), and the grace runs out.
    const shim = h.attach("scribe");
    const pushed = await pushPastGrace(h, shim);
    const unconfirmed = (await run()).byName("ear scribe: registered");
    assert.equal(unconfirmed.ok, false);
    assert.equal(unconfirmed.required, false);
    assert.doesNotMatch(unconfirmed.detail, /Until frond-ear#30/u);
    assert.match(unconfirmed.detail, /token form \(N-<token>\)/u);
    assert.match(unconfirmed.detail, /tap or inbox .* proves nothing/u);
    assert.match(unconfirmed.hint ?? "", /ack the attach canary's nonce/u);
    assert.match(unconfirmed.hint ?? "", /N-<token>/u);
    assert.match(
      unconfirmed.hint ?? "",
      /--dangerously-load-development-channels server:frond-ear/u,
    );
    // The session itself is told the same fix (#39).
    assert.equal(deafFix(daemonWarning(h)), deafFix(unconfirmed.hint ?? ""));

    // Using the pushed id in its token form registers the ear with no canary ack.
    const reply = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "yes",
      batch_id: pushed?.meta.batch_id,
    });
    assert.equal(reply.ok, true, reply.text);
    const confirmed = (await run()).byName("ear scribe: registered");
    assert.equal(confirmed.ok, true);
    assert.doesNotMatch(confirmed.detail, /acked the attach canary:/u);
    assert.match(confirmed.detail, /status does not say which/u);
  });
});

test("doctor: a copilot-extension ear gets Copilot advice, never Claude setup", async () => {
  const config = {
    ...CONFIG_JSON,
    ears: {
      scribe: { ...CONFIG_JSON.ears.scribe, target: "copilot-extension" },
    },
  };
  await withDaemon(config, async (h, run) => {
    const detached = await run();
    assert.equal(detached.code, 0);
    const attach = detached.byName("ear scribe: attached");
    assert.equal(attach.ok, false);
    assert.match(attach.hint ?? "", /copilot-extension --ear scribe/u);
    assert.match(attach.hint ?? "", /copilot --experimental/u);
    assert.match(attach.hint ?? "", /after upgrading frond-ear/u);
    assert.doesNotMatch(attach.hint ?? "", CLAUDE_ADVICE);
    assert.ok(
      !detached.checks.some((check) => check.name === "claude"),
      "no claude check when every ear is Copilot",
    );

    const shim = h.attach("scribe");
    await pushPastGrace(h, shim);
    const unconfirmed = (await run()).byName("ear scribe: registered");
    assert.equal(unconfirmed.ok, false);
    assert.match(unconfirmed.hint ?? "", /N-<token>/u);
    assert.match(unconfirmed.hint ?? "", /copilot --experimental/u);
    assert.match(
      unconfirmed.hint ?? "",
      /after upgrading frond-ear, re-run the install: .*copilot-extension --ear scribe$/u,
    );
    assert.match(unconfirmed.hint ?? "", /could not deliver batch/u);
    assert.doesNotMatch(unconfirmed.hint ?? "", CLAUDE_ADVICE);
    assert.doesNotMatch(unconfirmed.detail, /Claude Code/u);
    // The session itself is told the same Copilot fix, never Claude's relaunch (#39).
    const warning = daemonWarning(h);
    assert.equal(deafFix(warning), deafFix(unconfirmed.hint ?? ""));
    assert.doesNotMatch(warning, CLAUDE_ADVICE);
    assert.doesNotMatch(warning, /Claude Code/u);
  });
});

test("doctor: a copilot-extension ear on a TCP daemon is told a TCP reinstall, never a socket one (#40 review)", async () => {
  const config = {
    ...CONFIG_JSON,
    ears: {
      scribe: { ...CONFIG_JSON.ears.scribe, target: "copilot-extension" },
    },
  };
  await withDaemon(
    config,
    async (h, run) => {
      // The installer writes a unix socket unless FROND_EAR_TCP is set (cli.ts), so a
      // socket-only reinstall would replace this ear's working TCP config.
      const tcpInstall =
        /FROND_EAR_TCP=127\.0\.0\.1:\d+ FROND_EAR_TOKEN_FILE=\S*tcp-token \S+ \S+ copilot-extension --ear scribe/u;
      const detached = await run();
      const attach = detached.byName("ear scribe: attached");
      assert.match(attach.hint ?? "", tcpInstall);
      assert.doesNotMatch(attach.hint ?? "", /FROND_EAR_SOCKET/u);

      const shim = h.attach("scribe");
      await pushPastGrace(h, shim);
      const run2 = await run();
      const unconfirmed = run2.byName("ear scribe: registered");
      assert.match(
        unconfirmed.hint ?? "",
        new RegExp(`re-run the install: ${tcpInstall.source}$`, "u"),
      );
      assert.doesNotMatch(unconfirmed.hint ?? "", /FROND_EAR_SOCKET/u);
      // The session is told the same TCP reinstall.
      const warning = daemonWarning(h);
      assert.equal(deafFix(warning), deafFix(unconfirmed.hint ?? ""));
      assert.doesNotMatch(warning, /FROND_EAR_SOCKET/u);
      for (const text of [warning, JSON.stringify(run2.checks)]) {
        assert.doesNotMatch(text, new RegExp(TCP_TOKEN, "u"));
      }
    },
    () => {},
    "tcp",
  );
});

test("doctor: a target it does not know gets an honest not-supported note, no setup advice", async () => {
  // config.ts rejects reserved targets, so only a mismatched daemon reports one.
  await withDaemon(
    CONFIG_JSON,
    async (h, run) => {
      const detached = await run();
      const target = detached.byName("ear scribe: target");
      assert.equal(target.ok, false);
      assert.equal(target.required, false);
      assert.match(target.detail, /copilot-sdk is not supported/u);
      assert.equal(detached.byName("ear scribe: attached").hint, undefined);
      const shim = h.attach("scribe");
      await pushPastGrace(h, shim);
      const unconfirmed = (await run()).byName("ear scribe: registered");
      assert.doesNotMatch(unconfirmed.hint ?? "", CLAUDE_ADVICE);
      assert.doesNotMatch(unconfirmed.hint ?? "", /copilot --experimental/u);
    },
    (parsed) => {
      const ear = parsed.ears.scribe;
      assert.ok(ear);
      (ear as { target: string }).target = "copilot-sdk";
    },
  );
});

test("doctor: a 0644 token, a dead gateway, and a missing daemon each fail a required check", async () => {
  const directory = temp();
  const configPath = join(directory, "frond-ear.json");
  const tokenPath = join(directory, "token");
  writeFileSync(configPath, JSON.stringify(CONFIG_JSON));
  writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o644 });
  const socketPath = join(directory, "run", "daemon.sock");
  const h = harness(parseConfig(CONFIG_JSON), {
    gatewayStatus: () => ({ state: "disconnected", closeCode: 4014 }),
  });
  const server = await listenUnix(h.daemon, socketPath);
  try {
    const env = { FROND_EAR_SOCKET: socketPath };
    const run = await doctor(
      ["--config", configPath, "--token-file", tokenPath],
      env,
    );
    assert.equal(run.code, 1);
    assert.equal(run.ok, false);
    const token = run.byName("token");
    assert.equal(token.ok, false);
    assert.match(token.detail, /mode 0644, want 0600/u);
    assert.match(token.hint ?? "", /chmod 600/u);
    const gateway = run.byName("gateway");
    assert.equal(gateway.ok, false);
    assert.match(gateway.detail, /disconnected \(close code 4014\)/u);
    assert.match(gateway.hint ?? "", /Message Content Intent/u);
    assert.equal(run.byName("daemon").ok, true);

    chmodSync(tokenPath, 0o600);
    const fixedToken = await doctor(
      ["--config", configPath, "--token-file", tokenPath],
      env,
    );
    assert.equal(fixedToken.byName("token").ok, true);
    assert.equal(fixedToken.code, 1, "the gateway still fails");
  } finally {
    server.close();
    h.dispose();
  }
  try {
    // Nobody is listening any more.
    const gone = await doctor(
      ["--config", configPath, "--token-file", tokenPath],
      { FROND_EAR_SOCKET: socketPath, DISCORD_BOT_TOKEN_FILE: tokenPath },
    );
    assert.equal(gone.code, 1);
    assert.equal(gone.byName("daemon").ok, false);
    assert.match(gone.byName("daemon").hint ?? "", /start the daemon/u);
    assert.ok(
      !gone.checks.some((check) => check.name === "gateway"),
      "nothing to ask about the gateway without a daemon",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor: a config that does not parse, a missing token file, and no claude on PATH", async () => {
  const directory = temp();
  try {
    const configPath = join(directory, "frond-ear.json");
    writeFileSync(configPath, JSON.stringify({ ...CONFIG_JSON, ears: {} }));
    const run = await doctor(
      ["--config", configPath, "--token-file", join(directory, "nope")],
      { FROND_EAR_SOCKET: join(directory, "none", "daemon.sock") },
    );
    assert.equal(run.code, 1);
    assert.match(run.byName("config").detail, /ears must define at least one/u);
    assert.match(run.byName("config").hint ?? "", /frond-ear init/u);
    assert.match(run.byName("token").detail, /no token file/u);
    assert.match(run.byName("token").hint ?? "", /install -m 600/u);
    assert.equal(run.byName("socket dir").ok, false);
    assert.equal(run.byName("daemon").ok, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor resolves config and token exactly as the daemon does, and names a home config the daemon would not load", async () => {
  const directory = temp();
  try {
    const confDir = join(directory, "conf");
    const homeConfig = join(confDir, "frond-ear.json");
    const homeToken = join(confDir, "token");
    mkdirSync(confDir, { mode: 0o700 });
    writeFileSync(homeConfig, JSON.stringify(CONFIG_JSON), { mode: 0o600 });
    writeFileSync(homeToken, `${TOKEN}\n`, { mode: 0o600 });
    const cwd = join(directory, "work");
    mkdirSync(cwd);
    const base = {
      PATH: "",
      FROND_EAR_CONF_DIR: confDir,
      FROND_EAR_SOCKET: join(directory, "none", "daemon.sock"),
    };
    const daemonPath = (env: NodeJS.ProcessEnv): string =>
      resolve(cwd, runtimeOptions(env, { dryRun: false }).configPath);
    const byName = (checks: Check[], name: string): Check => {
      const check = checks.find((item) => item.name === name);
      assert.ok(check, `no check named ${name} in ${JSON.stringify(checks)}`);
      return check;
    };

    // Flagless, no ./frond-ear.json: doctor checks what the daemon would load, not the home
    // config, and says why the daemon would not find the config that does exist.
    assert.equal(
      resolveConfigPath(undefined, base, cwd).path,
      daemonPath(base),
    );
    const stranded = await doctorChecks({ "timeout-ms": "200" }, base, cwd);
    const config = byName(stranded, "config");
    assert.equal(config.ok, false);
    assert.ok(
      config.detail.includes(join(cwd, "frond-ear.json")),
      config.detail,
    );
    assert.match(config.detail, /the daemon's default/u);
    assert.ok(config.detail.includes(homeConfig), config.detail);
    assert.match(config.detail, /will not load it/u);
    assert.ok(
      (config.hint ?? "").includes(`FROND_EAR_CONFIG=${homeConfig}`),
      config.hint,
    );
    const token = byName(stranded, "token");
    assert.equal(
      token.ok,
      false,
      "the daemon has no default token path either",
    );
    assert.match(
      token.detail,
      /neither DISCORD_BOT_TOKEN_FILE nor DISCORD_BOT_TOKEN/u,
    );
    assert.ok(token.detail.includes(homeToken), token.detail);
    assert.ok(
      (token.hint ?? "").includes(`DISCORD_BOT_TOKEN_FILE=${homeToken}`),
      token.hint,
    );

    // The env the daemon would get: both pass, and the config names where it came from.
    const named = {
      ...base,
      FROND_EAR_CONFIG: homeConfig,
      DISCORD_BOT_TOKEN_FILE: homeToken,
    };
    assert.equal(
      resolveConfigPath(undefined, named, cwd).path,
      daemonPath(named),
    );
    const fixed = await doctorChecks({ "timeout-ms": "200" }, named, cwd);
    assert.equal(byName(fixed, "config").ok, true);
    assert.match(byName(fixed, "config").detail, /\(FROND_EAR_CONFIG\)/u);
    assert.equal(byName(fixed, "token").ok, true);

    // A ./frond-ear.json in the working directory is what a flagless daemon loads.
    writeFileSync(join(cwd, "frond-ear.json"), JSON.stringify(CONFIG_JSON));
    assert.equal(
      resolveConfigPath(undefined, base, cwd).path,
      daemonPath(base),
    );
    const local = await doctorChecks({ "timeout-ms": "200" }, base, cwd);
    assert.equal(byName(local, "config").ok, true);
    assert.ok(
      byName(local, "config").detail.startsWith(join(cwd, "frond-ear.json")),
      byName(local, "config").detail,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
