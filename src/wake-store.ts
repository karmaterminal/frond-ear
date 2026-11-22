/**
 * The wake ledger (#111): daemon-held schedules and GitHub watches, the durable
 * occurrences they write when they come due, and each delivery of those occurrences
 * under its own nonce.
 *
 * A trigger and the occurrence it owes are one transaction: either the occurrence is
 * written and the trigger advanced (or retired) together, or neither is. An occurrence
 * absorbs further due ticks only until it is first delivered; from then on it is frozen,
 * so a delivery's nonce settles exactly what that delivery showed and nothing later.
 */
import type { DatabaseSync } from "node:sqlite";

export type ScheduleKind = "at" | "every" | "github";

/** `done`: a one-shot fired, or a watch's trigger did. The rest end without firing. */
export type ScheduleState =
  | "active"
  | "done"
  | "cancelled"
  | "expired"
  | "orphaned"
  | "failed";

export interface Schedule {
  id: number;
  ear: string;
  /** The session that set it: the only one shown its note, its target and its wakes. */
  setter: string;
  kind: ScheduleKind;
  note: string;
  periodMs: number | null;
  firstDue: number | null;
  /** A time schedule's next tick; a watch's next poll. Null once ended. */
  nextDue: number | null;
  /** A watch's target (JSON); null for a time schedule. */
  target: string | null;
  /** A watch's cursor (JSON): baseline, ETags, page. */
  cursor: string | null;
  /** A watch's consecutive retryable failures. */
  failures: number;
  failingSince: number | null;
  createdAt: number;
  expiresAt: number;
  /** When the setter last held the ear, for the orphan bound. */
  setterSeenAt: number;
  /** Occurrences written so far. */
  generation: number;
  state: ScheduleState;
  endedAt: number | null;
  endReason: string | null;
}

export type WakeKind = "tick" | "github" | "ended";

export interface Wake {
  id: number;
  scheduleId: number;
  ear: string;
  setter: string;
  generation: number;
  kind: WakeKind;
  firstDue: number;
  latestDue: number;
  /** Due ticks this occurrence covers (1 for a watch's trigger or an ended notice). */
  ticks: number;
  /** The daemon's facts (JSON): a watch's observation, or why a schedule ended. */
  facts: string | null;
  createdAt: number;
  deliveredAt: number | null;
  deliveries: number;
  lastDeliveredAt: number | null;
  ackedAt: number | null;
}

export interface WakeDelivery {
  nonce: string;
  ear: string;
  sessionId: string;
  scheduleId: number;
  deliveredAt: number;
  wakeIds: number[];
}

const SCHEDULE_COLUMNS = `id, ear, setter, kind, note, period_ms AS periodMs, first_due AS firstDue,
  next_due AS nextDue, target, cursor, failures, failing_since AS failingSince,
  created_at AS createdAt, expires_at AS expiresAt, setter_seen_at AS setterSeenAt,
  generation, state, ended_at AS endedAt, end_reason AS endReason`;

const WAKE_COLUMNS = `id, schedule_id AS scheduleId, ear, setter, generation, kind,
  first_due AS firstDue, latest_due AS latestDue, ticks, facts, created_at AS createdAt,
  delivered_at AS deliveredAt, deliveries, last_delivered_at AS lastDeliveredAt,
  acked_at AS ackedAt`;

export const WAKE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ear TEXT NOT NULL,
    setter TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('at', 'every', 'github')),
    note TEXT NOT NULL,
    period_ms INTEGER,
    first_due INTEGER,
    next_due INTEGER,
    target TEXT,
    cursor TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    failing_since INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    setter_seen_at INTEGER NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'active'
      CHECK (state IN ('active', 'done', 'cancelled', 'expired', 'orphaned', 'failed')),
    ended_at INTEGER,
    end_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS schedules_ear ON schedules (ear, state);
  CREATE TABLE IF NOT EXISTS wakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    ear TEXT NOT NULL,
    setter TEXT NOT NULL,
    generation INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('tick', 'github', 'ended')),
    first_due INTEGER NOT NULL,
    latest_due INTEGER NOT NULL,
    ticks INTEGER NOT NULL DEFAULT 1,
    facts TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    deliveries INTEGER NOT NULL DEFAULT 0,
    last_delivered_at INTEGER,
    acked_at INTEGER,
    UNIQUE (schedule_id, generation)
  );
  CREATE INDEX IF NOT EXISTS wakes_owed ON wakes (ear, acked_at);
  CREATE TABLE IF NOT EXISTS wake_deliveries (
    nonce TEXT PRIMARY KEY,
    ear TEXT NOT NULL,
    session_id TEXT NOT NULL,
    schedule_id INTEGER NOT NULL,
    delivered_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wake_delivery_items (
    nonce TEXT NOT NULL,
    wake_id INTEGER NOT NULL,
    PRIMARY KEY (nonce, wake_id)
  );
`;

/** What one due step of a trigger does, in one transaction with its occurrence. */
export type ScheduleAdvance =
  | { next: number }
  | { end: Exclude<ScheduleState, "active">; reason: string };

export class WakeStore {
  private readonly database: DatabaseSync;
  private readonly transaction: <T>(work: () => T) => T;

  public constructor(
    database: DatabaseSync,
    transaction: <T>(work: () => T) => T,
  ) {
    this.database = database;
    this.transaction = transaction;
    database.exec(WAKE_SCHEMA);
  }

  public addSchedule(schedule: {
    ear: string;
    setter: string;
    kind: ScheduleKind;
    note: string;
    periodMs: number | null;
    firstDue: number | null;
    nextDue: number | null;
    target: string | null;
    cursor: string | null;
    createdAt: number;
    expiresAt: number;
  }): number {
    const result = this.database
      .prepare(
        `INSERT INTO schedules (ear, setter, kind, note, period_ms, first_due, next_due, target,
           cursor, created_at, expires_at, setter_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.ear,
        schedule.setter,
        schedule.kind,
        schedule.note,
        schedule.periodMs,
        schedule.firstDue,
        schedule.nextDue,
        schedule.target,
        schedule.cursor,
        schedule.createdAt,
        schedule.expiresAt,
        schedule.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  public schedule(id: number): Schedule | undefined {
    return this.database
      .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?`)
      .get(id) as Schedule | undefined;
  }

  /** Every schedule the ear holds, ended ones included, oldest first. */
  public schedules(ear: string): Schedule[] {
    return this.database
      .prepare(
        `SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE ear = ? ORDER BY id`,
      )
      .all(ear) as unknown as Schedule[];
  }

  /** Active schedules and watches of every ear, soonest first. */
  public active(): Schedule[] {
    return this.database
      .prepare(
        `SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE state = 'active'
          ORDER BY next_due, id`,
      )
      .all() as unknown as Schedule[];
  }

  /** The setter held the ear at `now`: its schedules aren't orphaned. */
  public touchSetter(ear: string, setter: string, now: number): void {
    this.database
      .prepare(
        `UPDATE schedules SET setter_seen_at = MAX(setter_seen_at, ?)
          WHERE ear = ? AND setter = ? AND state = 'active'`,
      )
      .run(now, ear, setter);
  }

  /**
   * Due ticks of a time schedule: they join the schedule's open occurrence (one never
   * delivered or settled), or open the next generation, and the schedule advances or
   * ends, all in one transaction. Ending with an `ended` notice writes that too.
   */
  public recordTicks(
    schedule: Schedule,
    ticks: { firstDue: number; latestDue: number; count: number } | null,
    advance: ScheduleAdvance,
    now: number,
    notice?: { facts: string },
  ): void {
    this.transaction(() => {
      let generation = this.generation(schedule.id);
      if (ticks && ticks.count > 0) {
        const open = this.database
          .prepare(
            `SELECT id FROM wakes WHERE schedule_id = ? AND kind = 'tick'
               AND delivered_at IS NULL AND acked_at IS NULL
             ORDER BY generation DESC LIMIT 1`,
          )
          .get(schedule.id) as { id: number } | undefined;
        if (open) {
          this.database
            .prepare(
              `UPDATE wakes SET latest_due = MAX(latest_due, ?), ticks = ticks + ? WHERE id = ?`,
            )
            .run(ticks.latestDue, ticks.count, open.id);
        } else {
          generation += 1;
          this.insertWake(schedule, generation, "tick", {
            firstDue: ticks.firstDue,
            latestDue: ticks.latestDue,
            ticks: ticks.count,
            facts: null,
            now,
          });
        }
      }
      if ("end" in advance && notice) {
        generation += 1;
        this.insertWake(schedule, generation, "ended", {
          firstDue: now,
          latestDue: now,
          ticks: 0,
          facts: notice.facts,
          now,
        });
      }
      this.advance(schedule.id, generation, advance, now);
    });
  }

  /**
   * A watch's trigger or terminal failure: its occurrence and its retirement, in one
   * transaction, with the cursor that observed it.
   */
  public recordWatch(
    schedule: Schedule,
    kind: "github" | "ended",
    facts: string,
    cursor: string | null,
    advance: ScheduleAdvance,
    now: number,
  ): number {
    return this.transaction(() => {
      const generation = this.generation(schedule.id) + 1;
      const id = this.insertWake(schedule, generation, kind, {
        firstDue: now,
        latestDue: now,
        ticks: kind === "github" ? 1 : 0,
        facts,
        now,
      });
      if (cursor !== null) {
        this.database
          .prepare("UPDATE schedules SET cursor = ? WHERE id = ?")
          .run(cursor, schedule.id);
      }
      this.advance(schedule.id, generation, advance, now);
      return id;
    });
  }

  /** A watch's poll changed nothing that wakes: its cursor, next poll and failure count. */
  public updateWatch(
    id: number,
    fields: {
      cursor: string | null;
      nextDue: number;
      failures: number;
      failingSince: number | null;
    },
  ): void {
    this.database
      .prepare(
        `UPDATE schedules SET cursor = COALESCE(?, cursor), next_due = ?, failures = ?,
           failing_since = ? WHERE id = ? AND state = 'active'`,
      )
      .run(
        fields.cursor,
        fields.nextDue,
        fields.failures,
        fields.failingSince,
        id,
      );
  }

  private generation(scheduleId: number): number {
    const row = this.database
      .prepare("SELECT generation FROM schedules WHERE id = ?")
      .get(scheduleId) as { generation: number } | undefined;
    return row?.generation ?? 0;
  }

  private insertWake(
    schedule: Schedule,
    generation: number,
    kind: WakeKind,
    fields: {
      firstDue: number;
      latestDue: number;
      ticks: number;
      facts: string | null;
      now: number;
    },
  ): number {
    const result = this.database
      .prepare(
        `INSERT INTO wakes (schedule_id, ear, setter, generation, kind, first_due, latest_due,
           ticks, facts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id,
        schedule.ear,
        schedule.setter,
        generation,
        kind,
        fields.firstDue,
        fields.latestDue,
        fields.ticks,
        fields.facts,
        fields.now,
      );
    return Number(result.lastInsertRowid);
  }

  private advance(
    id: number,
    generation: number,
    advance: ScheduleAdvance,
    now: number,
  ): void {
    if ("next" in advance) {
      this.database
        .prepare(
          "UPDATE schedules SET next_due = ?, generation = ? WHERE id = ? AND state = 'active'",
        )
        .run(advance.next, generation, id);
      return;
    }
    this.database
      .prepare(
        `UPDATE schedules SET next_due = NULL, generation = ?, state = ?, ended_at = ?,
           end_reason = ? WHERE id = ? AND state = 'active'`,
      )
      .run(generation, advance.end, now, advance.reason, id);
  }

  /** Ends an active schedule with no occurrence: a cancel. Returns whether it was active. */
  public end(
    id: number,
    state: Exclude<ScheduleState, "active">,
    reason: string,
    now: number,
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE schedules SET next_due = NULL, state = ?, ended_at = ?, end_reason = ?
          WHERE id = ? AND state = 'active'`,
      )
      .run(state, now, reason, id);
    return Number(result.changes) > 0;
  }

  /** Every unsettled occurrence of the ear, whoever it is owed to, oldest first. */
  public owed(ear: string): Wake[] {
    return this.database
      .prepare(
        `SELECT ${WAKE_COLUMNS} FROM wakes WHERE ear = ? AND acked_at IS NULL
          ORDER BY schedule_id, generation`,
      )
      .all(ear) as unknown as Wake[];
  }

  public wakesOf(scheduleId: number): Wake[] {
    return this.database
      .prepare(
        `SELECT ${WAKE_COLUMNS} FROM wakes WHERE schedule_id = ? ORDER BY generation`,
      )
      .all(scheduleId) as unknown as Wake[];
  }

  /**
   * One push of `wakeIds` to `sessionId` under `nonce`. The first delivery freezes each
   * occurrence: later ticks open a new one.
   */
  public deliver(delivery: Omit<WakeDelivery, "deliveredAt">, now: number) {
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO wake_deliveries (nonce, ear, session_id, schedule_id, delivered_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          delivery.nonce,
          delivery.ear,
          delivery.sessionId,
          delivery.scheduleId,
          now,
        );
      const item = this.database.prepare(
        "INSERT INTO wake_delivery_items (nonce, wake_id) VALUES (?, ?)",
      );
      const wake = this.database.prepare(
        `UPDATE wakes SET delivered_at = COALESCE(delivered_at, ?), deliveries = deliveries + 1,
           last_delivered_at = ? WHERE id = ?`,
      );
      for (const id of delivery.wakeIds) {
        item.run(delivery.nonce, id);
        wake.run(now, now, id);
      }
    });
  }

  public delivery(ear: string, nonce: string): WakeDelivery | undefined {
    const row = this.database
      .prepare(
        `SELECT nonce, ear, session_id AS sessionId, schedule_id AS scheduleId,
                delivered_at AS deliveredAt
           FROM wake_deliveries WHERE ear = ? AND nonce = ?`,
      )
      .get(ear, nonce) as Omit<WakeDelivery, "wakeIds"> | undefined;
    if (!row) {
      return undefined;
    }
    const items = this.database
      .prepare(
        "SELECT wake_id AS id FROM wake_delivery_items WHERE nonce = ? ORDER BY wake_id",
      )
      .all(nonce) as Array<{ id: number }>;
    return { ...row, wakeIds: items.map((item) => item.id) };
  }

  /** Settles the occurrences delivery `nonce` showed and nothing else. Returns their ids. */
  public ack(nonce: string, now: number): number[] {
    return this.transaction(() => {
      const ids = (
        this.database
          .prepare(
            `SELECT w.id AS id FROM wakes w JOIN wake_delivery_items i ON i.wake_id = w.id
              WHERE i.nonce = ? AND w.acked_at IS NULL ORDER BY w.id`,
          )
          .all(nonce) as Array<{ id: number }>
      ).map((row) => row.id);
      const settle = this.database.prepare(
        "UPDATE wakes SET acked_at = ? WHERE id = ? AND acked_at IS NULL",
      );
      for (const id of ids) {
        settle.run(now, id);
      }
      return ids;
    });
  }

  public lastDeliveredAt(ear: string): number | null {
    const row = this.database
      .prepare("SELECT MAX(last_delivered_at) AS at FROM wakes WHERE ear = ?")
      .get(ear) as { at: number | null };
    return row.at;
  }

  public lastAckedAt(ear: string): number | null {
    const row = this.database
      .prepare("SELECT MAX(acked_at) AS at FROM wakes WHERE ear = ?")
      .get(ear) as { at: number | null };
    return row.at;
  }

  /**
   * Forgets settled occurrences after `keepSettledMs`, unsettled ones after `owedKeepMs`
   * (returned, for the visible counter: never silently), ended schedules with nothing
   * left owed after `keepEndedMs`, and deliveries naming nothing left.
   */
  public prune(
    now: number,
    limits: { keepSettledMs: number; owedKeepMs: number; keepEndedMs: number },
  ): { droppedUnacked: Wake[] } {
    return this.transaction(() => {
      const droppedUnacked = this.database
        .prepare(
          `SELECT ${WAKE_COLUMNS} FROM wakes WHERE acked_at IS NULL AND created_at <= ?`,
        )
        .all(now - limits.owedKeepMs) as unknown as Wake[];
      this.database
        .prepare(
          `DELETE FROM wakes WHERE (acked_at IS NOT NULL AND acked_at <= ?)
              OR (acked_at IS NULL AND created_at <= ?)`,
        )
        .run(now - limits.keepSettledMs, now - limits.owedKeepMs);
      this.database
        .prepare(
          `DELETE FROM schedules WHERE state <> 'active' AND ended_at <= ?
              AND NOT EXISTS (SELECT 1 FROM wakes WHERE wakes.schedule_id = schedules.id)`,
        )
        .run(now - limits.keepEndedMs);
      this.database.exec(
        `DELETE FROM wake_delivery_items
          WHERE wake_id NOT IN (SELECT id FROM wakes);
         DELETE FROM wake_deliveries
          WHERE nonce NOT IN (SELECT nonce FROM wake_delivery_items);`,
      );
      return { droppedUnacked };
    });
  }
}
