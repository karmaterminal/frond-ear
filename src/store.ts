import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  BatchKind,
  Clock,
  EventState,
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
   * Per-ear pending cap. Oldest context goes first, then stored, then queued,
   * so wake-worthy traffic is the last to be dropped.
   */
  public capPending(ear: string, max: number): number {
    let dropped = 0;
    for (const state of ["context", "stored", "queued"] as const) {
      const count = (
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM events WHERE ear = ? AND state IN ${PENDING_STATES}`,
          )
          .get(ear) as { count: number }
      ).count;
      const excess = count - max;
      if (excess <= 0) {
        break;
      }
      const result = this.database
        .prepare(
          `UPDATE events SET state = 'dropped', updated_at = ?
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
            `DELETE FROM events WHERE updated_at < ? AND state IN ('seen', 'expired', 'dropped')`,
          )
          .run(cutoff).changes,
      );
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
