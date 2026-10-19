export type Trust = "principal" | "peer_agent" | "ambient";

export type Mode = "silent" | "mentions" | "room";

/**
 * Ledger states. `context` (mentions-mode ambient traffic) and `queued`
 * (wake-worthy) are pending delivery; `stored` is silent-mode traffic that is
 * never pushed. `offered` means rendered into a channel notification; `seen`
 * means the model acted on the chat through a tool. `expired` and `dropped`
 * are bounded-history and overflow dispositions.
 */
export type EventState =
  | "context"
  | "queued"
  | "stored"
  | "offered"
  | "seen"
  | "expired"
  | "dropped";

export type BatchKind = "mention" | "room" | "dm";

export interface DiscordAuthor {
  id: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  content_type?: string;
  url: string;
}

/**
 * A message component, with only the fields frond-ear reads text from. Components V2 nest:
 * a Container or Section holds `components`, and a Section may have a button `accessory`.
 */
export interface DiscordComponent {
  type: number;
  /** A TextDisplay's text. */
  content?: string;
  /** A button's label, and a link button's URL. */
  label?: string;
  url?: string;
  /** A select menu's placeholder. */
  placeholder?: string;
  components?: DiscordComponent[];
  accessory?: DiscordComponent;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordAuthor;
  member?: { nick?: string | null };
  content: string;
  timestamp: string;
  mentions?: Array<{ id: string }>;
  attachments?: DiscordAttachment[];
  /** Where a Components V2 message (flag IS_COMPONENTS_V2, 1 << 15) keeps its text. */
  components?: DiscordComponent[];
  message_reference?: { message_id?: string; channel_id?: string };
  referenced_message?: { id: string; author: DiscordAuthor } | null;
  webhook_id?: string;
  type?: number;
}

export interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

export interface StoredEvent {
  id: number;
  messageId: string;
  ear: string;
  chatId: string;
  guildId: string | null;
  authorId: string;
  authorName: string;
  isBot: boolean;
  trust: Trust;
  wake: boolean;
  priority: boolean;
  content: string;
  timestamp: string;
  replyTo: string | null;
  attachments: Array<{ name: string; type: string; size: number }>;
  state: EventState;
  batchId: number | null;
  createdAt: number;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimers: Timers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
