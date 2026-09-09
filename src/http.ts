import { createServer, type Server } from "node:http";

import type { EarService } from "./service.js";
import type { EventStore } from "./store.js";
import type { Policy } from "./types.js";

const MAX_BODY_BYTES = 64 * 1_024;

async function readJson(
  request: NodeJS.ReadableStream,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(typeof chunk === "string" ? chunk : (chunk as Uint8Array));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function writeJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function createHttpServer(options: {
  host: string;
  port: number;
  store: EventStore;
  service: EarService;
  getPolicy: () => Policy;
  reloadPolicy: () => Policy;
  leaseMs: number;
}): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${options.host}:${options.port}`,
      );
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { ok: true, ...options.service.status() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/queue/status") {
        writeJson(response, 200, options.service.status());
        return;
      }
      if (request.method === "POST" && url.pathname === "/queue/lease-next") {
        const body = await readJson(request);
        const leaseMs =
          typeof body.leaseMs === "number" &&
          Number.isSafeInteger(body.leaseMs) &&
          body.leaseMs > 0
            ? body.leaseMs
            : options.leaseMs;
        const batch = options.store.leaseNext(options.getPolicy(), leaseMs);
        writeJson(response, 200, { batch: batch ?? null });
        return;
      }
      if (request.method === "POST" && url.pathname === "/queue/ack") {
        const body = await readJson(request);
        if (typeof body.claimToken !== "string") {
          throw new Error("claimToken is required");
        }
        writeJson(response, 200, {
          updated: options.store.ack(body.claimToken),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/queue/release") {
        const body = await readJson(request);
        if (typeof body.claimToken !== "string") {
          throw new Error("claimToken is required");
        }
        const error =
          typeof body.error === "string" ? body.error : "released by client";
        writeJson(response, 200, {
          updated: options.store.release(
            body.claimToken,
            error,
            options.getPolicy().maxDeliveryAttempts,
          ),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/policy/reload") {
        writeJson(response, 200, { policy: options.reloadPolicy() });
        return;
      }
      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
