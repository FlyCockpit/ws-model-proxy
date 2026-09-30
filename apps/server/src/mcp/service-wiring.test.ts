import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The metric rule editor is a management (M) writer and must not write the
// hot-path verdict table, so it clears a pool's verdicts through
// `services.onPoolRoutingRulesChanged`, which the relay implements. An
// unwired service would silently leave stale verdicts, so pin the wiring.
describe("context services wiring", () => {
  it("connects onPoolRoutingRulesChanged and onRemoteMetricSourcesChanged to the relay", () => {
    const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(app).toMatch(
      /onPoolRoutingRulesChanged:\s*\(poolId: string\)\s*=>\s*relaySessionManager\.onPoolRoutingRulesChanged\(poolId\)/,
    );
    expect(app).toMatch(
      /onRemoteMetricSourcesChanged:\s*\(cliDeviceId: string\)\s*=>\s*relaySessionManager\.onRemoteMetricSourcesChanged\(cliDeviceId\)/,
    );
  });
});
