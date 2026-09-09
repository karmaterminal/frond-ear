import type { WakeAdapter } from "./adapters.js";
import type { DiscordGateway } from "./gateway.js";
import type { StructuredLogger } from "./logger.js";
import { classifyMessage } from "./policy.js";
import type { EventStore } from "./store.js";
import type { DiscordMessage, Policy } from "./types.js";

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
    if (this.options.adapter.name !== "manual") {
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

  private async deliverOnce(): Promise<void> {
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
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.store.release(
        batch.claimToken,
        message,
        policy.maxDeliveryAttempts,
      );
      this.options.logger.log("error", "adapter.delivery_failed", {
        adapter: this.options.adapter.name,
        error: message,
      });
    }
  }
}
