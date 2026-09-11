import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  CommandAdapter,
  CopilotSdkAdapter,
  ManualAdapter,
  ReleasedCopilotSdkFactory,
} from "./adapters.js";
import { loadConfig, loadPolicy } from "./config.js";
import { DiscordGateway } from "./gateway.js";
import { createHttpServer } from "./http.js";
import { StructuredLogger } from "./logger.js";
import { EarService } from "./service.js";
import { EventStore } from "./store.js";

const config = loadConfig();
let policy = loadPolicy(config.policyPath);
mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
const logger = new StructuredLogger(undefined, [config.discordToken]);
const store = new EventStore(config.databasePath);
let service: EarService;
const gateway = new DiscordGateway({
  token: config.discordToken,
  gatewayUrl: config.gatewayUrl,
  store,
  logger,
  onMessage: (message) => {
    const result = service.ingest(message);
    logger.log("debug", "message.classified", {
      messageId: message.id,
      channelId: message.channel_id,
      authorId: message.author.id,
      result,
    });
  },
});
const adapter =
  config.adapter.kind === "manual"
    ? new ManualAdapter()
    : config.adapter.kind === "command"
      ? new CommandAdapter(config.adapter)
      : new CopilotSdkAdapter({
          factory: new ReleasedCopilotSdkFactory(),
          timeoutMs: config.adapter.timeoutMs,
          maxCachedSessions: config.adapter.maxCachedSessions,
          isLeaseActive: (
            claimToken,
            bindingId,
            generation,
            minimumRemainingMs,
          ) =>
            store.isLeaseActive(
              claimToken,
              bindingId,
              generation,
              minimumRemainingMs,
            ),
        });
service = new EarService({
  store,
  policy: () => policy,
  gateway,
  adapter,
  leaseMs: config.leaseMs,
  logger,
});
const server = createHttpServer({
  host: config.host,
  port: config.port,
  store,
  service,
  getPolicy: () => policy,
  reloadPolicy: () => {
    const previous = policy;
    const next = loadPolicy(config.policyPath);
    policy = next;
    service.onPolicyReload(previous, next);
    logger.log("info", "policy.reloaded", {
      gatewayEnabled: next.gatewayEnabled,
      wakeDeliveryPaused: next.wakeDeliveryPaused,
      allowedGuildCount: next.allowedGuildIds.length,
      allowedChannelCount: next.allowedChannelIds.length,
    });
    return next;
  },
  leaseMs: config.leaseMs,
});

server.listen(config.port, config.host, () => {
  logger.log("info", "service.started", {
    host: config.host,
    port: config.port,
    gatewayEnabled: policy.gatewayEnabled,
    adapter: adapter.name,
  });
  service.start();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.log("info", "service.stopping", { signal });
  await service.stop();
  server.close(() => {
    store.close();
    process.exitCode = 0;
  });
  setTimeout(() => {
    process.exitCode = 1;
    server.closeAllConnections();
  }, 10_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
