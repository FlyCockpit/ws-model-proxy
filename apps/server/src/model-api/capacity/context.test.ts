import { describe, expect, it, vi } from "vitest";
import { countContext } from "./context.js";

describe("context counting hierarchy", () => {
  it("uses the first available counter", async () => {
    const unavailable = { count: vi.fn().mockResolvedValue(null) };
    const tokenizer = {
      count: vi.fn().mockResolvedValue({ tokens: 42, method: "TOKENIZER_TEMPLATE", exact: false }),
    };
    await expect(
      countContext({ input: {}, counters: [unavailable, tokenizer], serializedChars: 1000 }),
    ).resolves.toEqual({ tokens: 42, method: "TOKENIZER_TEMPLATE", exact: false });
  });

  it("falls back to a conservative character estimate", async () => {
    await expect(
      countContext({ input: {}, counters: [], serializedChars: 100, safetyMargin: 1.2 }),
    ).resolves.toEqual({ tokens: 30, method: "CHAR_ESTIMATE", exact: false });
  });

  it("allows only native counts to claim exactness", async () => {
    await expect(
      countContext({
        input: {},
        counters: [{ count: async () => ({ tokens: 1, method: "TOKEN_ESTIMATE", exact: true }) }],
        serializedChars: 0,
      }),
    ).rejects.toThrow("Only native counts");
  });
});
