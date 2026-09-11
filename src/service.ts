import { DeliveryError, type WakeAdapter } from "./adapters.js";
import type { DiscordGateway } from "./gateway.js";
import type { StructuredLogger } from "./logger.js";
import { classifyMessage } from "./policy.js";
import { conversationIdentity, type EventStore } from "./store.js";
import type {
  ConversationIdentity,
  DiscordMessage,
  Policy,
  SessionBinding,
} from "./types.js";

export class EarService {
  private deliveryTimer: NodeJS.Timeout | undefined;
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private deliveryInFlight: Promise<void> | undefined;
  private running = false;

  public constructor(
    private readonly options: {
      store: EventStore;
      policy: () => Policy;
      gateway: DiscordGateway;
      adapter: WakeAdapter;
      leaseMs: number;
      logger: StructuredLogger;
    },
  ) {}

  public ingest(message: DiscordMessage): string {
    const policy = this.options.policy();
    const classification = classifyMessage(message, policy);
    if (!classification.accepted) {
      this.options.store.incrementCounter(
        `suppressed_${classification.reason}`,
      );
      return classification.reason;
    }
    if (this.isNewCommand(message)) {
      if (policy.priorityAuthorIds.includes(message.author.id)) {
        const result = this.options.store.rotate(
          conversationIdentity(message),
          `discord:${message.id}`,
          message.author.id,
          "authorized_discord_new",
        );
        this.options.logger.log("info", "binding.rotated", {
          conversationKey: result.binding.conversation.key,
          generation: result.binding.generation,
          sessionId: result.binding.sessionId,
          actorId: message.author.id,
          fencedEvents: result.fencedEvents,
          replay: !result.rotated,
        });
        return result.rotated ? "binding_rotated" : "duplicate_control";
      }
      this.options.store.incrementCounter("unauthorized_control_messages");
    }
    const result = this.options.store.enqueue(
      message,
      policy,
      classification.priority,
      classification.weight,
    );
    if (result === "duplicate") {
      this.options.store.incrementCounter("duplicates");
    }
    return result;
  }

  private isNewCommand(message: DiscordMessage): boolean {
    const directMention = `<@${this.options.policy().botUserId}>`;
    return (
      message.content.trim() === "/new" ||
      message.content.trim() === `${directMention} /new`
    );
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.options.store.recoverExpiredLeases();
    this.options.store.prune(this.options.policy().retentionMs);
    this.scheduleMaintenance();
    if (this.options.policy().gatewayEnabled) {
      this.options.gateway.start();
    }
    if (
      this.options.adapter.automaticDelivery &&
      this.options.adapter.available()
    ) {
      this.scheduleDelivery(0);
    }
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.deliveryTimer) {
      clearTimeout(this.deliveryTimer);
      this.deliveryTimer = undefined;
    }
    if (this.maintenanceTimer) {
      clearTimeout(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }
    this.options.gateway.stop();
    await this.deliveryInFlight;
    await this.options.adapter.close?.();
  }

  public onPolicyReload(previous: Policy, next: Policy): void {
    if (previous.gatewayEnabled && !next.gatewayEnabled) {
      this.options.gateway.stop();
    } else if (!previous.gatewayEnabled && next.gatewayEnabled) {
      this.options.gateway.start();
    }
  }

  public status(): Record<string, unknown> {
    return {
      gateway: this.options.gateway.status(),
      queue: this.options.store.counts(),
      counters: this.options.store.counters(),
      runtime: this.options.store.runtimeState(),
      wakeDeliveryPaused: this.options.policy().wakeDeliveryPaused,
      adapter: this.options.adapter.status(),
    };
  }

  public rotateBinding(
    identity: ConversationIdentity,
    requestId: string,
    actorId = "loopback-operator",
  ): SessionBinding {
    const result = this.options.store.rotate(
      identity,
      `loopback:${requestId}`,
      actorId,
      "authorized_loopback_new",
    );
    this.options.logger.log("info", "binding.rotated", {
      conversationKey: result.binding.conversation.key,
      generation: result.binding.generation,
      sessionId: result.binding.sessionId,
      actorId,
      fencedEvents: result.fencedEvents,
      replay: !result.rotated,
    });
    return result.binding;
  }

  public setBindingPaused(
    conversationKey: string,
    paused: boolean,
  ): SessionBinding {
    const binding = this.options.store.setBindingPaused(
      conversationKey,
      paused,
    );
    this.options.logger.log("info", "binding.pause_changed", {
      conversationKey,
      generation: binding.generation,
      paused,
    });
    return binding;
  }

  private scheduleDelivery(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.deliveryTimer = setTimeout(() => {
      this.deliveryInFlight = this.deliverOnce()
        .catch((error: unknown) => {
          this.options.logger.log("error", "adapter.delivery_loop_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.deliveryInFlight = undefined;
          if (this.running) {
            this.scheduleDelivery(1_000);
          }
        });
    }, delayMs);
  }

  private scheduleMaintenance(): void {
    if (!this.running) {
      return;
    }
    const interval = Math.min(
      this.options.policy().retentionMs,
      60 * 60 * 1_000,
    );
    this.maintenanceTimer = setTimeout(() => {
      this.options.store.prune(this.options.policy().retentionMs);
      this.scheduleMaintenance();
    }, interval);
    this.maintenanceTimer.unref();
  }

  public async deliverOnce(): Promise<void> {
    if (!this.options.adapter.available()) {
      return;
    }
    const policy = this.options.policy();
    const batch = this.options.store.leaseNext(policy, this.options.leaseMs);
    if (!batch) {
      return;
    }
    try {
      await this.options.adapter.deliver(batch);
      const updated = this.options.store.ack(batch.claimToken);
      if (updated === 0) {
        this.options.store.incrementCounter("lease_lost");
        this.options.logger.log("warn", "adapter.lease_lost", {
          claimToken: batch.claimToken,
          bindingGeneration: batch.binding.generation,
        });
      } else {
        this.options.logger.log("info", "adapter.delivery_accepted", {
          adapter: this.options.adapter.name,
          conversationKey: batch.binding.conversation.key,
          bindingGeneration: batch.binding.generation,
          sessionId: batch.binding.sessionId,
          eventCount: batch.eventIds.length,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const disposition =
        error instanceof DeliveryError ? error.disposition : "retry";
      if (disposition === "dead_letter") {
        this.options.store.deadLetterLease(batch.claimToken, message);
      } else {
        this.options.store.release(
          batch.claimToken,
          message,
          policy.maxDeliveryAttempts,
        );
      }
      this.options.logger.log("error", "adapter.delivery_failed", {
        adapter: this.options.adapter.name,
        deliveryError: message,
        disposition,
        conversationKey: batch.binding.conversation.key,
        bindingGeneration: batch.binding.generation,
      });
    }
  }
}
