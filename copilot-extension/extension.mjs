// frond-ear as a GitHub Copilot CLI extension. Installed by `frond-ear copilot-extension`
// into ~/.copilot/extensions/frond-ear/ beside core.mjs and config.json; the CLI forks it
// with `copilot --experimental` and resolves `@github/copilot-sdk` itself.

import { readFileSync } from "node:fs";

import { joinSession } from "@github/copilot-sdk/extension";

import { start } from "./core.mjs";

const config = JSON.parse(
  readFileSync(new URL("./config.json", import.meta.url), "utf8"),
);

await start(joinSession, config, {
  readToken: (path) => readFileSync(path, "utf8").trim(),
});
