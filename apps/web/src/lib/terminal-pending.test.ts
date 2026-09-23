import { describe, expect, it } from "vitest";

import { takePendingByTerminalId } from "./terminal-pending";

describe("takePendingByTerminalId", () => {
  it("matches only the terminal id and does not delete a different key", () => {
    const pending = new Map([
      ["local-a", { localId: "local-a", terminalId: "term-a" }],
      ["local-b", { localId: "local-b", terminalId: "term-b" }],
    ]);
    expect(takePendingByTerminalId(pending, "term-b")?.localId).toBe("local-b");
    expect(pending.has("local-a")).toBe(true);
    expect(pending.has("local-b")).toBe(false);
    expect(takePendingByTerminalId(pending, "term-missing")).toBeNull();
    expect(pending.size).toBe(1);
    expect(takePendingByTerminalId(pending, "term-a")).not.toBeNull();
    const only = new Map([["local-a", { localId: "local-a", terminalId: "term-a" }]]);
    expect(takePendingByTerminalId(only, "term-other")).toBeNull();
    expect(only.size).toBe(1);
  });
});
