import { describe, expect, it, vi } from "vitest";
import { contextFitsLimits, countContext, countSerializedRequestContext } from "./context.js";

function largePngDataUrl(width: number, height: number, base64Chars: number): string {
  const header = Buffer.alloc(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header[11] = 13;
  header.write("IHDR", 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  const binary = Buffer.alloc(Math.ceil((base64Chars * 3) / 4));
  header.copy(binary);
  return `data:image/png;base64,${binary.toString("base64")}`;
}

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

  it("threads cancellation through the counting hierarchy", async () => {
    const controller = new AbortController();
    const count = vi.fn(async (_input, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error("cancelled"));
      return null;
    });
    await expect(
      countContext({
        input: {},
        counters: [{ count }],
        serializedChars: 10,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });

  it("serializes the complete request and reports fallback confidence and margin", async () => {
    const input = {
      instructions: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup", schema: { type: "object" } }],
      max_output_tokens: 200,
    };
    const serializedChars = JSON.stringify(input).length;
    await expect(
      countSerializedRequestContext({ input, safetyMargin: 1.25, useTokenEstimate: false }),
    ).resolves.toEqual({
      tokens: Math.ceil((serializedChars / 4) * 1.25),
      method: "CHAR_ESTIMATE",
      exact: false,
      confidence: "FALLBACK",
      safetyMargin: 1.25,
      serializedChars,
    });
  });

  it("uses a conservative tokenizer estimate ahead of character fallback", async () => {
    const input = { messages: [{ content: "hello" }] };
    const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    await expect(
      countSerializedRequestContext({ input, safetyMargin: 1.2 }),
    ).resolves.toMatchObject({
      tokens: Math.ceil((bytes / 3) * 1.2),
      method: "TOKEN_ESTIMATE",
      exact: false,
      confidence: "CONSERVATIVE",
      safetyMargin: 1.2,
    });
  });

  it("does not reserve requested output tokens in the local estimate", async () => {
    const input = {
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 8_192,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    await expect(countSerializedRequestContext({ input })).resolves.toMatchObject({
      tokens: Math.ceil((bytes / 3) * 1.2),
      method: "TOKEN_ESTIMATE",
    });
  });

  it("applies the strictest physical/member ceiling and reserved margin", () => {
    expect(
      contextFitsLimits({
        count: { tokens: 90, method: "NATIVE", exact: true },
        physicalMaxContext: 200,
        effectiveContextCeiling: 100,
        contextMargin: 10,
      }),
    ).toBe(true);
    expect(
      contextFitsLimits({
        count: { tokens: 91, method: "CHAR_ESTIMATE", exact: false },
        physicalMaxContext: 200,
        effectiveContextCeiling: 100,
        contextMargin: 10,
      }),
    ).toBe(false);
  });

  it("admits a 400 KB base64 image on a 32k member", async () => {
    const input = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image_url",
              image_url: { url: largePngDataUrl(64, 64, 400_000) },
            },
          ],
        },
      ],
    };
    const count = await countSerializedRequestContext({ input });
    const rawBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    expect(Math.ceil((rawBytes / 3) * 1.2)).toBeGreaterThan(32_768);
    expect(count.tokens).toBeLessThanOrEqual(32_768);
    expect(
      contextFitsLimits({
        count,
        physicalMaxContext: 32_768,
      }),
    ).toBe(true);
  });
});
