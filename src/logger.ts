// Salvaged from codeagent/frond-ear-live-canary-v2 (src/logger.ts).
const SENSITIVE_KEY =
  /(token|secret|authorization|content|payload|body|error|text)/iu;

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets) {
      if (secret) {
        result = result.replaceAll(secret, "[REDACTED]");
      }
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, secrets),
      ]),
    );
  }
  return value;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * JSON-lines logger. Keys that can carry message content or credentials are
 * redacted wholesale; known secret values are scrubbed from every string.
 */
export class StructuredLogger {
  private readonly sink: (line: string) => void;
  private readonly secrets: readonly string[];

  public constructor(
    sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
    secrets: readonly string[] = [],
  ) {
    this.sink = sink;
    this.secrets = secrets;
  }

  public log(level: LogLevel, event: string, fields: object = {}): void {
    this.sink(
      JSON.stringify(
        redact(
          { time: new Date().toISOString(), level, event, ...fields },
          this.secrets,
        ),
      ),
    );
  }
}
