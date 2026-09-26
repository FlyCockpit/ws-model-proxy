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

// F2-07: the database step is the tested helper disconnectDatabaseClients
// (sweep shutdown bounded by join + disconnect, then the shared disconnect
// bounded by SHARED_DISCONNECT_TIMEOUT_MS; executed against PostgreSQL in
// packages/api/src/lib/parent-deletion.postgres.integration.test.ts), and the
// whole sequence runs under the process watchdog (runProcessShutdown, armed
// before anything is awaited; unit-tested in graceful-shutdown.test.ts).
// Supplementary: the behavior is covered by those tests, this pins the wiring.
describe("shutdown wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("disconnectPrisma runs disconnectDatabaseClients: the sweep's bounded shutdown, then the shared client", () => {
    const step = code.match(/disconnectPrisma: async \(\) => \{([\s\S]*?)\n {4}\},/)?.[1];
    expect(step).toBeDefined();
    expect(step).toMatch(
      /^\s*await disconnectDatabaseClients\(\{\s*shutDownSweep: \(\) =>\s*shutDownUserDeletionSweep\(\{\s*stopped: \(\) => userDeletionSweepStopped \?\? stopUserDeletionSweep\(\),\s*client: userDeletionSweepClient,\s*\}\),\s*shared: prisma,\s*\}\);\s*$/,
    );
    // Nothing else disconnects a client or waits on the sweep client.
    expect(code.match(/\$disconnect\(/g)).toBeNull();
    expect(source.match(/userDeletionSweepClient\b/g)).toHaveLength(3);
    expect(source).toContain("startUserDeletionSweep({ prisma: userDeletionSweepClient.prisma })");
  });

  it("shutdown arms the process watchdog before anything is awaited and exits only through it", () => {
    const body = code.match(/\nfunction shutdown\(signal: string\) \{([\s\S]*?)\n\}\n/)?.[1];
    expect(body).toBeDefined();
    // Synchronous function: no await can precede the watchdog.
    expect(body).not.toMatch(/\bawait\b[\s\S]*runProcessShutdown\(/);
    expect(body).toMatch(
      /isShuttingDown = true;\s*console\.log\([^\n]*\);\s*runProcessShutdown\(\{ sequence: runShutdownSequence \}\);\s*$/,
    );
    expect(code).not.toMatch(/async function shutdown\(/);
    expect(code).toMatch(
      /\nasync function runShutdownSequence\(\) \{\n {2}await runGracefulShutdownSequence\(\{/,
    );
    // The only exits on the shutdown path are runProcessShutdown's.
    expect(body).not.toContain("process.exit");
  });
});
