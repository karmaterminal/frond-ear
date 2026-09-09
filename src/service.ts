import type { WakeAdapter } from "./adapters.js";
import type { DiscordGateway } from "./gateway.js";
import type { StructuredLogger } from "./logger.js";
import { classifyMessage } from "./policy.js";
import type { EventStore } from "./store.js";
import type { DiscordMessage, Policy } from "./types.js";

export class EarService {
  private deliveryTimer: NodeJS.Timeout | undefined;

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
      this.options.store.incrementCounter(`suppressed_${classification.reason}`);
      return classification.reason;
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

  public start(): void {
    this.options.store.recoverExpiredLeases();
    this.options.store.prune(this.options.policy().retentionMs);
    if (this.options.policy().gatewayEnabled) {
      this.options.gateway.start();
    }
    if (this.options.adapter.name !== "manual") {
      this.scheduleDelivery(0);
    }
  }

  public stop(): void {
    if (this.deliveryTimer) {
      clearTimeout(this.deliveryTimer);
      this.deliveryTimer = undefined;
    }
    this.options.gateway.stop();
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

  private scheduleDelivery(delayMs: number): void {
    this.deliveryTimer = setTimeout(() => {
      void this.deliverOnce().finally(() => this.scheduleDelivery(1_000));
    }, delayMs);
  }

  private async deliverOnce(): Promise<void> {
    const policy = this.options.policy();
    const batch = this.options.store.leaseNext(policy, this.options.leaseMs);
    if (!batch) {
      return;
    }
    try {
      await this.options.adapter.deliver(batch);
      this.options.store.ack(batch.claimToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.store.release(batch.claimToken, message, policy.maxDeliveryAttempts);
      this.options.logger.log("error", "adapter.delivery_failed", {
        adapter: this.options.adapter.name,
        error: message,
      });
    }
  }
}
