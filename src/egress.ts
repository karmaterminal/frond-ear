// Room output and source use, frond-ear's scope (binary-canticle#161 item 3).
//
// frond-ear holds both ends for a Claude seat: canticle comes in through it (`hear`, the
// push) and room output goes out through it (`reply`, `react`, `edit_message`). So the
// source-use check sits in one process, at every write to a Discord room: `RoomEgress.open`.
// It reads the speaking session's canticle custody, asks the configured policy, and records
// an egress row of the exposure state at that moment (the records the speaker had echoed,
// by id and digest, never payload; the history flag; the compaction boundary) before
// anything is sent. Only the permit it returns can write to Discord, and only the write it
// was opened for, until it is settled: a retry or replay opens a new one and is checked
// again. Bash, gh, files and other MCP servers reach rooms without frond-ear: they are
// outside this check, and nothing here vouches for them.
//
// The source-use rule itself is not adopted. `observe` (the default) refuses nothing and
// records. `strict-fresh`, the unadopted "all history must be fresh" candidate, refuses
// unless the speaker's history is complete: every record it was exposed to in the window
// offered and echoed within its current compaction boundary, nothing unknown.

import { createHash } from "node:crypto";

import type { CustodyState, CustodyView } from "./canticle/custody.ts";
import type { OutboundFile } from "./outbound-files.ts";
import type { DiscordRest } from "./rest.ts";
import type { CompactionBoundary, EventStore } from "./store.ts";
import type { Clock } from "./types.ts";

/** config `canticle.roomPolicy`: what the egress gate does with what it reads. */
export const ROOM_POLICIES = ["observe", "strict-fresh"] as const;
export type RoomPolicy = (typeof ROOM_POLICIES)[number];

/** The tools whose calls write to a Discord room; each goes through `RoomEgress.open`. */
export const ROOM_OUTPUT_TOOLS = ["reply", "react", "edit_message"] as const;
export type RoomOutputTool = (typeof ROOM_OUTPUT_TOOLS)[number];

/** The Discord calls the daemon may make outside the gate: reads only. */
export type DiscordReads = Pick<
  DiscordRest,
  "fetchMessages" | "fetchMessage" | "downloadAttachment"
>;

type DiscordWrites = Pick<
  DiscordRest,
  "sendMessage" | "addReaction" | "editMessage"
>;

/** One room output as the gate sees it: where it goes and what it is. */
export type RoomOutput =
  | {
      tool: "reply";
      chatId: string;
      replyTo: string | undefined;
      /** The reply's identity hash (chat, reply_to, whole text, files): never its text. */
      identity: string;
    }
  | { tool: "react"; chatId: string; messageId: string; emoji: string }
  | { tool: "edit_message"; chatId: string; messageId: string; text: string };

/**
 * Who is speaking, as custody can judge them: the session holding the ear, a session it
 * superseded (or whose ear was removed), or no ear's session at all (a CLI, a script).
 */
export type Speaker = "holder" | "superseded" | "other";

/** The speaking session's custody when the gate is asked. */
export interface SpeakerCustody {
  /** The ear whose custody was read: the speaker's, else the chat's. */
  ear: string;
  speaker: Speaker;
  sessionId: string | null;
  view: CustodyView;
  /** The speaker's compaction boundary; undefined when frond-ear can't know it. */
  boundary: CompactionBoundary;
  /** Where the custody window began. */
  since: number;
}

/** A source the speaker had echoed, as an egress row keeps it: id, digest, state. */
export interface EgressSource {
  identity: string;
  digest: string | null;
  state: CustodyState;
}

export interface RoomDecision {
  allow: boolean;
  reason: string;
}

const historyLine = (view: CustodyView) =>
  `history ${view.history}${view.reasons.length > 0 ? `: ${view.reasons.join("; ")}` : ""}`;

/**
 * What a policy makes of the speaker's custody. `observe` allows everything. `strict-fresh`
 * refuses when any echoed source predates the current compaction boundary, or when the
 * history is unknown or incomplete; it allows only a complete history.
 */
export function roomDecision(
  policy: RoomPolicy,
  view: CustodyView,
): RoomDecision {
  if (policy === "observe") {
    return { allow: true, reason: "observed, not enforced" };
  }
  const stale = view.records.some(
    (record) => record.state === "echoed_before_boundary",
  );
  return {
    allow: view.history === "complete" && !stale,
    reason: historyLine(view),
  };
}

/** The records a view holds as echoed (in any state), by id and digest. */
export function echoedSources(view: CustodyView): EgressSource[] {
  return view.records
    .filter((record) => record.exposure.echoedAt !== null)
    .map((record) => ({
      identity: record.exposure.identity,
      digest: record.exposure.digest,
      state: record.state,
    }));
}

/**
 * A speaker frond-ear can't place against a compaction boundary: what custody holds of it,
 * with its history unknown for `reason` alone.
 */
export function unplaced(view: CustodyView, reason: string): CustodyView {
  return { ...view, history: "unknown", reasons: [reason] };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** What an output's row names it by: never its text. */
function described(output: RoomOutput): {
  target: string | null;
  digest: string;
} {
  switch (output.tool) {
    case "reply":
      return { target: output.replyTo ?? null, digest: output.identity };
    case "react":
      return {
        target: output.messageId,
        digest: sha256(
          `${output.chatId}\n${output.messageId}\n${output.emoji}`,
        ),
      };
    case "edit_message":
      return {
        target: output.messageId,
        digest: sha256(`${output.chatId}\n${output.messageId}\n${output.text}`),
      };
  }
}

/** A room output the policy refused: its row is recorded, and nothing was sent. */
export class RoomRefused extends Error {
  public readonly egressId: number;
  public readonly reason: string;

  public constructor(policy: RoomPolicy, reason: string, egressId: number) {
    super(
      `refused by canticle.roomPolicy ${policy}: ${reason}; nothing was sent (frond-ear room output, egress row ${egressId})`,
    );
    this.name = "RoomRefused";
    this.egressId = egressId;
    this.reason = reason;
  }
}

/**
 * The only way to write to Discord: one room output's, until it is settled. A reply's
 * permit sends its parts to its chat; a reaction's or an edit's applies that one write.
 */
export interface RoomPermit {
  readonly egressId: number;
  /** One message of the reply this permit was opened for, in its chat. */
  send(
    content: string,
    replyTo: string | undefined,
    nonce: string,
    files: readonly OutboundFile[],
  ): Promise<{ id: string }>;
  /** The reaction or the edit this permit was opened for. */
  apply(): Promise<void>;
  /** Records how the output went; after it the permit writes nothing. */
  settle(outcome: "sent" | "error"): void;
}

/** The egress gate: one per daemon, holding the only reference to Discord's writes. */
export class RoomEgress {
  readonly #writes: DiscordWrites;
  readonly #store: EventStore;
  readonly #clock: Clock;

  public constructor(writes: DiscordWrites, store: EventStore, clock: Clock) {
    this.#writes = writes;
    this.#store = store;
    this.#clock = clock;
  }

  /**
   * Decides one room output under `policy` from the speaker's custody now, and records its
   * row before anything is sent. Throws `RoomRefused` (the row recorded as refused) or
   * returns the permit for that output alone.
   */
  public open(
    output: RoomOutput,
    policy: RoomPolicy,
    custody: SpeakerCustody,
  ): RoomPermit {
    const decision = roomDecision(policy, custody.view);
    const egressId = this.#store.openEgress({
      ear: custody.ear,
      tool: output.tool,
      chatId: output.chatId,
      ...described(output),
      sessionId: custody.sessionId,
      speaker: custody.speaker,
      policy,
      decision: decision.allow ? "allow" : "refuse",
      reason: decision.reason,
      history: custody.view.history,
      reasons: custody.view.reasons,
      boundary: custody.boundary,
      sources: echoedSources(custody.view),
      since: custody.since,
      decidedAt: this.#clock.now(),
    });
    if (!decision.allow) {
      throw new RoomRefused(policy, decision.reason, egressId);
    }
    const writes = this.#writes;
    const written: string[] = [];
    let settled = false;
    const live = () => {
      if (settled) {
        throw new Error(
          "this room output is settled: a retry goes through the egress gate again",
        );
      }
    };
    return {
      egressId,
      send: async (content, replyTo, nonce, files) => {
        live();
        if (output.tool !== "reply") {
          throw new Error(`a ${output.tool} permit sends no message`);
        }
        const sent = await writes.sendMessage(
          output.chatId,
          content,
          replyTo,
          nonce,
          files,
        );
        written.push(sent.id);
        return sent;
      },
      apply: async () => {
        live();
        if (output.tool === "react") {
          await writes.addReaction(
            output.chatId,
            output.messageId,
            output.emoji,
          );
        } else if (output.tool === "edit_message") {
          await writes.editMessage(
            output.chatId,
            output.messageId,
            output.text,
          );
          written.push(output.messageId);
        } else {
          throw new Error("a reply's permit sends its parts");
        }
      },
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        this.#store.settleEgress(egressId, outcome, written, this.#clock.now());
      },
    };
  }
}
