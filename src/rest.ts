import type { DiscordMessage } from "./types.ts";

export const DISCORD_MESSAGE_LIMIT = 2_000;

export interface DiscordRest {
  /**
   * `nonce` is sent with `enforce_nonce`, so Discord returns the original
   * message instead of creating a second one when the same nonce is retried
   * within its dedupe window.
   */
  sendMessage(
    channelId: string,
    content: string,
    replyTo?: string,
    nonce?: string,
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
  fetchMessage(channelId: string, messageId: string): Promise<DiscordMessage>;
  /**
   * Downloads an attachment from Discord's CDN, never sending the bot token,
   * refusing redirects and stopping at `maxBytes`.
   */
  downloadAttachment(url: string, maxBytes: number): Promise<Uint8Array>;
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

/** Every caller-influenced path segment is encoded, never interpolated raw. */
const seg = (value: string): string => encodeURIComponent(value);

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
    nonce?: string,
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      content,
      allowed_mentions: { parse: ["users"], replied_user: false },
    };
    if (nonce) {
      body.nonce = nonce;
      body.enforce_nonce = true;
    }
    if (replyTo) {
      body.message_reference = {
        message_id: replyTo,
        fail_if_not_exists: false,
      };
    }
    const result = (await this.request(
      "POST",
      `/channels/${seg(channelId)}/messages`,
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
      `/channels/${seg(channelId)}/messages/${seg(messageId)}/reactions/${encodeEmoji(emoji)}/@me`,
    );
  }

  public async editMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    await this.request(
      "PATCH",
      `/channels/${seg(channelId)}/messages/${seg(messageId)}`,
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
      `/channels/${seg(channelId)}/messages?${query.toString()}`,
    )) as DiscordMessage[];
  }

  public async fetchMessage(
    channelId: string,
    messageId: string,
  ): Promise<DiscordMessage> {
    return (await this.request(
      "GET",
      `/channels/${seg(channelId)}/messages/${seg(messageId)}`,
    )) as DiscordMessage;
  }

  public async downloadAttachment(
    url: string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    assertAttachmentUrl(url);
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    // No Authorization header: CDN URLs are signed, and the bot token must never
    // leave for anything but the API. No redirects: a hop off the CDN is refused.
    const response = await fetchImpl(url, { redirect: "error" });
    if (!response.ok || !response.body) {
      throw new Error(`attachment download failed: ${response.status}`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new Error(`attachment is larger than ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

const ATTACHMENT_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

/** Only https URLs on Discord's attachment CDN are ever fetched. */
export function assertAttachmentUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("attachment URL is not a URL");
  }
  if (
    parsed.protocol !== "https:" ||
    !ATTACHMENT_HOSTS.has(parsed.hostname) ||
    parsed.port !== ""
  ) {
    throw new Error(
      `attachment URL is not on Discord's CDN: ${parsed.hostname}`,
    );
  }
}

export interface RecordedCall {
  method: "send" | "react" | "edit" | "fetch" | "fetch_one" | "download";
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

  private readonly byNonce = new Map<string, string>();

  public async sendMessage(
    channelId: string,
    content: string,
    replyTo?: string,
    nonce?: string,
  ): Promise<{ id: string }> {
    // Mirror Discord's enforce_nonce: a repeated nonce returns the original.
    const existing = nonce
      ? this.byNonce.get(`${channelId}:${nonce}`)
      : undefined;
    if (existing) {
      return { id: existing };
    }
    // Snowflake-shaped so dry-run replies can be edited like real ones.
    const id = String(900_000_000_000_000_000n + BigInt(this.nextId++));
    if (nonce) {
      this.byNonce.set(`${channelId}:${nonce}`, id);
    }
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

  /** Test seam: messages by id and attachment bytes by URL. */
  public readonly messages = new Map<string, DiscordMessage>();
  public readonly files = new Map<string, Uint8Array>();

  public async fetchMessage(
    channelId: string,
    messageId: string,
  ): Promise<DiscordMessage> {
    this.record({ method: "fetch_one", channelId, messageId });
    const message = this.messages.get(messageId);
    if (!message) {
      throw new RestError(404, 10008, "Unknown Message");
    }
    return message;
  }

  public async downloadAttachment(
    url: string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    assertAttachmentUrl(url);
    this.record({ method: "download", channelId: "", content: url });
    const bytes = this.files.get(url);
    if (!bytes) {
      throw new Error("attachment download failed: 404");
    }
    if (bytes.length > maxBytes) {
      throw new Error(`attachment is larger than ${maxBytes} bytes`);
    }
    return bytes;
  }
}
