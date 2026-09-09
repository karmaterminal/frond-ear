import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);
const patterns = [
  {
    name: "Discord bot token",
    expression: /(?:mfa\.[\w-]{20,}|[\w-]{24,}\.[\w-]{6}\.[\w-]{25,})/gu,
  },
  {
    name: "secret assignment",
    expression:
      /(?:DISCORD_BOT_TOKEN|AUTHORIZATION)\s*=\s*["']?[^$\s"'<>]{8,}/giu,
  },
];
const findings = [];
for (const file of files) {
  if (file === "pnpm-lock.yaml") {
    continue;
  }
  const content = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    if (pattern.expression.test(content)) {
      findings.push(`${file}: ${pattern.name}`);
    }
    pattern.expression.lastIndex = 0;
  }
}
if (findings.length > 0) {
  process.stderr.write(
    `Credential-pattern scan failed:\n${findings.join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Credential-pattern scan passed (${files.length} tracked files).\n`,
  );
}
