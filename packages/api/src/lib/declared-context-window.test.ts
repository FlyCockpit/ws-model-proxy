import { describe, expect, it } from "vitest";
import {
  declaredContextWindow,
  isContextWindowSeedAdmissible,
  MAX_DECLARED_CONTEXT_WINDOW,
} from "./declared-context-window";

describe("declaredContextWindow", () => {
  it("returns null for absent and pre-surface inventories", () => {
    expect(declaredContextWindow(null)).toBeNull();
    expect(declaredContextWindow(undefined)).toBeNull();
    expect(
      declaredContextWindow({
        version: 1,
        protocol: "openai-compatible",
        chatCompletions: { supported: true },
      }),
    ).toBeNull();
    expect(
      declaredContextWindow({
        version: 2,
        protocol: "openai-compatible",
        chatCompletions: { supported: true },
      }),
    ).toBeNull();
  });

  it("reads declared v4 surface windows", () => {
    expect(
      declaredContextWindow({
        version: 4,
        protocol: "openai-compatible",
        surfaces: {
          openaiChatCompletions: {
            source: "declared",
            confidence: "exact",
            streaming: true,
            maxContextTokens: 1_000_000,
            operations: ["create"],
          },
        },
      }),
    ).toBe(1_000_000);
  });

  it("supports older surface inventories and does not invent a window", () => {
    expect(
      declaredContextWindow({
        version: 3,
        protocol: "openai-compatible",
        surfaces: {
          openaiChatCompletions: {
            source: "declared",
            confidence: "exact",
            supported: true,
            streaming: true,
            maxContextTokens: 32_768,
          },
        },
      }),
    ).toBe(32_768);
    expect(
      declaredContextWindow({
        version: 3,
        protocol: "openai-compatible",
        surfaces: {
          openaiChatCompletions: {
            source: "declared",
            confidence: "exact",
            supported: true,
            streaming: true,
          },
        },
      }),
    ).toBeNull();
  });

  it("uses the greatest declared window across supported surfaces", () => {
    expect(
      declaredContextWindow({
        version: 4,
        protocol: "openai-compatible",
        surfaces: {
          openaiChatCompletions: {
            source: "declared",
            confidence: "exact",
            streaming: true,
            maxContextTokens: 32_768,
            operations: ["create"],
          },
          openaiResponses: {
            source: "declared",
            confidence: "exact",
            streaming: true,
            maxContextTokens: 128_000,
            operations: ["create"],
          },
        },
      }),
    ).toBe(128_000);
  });

  it("rejects declared windows outside the database integer range", () => {
    expect(
      declaredContextWindow({
        version: 4,
        protocol: "openai-compatible",
        surfaces: {
          openaiChatCompletions: {
            source: "declared",
            confidence: "exact",
            streaming: true,
            maxContextTokens: MAX_DECLARED_CONTEXT_WINDOW + 1,
            operations: ["create"],
          },
        },
      }),
    ).toBeNull();
  });

  it("ignores invalid surfaces while retaining an in-range declaration", () => {
    expect(
      declaredContextWindow({
        version: 4,
        protocol: "openai-compatible",
        surfaces: {
          openaiChatCompletions: {
            source: "declared",
            confidence: "exact",
            streaming: true,
            maxContextTokens: MAX_DECLARED_CONTEXT_WINDOW + 1,
            operations: ["create"],
          },
          openaiResponses: {
            source: "declared",
            confidence: "exact",
            streaming: true,
            maxContextTokens: 128_000,
            operations: ["create"],
          },
        },
      }),
    ).toBe(128_000);
  });
});

describe("isContextWindowSeedAdmissible", () => {
  it("accepts an empty dependency set", () => {
    expect(isContextWindowSeedAdmissible(8_192, [])).toBe(true);
  });

  it("accepts a direct policy without a configured ceiling", () => {
    expect(
      isContextWindowSeedAdmissible(8_192, [
        { kind: "direct", contextCeiling: null, contextMargin: 0 },
      ]),
    ).toBe(true);
  });

  it("accepts inherited members whose pool has no configured ceiling", () => {
    expect(
      isContextWindowSeedAdmissible(8_192, [
        {
          kind: "member",
          contextCeilingMode: "INHERIT",
          contextCeiling: null,
          contextMargin: null,
          poolContextCeiling: null,
          poolContextMargin: 0,
        },
      ]),
    ).toBe(true);
  });

  it("does not let an unlimited member block a finite configured dependent", () => {
    expect(
      isContextWindowSeedAdmissible(8_192, [
        {
          kind: "member",
          contextCeilingMode: "UNLIMITED",
          contextCeiling: null,
          contextMargin: null,
          poolContextCeiling: 7_000,
          poolContextMargin: 256,
        },
        { kind: "direct", contextCeiling: 7_000, contextMargin: 256 },
      ]),
    ).toBe(true);
  });

  it("skips limited members that exceed the declared window after margin", () => {
    expect(
      isContextWindowSeedAdmissible(8_192, [
        {
          kind: "member",
          contextCeilingMode: "LIMITED",
          contextCeiling: 8_000,
          contextMargin: 256,
          poolContextCeiling: null,
          poolContextMargin: 0,
        },
      ]),
    ).toBe(false);
  });

  it("accepts bounded direct and member policies that fit", () => {
    expect(
      isContextWindowSeedAdmissible(8_192, [
        { kind: "direct", contextCeiling: 7_000, contextMargin: 1_000 },
        {
          kind: "member",
          contextCeilingMode: "INHERIT",
          contextCeiling: null,
          contextMargin: null,
          poolContextCeiling: 7_000,
          poolContextMargin: 1_000,
        },
      ]),
    ).toBe(true);
  });

  it("uses the pool margin when a member does not override it", () => {
    expect(
      isContextWindowSeedAdmissible(8_192, [
        {
          kind: "member",
          contextCeilingMode: "INHERIT",
          contextCeiling: null,
          contextMargin: null,
          poolContextCeiling: 7_500,
          poolContextMargin: 512,
        },
      ]),
    ).toBe(true);
    expect(
      isContextWindowSeedAdmissible(8_192, [
        {
          kind: "member",
          contextCeilingMode: "INHERIT",
          contextCeiling: null,
          contextMargin: null,
          poolContextCeiling: 7_500,
          poolContextMargin: 1_024,
        },
      ]),
    ).toBe(false);
  });

  it("skips a shared capacity when any dependent violates the seed", () => {
    expect(
      isContextWindowSeedAdmissible(8_192, [
        { kind: "direct", contextCeiling: 8_000, contextMargin: 0 },
        { kind: "direct", contextCeiling: 8_000, contextMargin: 256 },
      ]),
    ).toBe(false);
  });
});
