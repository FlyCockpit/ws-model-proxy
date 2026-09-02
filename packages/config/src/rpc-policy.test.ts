import { describe, expect, it } from "vitest";
import { RPC_BATCH_MAX_SIZE } from "./rpc-policy";

describe("RPC_BATCH_MAX_SIZE", () => {
  it("limits each HTTP batch to three operations", () => {
    expect(RPC_BATCH_MAX_SIZE).toBe(3);
    expect(typeof RPC_BATCH_MAX_SIZE).toBe("number");
  });
});
