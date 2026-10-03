// ops/install-systemd.sh against a temp HOME. systemctl and loginctl are stubs on PATH, so no
// unit is ever installed on the host; the status poll at the end talks to an in-process daemon.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseConfig } from "../src/config.ts";
import { listenUnix } from "../src/server.ts";
import { BOT, CHANNEL, PRINCIPAL, harness } from "./helpers.ts";

const INSTALLER = join(import.meta.dirname, "..", "ops", "install-systemd.sh");

const CONFIG_JSON = {
  botUserId: BOT,
  principals: [PRINCIPAL],
  ears: {
    scribe: {
      target: "claude-channel",
      channels: { [CHANNEL]: "mentions" },
    },
  },
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function install(env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((done) => {
    execFile("bash", [INSTALLER], { env }, (error, stdout, stderr) => {
      done({
        code: error ? Number((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
      });
    });
  });
}

function stubBin(directory: string, log: string): string {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> '${log}'\n`, {
    mode: 0o755,
  });
  writeFileSync(join(bin, "loginctl"), "#!/bin/sh\necho yes\n", {
    mode: 0o755,
  });
  return bin;
}

test("install-systemd: custom config and token paths on a fresh HOME with no ~/.config/frond-ear install the unit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-install-"));
  const h = harness(parseConfig(CONFIG_JSON), {
    gatewayStatus: () => ({ state: "connected" }),
  });
  const socketPath = join(directory, "run", "daemon.sock");
  const server = await listenUnix(h.daemon, socketPath);
  try {
    const log = join(directory, "systemctl.log");
    const bin = stubBin(directory, log);
    const base = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      USER: "frond-ear-test",
      NODE_BIN: process.execPath,
      FROND_EAR_SOCKET: socketPath,
    };

    // Custom paths, and the default directory does not exist.
    const home = join(directory, "home");
    const custom = join(directory, "custom");
    mkdirSync(home);
    mkdirSync(custom, { mode: 0o755 });
    chmodSync(custom, 0o755);
    const config = join(custom, "frond-ear.json");
    const token = join(custom, "token");
    writeFileSync(config, JSON.stringify(CONFIG_JSON), { mode: 0o644 });
    writeFileSync(token, "not-a-real-token\n", { mode: 0o644 });
    const run = await install({
      ...base,
      HOME: home,
      FROND_EAR_CONFIG: config,
      DISCORD_BOT_TOKEN_FILE: token,
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /installed and connected \(frond-ear\.service\)/u);
    const unit = readFileSync(
      join(home, ".config", "systemd", "user", "frond-ear.service"),
      "utf8",
    );
    assert.match(
      unit,
      new RegExp(`Environment=FROND_EAR_CONFIG=${config}\n`, "u"),
    );
    assert.match(
      unit,
      new RegExp(`Environment=DISCORD_BOT_TOKEN_FILE=${token}\n`, "u"),
    );
    assert.equal(
      existsSync(join(home, ".config", "frond-ear")),
      false,
      "the unused default directory is not created",
    );
    assert.equal(
      statSync(custom).mode & 0o777,
      0o755,
      "a custom file's directory is left alone",
    );
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.equal(statSync(token).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "--user daemon-reload",
      "--user enable --now frond-ear.service",
    ]);

    // Default paths: the directory holds both files and is tightened to 0700.
    const home2 = join(directory, "home2");
    const confDir = join(home2, ".config", "frond-ear");
    mkdirSync(confDir, { recursive: true, mode: 0o755 });
    chmodSync(confDir, 0o755);
    writeFileSync(join(confDir, "frond-ear.json"), JSON.stringify(CONFIG_JSON));
    writeFileSync(join(confDir, "token"), "not-a-real-token\n");
    const defaults = await install({ ...base, HOME: home2 });
    assert.equal(defaults.code, 0, defaults.stderr);
    assert.equal(statSync(confDir).mode & 0o777, 0o700);
    assert.match(
      readFileSync(
        join(home2, ".config", "systemd", "user", "frond-ear.service"),
        "utf8",
      ),
      new RegExp(
        `Environment=FROND_EAR_CONFIG=${join(confDir, "frond-ear.json")}\n`,
        "u",
      ),
    );
  } finally {
    server.close();
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
