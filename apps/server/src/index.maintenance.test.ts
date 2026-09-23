import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("relay maintenance wiring", () => {
  it("starts the stale session sweep from index without sleeping", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/startUnrefInterval\(\(\) => \{[\s\S]*?checkStaleSessions\(/);
    expect(source).toContain("sweepExpiredPendingTerminals");
    expect(source).toContain("closeBrowserSockets");
    expect(source).toContain("closeIdleRelaySessions");
  });
});
