import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  BatchKind,
  Clock,
  EventState,
  Mode,
  StoredEvent,
  Trust,
} from "./types.ts";
import { systemClock } from "./types.ts";

interface EventRow {
  id: number;
  message_id: string;
  ear: string;
  chat_id: string;
  guild_id: string | null;
  author_id: string;
  author_name: string;
  is_bot: number;
  trust: Trust;
  wake: number;
  priority: number;
  content: string;
  ts: string;
  reply_to: string | null;
  attachments: string;
  state: EventState;
  batch_id: number | null;
  created_at: number;
}

export interface NewEvent {
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
  attachments: StoredEvent["attachments"];
  state: "queued" | "context" | "stored";
}

export interface GatewayCursor {
  sessionId: string | null;
  sequence: number | null;
  resumeGatewayUrl: string | null;
}

export interface EarRecord {
  name: string;
  generation: number;
  attachedAt: number | null;
  sessionId: string | null;
  registered: boolean;
  canaryNonce: string | null;
}

export interface Batch {
  id: number;
  ear: string;
  chatId: string;
  kind: BatchKind;
  events: StoredEvent[];
}

function mapEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    messageId: row.message_id,
    ear: row.ear,
    chatId: row.chat_id,
    guildId: row.guild_id,
    authorId: row.author_id,
    authorName: row.author_name,
    isBot: row.is_bot === 1,
    trust: row.trust,
    wake: row.wake === 1,
    priority: row.priority === 1,
    content: row.content,
    timestamp: row.ts,
    replyTo: row.reply_to,
    attachments: JSON.parse(row.attachments) as StoredEvent["attachments"],
    state: row.state,
    batchId: row.batch_id,
    createdAt: row.created_at,
  };
}

const PENDING_STATES = "('context', 'queued', 'stored')";
const UNSEEN_STATES = "('context', 'queued', 'stored', 'offered')";

export class EventStore {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  public constructor(path: string, clock: Clock = systemClock) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.clock = clock;
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        ear TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        guild_id TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        is_bot INTEGER NOT NULL CHECK (is_bot IN (0, 1)),
        trust TEXT NOT NULL CHECK (trust IN ('principal', 'peer_agent', 'ambient')),
        wake INTEGER NOT NULL CHECK (wake IN (0, 1)),
        priority INTEGER NOT NULL CHECK (priority IN (0, 1)),
        content TEXT NOT NULL,
        ts TEXT NOT NULL,
        reply_to TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL CHECK (state IN
          ('context', 'queued', 'stored', 'offered', 'seen', 'expired', 'dropped')),
        due_at INTEGER,
        batch_id INTEGER REFERENCES batches(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_chat_state ON events (ear, chat_id, state, created_at);
      CREATE INDEX IF NOT EXISTS events_due ON events (state, due_at);
      CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ear TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        attach_generation INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        offered_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS ears (
        name TEXT PRIMARY KEY,
        generation INTEGER NOT NULL DEFAULT 0,
        attached_at INTEGER,
        session_id TEXT,
        registered INTEGER NOT NULL DEFAULT 0,
        canary_nonce TEXT
      );
      CREATE TABLE IF NOT EXISTS gateway_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        session_id TEXT,
        sequence INTEGER,
        resume_gateway_url TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_parents (
        thread_id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attention (
        ear TEXT NOT NULL,
        scope TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('silent', 'mentions', 'room')),
        set_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (ear, scope)
      );
      CREATE TABLE IF NOT EXISTS outbound_intents (
        nonce TEXT PRIMARY KEY,
        intent_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        preview TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed')),
        message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbound_intents_key
        ON outbound_intents (intent_key, state, created_at);
      CREATE TABLE IF NOT EXISTS sent_messages (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dm_channels (
        channel_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_state (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  public close(): void {
    this.database.close();
  }

  /** Runs `work` in one IMMEDIATE transaction (not re-entrant). */
  public atomically<T>(work: () => T): T {
    return this.transaction(work);
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- counters and runtime state ------------------------------------------

  public increment(name: string, by = 1): void {
    this.database
      .prepare(
        `INSERT INTO counters (name, value) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`,
      )
      .run(name, by);
  }

  public counters(): Record<string, number> {
    const rows = this.database
      .prepare("SELECT name, value FROM counters ORDER BY name")
      .all() as Array<{ name: string; value: number }>;
    return Object.fromEntries(rows.map((row) => [row.name, row.value]));
  }

  public setRuntimeState(name: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO runtime_state (name, value) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      )
      .run(name, value);
  }

  // ---- gateway cursor ------------------------------------------------------

  public gatewayState(): GatewayCursor {
    const row = this.database
      .prepare(
        "SELECT session_id, sequence, resume_gateway_url FROM gateway_state WHERE singleton = 1",
      )
      .get() as
      | {
          session_id: string | null;
          sequence: number | null;
          resume_gateway_url: string | null;
        }
      | undefined;
    return {
      sessionId: row?.session_id ?? null,
      sequence: row?.sequence ?? null,
      resumeGatewayUrl: row?.resume_gateway_url ?? null,
    };
  }

  public saveGatewayState(state: GatewayCursor): void {
    this.database
      .prepare(
        `INSERT INTO gateway_state (singleton, session_id, sequence, resume_gateway_url, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET session_id = excluded.session_id,
           sequence = excluded.sequence, resume_gateway_url = excluded.resume_gateway_url,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.sessionId,
        state.sequence,
        state.resumeGatewayUrl,
        this.clock.now(),
      );
  }

  public clearGatewaySession(): void {
    this.saveGatewayState({
      sessionId: null,
      sequence: null,
      resumeGatewayUrl: null,
    });
  }

  // ---- routing memory ------------------------------------------------------

  public setThreadParent(threadId: string, parentId: string): void {
    this.database
      .prepare(
        `INSERT INTO thread_parents (thread_id, parent_id) VALUES (?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET parent_id = excluded.parent_id`,
      )
      .run(threadId, parentId);
  }

  public threadParent(threadId: string): string | undefined {
    const row = this.database
      .prepare("SELECT parent_id FROM thread_parents WHERE thread_id = ?")
      .get(threadId) as { parent_id: string } | undefined;
    return row?.parent_id;
  }

  public recordDmChannel(channelId: string, userId: string): void {
    this.database
      .prepare(
        `INSERT INTO dm_channels (channel_id, user_id) VALUES (?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET user_id = excluded.user_id`,
      )
      .run(channelId, userId);
  }

  // ---- session-chosen attention -------------------------------------------------

  /** `scope` is a chat ID, or "*" for every chat of the ear. */
  public setAttention(
    ear: string,
    scope: string,
    mode: Mode,
    expiresAt: number | null,
  ): void {
    this.database
      .prepare(
        `INSERT INTO attention (ear, scope, mode, set_at, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ear, scope) DO UPDATE SET mode = excluded.mode,
           set_at = excluded.set_at, expires_at = excluded.expires_at`,
      )
      .run(ear, scope, mode, this.clock.now(), expiresAt);
  }

  /** Clears one scope, or every override of the ear when scope is omitted. */
  public clearAttention(ear: string, scope?: string): number {
    const result =
      scope === undefined
        ? this.database.prepare("DELETE FROM attention WHERE ear = ?").run(ear)
        : this.database
            .prepare("DELETE FROM attention WHERE ear = ? AND scope = ?")
            .run(ear, scope);
    return Number(result.changes);
  }

  /** Active overrides for an ear; expired ones are removed as they are read. */
  public attentionOverrides(
    ear: string,
    now: number,
  ): Array<{
    scope: string;
    mode: Mode;
    setAt: number;
    expiresAt: number | null;
  }> {
    this.database
      .prepare(
        "DELETE FROM attention WHERE ear = ? AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(ear, now);
    return this.database
      .prepare(
        `SELECT scope, mode, set_at AS setAt, expires_at AS expiresAt FROM attention
           WHERE ear = ? ORDER BY scope`,
      )
      .all(ear) as Array<{
      scope: string;
      mode: Mode;
      setAt: number;
      expiresAt: number | null;
    }>;
  }

  /** The session's choice for a chat: a chat-specific override beats "*". */
  public attentionFor(
    ear: string,
    chatId: string,
    now: number,
  ): Mode | undefined {
    const overrides = this.attentionOverrides(ear, now);
    return (
      overrides.find((item) => item.scope === chatId) ??
      overrides.find((item) => item.scope === "*")
    )?.mode;
  }

  /**
   * Applies a narrowed mode to rows already waiting in a chat: silent turns
   * pending pushes into inbox-only rows; mentions demotes unaddressed queued
   * rows to context. Nothing is ever promoted by this.
   */
  public narrowPending(ear: string, chatId: string, mode: Mode): number {
    if (mode === "silent") {
      return this.silenceChat(ear, chatId);
    }
    if (mode === "mentions") {
      return Number(
        this.database
          .prepare(
            `UPDATE events SET state = 'context', due_at = NULL, updated_at = ?
             WHERE ear = ? AND chat_id = ? AND state = 'queued' AND priority = 0`,
          )
          .run(this.clock.now(), ear, chatId).changes,
      );
    }
    return 0;
  }

  // ---- outbound intents (write-ahead for sends) ------------------------------------

  /**
   * Records the intent to send one message *before* calling Discord. If an
   * earlier attempt with the same key is still pending (its outcome unknown:
   * crash, timeout, lost response) and within `reuseWindowMs`, its nonce is
   * reused so Discord's enforce_nonce returns the original message instead of
   * posting a duplicate. A completed send is never reused, so a deliberate
   * repeat of the same text still posts.
   */
  public beginSend(
    key: string,
    chatId: string,
    preview: string,
    nonce: string,
    reuseWindowMs: number,
  ): { nonce: string; reused: boolean } {
    const now = this.clock.now();
    const pending = this.database
      .prepare(
        `SELECT nonce FROM outbound_intents
         WHERE intent_key = ? AND state = 'pending' AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(key, now - reuseWindowMs) as { nonce: string } | undefined;
    if (pending) {
      this.database
        .prepare("UPDATE outbound_intents SET updated_at = ? WHERE nonce = ?")
        .run(now, pending.nonce);
      return { nonce: pending.nonce, reused: true };
    }
    this.database
      .prepare(
        `INSERT INTO outbound_intents
           (nonce, intent_key, chat_id, preview, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(nonce, key, chatId, preview.slice(0, 80), now, now);
    return { nonce, reused: false };
  }

  /** Discord confirmed the post: mark the intent sent and keep the receipt. */
  public completeSend(nonce: string, messageId: string, chatId: string): void {
    this.transaction(() => {
      this.database
        .prepare(
          `UPDATE outbound_intents SET state = 'sent', message_id = ?, updated_at = ?
           WHERE nonce = ?`,
        )
        .run(messageId, this.clock.now(), nonce);
      this.recordSent(messageId, chatId);
    });
  }

  /** Discord definitively rejected the post (a 4xx other than 429). */
  public failSend(nonce: string): void {
    this.database
      .prepare(
        "UPDATE outbound_intents SET state = 'failed', updated_at = ? WHERE nonce = ?",
      )
      .run(this.clock.now(), nonce);
  }

  /** Sends whose outcome is unknown (pending and not in flight right now). */
  public ambiguousSends(exclude: ReadonlySet<string>): Array<{
    nonce: string;
    chatId: string;
    preview: string;
    createdAt: number;
  }> {
    return (
      this.database
        .prepare(
          `SELECT nonce, chat_id AS chatId, preview, created_at AS createdAt
           FROM outbound_intents WHERE state = 'pending' ORDER BY created_at`,
        )
        .all() as Array<{
        nonce: string;
        chatId: string;
        preview: string;
        createdAt: number;
      }>
    ).filter((row) => !exclude.has(row.nonce));
  }

  /** Remembers a message frond-ear itself sent, so edits can be authorised. */
  public recordSent(messageId: string, channelId: string): void {
    this.database
      .prepare(
        `INSERT INTO sent_messages (message_id, channel_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(message_id) DO NOTHING`,
      )
      .run(messageId, channelId, this.clock.now());
  }

  public sentIn(messageId: string, channelId: string): boolean {
    return (
      this.database
        .prepare(
          "SELECT 1 AS found FROM sent_messages WHERE message_id = ? AND channel_id = ?",
        )
        .get(messageId, channelId) !== undefined
    );
  }

  public isDmChannel(channelId: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 AS found FROM dm_channels WHERE channel_id = ?")
        .get(channelId) !== undefined
    );
  }

  // ---- events ----------------------------------------------------------------

  public insertEvent(event: NewEvent): "inserted" | "duplicate" {
    const now = this.clock.now();
    const result = this.database
      .prepare(
        `INSERT INTO events (
          message_id, ear, chat_id, guild_id, author_id, author_name, is_bot, trust,
          wake, priority, content, ts, reply_to, attachments, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO NOTHING`,
      )
      .run(
        event.messageId,
        event.ear,
        event.chatId,
        event.guildId,
        event.authorId,
        event.authorName,
        event.isBot ? 1 : 0,
        event.trust,
        event.wake ? 1 : 0,
        event.priority ? 1 : 0,
        event.content,
        event.timestamp,
        event.replyTo,
        JSON.stringify(event.attachments),
        event.state,
        now,
        now,
      );
    return result.changes === 1 ? "inserted" : "duplicate";
  }

  /**
   * Debounce: a chat with queued events flushes at the earliest of
   * - `quietMs` after the latest wake-worthy event (extends while chatter continues),
   * - `maxDelayMs` after the oldest queued event (continuous chatter cannot starve delivery),
   * - `priorityQuietMs` after the oldest queued priority event (later room chatter
   *   cannot push a mention back).
   */
  public scheduleChat(
    ear: string,
    chatId: string,
    quietMs: number,
    maxDelayMs: number,
    priorityQuietMs: number,
  ): void {
    const now = this.clock.now();
    const bounds = this.database
      .prepare(
        `SELECT MIN(created_at) AS oldest,
           MIN(CASE WHEN priority = 1 THEN created_at END) AS oldest_priority
         FROM events WHERE ear = ? AND chat_id = ? AND state = 'queued'`,
      )
      .get(ear, chatId) as {
      oldest: number | null;
      oldest_priority: number | null;
    };
    if (bounds.oldest === null) {
      return;
    }
    let due = Math.min(bounds.oldest + maxDelayMs, now + quietMs);
    if (bounds.oldest_priority !== null) {
      due = Math.min(due, bounds.oldest_priority + priorityQuietMs);
    }
    this.database
      .prepare(
        `UPDATE events SET due_at = ? WHERE ear = ? AND chat_id = ? AND state = 'queued'`,
      )
      .run(due, ear, chatId);
  }

  /** Distinct (ear, chat) pairs that still hold undelivered events. */
  public pendingChats(): Array<{ ear: string; chatId: string }> {
    return this.database
      .prepare(
        `SELECT DISTINCT ear, chat_id AS chatId FROM events
         WHERE state IN ${PENDING_STATES} ORDER BY ear, chat_id`,
      )
      .all() as Array<{ ear: string; chatId: string }>;
  }

  /**
   * Routing for a chat was revoked (channel unbound or moved to another ear):
   * its undelivered events are dropped so the old ear can never receive them.
   */
  public revokeChat(ear: string, chatId: string): number {
    return Number(
      this.database
        .prepare(
          `UPDATE events SET state = 'dropped', due_at = NULL, updated_at = ?
           WHERE ear = ? AND chat_id = ? AND state IN ${PENDING_STATES}`,
        )
        .run(this.clock.now(), ear, chatId).changes,
    );
  }

  /** A chat became silent: pending pushes turn into stored (inbox-only) rows. */
  public silenceChat(ear: string, chatId: string): number {
    return Number(
      this.database
        .prepare(
          `UPDATE events SET state = 'stored', due_at = NULL, updated_at = ?
           WHERE ear = ? AND chat_id = ? AND state IN ('queued', 'context')`,
        )
        .run(this.clock.now(), ear, chatId).changes,
    );
  }

  public dueChats(ear: string, now: number): string[] {
    return (
      this.database
        .prepare(
          `SELECT chat_id FROM events WHERE ear = ? AND state = 'queued'
           GROUP BY chat_id HAVING MIN(due_at) <= ? ORDER BY MIN(due_at)`,
        )
        .all(ear, now) as Array<{ chat_id: string }>
    ).map((row) => row.chat_id);
  }

  public nextDue(ear: string): number | undefined {
    const row = this.database
      .prepare(
        `SELECT MIN(due_at) AS due FROM events WHERE ear = ? AND state = 'queued'`,
      )
      .get(ear) as { due: number | null };
    return row.due ?? undefined;
  }

  /** Bounded ambient history: keep only the newest `limit` context rows. */
  public expireContext(ear: string, chatId: string, limit: number): number {
    const result = this.database
      .prepare(
        `UPDATE events SET state = 'expired', updated_at = ?
         WHERE id IN (
           SELECT id FROM events WHERE ear = ? AND chat_id = ? AND state = 'context'
           ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(this.clock.now(), ear, chatId, limit);
    return Number(result.changes);
  }

  /**
   * Per-ear bound on everything not yet acted on (pending and offered).
   * Oldest context goes first, then offered rows the model already received
   * but never acted on, then silent-channel rows, then queued, so wake-worthy
   * traffic that has not been delivered is the last to be dropped.
   */
  public capPending(ear: string, max: number): number {
    let dropped = 0;
    for (const state of ["context", "offered", "stored", "queued"] as const) {
      const count = (
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM events WHERE ear = ? AND state IN ${UNSEEN_STATES}`,
          )
          .get(ear) as { count: number }
      ).count;
      const excess = count - max;
      if (excess <= 0) {
        break;
      }
      const result = this.database
        .prepare(
          `UPDATE events SET state = 'dropped', due_at = NULL, updated_at = ?
           WHERE id IN (
             SELECT id FROM events WHERE ear = ? AND state = ?
             ORDER BY created_at, id LIMIT ?
           )`,
        )
        .run(this.clock.now(), ear, state, excess);
      dropped += Number(result.changes);
    }
    return dropped;
  }

  /**
   * Queued rows without a flush time can only exist if a crash interrupted
   * admission; give them one so they are delivered rather than stranded.
   */
  public repairUnscheduled(now: number): number {
    return Number(
      this.database
        .prepare(
          "UPDATE events SET due_at = ? WHERE state = 'queued' AND due_at IS NULL",
        )
        .run(now).changes,
    );
  }

  /**
   * Moves a chat's queued events plus its buffered context into a new batch.
   * The batch is unconfirmed until `confirmBatch`; `revertUnconfirmed`
   * returns its events to their prior states if the shim disappears first.
   */
  public takeBatch(
    ear: string,
    chatId: string,
    kind: BatchKind,
    attachGeneration: number,
  ): Batch | undefined {
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT * FROM events WHERE ear = ? AND chat_id = ? AND state IN ('queued', 'context')
           ORDER BY created_at, id`,
        )
        .all(ear, chatId) as unknown as EventRow[];
      if (!rows.some((row) => row.state === "queued")) {
        return undefined;
      }
      const now = this.clock.now();
      const batchId = Number(
        this.database
          .prepare(
            `INSERT INTO batches (ear, chat_id, kind, attach_generation, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(ear, chatId, kind, attachGeneration, now).lastInsertRowid,
      );
      this.database
        .prepare(
          `UPDATE events SET state = 'offered', batch_id = ?, due_at = NULL, updated_at = ?
           WHERE ear = ? AND chat_id = ? AND state IN ('queued', 'context')`,
        )
        .run(batchId, now, ear, chatId);
      return {
        id: batchId,
        ear,
        chatId,
        kind,
        events: rows.map((row) => ({
          ...mapEvent(row),
          state: "offered" as const,
          batchId,
        })),
      };
    });
  }

  public confirmBatch(batchId: number): void {
    this.database
      .prepare(
        "UPDATE batches SET offered_at = ? WHERE id = ? AND offered_at IS NULL",
      )
      .run(this.clock.now(), batchId);
  }

  public revertUnconfirmed(ear: string): number {
    return this.transaction(() => {
      const batches = this.database
        .prepare("SELECT id FROM batches WHERE ear = ? AND offered_at IS NULL")
        .all(ear) as Array<{ id: number }>;
      const now = this.clock.now();
      for (const batch of batches) {
        this.database
          .prepare(
            `UPDATE events SET state = CASE WHEN wake = 1 THEN 'queued' ELSE 'context' END,
               due_at = CASE WHEN wake = 1 THEN ? ELSE NULL END, batch_id = NULL, updated_at = ?
             WHERE batch_id = ? AND state = 'offered'`,
          )
          .run(now, now, batch.id);
        this.database.prepare("DELETE FROM batches WHERE id = ?").run(batch.id);
      }
      return batches.length;
    });
  }

  /** Offered-but-unseen events from attaches before `generation`, per chat. */
  public unseenFromEarlierAttaches(
    ear: string,
    generation: number,
  ): Array<{ chatId: string; count: number }> {
    return this.database
      .prepare(
        `SELECT e.chat_id AS chatId, COUNT(*) AS count FROM events e
           JOIN batches b ON b.id = e.batch_id
           WHERE e.ear = ? AND e.state = 'offered' AND b.attach_generation < ?
           GROUP BY e.chat_id ORDER BY e.chat_id`,
      )
      .all(ear, generation) as Array<{ chatId: string; count: number }>;
  }

  public markSeen(ear: string, chatId?: string, ids?: number[]): number {
    const now = this.clock.now();
    if (ids) {
      let changed = 0;
      for (const id of ids) {
        changed += Number(
          this.database
            .prepare(
              `UPDATE events SET state = 'seen', updated_at = ?
               WHERE id = ? AND ear = ? AND state IN ${UNSEEN_STATES}`,
            )
            .run(now, id, ear).changes,
        );
      }
      return changed;
    }
    const result =
      chatId === undefined
        ? this.database
            .prepare(
              `UPDATE events SET state = 'seen', updated_at = ? WHERE ear = ? AND state = 'offered'`,
            )
            .run(now, ear)
        : this.database
            .prepare(
              `UPDATE events SET state = 'seen', updated_at = ?
               WHERE ear = ? AND chat_id = ? AND state = 'offered'`,
            )
            .run(now, ear, chatId);
    return Number(result.changes);
  }

  /** Highest batch id the shim has confirmed for this ear (and chat). */
  public latestConfirmedBatch(ear: string, chatId?: string): number {
    const row = (
      chatId === undefined
        ? this.database
            .prepare(
              "SELECT MAX(id) AS id FROM batches WHERE ear = ? AND offered_at IS NOT NULL",
            )
            .get(ear)
        : this.database
            .prepare(
              "SELECT MAX(id) AS id FROM batches WHERE ear = ? AND chat_id = ? AND offered_at IS NOT NULL",
            )
            .get(ear, chatId)
    ) as { id: number | null };
    return row.id ?? 0;
  }

  /**
   * Marks offered events seen only up to (and including) `throughBatch`, and
   * only from confirmed batches, so a batch delivered after the model acted
   * is never acknowledged on its behalf.
   */
  public markSeenThrough(
    ear: string,
    chatId: string | undefined,
    throughBatch: number,
  ): number {
    const now = this.clock.now();
    const sql = `UPDATE events SET state = 'seen', updated_at = ?
      WHERE ear = ? AND state = 'offered' AND batch_id <= ?
        AND batch_id IN (SELECT id FROM batches WHERE offered_at IS NOT NULL)`;
    const result =
      chatId === undefined
        ? this.database.prepare(sql).run(now, ear, throughBatch)
        : this.database
            .prepare(`${sql} AND chat_id = ?`)
            .run(now, ear, throughBatch, chatId);
    return Number(result.changes);
  }

  /** Unseen events (pending or offered), newest last, for the inbox tool. */
  public unseen(
    ear: string,
    chatId: string | undefined,
    limit: number,
  ): StoredEvent[] {
    const rows = (chatId === undefined
      ? this.database
          .prepare(
            `SELECT * FROM events WHERE ear = ? AND state IN ${UNSEEN_STATES}
               ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(ear, limit)
      : this.database
          .prepare(
            `SELECT * FROM events WHERE ear = ? AND chat_id = ? AND state IN ${UNSEEN_STATES}
               ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(ear, chatId, limit)) as unknown as EventRow[];
    return rows.map(mapEvent).reverse();
  }

  public recent(chatId: string, limit: number): StoredEvent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM events WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(chatId, limit) as unknown as EventRow[];
    return rows.map(mapEvent).reverse();
  }

  public stateCounts(ear: string): Record<EventState, number> {
    const counts: Record<EventState, number> = {
      context: 0,
      queued: 0,
      stored: 0,
      offered: 0,
      seen: 0,
      expired: 0,
      dropped: 0,
    };
    const rows = this.database
      .prepare(
        "SELECT state, COUNT(*) AS count FROM events WHERE ear = ? GROUP BY state",
      )
      .all(ear) as Array<{ state: EventState; count: number }>;
    for (const row of rows) {
      counts[row.state] = row.count;
    }
    return counts;
  }

  public lastEventAt(ear: string): number | null {
    const row = this.database
      .prepare("SELECT MAX(created_at) AS last FROM events WHERE ear = ?")
      .get(ear) as { last: number | null };
    return row.last;
  }

  public prune(retentionMs: number): number {
    const cutoff = this.clock.now() - retentionMs;
    return this.transaction(() => {
      const events = Number(
        this.database
          .prepare(
            `DELETE FROM events WHERE updated_at < ?
             AND state IN ('seen', 'expired', 'dropped', 'offered')`,
          )
          .run(cutoff).changes,
      );
      this.database
        .prepare(
          "DELETE FROM outbound_intents WHERE updated_at < ? AND state IN ('sent', 'failed')",
        )
        .run(cutoff);
      this.database
        .prepare(
          `DELETE FROM batches WHERE created_at < ?
           AND NOT EXISTS (SELECT 1 FROM events WHERE events.batch_id = batches.id)`,
        )
        .run(cutoff);
      return events;
    });
  }

  // ---- ears -------------------------------------------------------------------

  public attachEar(
    name: string,
    sessionId: string | null,
    canaryNonce: string | null,
  ): EarRecord {
    return this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO ears (name, generation, attached_at, session_id, registered, canary_nonce)
           VALUES (?, 1, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET generation = generation + 1,
             attached_at = excluded.attached_at, session_id = excluded.session_id,
             registered = excluded.registered, canary_nonce = excluded.canary_nonce`,
        )
        .run(
          name,
          this.clock.now(),
          sessionId,
          canaryNonce === null ? 1 : 0,
          canaryNonce,
        );
      return this.ear(name) as EarRecord;
    });
  }

  public ear(name: string): EarRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT name, generation, attached_at, session_id, registered, canary_nonce FROM ears WHERE name = ?",
      )
      .get(name) as
      | {
          name: string;
          generation: number;
          attached_at: number | null;
          session_id: string | null;
          registered: number;
          canary_nonce: string | null;
        }
      | undefined;
    return row
      ? {
          name: row.name,
          generation: row.generation,
          attachedAt: row.attached_at,
          sessionId: row.session_id,
          registered: row.registered === 1,
          canaryNonce: row.canary_nonce,
        }
      : undefined;
  }

  public updateEarSession(name: string, sessionId: string): void {
    this.database
      .prepare("UPDATE ears SET session_id = ? WHERE name = ?")
      .run(sessionId, name);
  }

  public registerEar(name: string, nonce: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE ears SET registered = 1, canary_nonce = NULL
         WHERE name = ? AND canary_nonce = ?`,
      )
      .run(name, nonce);
    return result.changes === 1;
  }
}
