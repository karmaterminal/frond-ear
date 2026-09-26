// Shared k6 helpers for frond-ear chaos proof rows. Every row is single-VU,
// fire-and-observe against tools/chaos/controller.ts (never real Discord or a
// real Claude session), mirroring karmaterminal's k6 proof-row methodology.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

export const failures = new Counter("proof_failures");

export const IDS = {
  bot: "100000000000000001",
  principal: "200000000000000002",
  ambient: "400000000000000004",
  guild: "600000000000000006",
  channel: "700000000000000007",
  room: "700000000000000008",
};

export function rowOptions(maxDuration = "90s") {
  return {
    scenarios: {
      proof: {
        executor: "shared-iterations",
        vus: 1,
        iterations: 1,
        maxDuration,
      },
    },
    thresholds: { proof_failures: ["count==0"] },
  };
}

const BASE = __ENV.FROND_EAR_CHAOS_URL || "http://127.0.0.1:7788";

export function api(method, path, body, timeout = "60s") {
  const response = http.request(
    method,
    `${BASE}${path}`,
    body === undefined ? null : JSON.stringify(body),
    {
      headers: { "content-type": "application/json" },
      timeout,
    },
  );
  let parsed = null;
  try {
    parsed = response.json();
  } catch (_) {
    parsed = { raw: response.body };
  }
  if (response.status !== 200) {
    failures.add(1);
    console.error(`${method} ${path} -> ${response.status} ${response.body}`);
  }
  return parsed;
}

/** A named assertion; every failure counts toward the proof_failures threshold. */
export function expect(name, condition, detail) {
  const ok = check(null, { [name]: () => condition === true });
  if (!ok) {
    failures.add(1);
    console.error(
      `ASSERTION FAILED: ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`,
    );
  }
  return ok;
}

export function waitFor(query, timeoutMs = 10000) {
  const params = Object.entries({ ...query, timeoutMs })
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return api(
    "GET",
    `/session/wait?${params}`,
    undefined,
    `${Math.ceil(timeoutMs / 1000) + 10}s`,
  );
}

export function saveLedger(row) {
  const dir = __ENV.FROND_EAR_ARTIFACT_DIR;
  const suffix = dir
    ? `?save=${encodeURIComponent(`${dir}/${row}/ledger.json`)}`
    : "";
  return api("GET", `/ledger${suffix}`);
}

export function summaryWriter(row, classification) {
  return (data) => {
    const dir = __ENV.FROND_EAR_ARTIFACT_DIR;
    const verdict =
      (data.metrics.proof_failures?.values?.count ?? 0) === 0
        ? "PASS-candidate"
        : "FAIL";
    const receipt = {
      schema: "frond-ear.k6.proof-row-receipt.v1",
      row,
      classification,
      verdict,
      candidateSha: __ENV.FROND_EAR_CANDIDATE_SHA || "unset",
      checks: data.root_group.checks.map((item) => ({
        name: item.name,
        passes: item.passes,
        fails: item.fails,
      })),
    };
    const out = { stdout: `${row}: ${verdict}\n` };
    if (dir) {
      out[`${dir}/${row}/k6-summary.json`] = JSON.stringify(data, null, 2);
      out[`${dir}/${row}/receipt.json`] = JSON.stringify(receipt, null, 2);
    }
    return out;
  };
}

/**
 * Blocks on an observable state in the controller (ledger row, held send,
 * quiescence). A barrier that is not reached fails the row; rows never sleep.
 */
export function barrier(name, cond, params = {}, timeoutMs = 10000) {
  const query = Object.entries({ cond, ...params, timeoutMs })
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  const result = api(
    "GET",
    `/barrier?${query}`,
    undefined,
    `${Math.ceil(timeoutMs / 1000) + 10}s`,
  );
  expect(`barrier: ${name}`, result.reached === true, result);
  return result.reached === true;
}
