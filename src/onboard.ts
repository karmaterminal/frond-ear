// `frond-ear init` and `frond-ear doctor`: the onboarding contract in code.
// `init` writes exactly two files (the config and, if asked, the 0600 token
// file) and prints the steps it cannot do for you. `doctor` is read-only.
// Neither ever prints the token. The contract is docs/onboarding.md.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";

import {
  CLI,
  DELIVERY_PROOF,
  LAUNCH_FLAG,
  shellWord,
  targetAdvice,
} from "./advice.ts";
import { request, tcpTarget } from "./client.ts";
import {
  EAR_NAME,
  SNOWFLAKE,
  daemonConfigPath,
  defaultSocketPath,
  loadConfigFile,
  parseConfig,
} from "./config.ts";
import type { Mode } from "./types.ts";

export interface Io {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
}

const MIN_NODE = { major: 22, minor: 18 };
const MAX_SOCKET_PATH = 107;
const MODES = new Set<Mode>(["silent", "mentions", "room"]);

// ---- paths -------------------------------------------------------------------------------

/** `~/.config/frond-ear`, the directory ops/install-systemd.sh also uses. */
export function defaultConfDir(env: NodeJS.ProcessEnv): string {
  return env.FROND_EAR_CONF_DIR ?? join(homedir(), ".config", "frond-ear");
}

export function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  return join(defaultConfDir(env), "frond-ear.json");
}

export function defaultTokenPath(env: NodeJS.ProcessEnv): string {
  return join(defaultConfDir(env), "token");
}

/**
 * The shell line that creates a token file 0600 and opens it in $EDITOR. `set -C` makes it
 * refuse a file that already exists: on a host shared with another agent's ear that file may be
 * the other ear's token, which `install -m 600 /dev/null` would have emptied (#57). The create
 * runs under `sh -c` with the path as an argument, so the line also works pasted into fish.
 */
export function createTokenCommand(path: string): string {
  const file = shellWord(path);
  return `sh -c 'umask 077; set -C; : > "$1"' sh ${file} && $EDITOR ${file}`;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function octal(mode: number): string {
  return `0${mode.toString(8)}`;
}

// ---- init: answers -----------------------------------------------------------------------

export interface Labelled {
  id: string;
  label?: string;
}

export interface InitAnswers {
  botUserId: string;
  principals: Labelled[];
  peerAgents: Labelled[];
  mentionPatterns: string[];
  ear: string;
  channels: Array<{ id: string; mode: Mode }>;
  dms: boolean;
  token:
    | { kind: "paste"; value: string; path: string }
    | { kind: "file"; path: string }
    | { kind: "none"; path: string };
}

export function parseLabelled(raw: string, flag: string): Labelled {
  const index = raw.indexOf(":");
  const id = index >= 0 ? raw.slice(0, index) : raw;
  const label = index >= 0 ? raw.slice(index + 1).trim() : "";
  if (!SNOWFLAKE.test(id)) {
    throw new Error(
      `${flag} ${JSON.stringify(raw)}: not a Discord snowflake ID`,
    );
  }
  return label ? { id, label } : { id };
}

export function parseChannelFlag(raw: string): { id: string; mode: Mode } {
  const index = raw.indexOf(":");
  const id = index >= 0 ? raw.slice(0, index) : raw;
  const mode = index >= 0 ? raw.slice(index + 1).trim() : "mentions";
  if (!SNOWFLAKE.test(id)) {
    throw new Error(
      `--channel ${JSON.stringify(raw)}: not a Discord channel ID`,
    );
  }
  if (!MODES.has(mode as Mode)) {
    throw new Error(
      `--channel ${JSON.stringify(raw)}: mode must be silent, mentions or room`,
    );
  }
  return { id, mode: mode as Mode };
}

/** The JSON `init` writes. Minimal on purpose: unset knobs take parseConfig's defaults. */
export function buildConfig(answers: InitAnswers): Record<string, unknown> {
  const labels: Record<string, string> = {};
  for (const { id, label } of [...answers.principals, ...answers.peerAgents]) {
    if (label) {
      labels[id] = label;
    }
  }
  return {
    botUserId: answers.botUserId,
    principals: answers.principals.map((item) => item.id),
    peerAgents: answers.peerAgents.map((item) => item.id),
    labels,
    mentionPatterns: answers.mentionPatterns,
    ears: {
      [answers.ear]: {
        target: "claude-channel",
        dms: answers.dms,
        dmMode: "mentions",
        attachCanary: true,
        channels: Object.fromEntries(
          answers.channels.map((channel) => [
            channel.id,
            { mode: channel.mode },
          ]),
        ),
        instructions: "",
      },
    },
    paused: false,
  };
}

const INIT_OPTIONS = {
  "non-interactive": { type: "boolean" },
  "bot-user-id": { type: "string" },
  principal: { type: "string", multiple: true },
  peer: { type: "string", multiple: true },
  ear: { type: "string" },
  channel: { type: "string", multiple: true },
  "mention-pattern": { type: "string", multiple: true },
  "no-dms": { type: "boolean" },
  "token-file": { type: "string" },
  "token-stdin": { type: "boolean" },
  config: { type: "string" },
  force: { type: "boolean" },
} as const;

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return text;
}

async function answersFromFlags(
  values: Record<string, unknown>,
  io: Io,
): Promise<InitAnswers> {
  const botUserId = values["bot-user-id"];
  if (typeof botUserId !== "string" || !SNOWFLAKE.test(botUserId)) {
    throw new Error(
      "--bot-user-id must be the bot's Discord user ID (a snowflake)",
    );
  }
  const ear = values.ear;
  if (typeof ear !== "string" || !EAR_NAME.test(ear)) {
    throw new Error(`--ear is required and must match ${EAR_NAME}`);
  }
  const list = (key: string): string[] =>
    Array.isArray(values[key]) ? (values[key] as string[]) : [];
  const tokenPath = resolve(
    (values["token-file"] as string | undefined) ?? defaultTokenPath(io.env),
  );
  let token: InitAnswers["token"];
  if (values["token-stdin"] === true) {
    const value = (await readAll(io.stdin)).trim();
    if (!value) {
      throw new Error("--token-stdin: nothing arrived on stdin");
    }
    token = { kind: "paste", value, path: tokenPath };
  } else if (values["token-file"] !== undefined) {
    token = { kind: "file", path: tokenPath };
  } else {
    token = { kind: "none", path: tokenPath };
  }
  return {
    botUserId,
    principals: list("principal").map((raw) =>
      parseLabelled(raw, "--principal"),
    ),
    peerAgents: list("peer").map((raw) => parseLabelled(raw, "--peer")),
    mentionPatterns: list("mention-pattern"),
    ear,
    channels: list("channel").map(parseChannelFlag),
    dms: values["no-dms"] !== true,
    token,
  };
}

// ---- init: interactive -------------------------------------------------------------------

/** Output that can be muted, so a pasted token is never echoed. */
class MutableOutput extends Writable {
  public muted = false;
  private readonly target: NodeJS.WritableStream;

  public constructor(target: NodeJS.WritableStream) {
    super();
    this.target = target;
  }

  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) {
      this.target.write(chunk);
    }
    callback();
  }
}

/**
 * Sequential questions over readline. Lines are queued as they arrive, so a
 * piped stdin (an agent answering every prompt at once) works the same as a
 * terminal. On a TTY readline owns echo, which is what lets a token be hidden.
 */
class Prompter {
  private readonly rl: Interface;
  private readonly output: MutableOutput;
  private readonly lines: string[] = [];
  private waiting: ((line: string | undefined) => void) | undefined;
  private closed = false;

  public constructor(io: Io) {
    this.output = new MutableOutput(io.stdout);
    this.rl = createInterface({
      input: io.stdin,
      output: this.output,
      terminal: io.stdin.isTTY === true,
    });
    this.rl.setPrompt("");
    this.rl.on("line", (line) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(line);
      } else {
        this.lines.push(line);
      }
    });
    this.rl.on("close", () => {
      this.closed = true;
      this.waiting?.(undefined);
      this.waiting = undefined;
    });
  }

  public say(text: string): void {
    this.output.write(text);
  }

  private async line(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) {
      return queued;
    }
    if (this.closed) {
      throw new Error("input ended before init finished; nothing was written");
    }
    const line = await new Promise<string | undefined>((resolve) => {
      this.waiting = resolve;
    });
    if (line === undefined) {
      throw new Error("input ended before init finished; nothing was written");
    }
    return line;
  }

  public async ask(question: string, fallback?: string): Promise<string> {
    const suffix = fallback ? ` [${fallback}]` : "";
    this.output.write(`${question}${suffix}: `);
    const answer = (await this.line()).trim();
    return answer || fallback || "";
  }

  /** Asks without echoing the answer. */
  public async askHidden(question: string): Promise<string> {
    this.output.write(`${question}: `);
    this.output.muted = true;
    try {
      return (await this.line()).trim();
    } finally {
      this.output.muted = false;
      this.output.write("\n");
    }
  }

  public async askSnowflake(
    question: string,
    optional: boolean,
  ): Promise<string | undefined> {
    for (;;) {
      const answer = await this.ask(question);
      if (!answer && optional) {
        return undefined;
      }
      if (SNOWFLAKE.test(answer)) {
        return answer;
      }
      this.say("  that is not a Discord ID (digits only, up to 25)\n");
    }
  }

  public async askLabelled(what: string): Promise<Labelled[]> {
    const items: Labelled[] = [];
    for (;;) {
      const id = await this.askSnowflake(
        `${what} #${items.length + 1} Discord user ID (blank when done)`,
        true,
      );
      if (!id) {
        return items;
      }
      const label = await this.ask(`  label for ${id} (optional)`);
      items.push(label ? { id, label } : { id });
    }
  }

  public close(): void {
    this.rl.close();
  }
}

async function answersInteractively(
  values: Record<string, unknown>,
  io: Io,
): Promise<InitAnswers> {
  const p = new Prompter(io);
  try {
    p.say(
      "frond-ear init\nIDs come from Discord with Developer Mode on (right-click → Copy ID). None of them is secret.\n\n",
    );
    const botUserId = (await p.askSnowflake(
      "bot user ID (the bot's own Discord user ID)",
      false,
    )) as string;
    const principals = await p.askLabelled(
      "principal (a human who may command the session)",
    );
    const peerAgents = await p.askLabelled(
      "peer agent (another bot allowed through)",
    );
    const patternText = await p.ask(
      "mention patterns, regexes that count as addressing the bot, comma-separated (optional)",
    );
    const mentionPatterns = patternText
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    let ear: string;
    for (;;) {
      ear = await p.ask(
        "ear name (one per Claude session; letters, digits, - and _)",
      );
      if (EAR_NAME.test(ear)) {
        break;
      }
      p.say(`  must match ${EAR_NAME}\n`);
    }
    const channels: InitAnswers["channels"] = [];
    for (;;) {
      const id = await p.askSnowflake(
        `channel #${channels.length + 1} ID (blank when done)`,
        true,
      );
      if (!id) {
        break;
      }
      let mode: string;
      for (;;) {
        mode = await p.ask("  mode: silent, mentions or room", "mentions");
        if (MODES.has(mode as Mode)) {
          break;
        }
        p.say("  silent, mentions or room\n");
      }
      channels.push({ id, mode: mode as Mode });
    }
    const dms = (
      await p.ask("route DMs from principals and peers to this ear? (y/n)", "y")
    )
      .toLowerCase()
      .startsWith("y");
    const tokenPath = resolve(
      (values["token-file"] as string | undefined) ?? defaultTokenPath(io.env),
    );
    let token: InitAnswers["token"];
    for (;;) {
      const choice = await p.ask(
        `bot token: (1) paste it now, not echoed, written to ${tokenPath} (2) it is already in a file (3) skip for now`,
        "1",
      );
      if (choice === "1") {
        const value = await p.askHidden("  token (hidden)");
        if (!value) {
          p.say("  empty; try again\n");
          continue;
        }
        token = { kind: "paste", value, path: tokenPath };
        break;
      }
      if (choice === "2") {
        const path = await p.ask("  path to the token file", tokenPath);
        token = { kind: "file", path: resolve(path) };
        break;
      }
      if (choice === "3") {
        token = { kind: "none", path: tokenPath };
        break;
      }
    }
    return {
      botUserId,
      principals,
      peerAgents,
      mentionPatterns,
      ear,
      channels,
      dms,
      token,
    };
  } finally {
    p.close();
  }
}

// ---- init: write -------------------------------------------------------------------------

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  // `mode` applies only on creation; an overwritten file keeps its old bits.
  chmodSync(path, 0o600);
}

export async function runInit(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args: argv, options: INIT_OPTIONS });
  const out = (text: string) => io.stdout.write(text);
  try {
    const answers =
      values["non-interactive"] === true
        ? await answersFromFlags(values, io)
        : await answersInteractively(values, io);
    const configPath = resolve(
      (values.config as string | undefined) ?? defaultConfigPath(io.env),
    );
    const candidate = buildConfig(answers);
    const config = parseConfig(candidate); // throws with the field named
    const force = values.force === true;

    // Every refusal happens before any write.
    if (existsSync(configPath) && !force) {
      throw new Error(`${configPath} exists; pass --force to overwrite it`);
    }
    const { token } = answers;
    if (token.kind === "paste" && existsSync(token.path) && !force) {
      throw new Error(`${token.path} exists; pass --force to overwrite it`);
    }
    if (token.kind === "file") {
      if (!existsSync(token.path) || !readFileSync(token.path, "utf8").trim()) {
        throw new Error(`${token.path}: no such file, or it is empty`);
      }
    }
    if (answers.principals.length === 0) {
      io.stderr.write(
        "frond-ear init: no principals; nobody will have trust=principal until you add one\n",
      );
    }

    writePrivate(configPath, `${JSON.stringify(candidate, null, 2)}\n`);
    out(`wrote ${configPath} (0600)\n`);
    if (token.kind === "paste") {
      writePrivate(token.path, `${token.value}\n`);
      out(`wrote ${token.path} (0600)\n`);
    } else if (token.kind === "file") {
      if (modeOf(token.path) !== 0o600) {
        chmodSync(token.path, 0o600);
        out(`chmod 600 ${token.path}\n`);
      }
      out(`using token file ${token.path}\n`);
    } else if (existsSync(token.path)) {
      out(
        `no token written; ${token.path} already exists and the steps below use it as it is. If it is not this ear's own bot token (another ear on this host may use it), re-run init with --token-file naming this ear's own file\n`,
      );
    } else {
      out(
        `no token written; create it, then put the bot token in it:\n  ${createTokenCommand(token.path)}\n`,
      );
    }
    if (configPath === resolve(defaultConfigPath(io.env))) {
      chmodSync(dirname(configPath), 0o700);
    }

    const ear = Object.keys(config.ears)[0] as string;
    const envPrefix = `FROND_EAR_CONFIG=${shellWord(configPath)} DISCORD_BOT_TOKEN_FILE=${shellWord(token.path)}`;
    const socketEnv = io.env.FROND_EAR_SOCKET
      ? ` -e FROND_EAR_SOCKET=${shellWord(io.env.FROND_EAR_SOCKET)}`
      : "";
    out(
      [
        "",
        `ear ${ear}: ${answers.channels.length} channel(s), ${answers.principals.length} principal(s), ${answers.peerAgents.length} peer agent(s), dms ${answers.dms ? "on" : "off"}`,
        "",
        "next steps:",
        "  1. start the daemon (needs Message Content Intent on, and the bot invited to the channels):",
        `       ${envPrefix} ${shellWord(process.execPath)} ${shellWord(CLI)} daemon`,
        "     or keep it across reboots under systemd:",
        `       ${envPrefix} ${shellWord(join(dirname(CLI), "..", "ops", "install-systemd.sh"))}`,
        "  2. check the result (read-only):",
        `       ${envPrefix} ${shellWord(process.execPath)} ${shellWord(CLI)} doctor`,
        "  3. register the shim in the ONE project directory whose Claude Code session owns this ear:",
        `       claude mcp add -s local frond-ear -e FROND_EAR_EAR=${ear}${socketEnv} -- ${shellWord(process.execPath)} ${shellWord(CLI)} shim`,
        "  4. launch Claude Code there with the channel flag (read only at launch; --resume keeps history):",
        `       claude ${LAUNCH_FLAG}`,
        "  5. let the tools run unattended, in that project's .claude/settings.local.json:",
        `       { "permissions": { "allow": ["mcp__frond-ear"] } }`,
        "",
        "docs/onboarding.md is the full contract.",
        "",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `frond-ear init: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

// ---- doctor ------------------------------------------------------------------------------

export interface Check {
  name: string;
  ok: boolean;
  /** A failed required check makes doctor exit non-zero. */
  required: boolean;
  detail: string;
  hint?: string;
}

interface StatusEar {
  name: string;
  /** Absent from a daemon older than #36, which only had claude-channel. */
  target?: string;
  attached: boolean;
  registered: boolean;
  delivery: "confirmed" | "pending" | "unconfirmed" | "detached";
  hint?: string;
  sessionId: string | null;
  channels: Record<string, string>;
}

interface Status {
  paused: boolean;
  gateway: { state: string; closeCode?: number };
  ears: StatusEar[];
}

const DOCTOR_OPTIONS = {
  config: { type: "string" },
  "token-file": { type: "string" },
  json: { type: "boolean" },
  "timeout-ms": { type: "string" },
} as const;

function nodeCheck(): Check {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const ok =
    major > MIN_NODE.major ||
    (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  return {
    name: "node",
    ok,
    required: true,
    detail: `node ${process.versions.node}${ok ? "" : ` is older than ${MIN_NODE.major}.${MIN_NODE.minor}`}`,
    ...(ok
      ? {}
      : { hint: "install Node 22.18 or newer (CI runs 22, 24 and 26)" }),
  };
}

/** A config path doctor checks, and why that one. */
export interface ConfigSource {
  path: string;
  from: string;
  /** True when the path is the daemon's own default, not one somebody named. */
  daemonDefault: boolean;
}

/**
 * Which config doctor checks: `--config` if given, else exactly what the daemon would load from
 * `cwd` (daemonConfigPath: FROND_EAR_CONFIG, else ./frond-ear.json). No ~/.config fallback,
 * because the daemon has none.
 */
export function resolveConfigPath(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): ConfigSource {
  if (flag) {
    return {
      path: resolve(cwd, flag),
      from: "--config (the daemon itself reads FROND_EAR_CONFIG)",
      daemonDefault: false,
    };
  }
  return {
    path: resolve(cwd, daemonConfigPath(env)),
    from:
      env.FROND_EAR_CONFIG === undefined
        ? `the daemon's default, ./frond-ear.json in ${cwd}`
        : "FROND_EAR_CONFIG",
    daemonDefault: env.FROND_EAR_CONFIG === undefined,
  };
}

/** init's ~/.config file, when the daemon's default path has no config and that file exists. */
function strandedConfig(
  source: ConfigSource,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const home = resolve(defaultConfigPath(env));
  return source.daemonDefault &&
    home !== source.path &&
    !existsSync(source.path) &&
    existsSync(home)
    ? home
    : undefined;
}

function configCheck(
  source: ConfigSource,
  env: NodeJS.ProcessEnv,
): { check: Check; ears: string[] } {
  const { path, from } = source;
  if (!existsSync(path)) {
    const stranded = strandedConfig(source, env);
    return {
      check: {
        name: "config",
        ok: false,
        required: true,
        detail: stranded
          ? `no config at ${path} (${from}). ${stranded} exists, but a daemon started here without FROND_EAR_CONFIG will not load it: the daemon has no fallback to that path`
          : `no config at ${path} (${from})`,
        hint: stranded
          ? `export FROND_EAR_CONFIG=${shellWord(stranded)} for the daemon and for doctor (init prints it in front of every command), or pass --config to check that file`
          : "run `frond-ear init`, or point FROND_EAR_CONFIG / --config at the file",
      },
      ears: [],
    };
  }
  try {
    const config = loadConfigFile(path);
    const ears = Object.keys(config.ears);
    return {
      check: {
        name: "config",
        ok: true,
        required: true,
        detail: `${path} (${from}): ${ears.length} ear(s): ${ears.join(", ")}`,
      },
      ears,
    };
  } catch (error) {
    return {
      check: {
        name: "config",
        ok: false,
        required: true,
        detail: `${path} (${from}): ${error instanceof Error ? error.message : String(error)}`,
        hint: "fix the field named above (docs/onboarding.md lists every field), or re-run `frond-ear init --force`",
      },
      ears: [],
    };
  }
}

function tokenCheck(flag: string | undefined, env: NodeJS.ProcessEnv): Check {
  // Same precedence as readBotToken: the file if named, else the variable, else nothing.
  const path = flag || env.DISCORD_BOT_TOKEN_FILE;
  if (!path && env.DISCORD_BOT_TOKEN?.trim()) {
    return {
      name: "token",
      ok: true,
      required: true,
      detail:
        "token comes from DISCORD_BOT_TOKEN (a 0600 file via DISCORD_BOT_TOKEN_FILE is safer)",
    };
  }
  if (!path) {
    const home = resolve(defaultTokenPath(env));
    const found = existsSync(home);
    return {
      name: "token",
      ok: false,
      required: true,
      detail: `neither DISCORD_BOT_TOKEN_FILE nor DISCORD_BOT_TOKEN is set, and the daemon reads its token from nowhere else${found ? `; ${home} exists but the daemon does not look there` : ""}`,
      hint: found
        ? `export DISCORD_BOT_TOKEN_FILE=${shellWord(home)} for the daemon and for doctor`
        : `${createTokenCommand(home)}, then export DISCORD_BOT_TOKEN_FILE=${shellWord(home)}`,
    };
  }
  const file = resolve(path);
  if (!existsSync(file)) {
    return {
      name: "token",
      ok: false,
      required: true,
      detail: `no token file at ${file}`,
      hint: createTokenCommand(file),
    };
  }
  const mode = modeOf(file);
  if (mode !== 0o600) {
    return {
      name: "token",
      ok: false,
      required: true,
      detail: `${file} is mode ${octal(mode)}, want 0600`,
      hint: `chmod 600 ${shellWord(file)}`,
    };
  }
  if (!readFileSync(file, "utf8").trim()) {
    return {
      name: "token",
      ok: false,
      required: true,
      detail: `${file} is empty`,
      hint: "paste the bot token from the Discord developer portal (Bot → Reset Token) into it",
    };
  }
  return {
    name: "token",
    ok: true,
    required: true,
    detail: `${file}: present, 0600, non-empty (contents not read back)`,
  };
}

function socketChecks(env: NodeJS.ProcessEnv, startHint: string): Check[] {
  const tcp = tcpTarget(env);
  if (tcp) {
    return [
      {
        name: "socket",
        ok: true,
        required: true,
        detail: `TCP mode ${tcp.host}:${tcp.port}; no unix socket to check`,
      },
    ];
  }
  const socket = defaultSocketPath(env);
  const directory = dirname(socket);
  const checks: Check[] = [];
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    checks.push({
      name: "socket",
      ok: false,
      required: true,
      detail: `${socket} is ${Buffer.byteLength(socket)} bytes; unix socket paths are limited to ${MAX_SOCKET_PATH}`,
      hint: "set FROND_EAR_SOCKET to a shorter path on both the daemon and every shim",
    });
    return checks;
  }
  if (!existsSync(directory)) {
    checks.push({
      name: "socket dir",
      ok: false,
      required: true,
      detail: `${directory} does not exist (the daemon creates it)`,
      hint: startHint,
    });
    return checks;
  }
  const dirMode = modeOf(directory);
  checks.push({
    name: "socket dir",
    ok: dirMode === 0o700,
    required: true,
    detail: `${directory} is mode ${octal(dirMode)}${dirMode === 0o700 ? "" : ", want 0700"}`,
    ...(dirMode === 0o700 ? {} : { hint: `chmod 700 ${shellWord(directory)}` }),
  });
  if (!existsSync(socket)) {
    checks.push({
      name: "socket",
      ok: false,
      required: true,
      detail: `${socket} does not exist`,
      hint: startHint,
    });
    return checks;
  }
  const mode = modeOf(socket);
  checks.push({
    name: "socket",
    ok: mode === 0o600,
    required: true,
    detail: `${socket} is mode ${octal(mode)}${mode === 0o600 ? "" : ", want 0600"}`,
    ...(mode === 0o600 ? {} : { hint: `chmod 600 ${shellWord(socket)}` }),
  });
  return checks;
}

function earChecks(ear: StatusEar, env: NodeJS.ProcessEnv): Check[] {
  const advice = targetAdvice(ear, env);
  const checks: Check[] = [
    {
      name: `ear ${ear.name}: attached`,
      ok: ear.attached,
      required: false,
      detail: ear.attached
        ? `a shim is attached${ear.sessionId ? ` (session ${ear.sessionId})` : ""}`
        : "no session is attached; the ear keeps ingesting and holds events for it",
      ...(ear.attached || !advice ? {} : { hint: advice.attach }),
    },
  ];
  if (!advice) {
    // config.ts rejects reserved targets, so this is a daemon newer or older than this
    // doctor. Say so rather than guess at its setup.
    checks.push({
      name: `ear ${ear.name}: target`,
      ok: false,
      required: false,
      detail: `target ${String(ear.target)} is not supported by this doctor (claude-channel and copilot-extension are; copilot-sdk and claude-monitor are reserved, not built): no attach or delivery advice`,
    });
  }
  if (!ear.attached) {
    return checks;
  }
  if (ear.registered) {
    checks.push({
      name: `ear ${ear.name}: registered`,
      ok: true,
      required: false,
      detail:
        "delivery confirmed: the session acked the attach canary or used a pushed batch_id in its token form (status does not say which)",
    });
  } else if (ear.delivery === "pending") {
    checks.push({
      name: `ear ${ear.name}: registered`,
      ok: false,
      required: false,
      detail:
        "not yet: the session attached moments ago and has not confirmed delivery (grace period)",
      hint: `re-run doctor in a minute; the session confirms when it does either: ${DELIVERY_PROOF}`,
    });
  } else {
    checks.push({
      name: `ear ${ear.name}: registered`,
      ok: false,
      required: false,
      detail:
        "delivery unconfirmed: the session has neither acked the attach canary nor used a pushed batch_id in its token form (N-<token>). A bare id from tap or inbox marks a batch seen but proves nothing, so a session that has only used those stays unconfirmed while it may still hear",
      hint: `to confirm: ${DELIVERY_PROOF}${advice ? `. If no <channel> events arrive at all: ${advice.deaf}` : ""}`,
    });
  }
  return checks;
}

function claudeCheck(env: NodeJS.ProcessEnv): Check {
  const found = (env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((directory) => join(directory, "claude"))
    .find((candidate) => existsSync(candidate));
  return {
    name: "claude",
    ok: found !== undefined,
    required: false,
    detail: `${found ? `${found} on PATH` : "not on PATH (fine on a host that only runs the daemon)"}. Whether the shim is registered with it is NOT probed: \`claude mcp list\` starts a shim, and the newest attach takes the ear`,
  };
}

function formatChecks(checks: Check[]): string {
  const lines = ["frond-ear doctor"];
  for (const check of checks) {
    const mark = check.ok ? "✓" : "✗";
    const tag = check.ok || check.required ? "" : " (advisory)";
    lines.push(`  ${mark} ${check.name}${tag}: ${check.detail}`);
    if (!check.ok && check.hint) {
      lines.push(`      fix: ${check.hint}`);
    }
  }
  const failed = checks.filter((check) => !check.ok);
  const requiredFailed = failed.filter((check) => check.required);
  lines.push(
    failed.length === 0
      ? `all ${checks.length} checks passed`
      : `${failed.length} of ${checks.length} checks failed (${requiredFailed.length} required)`,
  );
  return `${lines.join("\n")}\n`;
}

export async function doctorChecks(
  values: { config?: string; "token-file"?: string; "timeout-ms"?: string },
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): Promise<Check[]> {
  const checks: Check[] = [nodeCheck()];
  const source = resolveConfigPath(values.config, env, cwd);
  const { check: config, ears: configuredEars } = configCheck(source, env);
  checks.push(config);
  const token = tokenCheck(values["token-file"], env);
  checks.push(token);
  const tokenPath = resolve(
    values["token-file"] ?? env.DISCORD_BOT_TOKEN_FILE ?? defaultTokenPath(env),
  );
  // The config that exists: init's ~/.config file when the daemon's default path has none.
  const startConfig = strandedConfig(source, env) ?? source.path;
  const startHint = `start the daemon: FROND_EAR_CONFIG=${shellWord(startConfig)} DISCORD_BOT_TOKEN_FILE=${shellWord(tokenPath)} ${shellWord(process.execPath)} ${shellWord(CLI)} daemon  (or ops/install-systemd.sh)`;
  checks.push(...socketChecks(env, startHint));

  let status: Status | undefined;
  const timeout = Number(values["timeout-ms"] ?? 3_000);
  try {
    const reply = await request({ type: "status" }, env, timeout);
    if (!reply.ok) {
      throw new Error(reply.text);
    }
    status = JSON.parse(reply.text) as Status;
    checks.push({
      name: "daemon",
      ok: true,
      required: true,
      detail: `answered status over ${tcpTarget(env) ? "TCP" : defaultSocketPath(env)}`,
    });
  } catch (error) {
    checks.push({
      name: "daemon",
      ok: false,
      required: true,
      detail: `not reachable: ${error instanceof Error ? error.message : String(error)}`,
      hint: `${startHint}; if it is running, FROND_EAR_SOCKET must match on both sides`,
    });
  }
  if (status) {
    const state = status.gateway.state;
    const connected = state === "connected";
    checks.push({
      name: "gateway",
      ok: connected || state === "dry-run",
      required: true,
      detail:
        state === "dry-run"
          ? "dry-run: no Discord connection by design"
          : `state ${state}${status.gateway.closeCode ? ` (close code ${status.gateway.closeCode})` : ""}`,
      ...(connected || state === "dry-run"
        ? {}
        : {
            hint: "4004 = wrong token, 4014 = Message Content Intent is off in the developer portal; otherwise wait for the reconnect and read the daemon's stderr / journalctl --user -u frond-ear.service -n 30",
          }),
    });
    if (status.paused) {
      checks.push({
        name: "paused",
        ok: false,
        required: false,
        detail:
          "paused: true in the config; events are ingested but nothing is pushed",
        hint: "set paused to false (the daemon reloads the config live)",
      });
    }
    const statusEars = new Set(status.ears.map((ear) => ear.name));
    for (const name of configuredEars) {
      if (!statusEars.has(name)) {
        checks.push({
          name: `ear ${name}`,
          ok: false,
          required: false,
          detail: "in the config file but not in the running daemon",
          hint: "the daemon loaded a different config, or rejected the last reload: check its stderr",
        });
      }
    }
    for (const ear of status.ears) {
      checks.push(...earChecks(ear, env));
    }
  }
  // A daemon whose ears are all Copilot has no use for `claude`; otherwise assume it might.
  const copilotOnly =
    status !== undefined &&
    status.ears.length > 0 &&
    status.ears.every((ear) => ear.target === "copilot-extension");
  if (!copilotOnly) {
    checks.push(claudeCheck(env));
  }
  return checks;
}

export async function runDoctor(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args: argv, options: DOCTOR_OPTIONS });
  const checks = await doctorChecks(values, io.env);
  const ok = checks.every((check) => check.ok || !check.required);
  io.stdout.write(
    values.json === true
      ? `${JSON.stringify({ ok, checks }, null, 2)}\n`
      : formatChecks(checks),
  );
  return ok ? 0 : 1;
}
