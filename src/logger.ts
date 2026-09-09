const SENSITIVE_KEY = /(token|secret|authorization|content|payload|body)/iu;

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

export class StructuredLogger {
  public constructor(
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly secrets: readonly string[] = [],
  ) {}

  public log(level: "debug" | "info" | "warn" | "error", event: string, fields = {}): void {
    this.sink(
      JSON.stringify(
        redact(
          {
            time: new Date().toISOString(),
            level,
            event,
            ...fields,
          },
          this.secrets,
        ),
      ),
    );
  }
}
