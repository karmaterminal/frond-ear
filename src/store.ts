import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { WakeStore } from "./wake-store.ts";
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

/** A send whose outcome Discord never confirmed. */
export interface AmbiguousSend {
  nonce: string;
  chatId: string;
  preview: string;
  createdAt: number;
  /** The ear whose session made it; null for a script, or a row from before #49. */
  sessionEar: string | null;
  /** Which part of its reply it is, from 0; null for a row from before #55. */
  part: number | null;
  /** How many parts its reply has; null for a row from before #55. */
  parts: number | null;
}

/**
 * A canticle record settled for one ear (frond-ear#65): its tombstone refuses a repeat
 * until `expiresAt`, the record's local expiry plus skew (RFC-0001 §14.18.5).
 */
export interface CanticleSettled {
  ear: string;
  /** `key:epoch:stream:seq`: the record's identity, never its text. */
  identity: string;
  /**
   * `pushed` to the session, `collapsed` as a refresh of a pushed record (§7.9), or
   * `passed` over by a mute, so it is never pushed after the mute lifts.
   */
  outcome: "pushed" | "collapsed" | "passed";
  /** For a keyed record, `[key, stream, state_key]` as JSON: what a refresh re-issues. */
  refreshKey: string | null;
  /** The body's SHA-256, for a keyed record. */
  digest: string | null;
  expiresAt: number;
}

/**
 * A session's compaction boundary as frond-ear knew it (#98): the latest compaction marker
 * its pressure hook read, `null` when the hook read none yet, and `undefined` when no
 * reading from that session had reached the daemon (unknown).
 */
export type CompactionBoundary = string | null | undefined;

/** How much of a record an exposure showed the session. */
export type CanticleShown = "whole" | "cut" | "none";

/** What a canticle exposure shows the session, before frond-ear knows how it went. */
export interface CanticleExposure {
  /** `immediate` or `report`: a push; `hear`: the tool's own return. */
  path: "immediate" | "report" | "hear";
  /** The ear's effective delivery mode for the record's station then. */
  mode: string;
  /** `key:epoch:stream:seq`, as dedupe has it. */
  identity: string;
  station: string;
  stream: string;
  keyId: string;
  epoch: number;
  seq: string;
  /** SHA-256 of the payload text, else the source's body digest; null when neither is known. */
  digest: string | null;
  /** `whole` payload, `cut` to fit, or `none` (a counts report, a non-text payload). */
  shown: CanticleShown;
  /** What the verified record said of itself; absent when the caller had no record. */
  lineage?: ExposureLineage;
}

/**
 * What a verified record said of itself when it was exposed (binary-canticle#161 items 2
 * and 4): its permission (scope), class, hop and lineage root, its station's principal, its
 * expiry and whether it was sung in a canticle-woken turn. A derived publication carries it
 * as each source's lineage, bound at exposure rather than read back later.
 */
export interface ExposureLineage {
  scope: string;
  class: string;
  hop: number;
  principal: string | null;
  /** `key:epoch:stream:seq` of the record's lineage root, when it named one. */
  root: string | null;
  expiresAt: number;
  wakeDerived: boolean | null;
}

/**
 * One exposure of a canticle record to an ear's session, as custody keeps it
 * (binary-canticle#161): claimed (deduplicated and handed to the session's connection),
 * offered (the host handed it to the session), echoed (the session named its batch_id, or
 * `hear` returned it). Each step carries the session and its compaction boundary then.
 */
export interface CanticleCustody extends Omit<CanticleExposure, "lineage"> {
  id: number;
  ear: string;
  /** The push's batch; null for `hear`. */
  batchId: number | null;
  /** The session holding the ear, as frond-ear knows it; null when its shim gave none. */
  sessionId: string | null;
  generation: number;
  claimedAt: number;
  offeredAt: number | null;
  /**
   * The session holding the ear when the host confirmed it: the one it was shown to. It
   * can differ from `sessionId` when a session changed within one attach (a /clear).
   */
  offerSession: string | null;
  offerBoundary: CompactionBoundary;
  echoedAt: number | null;
  /** The tool whose call named the batch, or `hear`. */
  echoKind: string | null;
  /** The batch the echo named: this one, or a later one of the same session. */
  echoBatch: number | null;
  echoSession: string | null;
  echoBoundary: CompactionBoundary;
  /** Null for custody kept before frond-ear kept lineage. */
  lineage: ExposureLineage | null;
}

interface CustodyRow {
  id: number;
  ear: string;
  path: CanticleExposure["path"];
  mode: string;
  batch_id: number | null;
  session_id: string | null;
  generation: number;
  identity: string;
  station: string;
  stream: string;
  key_id: string;
  epoch: number;
  seq: string;
  digest: string | null;
  shown: CanticleShown;
  claimed_at: number;
  offered_at: number | null;
  offer_session: string | null;
  offer_boundary: string | null;
  offer_boundary_known: number;
  echoed_at: number | null;
  echo_kind: string | null;
  echo_batch: number | null;
  echo_session: string | null;
  echo_boundary: string | null;
  echo_boundary_known: number;
  lineage: string | null;
}

const boundaryOf = (value: string | null, known: number): CompactionBoundary =>
  known === 1 ? value : undefined;

function mapCustody(row: CustodyRow): CanticleCustody {
  return {
    id: row.id,
    ear: row.ear,
    path: row.path,
    mode: row.mode,
    batchId: row.batch_id,
    sessionId: row.session_id,
    generation: row.generation,
    identity: row.identity,
    station: row.station,
    stream: row.stream,
    keyId: row.key_id,
    epoch: row.epoch,
    seq: row.seq,
    digest: row.digest,
    shown: row.shown,
    claimedAt: row.claimed_at,
    offeredAt: row.offered_at,
    offerSession: row.offer_session,
    offerBoundary: boundaryOf(row.offer_boundary, row.offer_boundary_known),
    echoedAt: row.echoed_at,
    echoKind: row.echo_kind,
    echoBatch: row.echo_batch,
    echoSession: row.echo_session,
    echoBoundary: boundaryOf(row.echo_boundary, row.echo_boundary_known),
    lineage:
      row.lineage === null
        ? null
        : (JSON.parse(row.lineage) as ExposureLineage),
  };
}

const lineageOf = (exposure: CanticleExposure): string | null =>
  exposure.lineage === undefined ? null : JSON.stringify(exposure.lineage);

/**
 * A canticle push a revert gave back (#161): its records, and the refreshes that had
 * collapsed into it (§7.9), whose tombstones went back with it.
 */
export interface CanticleReverted {
  batchId: number;
  identities: string[];
  collapsed: string[];
}

/** Since when custody is whole: set when the table is first made, moved by the prune. */
const CUSTODY_SINCE = "canticle.custody.since";

/** A session's own canticle delivery choice for a station, or "*" for all of them. */
export interface CanticleChoice {
  scope: string;
  mode: "mute" | "digest" | "immediate";
  style: "records" | "counts" | null;
  expiresAt: number | null;
}

/**
 * Something an ear's own session left for a later turn of itself (#88),
 * released to it as a channel event when its seat's SessionStart hook says
 * it compacted.
 */
export interface Letter {
  id: number;
  /** The session that held the ear when it left the letter. */
  sessionId: string | null;
  reason: string;
  body: string;
  bytes: number;
  /** What the letter rested on; the receiving turn re-reads each. */
  assumed: string[];
  leftAt: number;
  expiresAt: number;
  deliveredAt: number | null;
  deliveries: number;
  nonce: string | null;
  ackedAt: number | null;
  /** The ear's release count when it was left: releases since = compactions or starts since. */
  releasesAtLeave: number;
}

/**
 * One room output as the egress gate recorded it (binary-canticle#161 item 3): what it
 * was and where it went (never its text), who spoke, what the policy decided, the
 * speaker's custody then (the records it had echoed, by id and digest, never payload; the
 * history flag; the compaction boundary) and how the write went.
 */
export interface EgressRecord {
  id: number;
  /** The ear whose custody was read: the speaker's, else the chat's. */
  ear: string;
  tool: "reply" | "react" | "edit_message";
  chatId: string;
  /** The message replied to, reacted to or edited; null for a plain reply. */
  target: string | null;
  /** SHA-256 of what went out (a reply's identity, an edit's text, an emoji). */
  digest: string;
  sessionId: string | null;
  /** The session holding the ear, one it superseded, or no ear's session (a CLI). */
  speaker: "holder" | "superseded" | "other";
  policy: string;
  decision: "allow" | "refuse";
  reason: string;
  history: "complete" | "incomplete" | "unknown";
  reasons: string[];
  boundary: CompactionBoundary;
  /** The records the speaker had echoed in the window, with their state then. */
  sources: Array<{ identity: string; digest: string | null; state: string }>;
  /** Where the custody window began. */
  since: number;
  decidedAt: number;
  /**
   * `refused`: nothing sent. `pending`: allowed, its call still running (a row a previous
   * process left pending is settled when frond-ear starts). `sent`: every write it made
   * was confirmed. `error`: the call ended in an error, and nothing it wrote is unknown.
   * `unconfirmed`: a write it made was never answered, so it may have gone out; for a reply
   * part, `nonce` names it, and the row becomes `sent` when Discord confirms that nonce.
   */
  outcome: "refused" | "pending" | "sent" | "error" | "unconfirmed";
  /**
   * The messages this output posted (a reply's parts, by the nonces its own call first
   * sent) or edited, as Discord confirmed them. A part an earlier row first sent is that
   * row's, even when this row's retry got Discord's answer for it.
   */
  messageIds: string[];
  /** The nonce of the reply part this output's call left unanswered; null when none. */
  nonce: string | null;
  /**
   * Parts this output re-sent under an earlier row's nonce (an identical retry), and the
   * message Discord confirmed for each: credited to that row (`egressId`, null for a send
   * from before egress rows were kept), never to this one.
   */
  resent: EgressResend[];
  settledAt: number | null;
}

/** A reply part one egress row re-sent under another's nonce, as Discord confirmed it. */
export interface EgressResend {
  egressId: number | null;
  messageId: string;
}

/** How an allowed room output's call ended, as its permit saw it. */
export interface EgressSettlement {
  outcome: "sent" | "error" | "unconfirmed";
  /** What it wrote under its own nonces (or edited), as Discord confirmed it. */
  messageIds: readonly string[];
  resent: readonly EgressResend[];
  /** For `unconfirmed`: the nonce of the reply part left unanswered, if it was one. */
  nonce: string | null;
}

interface EgressRow {
  id: number;
  ear: string;
  tool: EgressRecord["tool"];
  chat_id: string;
  target: string | null;
  digest: string;
  session_id: string | null;
  speaker: EgressRecord["speaker"];
  policy: string;
  decision: EgressRecord["decision"];
  reason: string;
  history: EgressRecord["history"];
  reasons: string;
  boundary: string | null;
  boundary_known: number;
  sources: string;
  since: number;
  decided_at: number;
  outcome: EgressRecord["outcome"];
  message_ids: string;
  nonce: string | null;
  resent: string;
  settled_at: number | null;
}

function mapEgress(row: EgressRow): EgressRecord {
  return {
    id: row.id,
    ear: row.ear,
    tool: row.tool,
    chatId: row.chat_id,
    target: row.target,
    digest: row.digest,
    sessionId: row.session_id,
    speaker: row.speaker,
    policy: row.policy,
    decision: row.decision,
    reason: row.reason,
    history: row.history,
    reasons: JSON.parse(row.reasons) as string[],
    boundary: boundaryOf(row.boundary, row.boundary_known),
    sources: JSON.parse(row.sources) as EgressRecord["sources"],
    since: row.since,
    decidedAt: row.decided_at,
    outcome: row.outcome,
    messageIds: JSON.parse(row.message_ids) as string[],
    nonce: row.nonce,
    resent: JSON.parse(row.resent) as EgressResend[],
    settledAt: row.settled_at,
  };
}

/**
 * The room_egress table (binary-canticle#161 item 3) under `name`, so a store from an
 * earlier build can be rebuilt into the same shape.
 */
const egressTable = (name: string) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ear TEXT NOT NULL,
    tool TEXT NOT NULL CHECK (tool IN ('reply', 'react', 'edit_message')),
    chat_id TEXT NOT NULL,
    target TEXT,
    digest TEXT NOT NULL,
    session_id TEXT,
    speaker TEXT NOT NULL CHECK (speaker IN ('holder', 'superseded', 'other')),
    policy TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'refuse')),
    reason TEXT NOT NULL,
    history TEXT NOT NULL CHECK (history IN ('complete', 'incomplete', 'unknown')),
    reasons TEXT NOT NULL,
    boundary TEXT,
    boundary_known INTEGER NOT NULL,
    sources TEXT NOT NULL,
    since INTEGER NOT NULL,
    decided_at INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN
      ('refused', 'pending', 'sent', 'error', 'unconfirmed')),
    message_ids TEXT NOT NULL DEFAULT '[]',
    nonce TEXT,
    resent TEXT NOT NULL DEFAULT '[]',
    settled_at INTEGER
  );
`;

/** The columns an earlier build's room_egress already had, which a rebuild copies. */
const EGRESS_V1_COLUMNS =
  "id, ear, tool, chat_id, target, digest, session_id, speaker, policy, decision, reason, " +
  "history, reasons, boundary, boundary_known, sources, since, decided_at, outcome, " +
  "message_ids, settled_at";

/**
 * One derived publication frond-ear asked a station for (binary-canticle#161 item 4), by
 * the ids and digests of its sources, never the text. `issuing`: the owner's issuer was
 * asked for a capsule (after a crash, unknown whether it issued one). `claimed`: issued,
 * the station not yet answered (after a crash, unknown). `accepted`: the station's receipt
 * is kept. `refused`: the issuer or the station said no. `unknown`: no answer came; only
 * `derived_query` for the same election may settle it, never a second publish.
 */
export interface DerivedPublication {
  id: number;
  ear: string;
  /** The session holding the ear: the author. */
  sessionId: string | null;
  electionId: string | null;
  sources: Array<{ identity: string; digest: string }>;
  /** The narrowest scope among the sources: the widest the publication may reach. */
  audience: string;
  payloadSha256: string;
  state: "issuing" | "claimed" | "accepted" | "refused" | "unknown";
  reason: string | null;
  /** The station's acceptance receipt (ids and digests, no payload). */
  acceptance: Record<string, unknown> | null;
  createdAt: number;
  settledAt: number | null;
}

interface DerivedRow {
  id: number;
  ear: string;
  session_id: string | null;
  election_id: string | null;
  sources: string;
  audience: string;
  payload_sha256: string;
  state: DerivedPublication["state"];
  reason: string | null;
  acceptance: string | null;
  created_at: number;
  settled_at: number | null;
}

/** One publication's identity: the ear, its sources as a set, and its text's digest. */
function publicationKey(
  ear: string,
  sources: readonly string[],
  payloadSha256: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([ear, [...new Set(sources)].sort(), payloadSha256]),
      "utf8",
    )
    .digest("hex");
}

function mapDerived(row: DerivedRow): DerivedPublication {
  return {
    id: row.id,
    ear: row.ear,
    sessionId: row.session_id,
    electionId: row.election_id,
    sources: JSON.parse(row.sources) as DerivedPublication["sources"],
    audience: row.audience,
    payloadSha256: row.payload_sha256,
    state: row.state,
    reason: row.reason,
    acceptance:
      row.acceptance === null
        ? null
        : (JSON.parse(row.acceptance) as Record<string, unknown>),
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

/** Where one Discord message sits in the reply it is part of (#55). */
export interface ReplyPart {
  /** A hash of the chat, reply_to and whole text, so identical replies share it. */
  key: string;
  /** One reply, kept across identical retries until every part is confirmed. */
  id: string;
  /** From 0. */
  part: number;
  parts: number;
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
/**
 * Events in the order Discord sent them. Message ids are snowflakes, which grow with time;
 * they are digit strings, so a longer one is newer. Admission order differs only for
 * messages read back after an outage, which arrive after newer ones heard live.
 */
const OLDEST_FIRST = "length(message_id), message_id, id";
const NEWEST_FIRST = "length(message_id) DESC, message_id DESC, id DESC";
/** The chats whose anchors the prune keeps, the most recently active. */
const MAX_ANCHORS = 1_000;

/** SQL that is true when snowflake `a` is newer than snowflake `b`. */
function newerSnowflake(a: string, b: string): string {
  return `(length(${a}) > length(${b}) OR (length(${a}) = length(${b}) AND ${a} > ${b}))`;
}

export class EventStore {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;
  /** Daemon-held schedules, watches and the wakes they owe (#111). */
  public readonly wakes: WakeStore;

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
        updated_at INTEGER NOT NULL,
        session_ear TEXT,
        reply_key TEXT,
        reply_id TEXT,
        part INTEGER,
        parts INTEGER,
        egress_id INTEGER
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
      CREATE TABLE IF NOT EXISTS chat_anchors (
        chat_id TEXT PRIMARY KEY,
        guild_id TEXT,
        message_id TEXT NOT NULL,
        catch_up_after TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_state (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canticle_settled (
        ear TEXT NOT NULL,
        identity TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('pushed', 'collapsed', 'passed')),
        refresh_key TEXT,
        digest TEXT,
        settled_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (ear, identity)
      );
      CREATE INDEX IF NOT EXISTS canticle_settled_expiry
        ON canticle_settled (expires_at);
      CREATE TABLE IF NOT EXISTS canticle_attention (
        ear TEXT NOT NULL,
        scope TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('mute', 'digest', 'immediate')),
        style TEXT CHECK (style IN ('records', 'counts')),
        set_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (ear, scope)
      );
      CREATE TABLE IF NOT EXISTS letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ear TEXT NOT NULL,
        session_id TEXT,
        reason TEXT NOT NULL,
        body TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        assumed TEXT NOT NULL DEFAULT '[]',
        left_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        delivered_at INTEGER,
        deliveries INTEGER NOT NULL DEFAULT 0,
        nonce TEXT,
        acked_at INTEGER,
        releases_at_leave INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS letters_ear ON letters (ear, id);
      CREATE TABLE IF NOT EXISTS canticle_custody (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ear TEXT NOT NULL,
        path TEXT NOT NULL CHECK (path IN ('immediate', 'report', 'hear')),
        mode TEXT NOT NULL,
        batch_id INTEGER,
        session_id TEXT,
        generation INTEGER NOT NULL,
        identity TEXT NOT NULL,
        station TEXT NOT NULL,
        stream TEXT NOT NULL,
        key_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        seq TEXT NOT NULL,
        digest TEXT,
        shown TEXT NOT NULL CHECK (shown IN ('whole', 'cut', 'none')),
        claimed_at INTEGER NOT NULL,
        offered_at INTEGER,
        offer_session TEXT,
        offer_boundary TEXT,
        offer_boundary_known INTEGER NOT NULL DEFAULT 0,
        echoed_at INTEGER,
        echo_kind TEXT,
        echo_batch INTEGER,
        echo_session TEXT,
        echo_boundary TEXT,
        echo_boundary_known INTEGER NOT NULL DEFAULT 0,
        lineage TEXT
      );
      CREATE INDEX IF NOT EXISTS canticle_custody_ear
        ON canticle_custody (ear, claimed_at);
      CREATE INDEX IF NOT EXISTS canticle_custody_batch
        ON canticle_custody (ear, batch_id);
      CREATE INDEX IF NOT EXISTS canticle_custody_claimed
        ON canticle_custody (claimed_at);
      CREATE INDEX IF NOT EXISTS canticle_custody_identity
        ON canticle_custody (ear, identity);
      CREATE TABLE IF NOT EXISTS canticle_claims (
        batch_id INTEGER PRIMARY KEY,
        ear TEXT NOT NULL,
        cursor_name TEXT NOT NULL,
        cursor_before TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canticle_reverted (
        batch_id INTEGER PRIMARY KEY,
        ear TEXT NOT NULL,
        reverted_at INTEGER NOT NULL
      );
      ${egressTable("room_egress")}
      CREATE INDEX IF NOT EXISTS room_egress_ear
        ON room_egress (ear, decided_at);
      CREATE TABLE IF NOT EXISTS derived_publications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ear TEXT NOT NULL,
        session_id TEXT,
        election_id TEXT,
        sources TEXT NOT NULL,
        audience TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        publication_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN
          ('issuing', 'claimed', 'accepted', 'refused', 'unknown')),
        reason TEXT,
        acceptance TEXT,
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS derived_publications_election
        ON derived_publications (ear, election_id);
    `);
    // Custody is whole from the moment its table exists: a window that reaches back
    // before that (or before the prune's cutoff) reads as unknown, never as empty. A
    // store no session ever attached to, and that never settled a canticle record, has
    // exposed nothing, so its custody is whole from the start.
    const exposedBefore = this.database
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM ears) OR EXISTS (SELECT 1 FROM canticle_settled)
           AS used`,
      )
      .get() as { used: number };
    this.database
      .prepare(
        "INSERT INTO runtime_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
      )
      .run(
        CUSTODY_SINCE,
        String(exposedBefore.used === 1 ? this.clock.now() : 0),
      );
    // A push's tombstones name its batch (#161), so a push no session took can give its
    // claim back. Older tombstones name none and keep the claim they made.
    const settledColumns = new Set(
      (
        this.database
          .prepare("PRAGMA table_info(canticle_settled)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!settledColumns.has("batch_id")) {
      this.database.exec(
        "ALTER TABLE canticle_settled ADD COLUMN batch_id INTEGER",
      );
    }
    // Custody keeps each exposure's lineage (#161 item 4); older rows read as none.
    const custodyColumns = new Set(
      (
        this.database
          .prepare("PRAGMA table_info(canticle_custody)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!custodyColumns.has("lineage")) {
      this.database.exec(
        "ALTER TABLE canticle_custody ADD COLUMN lineage TEXT",
      );
    }
    // An earlier build of the egress gate had no `unconfirmed` outcome, nonce or resent:
    // rebuild its table into this shape, keeping every row and id. A row its process left
    // pending can't be tied to a nonce (that build's intents name no egress row), so
    // whether it went out is unknown: unconfirmed.
    const egress = this.database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'room_egress'",
      )
      .get() as { sql: string };
    if (!egress.sql.includes("'unconfirmed'")) {
      this.transaction(() => {
        this.database.exec(`
          ${egressTable("room_egress_rebuilt")}
          INSERT INTO room_egress_rebuilt (${EGRESS_V1_COLUMNS})
            SELECT ${EGRESS_V1_COLUMNS} FROM room_egress;
          DROP TABLE room_egress;
          ALTER TABLE room_egress_rebuilt RENAME TO room_egress;
          CREATE INDEX IF NOT EXISTS room_egress_ear
            ON room_egress (ear, decided_at);
        `);
        this.database
          .prepare(
            `UPDATE room_egress SET outcome = 'unconfirmed', settled_at = ?
             WHERE outcome = 'pending'`,
          )
          .run(this.clock.now());
      });
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS room_egress_nonce
        ON room_egress (nonce) WHERE nonce IS NOT NULL;
    `);
    // outbound_intents shipped without these columns; a database created before
    // one of them gains it here. Its older rows read as no session's (#49), no
    // reply's (#55) and no egress row's (#161).
    const intentColumns = new Set(
      (
        this.database
          .prepare("PRAGMA table_info(outbound_intents)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    for (const [column, type] of [
      ["session_ear", "TEXT"],
      ["reply_key", "TEXT"],
      ["reply_id", "TEXT"],
      ["part", "INTEGER"],
      ["parts", "INTEGER"],
      ["egress_id", "INTEGER"],
    ] as const) {
      if (!intentColumns.has(column)) {
        this.database.exec(
          `ALTER TABLE outbound_intents ADD COLUMN ${column} ${type}`,
        );
      }
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS outbound_intents_reply
        ON outbound_intents (reply_key, reply_id, part);
    `);
    // An earlier build of derived publication kept no publication key: key its rows in
    // place, so a standing publication still blocks the same one again.
    const derivedColumns = new Set(
      (
        this.database
          .prepare("PRAGMA table_info(derived_publications)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!derivedColumns.has("publication_key")) {
      this.transaction(() => {
        this.database.exec(
          "ALTER TABLE derived_publications ADD COLUMN publication_key TEXT",
        );
        const keyed = this.database.prepare(
          "UPDATE derived_publications SET publication_key = ? WHERE id = ?",
        );
        for (const row of this.database
          .prepare(
            "SELECT id, ear, sources, payload_sha256 FROM derived_publications",
          )
          .all() as Array<{
          id: number;
          ear: string;
          sources: string;
          payload_sha256: string;
        }>) {
          const sources = JSON.parse(row.sources) as Array<{
            identity: string;
          }>;
          keyed.run(
            publicationKey(
              row.ear,
              sources.map((source) => source.identity),
              row.payload_sha256,
            ),
            row.id,
          );
        }
      });
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS derived_publications_key
        ON derived_publications (publication_key, state);
    `);
    this.wakes = new WakeStore(
      this.database,
      <T>(work: () => T): T => this.transaction(work),
    );
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

  public runtimeState(name: string): string | undefined {
    const row = this.database
      .prepare("SELECT value FROM runtime_state WHERE name = ?")
      .get(name) as { value: string } | undefined;
    return row?.value;
  }

  public setRuntimeState(name: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO runtime_state (name, value) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      )
      .run(name, value);
  }

  public clearRuntimeState(name: string): void {
    this.database.prepare("DELETE FROM runtime_state WHERE name = ?").run(name);
  }

  /** A runtime_state entry's write-ahead records since it was last checkpointed, oldest first. */
  public runtimeJournal(name: string): string[] {
    const rows = this.database
      .prepare("SELECT value FROM runtime_journal WHERE name = ? ORDER BY id")
      .all(name) as Array<{ value: string }>;
    return rows.map((row) => row.value);
  }

  /** One autocommit insert: as durable on return as `setRuntimeState`. */
  public appendRuntimeJournal(name: string, value: string): void {
    this.database
      .prepare("INSERT INTO runtime_journal (name, value) VALUES (?, ?)")
      .run(name, value);
  }

  /** Replace the entry and drop its journal in one transaction. */
  public checkpointRuntimeState(name: string, value: string): void {
    this.transaction(() => {
      this.setRuntimeState(name, value);
      this.database
        .prepare("DELETE FROM runtime_journal WHERE name = ?")
        .run(name);
    });
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

  // ---- chat anchors: what a fresh Gateway session owes ----------------------

  /**
   * Records the newest message heard in a chat. Only ever moves forward, so reading back
   * older messages leaves it where it is.
   */
  public advanceAnchor(
    chatId: string,
    guildId: string | null,
    messageId: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO chat_anchors (chat_id, guild_id, message_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           guild_id = COALESCE(excluded.guild_id, chat_anchors.guild_id),
           message_id = excluded.message_id, updated_at = excluded.updated_at
         WHERE ${newerSnowflake("excluded.message_id", "chat_anchors.message_id")}`,
      )
      .run(chatId, guildId, messageId, this.clock.now());
  }

  /**
   * A Gateway session started afresh, so Discord replays nothing from before it: every chat
   * heard so far owes a read-back of what came after its anchor. A chat still owed one from
   * an earlier session keeps that older starting point.
   */
  public oweCatchUp(): number {
    return Number(
      this.database
        .prepare(
          `UPDATE chat_anchors SET catch_up_after = message_id
           WHERE catch_up_after IS NULL`,
        )
        .run().changes,
    );
  }

  /** Chats owed a read-back, the most recently active first. */
  public owedCatchUps(): Array<{
    chatId: string;
    guildId: string | null;
    after: string;
  }> {
    return this.database
      .prepare(
        `SELECT chat_id AS chatId, guild_id AS guildId, catch_up_after AS after
         FROM chat_anchors WHERE catch_up_after IS NOT NULL
         ORDER BY length(message_id) DESC, message_id DESC`,
      )
      .all() as Array<{
      chatId: string;
      guildId: string | null;
      after: string;
    }>;
  }

  public settleCatchUp(chatId: string): void {
    this.database
      .prepare(
        "UPDATE chat_anchors SET catch_up_after = NULL WHERE chat_id = ?",
      )
      .run(chatId);
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

  // ---- canticle delivery (frond-ear#65) ---------------------------------------------

  /**
   * Every ear's settled canticle records whose tombstone still holds: pushed to the
   * session, collapsed as a refresh of one that was, or passed over by a mute. Expired
   * ones are removed first.
   */
  public canticleSettled(now: number): CanticleSettled[] {
    this.database
      .prepare("DELETE FROM canticle_settled WHERE expires_at <= ?")
      .run(now);
    return this.database
      .prepare(
        `SELECT ear, identity, outcome, refresh_key AS refreshKey, digest,
           expires_at AS expiresAt FROM canticle_settled`,
      )
      .all() as unknown as CanticleSettled[];
  }

  /**
   * Settles records for one ear and saves its delivery cursor, in one transaction, before
   * anything is pushed: a crash between the two loses a push, never repeats one. Settling
   * a record again only ever lengthens its tombstone, as the in-memory copy does.
   */
  public settleCanticle(
    ear: string,
    rows: ReadonlyArray<Omit<CanticleSettled, "ear">>,
    cursor?: { name: string; value: string },
  ): void {
    this.transaction(() => {
      for (const row of rows) {
        this.insertSettled(ear, [row], this.collapsedInto(ear, row));
      }
      if (cursor) {
        this.setRuntimeState(cursor.name, cursor.value);
      }
    });
  }

  /**
   * The push a refresh collapses into (§7.9), when it rides only on pushes the host hasn't
   * confirmed yet: the latest of them, so a revert that gives that push back gives the
   * refresh's tombstone back too (#161). Null for any other row, and when a confirmed push
   * (or a tombstone from before #161) stands behind the collapse.
   */
  private collapsedInto(
    ear: string,
    row: Omit<CanticleSettled, "ear">,
  ): number | null {
    if (
      row.outcome !== "collapsed" ||
      row.refreshKey === null ||
      row.digest === null
    ) {
      return null;
    }
    const seeds = this.database
      .prepare(
        `SELECT s.batch_id AS batchId,
           EXISTS (SELECT 1 FROM canticle_claims c WHERE c.batch_id = s.batch_id) AS held
         FROM canticle_settled s
         WHERE s.ear = ? AND s.refresh_key = ? AND s.digest = ? AND s.expires_at > ?`,
      )
      .all(ear, row.refreshKey, row.digest, this.clock.now()) as Array<{
      batchId: number | null;
      held: number;
    }>;
    if (
      seeds.length === 0 ||
      seeds.some((seed) => seed.batchId === null || seed.held !== 1)
    ) {
      return null;
    }
    return Math.max(...seeds.map((seed) => seed.batchId!));
  }

  private insertSettled(
    ear: string,
    rows: ReadonlyArray<Omit<CanticleSettled, "ear">>,
    batchId: number | null,
  ): void {
    // A lapsed tombstone that no prune has removed yet decides nothing: a new claim
    // replaces it whole, so its batch is this one and a release takes it back (#161).
    const lapsed = this.database.prepare(
      "DELETE FROM canticle_settled WHERE ear = ? AND identity = ? AND expires_at <= ?",
    );
    for (const row of rows) {
      lapsed.run(ear, row.identity, this.clock.now());
    }
    const insert = this.database.prepare(
      `INSERT INTO canticle_settled
         (ear, identity, outcome, refresh_key, digest, settled_at, expires_at, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ear, identity) DO UPDATE SET
         expires_at = MAX(canticle_settled.expires_at, excluded.expires_at)`,
    );
    for (const row of rows) {
      insert.run(
        ear,
        row.identity,
        row.outcome,
        row.refreshKey,
        row.digest,
        this.clock.now(),
        row.expiresAt,
        batchId,
      );
    }
  }

  // ---- canticle custody (binary-canticle#161) ------------------------------------

  /**
   * Opens a canticle push, in one transaction, before anything is pushed: its batch, the
   * tombstones that claim its records for dedupe, the delivery cursor (`value`; `before`
   * is kept until the host confirms the push, for a revert to give back), and one custody
   * row per record, claimed. After a crash the push stays claimed until the next attach
   * reverts it. Nothing here says the session got it: that is `offerCanticleCustody`, on
   * the host's word. Returns the batch id, which the push carries as its batch_id.
   */
  public claimCanticlePush(
    ear: string,
    session: { generation: number; sessionId: string | null },
    rows: ReadonlyArray<Omit<CanticleSettled, "ear">>,
    cursor: { name: string; value: string; before: string },
    exposures: readonly CanticleExposure[],
  ): number {
    return this.transaction(() => {
      const now = this.clock.now();
      const batchId = Number(
        this.database
          .prepare(
            `INSERT INTO batches (ear, chat_id, kind, attach_generation, created_at)
             VALUES (?, 'canticle', 'canticle', ?, ?)`,
          )
          .run(ear, session.generation, now).lastInsertRowid,
      );
      this.insertSettled(ear, rows, batchId);
      this.setRuntimeState(cursor.name, cursor.value);
      this.database
        .prepare(
          `INSERT INTO canticle_claims (batch_id, ear, cursor_name, cursor_before)
           VALUES (?, ?, ?, ?)`,
        )
        .run(batchId, ear, cursor.name, cursor.before);
      const insert = this.database.prepare(
        `INSERT INTO canticle_custody (ear, path, mode, batch_id, session_id, generation,
           identity, station, stream, key_id, epoch, seq, digest, shown, claimed_at, lineage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const exposure of exposures) {
        insert.run(
          ear,
          exposure.path,
          exposure.mode,
          batchId,
          session.sessionId,
          session.generation,
          exposure.identity,
          exposure.station,
          exposure.stream,
          exposure.keyId,
          exposure.epoch,
          exposure.seq,
          exposure.digest,
          exposure.shown,
          now,
          lineageOf(exposure),
        );
      }
      return batchId;
    });
  }

  /**
   * A push no session's connection took gives its claim back, in one transaction: its
   * batch, custody rows and tombstones go, and the cursor is put back, so its records wait
   * for the next push as if this one had never been tried.
   */
  public releaseCanticlePush(
    ear: string,
    batchId: number,
    cursor: { name: string; value: string },
  ): void {
    this.transaction(() => {
      this.dropCanticleClaim(ear, batchId);
      this.setRuntimeState(cursor.name, cursor.value);
    });
  }

  /** A canticle push's claim gone whole: custody rows, tombstones, saved cursor, batch. */
  private dropCanticleClaim(ear: string, batchId: number): void {
    this.database
      .prepare("DELETE FROM canticle_custody WHERE ear = ? AND batch_id = ?")
      .run(ear, batchId);
    this.database
      .prepare("DELETE FROM canticle_settled WHERE ear = ? AND batch_id = ?")
      .run(ear, batchId);
    this.database
      .prepare("DELETE FROM canticle_claims WHERE ear = ? AND batch_id = ?")
      .run(ear, batchId);
    this.database
      .prepare(
        "DELETE FROM batches WHERE id = ? AND ear = ? AND kind = 'canticle'",
      )
      .run(batchId, ear);
  }

  /**
   * The host handed canticle batch `batchId` to the session (the shim's `offered`): its
   * records are offered now, to the session holding the ear now, under its boundary now,
   * and no revert can give the push back. Returns how many.
   */
  public offerCanticleCustody(
    ear: string,
    batchId: number,
    offer: {
      at: number;
      sessionId: string | null;
      boundary: CompactionBoundary;
    },
  ): number {
    this.database
      .prepare("DELETE FROM canticle_claims WHERE ear = ? AND batch_id = ?")
      .run(ear, batchId);
    return Number(
      this.database
        .prepare(
          `UPDATE canticle_custody SET offered_at = ?, offer_session = ?, offer_boundary = ?,
             offer_boundary_known = ?
           WHERE ear = ? AND batch_id = ? AND offered_at IS NULL`,
        )
        .run(
          offer.at,
          offer.sessionId,
          offer.boundary ?? null,
          offer.boundary === undefined ? 0 : 1,
          ear,
          batchId,
        ).changes,
    );
  }

  /** Whether `batchId` is one of this ear's canticle pushes that custody still holds. */
  public isCanticleBatch(ear: string, batchId: number): boolean {
    const push = this.canticlePush(ear, batchId);
    return push !== undefined && push !== "reverted";
  }

  /**
   * Canticle push `batchId` of this ear as custody holds it, with the attach generation it
   * went out under (its delivery token is keyed by it); `empty` for a push that carried a
   * coverage note and no record, which custody holds no row for; `reverted` when a revert
   * gave it back (its records went out again under new ids); undefined when it is no
   * canticle push of this ear that frond-ear still knows.
   */
  public canticlePush(
    ear: string,
    batchId: number,
  ): { generation: number; empty?: true } | "reverted" | undefined {
    const row = this.database
      .prepare(
        "SELECT generation FROM canticle_custody WHERE ear = ? AND batch_id = ? LIMIT 1",
      )
      .get(ear, batchId) as { generation: number } | undefined;
    if (row !== undefined) {
      return { generation: row.generation };
    }
    if (
      this.database
        .prepare(
          "SELECT 1 AS hit FROM canticle_reverted WHERE ear = ? AND batch_id = ?",
        )
        .get(ear, batchId) !== undefined
    ) {
      return "reverted";
    }
    const note = this.database
      .prepare(
        "SELECT attach_generation AS generation FROM batches WHERE id = ? AND ear = ? AND kind = 'canticle'",
      )
      .get(batchId, ear) as { generation: number } | undefined;
    return note === undefined
      ? undefined
      : { generation: note.generation, empty: true };
  }

  /**
   * The session named canticle batch `batchId` in a tool call: that batch's records, and
   * no other's, are echoed, if the host confirmed it to this same session and they aren't
   * echoed yet. Unlike a Discord batch, it settles nothing earlier: the session can only
   * vouch for the push it names (🍃 on #112). The same session is the one the offer went
   * to, by id; only an offer made while no id was known falls back to the attach. A
   * session that changed within one attach (a /clear) never echoes what the one before it
   * was shown, and a push the host never confirmed echoes nothing. Returns how many
   * records were echoed.
   */
  public echoCanticleCustody(
    ear: string,
    batchId: number,
    echo: {
      at: number;
      kind: string;
      sessionId: string | null;
      generation: number;
      boundary: CompactionBoundary;
    },
  ): number {
    return Number(
      this.database
        .prepare(
          `UPDATE canticle_custody SET echoed_at = ?, echo_kind = ?, echo_batch = ?,
             echo_session = ?, echo_boundary = ?, echo_boundary_known = ?
           WHERE ear = ? AND batch_id = ?
             AND offered_at IS NOT NULL AND echoed_at IS NULL
             AND (offer_session = ? OR (offer_session IS NULL AND generation = ?))`,
        )
        .run(
          echo.at,
          echo.kind,
          batchId,
          echo.sessionId,
          echo.boundary ?? null,
          echo.boundary === undefined ? 0 : 1,
          ear,
          batchId,
          echo.sessionId,
          echo.generation,
        ).changes,
    );
  }

  /**
   * `hear` returned these records' payloads to the session: each is an exposure offered
   * and echoed at once, at the tool's return, under the session's boundary then.
   */
  public recordCanticleHear(
    ear: string,
    session: { generation: number; sessionId: string | null },
    exposures: readonly CanticleExposure[],
    at: number,
    boundary: CompactionBoundary,
  ): void {
    const insert = this.database.prepare(
      `INSERT INTO canticle_custody (ear, path, mode, batch_id, session_id, generation,
         identity, station, stream, key_id, epoch, seq, digest, shown, claimed_at,
         offered_at, offer_session, offer_boundary, offer_boundary_known, echoed_at,
         echo_kind, echo_session, echo_boundary, echo_boundary_known, lineage)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hear', ?, ?, ?, ?)`,
    );
    const known = boundary === undefined ? 0 : 1;
    this.atomically(() => {
      for (const exposure of exposures) {
        insert.run(
          ear,
          exposure.path,
          exposure.mode,
          session.sessionId,
          session.generation,
          exposure.identity,
          exposure.station,
          exposure.stream,
          exposure.keyId,
          exposure.epoch,
          exposure.seq,
          exposure.digest,
          exposure.shown,
          at,
          at,
          session.sessionId,
          boundary ?? null,
          known,
          at,
          session.sessionId,
          boundary ?? null,
          known,
          lineageOf(exposure),
        );
      }
    });
  }

  /** The ear's custody rows claimed at or after `since`, oldest first. */
  public canticleCustody(ear: string, since: number): CanticleCustody[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM canticle_custody WHERE ear = ? AND claimed_at >= ? ORDER BY id",
        )
        .all(ear, since) as unknown as CustodyRow[]
    ).map(mapCustody);
  }

  /** The ear's custody rows for these record identities, oldest first. */
  public canticleCustodyOf(
    ear: string,
    identities: readonly string[],
  ): CanticleCustody[] {
    const query = this.database.prepare(
      "SELECT * FROM canticle_custody WHERE ear = ? AND identity = ? ORDER BY id",
    );
    return [...new Set(identities)]
      .flatMap(
        (identity) => query.all(ear, identity) as unknown as CustodyRow[],
      )
      .sort((a, b) => a.id - b.id)
      .map(mapCustody);
  }

  /** Custody is whole for exposures claimed at or after this time. */
  public canticleCustodySince(): number {
    return Number(this.runtimeState(CUSTODY_SINCE) ?? 0);
  }

  /**
   * A settled record heard again with a later local expiry: its tombstone lasts until
   * then. Never shortened; the outcome and refresh seed stay as they were settled.
   */
  public lengthenCanticle(
    ear: string,
    identity: string,
    expiresAt: number,
  ): void {
    this.database
      .prepare(
        `UPDATE canticle_settled SET expires_at = MAX(expires_at, ?)
         WHERE ear = ? AND identity = ?`,
      )
      .run(expiresAt, ear, identity);
  }

  /** `scope` is a station name or key id (lowercase), or "*" for every station the ear hears. */
  public setCanticleAttention(
    ear: string,
    scope: string,
    mode: "mute" | "digest" | "immediate",
    style: "records" | "counts" | null,
    expiresAt: number | null,
  ): void {
    this.database
      .prepare(
        `INSERT INTO canticle_attention (ear, scope, mode, style, set_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ear, scope) DO UPDATE SET mode = excluded.mode, style = excluded.style,
           set_at = excluded.set_at, expires_at = excluded.expires_at`,
      )
      .run(ear, scope, mode, style, this.clock.now(), expiresAt);
  }

  /** Clears one scope, or every canticle choice of the ear when scope is omitted. */
  public clearCanticleAttention(ear: string, scope?: string): number {
    const result =
      scope === undefined
        ? this.database
            .prepare("DELETE FROM canticle_attention WHERE ear = ?")
            .run(ear)
        : this.database
            .prepare(
              "DELETE FROM canticle_attention WHERE ear = ? AND scope = ?",
            )
            .run(ear, scope);
    return Number(result.changes);
  }

  /** The ear's active canticle choices; expired ones are removed as they are read. */
  public canticleAttention(ear: string, now: number): CanticleChoice[] {
    this.database
      .prepare(
        "DELETE FROM canticle_attention WHERE ear = ? AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(ear, now);
    return this.database
      .prepare(
        `SELECT scope, mode, style, expires_at AS expiresAt FROM canticle_attention
           WHERE ear = ? ORDER BY scope`,
      )
      .all(ear) as unknown as CanticleChoice[];
  }

  // ---- room egress (binary-canticle#161 item 3) ---------------------------------------

  /**
   * The egress gate's row for one room output, written before anything is sent: `pending`
   * for an allowed one (a crash leaves it so), `refused`, settled at once, for one the
   * policy refused. Returns its id.
   */
  public openEgress(
    row: Omit<
      EgressRecord,
      "id" | "outcome" | "messageIds" | "nonce" | "resent" | "settledAt"
    >,
  ): number {
    const refused = row.decision === "refuse";
    return Number(
      this.database
        .prepare(
          `INSERT INTO room_egress (ear, tool, chat_id, target, digest, session_id, speaker,
             policy, decision, reason, history, reasons, boundary, boundary_known, sources,
             since, decided_at, outcome, settled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.ear,
          row.tool,
          row.chatId,
          row.target,
          row.digest,
          row.sessionId,
          row.speaker,
          row.policy,
          row.decision,
          row.reason,
          row.history,
          JSON.stringify(row.reasons),
          row.boundary ?? null,
          row.boundary === undefined ? 0 : 1,
          JSON.stringify(row.sources),
          row.since,
          row.decidedAt,
          refused ? "refused" : "pending",
          refused ? row.decidedAt : null,
        ).lastInsertRowid,
    );
  }

  /**
   * How an allowed room output went: once, from `pending`. Its message ids join those
   * `completeSend` already credited to it. An `unconfirmed` part whose nonce Discord has
   * meanwhile confirmed (a concurrent identical retry got the answer) settles it `sent`.
   */
  public settleEgress(id: number, settled: EgressSettlement, at: number): void {
    this.transaction(() => {
      const row = this.database
        .prepare(
          "SELECT outcome, message_ids, resent FROM room_egress WHERE id = ?",
        )
        .get(id) as
        | { outcome: string; message_ids: string; resent: string }
        | undefined;
      if (row?.outcome !== "pending") return;
      let outcome = settled.outcome;
      const resent = [
        ...(JSON.parse(row.resent) as EgressResend[]),
        ...settled.resent,
      ];
      if (outcome === "unconfirmed" && settled.nonce !== null) {
        const intent = this.sentIntent(settled.nonce);
        if (intent !== undefined) {
          outcome = "sent";
          if (intent.owner !== id) {
            resent.push({
              egressId: intent.owner,
              messageId: intent.messageId,
            });
          }
        }
      }
      const messageIds = [
        ...new Set([
          ...(JSON.parse(row.message_ids) as string[]),
          ...settled.messageIds,
        ]),
      ];
      this.database
        .prepare(
          `UPDATE room_egress SET outcome = ?, message_ids = ?, nonce = ?, resent = ?,
             settled_at = ?
           WHERE id = ?`,
        )
        .run(
          outcome,
          JSON.stringify(messageIds),
          settled.nonce,
          JSON.stringify(resent),
          at,
          id,
        );
    });
  }

  /** A send Discord confirmed: its message, and the egress row that first sent its nonce. */
  private sentIntent(
    nonce: string,
  ): { messageId: string; owner: number | null } | undefined {
    const intent = this.database
      .prepare(
        `SELECT message_id AS messageId, egress_id AS owner FROM outbound_intents
         WHERE nonce = ? AND state = 'sent'`,
      )
      .get(nonce) as { messageId: string; owner: number | null } | undefined;
    return intent;
  }

  /**
   * Inside `completeSend`: Discord confirmed `nonce` as `messageId`. The message is the
   * egress row's that first sent the nonce, and each row whose call left it unanswered
   * is `sent` now; one that only re-sent it names it as re-sent for that row.
   */
  private reconcileEgress(nonce: string, messageId: string): void {
    const owner = this.sentIntent(nonce)?.owner ?? null;
    if (owner !== null) {
      const row = this.database
        .prepare("SELECT message_ids FROM room_egress WHERE id = ?")
        .get(owner) as { message_ids: string } | undefined;
      const ids = row ? (JSON.parse(row.message_ids) as string[]) : [];
      if (row && !ids.includes(messageId)) {
        this.database
          .prepare("UPDATE room_egress SET message_ids = ? WHERE id = ?")
          .run(JSON.stringify([...ids, messageId]), owner);
      }
    }
    const waiting = this.database
      .prepare(
        "SELECT id, resent FROM room_egress WHERE nonce = ? AND outcome = 'unconfirmed'",
      )
      .all(nonce) as Array<{ id: number; resent: string }>;
    for (const row of waiting) {
      const resent = JSON.parse(row.resent) as EgressResend[];
      if (row.id !== owner) resent.push({ egressId: owner, messageId });
      this.database
        .prepare(
          `UPDATE room_egress SET outcome = 'sent', resent = ?, settled_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(resent), this.clock.now(), row.id);
    }
  }

  /**
   * At startup: a row a previous process left `pending` had its call cut off. A reply
   * whose part was still unanswered (an intent it first sent, still pending) is
   * `unconfirmed`, tied to that nonce; a reaction or an edit may have applied, so it is
   * `unconfirmed` too. A reply with nothing unanswered wrote only what its message ids
   * say: `error`. Returns how many.
   */
  public releasePendingEgress(at: number): number {
    return this.transaction(() => {
      this.database
        .prepare(
          `UPDATE room_egress SET nonce = (
             SELECT nonce FROM outbound_intents
              WHERE egress_id = room_egress.id AND state = 'pending'
              ORDER BY created_at DESC LIMIT 1)
           WHERE outcome = 'pending'`,
        )
        .run();
      return Number(
        this.database
          .prepare(
            `UPDATE room_egress SET settled_at = ?, outcome =
               CASE WHEN tool <> 'reply' OR nonce IS NOT NULL THEN 'unconfirmed' ELSE 'error' END
             WHERE outcome = 'pending'`,
          )
          .run(at).changes,
      );
    });
  }

  /** The ear's egress rows decided at or after `since`, oldest first. */
  public roomEgress(ear: string, since: number): EgressRecord[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM room_egress WHERE ear = ? AND decided_at >= ? ORDER BY id",
        )
        .all(ear, since) as unknown as EgressRow[]
    ).map(mapEgress);
  }

  /** ear_status's view of the ear's egress since `since`: decisions, and the latest refusal. */
  public roomEgressSummary(
    ear: string,
    since: number,
  ): {
    allowed: number;
    refused: number;
    lastRefusal: {
      at: number;
      tool: string;
      chatId: string;
      reason: string;
    } | null;
  } {
    const counts = this.database
      .prepare(
        `SELECT COALESCE(SUM(decision = 'allow'), 0) AS allowed,
                COALESCE(SUM(decision = 'refuse'), 0) AS refused
           FROM room_egress WHERE ear = ? AND decided_at >= ?`,
      )
      .get(ear, since) as { allowed: number; refused: number };
    const last = this.database
      .prepare(
        `SELECT decided_at, tool, chat_id, reason FROM room_egress
          WHERE ear = ? AND decided_at >= ? AND decision = 'refuse'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(ear, since) as
      | { decided_at: number; tool: string; chat_id: string; reason: string }
      | undefined;
    return {
      allowed: counts.allowed,
      refused: counts.refused,
      lastRefusal: last
        ? {
            at: last.decided_at,
            tool: last.tool,
            chatId: last.chat_id,
            reason: last.reason,
          }
        : null,
    };
  }

  // ---- derived publication (binary-canticle#161 item 4) ---------------------------------

  /** A derived publication about to ask the owner's issuer: `issuing`. Returns its id. */
  public openDerived(row: {
    ear: string;
    sessionId: string | null;
    sources: DerivedPublication["sources"];
    audience: string;
    payloadSha256: string;
    createdAt: number;
  }): number {
    return Number(
      this.database
        .prepare(
          `INSERT INTO derived_publications (ear, session_id, sources, audience,
             payload_sha256, publication_key, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'issuing', ?)`,
        )
        .run(
          row.ear,
          row.sessionId,
          JSON.stringify(row.sources),
          row.audience,
          row.payloadSha256,
          publicationKey(
            row.ear,
            row.sources.map((source) => source.identity),
            row.payloadSha256,
          ),
          row.createdAt,
        ).lastInsertRowid,
    );
  }

  /**
   * Moves a derived publication on: its election once issued, its outcome once known.
   * Only from one of `from` (any state when absent), so a settle that lost a race moves
   * nothing. `reason: null` clears it; a field left out keeps its value.
   */
  public updateDerived(
    id: number,
    change: {
      state: DerivedPublication["state"];
      electionId?: string;
      reason?: string | null;
      acceptance?: Record<string, unknown>;
      settledAt?: number;
      from?: readonly DerivedPublication["state"][];
    },
  ): boolean {
    const sets = ["state = ?"];
    const values: Array<string | number | null> = [change.state];
    if (change.electionId !== undefined) {
      sets.push("election_id = ?");
      values.push(change.electionId);
    }
    if (change.reason !== undefined) {
      sets.push("reason = ?");
      values.push(change.reason);
    }
    if (change.acceptance !== undefined) {
      sets.push("acceptance = ?");
      values.push(JSON.stringify(change.acceptance));
    }
    if (change.settledAt !== undefined) {
      sets.push("settled_at = ?");
      values.push(change.settledAt);
    }
    const from = change.from ?? [];
    return (
      Number(
        this.database
          .prepare(
            `UPDATE derived_publications SET ${sets.join(", ")} WHERE id = ?${
              from.length > 0
                ? ` AND state IN (${from.map(() => "?").join(", ")})`
                : ""
            }`,
          )
          .run(...values, id, ...from).changes,
      ) > 0
    );
  }

  /**
   * At startup: a publication a previous process left `issuing` had no derived_publish
   * sent for it (the request goes out only once it is `claimed`), so it is released,
   * refused, and blocks nothing. Returns how many.
   */
  public releaseIssuingDerived(at: number): number {
    return Number(
      this.database
        .prepare(
          `UPDATE derived_publications SET state = 'refused', settled_at = ?,
             reason = 'released at startup: frond-ear stopped while the issuer was asked, before any derived_publish was sent'
           WHERE state = 'issuing'`,
        )
        .run(at).changes,
    );
  }

  /**
   * The ear's publication of this text from these sources (in any order) that still
   * stands: in flight, unknown or accepted. A refused one doesn't.
   */
  public standingDerived(
    ear: string,
    sources: readonly string[],
    payloadSha256: string,
  ): DerivedPublication | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM derived_publications WHERE publication_key = ?
           AND state IN ('issuing', 'claimed', 'unknown', 'accepted')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(publicationKey(ear, sources, payloadSha256)) as
      | DerivedRow
      | undefined;
    return row ? mapDerived(row) : undefined;
  }

  /** The ear's derived publications, oldest first. */
  public derivedPublications(ear: string): DerivedPublication[] {
    return (
      this.database
        .prepare("SELECT * FROM derived_publications WHERE ear = ? ORDER BY id")
        .all(ear) as unknown as DerivedRow[]
    ).map(mapDerived);
  }

  /** The ear's derived publication for this election, if frond-ear asked for it. */
  public derivedByElection(
    ear: string,
    electionId: string,
  ): DerivedPublication | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM derived_publications WHERE ear = ? AND election_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(ear, electionId) as DerivedRow | undefined;
    return row ? mapDerived(row) : undefined;
  }

  // ---- letters (#88) ---------------------------------------------------------------

  public leaveLetter(letter: {
    ear: string;
    sessionId: string | null;
    reason: string;
    body: string;
    bytes: number;
    assumed: string[];
    leftAt: number;
    expiresAt: number;
    releasesAtLeave: number;
  }): number {
    const result = this.database
      .prepare(
        `INSERT INTO letters (ear, session_id, reason, body, bytes, assumed, left_at, expires_at,
           releases_at_leave)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        letter.ear,
        letter.sessionId,
        letter.reason,
        letter.body,
        letter.bytes,
        JSON.stringify(letter.assumed),
        letter.leftAt,
        letter.expiresAt,
        letter.releasesAtLeave,
      );
    return Number(result.lastInsertRowid);
  }

  /** Every letter the ear holds, expired ones included, oldest first. */
  public letters(ear: string): Letter[] {
    return (
      this.database
        .prepare(
          `SELECT id, session_id AS sessionId, reason, body, bytes, assumed, left_at AS leftAt,
                  expires_at AS expiresAt, delivered_at AS deliveredAt, deliveries, nonce,
                  acked_at AS ackedAt, releases_at_leave AS releasesAtLeave
             FROM letters WHERE ear = ? ORDER BY id`,
        )
        .all(ear) as Array<Record<string, unknown>>
    ).map((row) => ({
      ...(row as unknown as Letter),
      assumed: JSON.parse(String(row.assumed)) as string[],
    }));
  }

  /** Records one delivery of the letters under `nonce`; an ack of the nonce settles them. */
  public deliverLetters(ids: number[], nonce: string, now: number): void {
    const statement = this.database.prepare(
      "UPDATE letters SET delivered_at = ?, deliveries = deliveries + 1, nonce = ? WHERE id = ? AND acked_at IS NULL",
    );
    this.atomically(() => {
      for (const id of ids) {
        statement.run(now, nonce, id);
      }
    });
  }

  /** Settles the ear's letters delivered under `nonce`. Returns how many. */
  public ackLetters(ear: string, nonce: string, now: number): number {
    const result = this.database
      .prepare(
        "UPDATE letters SET acked_at = ? WHERE ear = ? AND nonce = ? AND acked_at IS NULL",
      )
      .run(now, ear, nonce);
    return Number(result.changes);
  }

  /** Deletes letters by id. */
  public deleteLetters(ear: string, ids: number[]): number {
    const statement = this.database.prepare(
      "DELETE FROM letters WHERE ear = ? AND id = ?",
    );
    let changes = 0;
    this.atomically(() => {
      for (const id of ids) {
        changes += Number(statement.run(ear, id).changes);
      }
    });
    return changes;
  }

  // ---- outbound intents (write-ahead for sends) ------------------------------------

  /**
   * The reply an outgoing reply belongs to (#55). An identical reply (same
   * `key`) whose parts were not all confirmed, and whose latest part began
   * within `reuseWindowMs`, is resumed, so a retry posts none of its confirmed
   * parts again. Otherwise the reply is new and gets `newId`. A finished reply
   * is never resumed, so a deliberate repeat of the same text still posts.
   */
  public resumeReply(
    key: string,
    parts: number,
    reuseWindowMs: number,
    newId: string,
  ): string {
    const unfinished = this.database
      .prepare(
        `SELECT reply_id AS replyId FROM outbound_intents
         WHERE reply_key = ?
         GROUP BY reply_id
         HAVING MAX(created_at) >= ?
           AND COUNT(DISTINCT CASE WHEN state = 'sent' THEN part END) < ?
         ORDER BY MAX(created_at) DESC LIMIT 1`,
      )
      .get(key, this.clock.now() - reuseWindowMs, parts) as
      | { replyId: string }
      | undefined;
    return unfinished?.replyId ?? newId;
  }

  /** The message id of this part, if Discord already confirmed it for this reply. */
  public sentPart(reply: ReplyPart): string | undefined {
    const sent = this.database
      .prepare(
        `SELECT message_id AS messageId FROM outbound_intents
         WHERE reply_key = ? AND reply_id = ? AND part = ? AND state = 'sent'
         LIMIT 1`,
      )
      .get(reply.key, reply.id, reply.part) as
      | { messageId: string }
      | undefined;
    return sent?.messageId;
  }

  /**
   * When the latest part of this reply was first tried (0 if none was). The
   * reuse window of resumeReply and beginSend runs from then, and trying the
   * part again does not move it.
   */
  public latestPartBegan(reply: ReplyPart): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(created_at), 0) AS began FROM outbound_intents
         WHERE reply_key = ? AND reply_id = ?`,
      )
      .get(reply.key, reply.id) as { began: number };
    return row.began;
  }

  /**
   * Records the intent to send one message *before* calling Discord. If an
   * earlier attempt at this part of this reply is still pending (its outcome
   * unknown: crash, timeout, lost response) and within `reuseWindowMs`, its
   * nonce is reused so Discord's enforce_nonce returns the original message
   * instead of posting a duplicate. A completed send is never reused, so a
   * deliberate repeat of the same text still posts. `sessionEar` is the ear
   * whose session is sending, or null for any other client (a `frond-ear send`
   * script): an unconfirmed send is put to that ear's sessions alone. A session
   * retrying a script's pending send makes it the session's; a script's retry
   * changes nothing. `egressId` is the egress row (#161) of the call sending it: a
   * new intent is that row's, and a reused one stays the row's that first sent it
   * (`owner`; null for an intent from before egress rows were kept).
   */
  public beginSend(
    key: string,
    chatId: string,
    preview: string,
    nonce: string,
    reuseWindowMs: number,
    sessionEar: string | null,
    reply: ReplyPart,
    egressId: number,
  ): { nonce: string; reused: boolean; owner: number | null } {
    const now = this.clock.now();
    const pending = this.database
      .prepare(
        `SELECT nonce, egress_id AS owner FROM outbound_intents
         WHERE intent_key = ? AND reply_id = ? AND state = 'pending' AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(key, reply.id, now - reuseWindowMs) as
      | { nonce: string; owner: number | null }
      | undefined;
    if (pending) {
      this.database
        .prepare(
          `UPDATE outbound_intents SET updated_at = ?, session_ear = COALESCE(?, session_ear)
           WHERE nonce = ?`,
        )
        .run(now, sessionEar, pending.nonce);
      return { nonce: pending.nonce, reused: true, owner: pending.owner };
    }
    this.database
      .prepare(
        `INSERT INTO outbound_intents
           (nonce, intent_key, chat_id, preview, state, created_at, updated_at, session_ear,
            reply_key, reply_id, part, parts, egress_id)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nonce,
        key,
        chatId,
        preview.slice(0, 80),
        now,
        now,
        sessionEar,
        reply.key,
        reply.id,
        reply.part,
        reply.parts,
        egressId,
      );
    return { nonce, reused: false, owner: egressId };
  }

  /**
   * Discord confirmed the post: mark the intent sent, keep the receipt, and credit the
   * message to the egress row that first sent the nonce (#161), in one transaction.
   */
  public completeSend(nonce: string, messageId: string, chatId: string): void {
    this.transaction(() => {
      this.database
        .prepare(
          `UPDATE outbound_intents SET state = 'sent', message_id = ?, updated_at = ?
           WHERE nonce = ?`,
        )
        .run(messageId, this.clock.now(), nonce);
      this.recordSent(messageId, chatId);
      this.reconcileEgress(nonce, messageId);
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
  public ambiguousSends(exclude: ReadonlySet<string>): AmbiguousSend[] {
    return (
      this.database
        .prepare(
          `SELECT nonce, chat_id AS chatId, preview, created_at AS createdAt,
             session_ear AS sessionEar, part, parts
           FROM outbound_intents WHERE state = 'pending' ORDER BY created_at`,
        )
        .all() as unknown as AmbiguousSend[]
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

  public dmUser(channelId: string): string | undefined {
    const row = this.database
      .prepare("SELECT user_id FROM dm_channels WHERE channel_id = ?")
      .get(channelId) as { user_id: string } | undefined;
    return row?.user_id;
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
           ORDER BY ${NEWEST_FIRST} LIMIT -1 OFFSET ?
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
             ORDER BY ${OLDEST_FIRST} LIMIT ?
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
           ORDER BY ${OLDEST_FIRST}`,
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

  /** The highest batch id ever handed out, deleted batches included (0 for none yet). */
  public batchHighWater(): number {
    const row = this.database
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'batches'")
      .get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  public confirmBatch(
    batchId: number,
    ear: string,
    attachGeneration: number,
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE batches SET offered_at = ?
         WHERE id = ? AND ear = ? AND attach_generation = ? AND offered_at IS NULL`,
      )
      .run(this.clock.now(), batchId, ear, attachGeneration);
    return result.changes === 1;
  }

  /**
   * Gives back every batch of the ear the host never confirmed, in one transaction. A
   * Discord batch's events are queued again. A canticle push's claim goes whole, as a
   * push no connection took gives it back (#161): its custody rows and tombstones go, the
   * tombstones of refreshes that collapsed into it too, so its records can be pushed
   * again while they are on air; the delivery cursor goes back to before the first such
   * push, unless a later push was confirmed since; and its id stays known as a canticle
   * push's, which names no chat. Returns how many batches it gave back and, for each
   * canticle push, its record identities and those of the refreshes collapsed into it.
   */
  public revertUnconfirmed(ear: string): {
    batches: number;
    canticle: CanticleReverted[];
  } {
    return this.transaction(() => {
      const batches = this.database
        .prepare(
          "SELECT id, kind FROM batches WHERE ear = ? AND offered_at IS NULL ORDER BY id",
        )
        .all(ear) as Array<{ id: number; kind: string }>;
      const now = this.clock.now();
      const canticle: CanticleReverted[] = [];
      const pushes = batches.filter((batch) => batch.kind === "canticle");
      const first = pushes[0];
      if (first !== undefined) {
        const claim = this.database
          .prepare(
            "SELECT cursor_name, cursor_before FROM canticle_claims WHERE ear = ? AND batch_id = ?",
          )
          .get(ear, first.id) as
          | { cursor_name: string; cursor_before: string }
          | undefined;
        const later = this.database
          .prepare(
            `SELECT 1 AS hit FROM batches WHERE ear = ? AND kind = 'canticle' AND id > ?
               AND offered_at IS NOT NULL LIMIT 1`,
          )
          .get(ear, first.id);
        if (claim !== undefined && later === undefined) {
          this.setRuntimeState(claim.cursor_name, claim.cursor_before);
        }
      }
      for (const batch of batches) {
        if (batch.kind === "canticle") {
          const identities = (
            this.database
              .prepare(
                "SELECT identity FROM canticle_custody WHERE ear = ? AND batch_id = ? ORDER BY id",
              )
              .all(ear, batch.id) as Array<{ identity: string }>
          ).map((row) => row.identity);
          const collapsed = (
            this.database
              .prepare(
                `SELECT identity FROM canticle_settled
                 WHERE ear = ? AND batch_id = ? AND outcome = 'collapsed' ORDER BY identity`,
              )
              .all(ear, batch.id) as Array<{ identity: string }>
          ).map((row) => row.identity);
          this.dropCanticleClaim(ear, batch.id);
          this.database
            .prepare(
              `INSERT INTO canticle_reverted (batch_id, ear, reverted_at) VALUES (?, ?, ?)
               ON CONFLICT(batch_id) DO NOTHING`,
            )
            .run(batch.id, ear, now);
          canticle.push({ batchId: batch.id, identities, collapsed });
          continue;
        }
        this.database
          .prepare(
            `UPDATE events SET state = CASE WHEN wake = 1 THEN 'queued' ELSE 'context' END,
               due_at = CASE WHEN wake = 1 THEN ? ELSE NULL END, batch_id = NULL, updated_at = ?
             WHERE batch_id = ? AND state = 'offered'`,
          )
          .run(now, now, batch.id);
        this.database.prepare("DELETE FROM batches WHERE id = ?").run(batch.id);
      }
      return { batches: batches.length, canticle };
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
               ORDER BY ${NEWEST_FIRST} LIMIT ?`,
          )
          .all(ear, limit)
      : this.database
          .prepare(
            `SELECT * FROM events WHERE ear = ? AND chat_id = ? AND state IN ${UNSEEN_STATES}
               ORDER BY ${NEWEST_FIRST} LIMIT ?`,
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
      // Pending ones too: an unconfirmed send that no retry resolved inside the
      // reuse window stays pending, and past retention it is history (#49).
      this.database
        .prepare("DELETE FROM outbound_intents WHERE updated_at < ?")
        .run(cutoff);
      this.database
        .prepare(
          `DELETE FROM batches WHERE created_at < ?
           AND NOT EXISTS (SELECT 1 FROM events WHERE events.batch_id = batches.id)`,
        )
        .run(cutoff);
      // One row per chat ever heard, so keep only the most recently active ones. A chat
      // quiet for longer than the rest owes little after an outage, and a read-back takes
      // at most limits.catchUpChats of them anyway.
      this.database
        .prepare(
          `DELETE FROM chat_anchors WHERE chat_id NOT IN (
             SELECT chat_id FROM chat_anchors
             ORDER BY length(message_id) DESC, message_id DESC LIMIT ?
           )`,
        )
        .run(MAX_ANCHORS);
      // A canticle tombstone outlives its record only by skew, whatever the retention.
      this.database
        .prepare("DELETE FROM canticle_settled WHERE expires_at <= ?")
        .run(this.clock.now());
      // Custody is kept for the retention window; once any of it goes, custody is whole
      // only from the cutoff, and a window reaching further back reads as unknown.
      const custody = Number(
        this.database
          .prepare("DELETE FROM canticle_custody WHERE claimed_at < ?")
          .run(cutoff).changes,
      );
      if (custody > 0 && this.canticleCustodySince() < cutoff) {
        this.setRuntimeState(CUSTODY_SINCE, String(cutoff));
      }
      // A push's saved cursor goes with its confirmation, release or revert; one whose
      // batch is gone otherwise has nothing left to give back to.
      this.database
        .prepare(
          "DELETE FROM canticle_claims WHERE batch_id NOT IN (SELECT id FROM batches)",
        )
        .run();
      // A reverted push's id stays a canticle id as long as its custody would have.
      this.database
        .prepare("DELETE FROM canticle_reverted WHERE reverted_at < ?")
        .run(cutoff);
      // Egress and derived-publication rows are kept as long as the custody they recorded.
      this.database
        .prepare("DELETE FROM room_egress WHERE decided_at < ?")
        .run(cutoff);
      // An unsettled derived publication is kept until it settles: it is the record that
      // its election may have published and must never be published again.
      this.database
        .prepare(
          `DELETE FROM derived_publications WHERE created_at < ?
           AND state IN ('accepted', 'refused')`,
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

  /** Was batch `id` offered (pushed) to this ear in this attach generation? */
  public offeredTo(id: number, ear: string, generation: number): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS hit FROM batches
         WHERE id = ? AND ear = ? AND attach_generation = ? AND offered_at IS NOT NULL`,
      )
      .get(id, ear, generation) as { hit: number } | undefined;
    return row !== undefined;
  }

  /**
   * Marks the ear registered without the canary: the session proved delivery by
   * acting on a pushed batch (#21). Returns true if this changed anything.
   */
  public registerEarByUse(name: string): boolean {
    const result = this.database
      .prepare(
        "UPDATE ears SET registered = 1, canary_nonce = NULL WHERE name = ? AND registered = 0",
      )
      .run(name);
    return result.changes === 1;
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
