import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeOwnerMatches } from "./node-owner.js";

describe("nodeOwnerMatches", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("matches the node's own owner only", () => {
    expect(nodeOwnerMatches({ userId: "user-1" }, "user-1", "command")).toBe(true);
    expect(nodeOwnerMatches({ userId: "user-1" }, "user-2", "command")).toBe(false);
    expect(warn.mock.calls).toEqual([
      ["[relay] refused a send to a node of another owner", "command"],
    ]);
  });

  it("refuses (without logging) a node that is offline or gone", () => {
    expect(nodeOwnerMatches(null, "user-1", "secret")).toBe(false);
    expect(nodeOwnerMatches(undefined, "user-1", "secret")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never matches an owner that is not a real id, even an equal one", () => {
    expect(nodeOwnerMatches({ userId: "" }, "", "frame")).toBe(false);
    const missing = undefined as unknown as string;
    expect(nodeOwnerMatches({ userId: missing }, missing, "frame")).toBe(false);
  });
});
