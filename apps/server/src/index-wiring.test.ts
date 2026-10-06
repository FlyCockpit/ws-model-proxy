import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * PRODUCTION WIRING GUARD: index.ts is the boot module (it starts timers and
 * listens), so its wiring object is not importable in a unit test. The relay
 * maintenance stop flushes the node audit queue and the telemetry rollups only
 * when index.ts passes the real writers (see relay-maintenance.ts and
 * relay/node-audit.ts); without those lines the queues are dropped at shutdown.
 * The maintenance unit tests inject their own fakes, so only this guard pins the
 * production object.
 */
const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

/** The argument object text of `startRelayMaintenance({ ... })`. */
function maintenanceOptions(): string {
  const match = /startRelayMaintenance\(\{([\s\S]*?)\n\}\)/.exec(source);
  if (!match?.[1]) throw new Error("startRelayMaintenance({ ... }) call not found in index.ts");
  return match[1];
}

describe("index.ts relay maintenance wiring", () => {
  it("imports the node audit stop and flush from their module", () => {
    expect(source).toMatch(
      /import \{ flushNodeAudit, stopNodeAuditWriter \} from "\.\/relay\/node-audit\.js";/,
    );
  });

  it("passes the real audit writer stop and the rollup flushes to relay maintenance", () => {
    const options = maintenanceOptions();
    expect(options).toMatch(/stopNodeAudit:\s*stopNodeAuditWriter\b/);
    expect(options).toMatch(
      /flushRollups:\s*\[\s*flushRuntimeLoadRollup,\s*flushNodeMetricsRollup\s*\]/,
    );
    expect(options).toMatch(/\bsweepExpiredNodeCommands\b/);
    expect(options).toMatch(/\bsweepExpiredFileOps\b/);
  });

  it("passes the real audit flush to the shutdown, after the relay close", () => {
    expect(source).toMatch(/installServerShutdown\(\{[\s\S]*?flushAgentAudit:\s*flushNodeAudit\b/);
  });

  it("keeps the relay maintenance stop in the shutdown periodic-job list", () => {
    expect(source).toMatch(/periodicJobStops:\s*\[[\s\S]*?\bstopRelayMaintenance\b/);
  });
});
