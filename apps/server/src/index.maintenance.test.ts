import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("relay maintenance wiring", () => {
  it("starts the stale session sweep from index without sleeping", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/startUnrefInterval\(\(\) => \{[\s\S]*?checkStaleSessions\(/);
    expect(source).toContain("sweepExpiredPendingTerminals");
    expect(source).toContain("closeBrowserSockets");
    expect(source).toContain("closeIdleRelaySessions");
    expect(source).toContain("backfillDiscoveredInferenceCapacities()");
  });
});

// F2-07: the sweep's shutdown step is the tested helper (join bounded,
// quarantine past the deadline, disconnect bounded; executed against
// PostgreSQL in packages/api/src/lib/parent-deletion.postgres.integration.test.ts),
// called on the sweep's own client before the shared client disconnects,
// and nothing in index.ts waits on the sweep client outside it.
describe("user deletion sweep shutdown wiring", () => {
  it("disconnectPrisma runs shutDownUserDeletionSweep on the sweep client, then the shared disconnect", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const step = source.match(/disconnectPrisma: async \(\) => \{([\s\S]*?)\n {4}\},/)?.[1];
    expect(step).toBeDefined();
    const code = (step ?? "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).toMatch(
      /await shutDownUserDeletionSweep\(\{\s*stopped: \(\) => userDeletionSweepStopped \?\? stopUserDeletionSweep\(\),\s*client: userDeletionSweepClient,\s*\}\);\s*await prisma\.\$disconnect\(\);\s*$/,
    );
    // The sweep client is created once, started on its fenced Prisma client,
    // and never disconnected or awaited anywhere else.
    expect(source.match(/userDeletionSweepClient\b/g)).toHaveLength(3);
    expect(source).toContain("startUserDeletionSweep({ prisma: userDeletionSweepClient.prisma })");
  });
});
