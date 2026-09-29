import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * PRODUCTION WIRING GUARD: index.ts is the boot module (it starts timers and
 * listens), so its wiring object is not importable in a unit test. The relay
 * maintenance stop flushes the agent audit queue only when index.ts passes the
 * real writer (see relay-maintenance.ts and relay/cli-agent-audit.ts); without
 * that line the queue is dropped at shutdown. The maintenance unit tests inject
 * their own fake `stopCliAgentAudit`, so only this guard pins the production
 * object. Mutating the wiring out of index.ts fails here.
 */
const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

/** The argument object text of `startRelayMaintenance({ ... })`. */
function maintenanceOptions(): string {
  const match = /startRelayMaintenance\(\{([\s\S]*?)\n\}\)/.exec(source);
  if (!match?.[1]) throw new Error("startRelayMaintenance({ ... }) call not found in index.ts");
  return match[1];
}

describe("index.ts relay maintenance wiring", () => {
  it("imports the agent audit stop from its module", () => {
    expect(source).toMatch(
      /import \{ stopCliAgentAuditWriter \} from "\.\/relay\/cli-agent-audit\.js";/,
    );
  });

  it("passes the real audit writer stop to relay maintenance", () => {
    // Property value must be the imported writer, not an inline no-op.
    expect(maintenanceOptions()).toMatch(/stopCliAgentAudit:\s*stopCliAgentAuditWriter\b/);
  });

  it("keeps the relay maintenance stop in the shutdown periodic-job list", () => {
    expect(source).toMatch(/periodicJobStops:\s*\[[\s\S]*?\bstopRelayMaintenance\b/);
  });
});
