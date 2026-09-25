import type { DiscordMessage } from "./types.ts";

export const DISCORD_MESSAGE_LIMIT = 2_000;

export interface DiscordRest {
  sendMessage(
    channelId: string,
    content: string,
    replyTo?: string,
  ): Promise<{ id: string }>;
  addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void>;
  editMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<void>;
  fetchMessages(
    channelId: string,
    options: { limit: number; before?: string },
  ): Promise<DiscordMessage[]>;
}

export class RestError extends Error {
  public readonly status: number;
  public readonly code: number | undefined;

  public constructor(
    status: number,
    code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RestError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Splits text into Discord-sized chunks, preferring paragraph, then line,
 * then word boundaries.
 */
export function chunkMessage(
  text: string,
  limit = DISCORD_MESSAGE_LIMIT,
): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit / 2) {
      cut = window.lastIndexOf("\n");
    }
    if (cut < limit / 2) {
      cut = window.lastIndexOf(" ");
    }
    if (cut < limit / 2) {
      cut = limit;
    }
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/u, "");
  }
  if (rest.length > 0 || chunks.length === 0) {
    chunks.push(rest);
  }
  return chunks;
}

function encodeEmoji(emoji: string): string {
  // Custom emoji are passed as name:id; unicode emoji as-is. Both URL-encoded.
  return encodeURIComponent(emoji.replace(/^<a?:/u, "").replace(/>$/u, ""));
}

export interface HttpRestOptions {
  token: string;
  apiBase: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class HttpDiscordRest implements DiscordRest {
  private readonly options: HttpRestOptions;

  public constructor(options: HttpRestOptions) {
    this.options = options;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const maxRetries = this.options.maxRetries ?? 3;
    for (let attempt = 0; ; attempt += 1) {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bot ${this.options.token}`,
          "User-Agent":
            "DiscordBot (https://github.com/karmaterminal/frond-ear, 0.1.0)",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      const response = await fetchImpl(`${this.options.apiBase}${path}`, init);
      if (response.status === 429 && attempt < maxRetries) {
        const payload = (await response.json().catch(() => ({}))) as {
          retry_after?: number;
        };
        const header = Number(response.headers.get("retry-after"));
        const seconds =
          typeof payload.retry_after === "number"
            ? payload.retry_after
            : Number.isFinite(header)
              ? header
              : 1;
        await sleep(Math.ceil(seconds * 1_000));
        continue;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          code?: number;
          message?: string;
        };
        throw new RestError(
          response.status,
          payload.code,
          `Discord ${method} ${path.split("?")[0]} failed: ${response.status} ${payload.message ?? ""}`.trim(),
        );
      }
      if (response.status === 204) {
        return undefined;
      }
      return response.json();
    }
  }

  public async sendMessage(
    channelId: string,
    content: string,
    replyTo?: string,
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      content,
      allowed_mentions: { parse: ["users"], replied_user: false },
    };
    if (replyTo) {
      body.message_reference = {
        message_id: replyTo,
        fail_if_not_exists: false,
      };
    }
    const result = (await this.request(
      "POST",
      `/channels/${channelId}/messages`,
      body,
    )) as { id: string };
    return { id: result.id };
  }

  public async addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeEmoji(emoji)}/@me`,
    );
  }

  public async editMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    await this.request(
      "PATCH",
      `/channels/${channelId}/messages/${messageId}`,
      {
        content,
      },
    );
  }

  public async fetchMessages(
    channelId: string,
    options: { limit: number; before?: string },
  ): Promise<DiscordMessage[]> {
    const query = new URLSearchParams({ limit: String(options.limit) });
    if (options.before) {
      query.set("before", options.before);
    }
    return (await this.request(
      "GET",
      `/channels/${channelId}/messages?${query.toString()}`,
    )) as DiscordMessage[];
  }
}

export interface RecordedCall {
  method: "send" | "react" | "edit" | "fetch";
  channelId: string;
  messageId?: string;
  content?: string;
  replyTo?: string;
  emoji?: string;
}

/** Dry-run and test double: records outbound calls, sends nothing. */
export class RecordingRest implements DiscordRest {
  public readonly calls: RecordedCall[] = [];
  private nextId = 1;
  private readonly history: (
    channelId: string,
    limit: number,
  ) => DiscordMessage[];
  private readonly onCall: ((call: RecordedCall) => void) | undefined;

  public constructor(
    history: (channelId: string, limit: number) => DiscordMessage[] = () => [],
    onCall?: (call: RecordedCall) => void,
  ) {
    this.history = history;
    this.onCall = onCall;
  }

  private record(call: RecordedCall): void {
    this.calls.push(call);
    this.onCall?.(call);
  }

  public async sendMessage(
    channelId: string,
    content: string,
    replyTo?: string,
  ): Promise<{ id: string }> {
    const id = `dry-${this.nextId++}`;
    this.record({
      method: "send",
      channelId,
      messageId: id,
      content,
      ...(replyTo ? { replyTo } : {}),
    });
    return { id };
  }

  public async addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    this.record({ method: "react", channelId, messageId, emoji });
  }

  public async editMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    this.record({ method: "edit", channelId, messageId, content });
  }

  public async fetchMessages(
    channelId: string,
    options: { limit: number; before?: string },
  ): Promise<DiscordMessage[]> {
    this.record({ method: "fetch", channelId });
    return this.history(channelId, options.limit);
  }
}
