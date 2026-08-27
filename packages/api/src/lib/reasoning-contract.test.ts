import { describe, expect, it } from "vitest";
import { parseOpenAiCompatibleCapabilities } from "./openai-compatible-capabilities";
import {
  ANTHROPIC_THINKING_BUDGET_MAX,
  encodeReasoning,
  reasoningConfigSchema,
  reasoningSelectorState,
} from "./reasoning-contract";

describe("reasoning config", () => {
  it("requires a non-empty coherent configuration", () => {
    expect(reasoningConfigSchema.safeParse({}).success).toBe(false);
    expect(reasoningConfigSchema.safeParse({ supportedLevels: ["low", "low"] }).success).toBe(
      false,
    );
    expect(
      reasoningConfigSchema.safeParse({ supportedLevels: ["low"], defaultLevel: "high" }).success,
    ).toBe(false);
  });

  it("keeps Anthropic thinking budgets within the exactly representable wire range", () => {
    expect(
      reasoningConfigSchema.safeParse({
        encoding: {
          kind: "anthropic_thinking",
          budgetByLevel: { max: ANTHROPIC_THINKING_BUDGET_MAX },
        },
      }).success,
    ).toBe(true);
    expect(
      reasoningConfigSchema.safeParse({
        encoding: {
          kind: "anthropic_thinking",
          budgetByLevel: { max: ANTHROPIC_THINKING_BUDGET_MAX + 1 },
        },
      }).success,
    ).toBe(false);
  });
});

describe("encodeReasoning", () => {
  it("omits unset and uses surface defaults", () => {
    expect(encodeReasoning({ surface: "OPENAI_CHAT_COMPLETIONS", selection: "unset" })).toEqual({});
    expect(encodeReasoning({ surface: "OPENAI_RESPONSES", selection: "none" })).toEqual({
      reasoning: { effort: "none" },
    });
    expect(encodeReasoning({ surface: "ANTHROPIC_MESSAGES", selection: "xhigh" })).toEqual({
      thinking: { type: "enabled", budget_tokens: 32768 },
      max_tokens: 33792,
    });
    expect(encodeReasoning({ surface: "ANTHROPIC_MESSAGES", selection: "none" })).toEqual({
      thinking: { type: "disabled" },
      max_tokens: 1024,
    });
  });

  it("encodes every canonical level without remapping and preserves Anthropic budget headroom", () => {
    const budgets = {
      minimal: 1024,
      low: 2048,
      medium: 8192,
      high: 16384,
      xhigh: 32768,
      max: 65536,
    } as const;
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(encodeReasoning({ surface: "OPENAI_CHAT_COMPLETIONS", selection: level })).toEqual({
        reasoning_effort: level,
      });
      expect(encodeReasoning({ surface: "OPENAI_RESPONSES", selection: level })).toEqual({
        reasoning: { effort: level },
      });
      if (level !== "none") {
        expect(encodeReasoning({ surface: "ANTHROPIC_MESSAGES", selection: level })).toEqual({
          thinking: { type: "enabled", budget_tokens: budgets[level] },
          max_tokens: budgets[level] + 1024,
        });
      }
    }
  });

  it("honors overrides without remapping levels", () => {
    expect(
      encodeReasoning({
        surface: "ANTHROPIC_MESSAGES",
        selection: "max",
        config: { encoding: { kind: "anthropic_thinking", budgetByLevel: { max: 70000 } } },
      }),
    ).toEqual({ thinking: { type: "enabled", budget_tokens: 70000 }, max_tokens: 71024 });
    expect(
      encodeReasoning({
        surface: "ANTHROPIC_MESSAGES",
        selection: "none",
        config: { encoding: { kind: "anthropic_adaptive_thinking" } },
      }),
    ).toEqual({ thinking: { type: "disabled" } });
    expect(
      encodeReasoning({
        surface: "OPENAI_CHAT_COMPLETIONS",
        selection: "high",
        config: { encoding: { kind: "openai_top_level_effort" } },
      }),
    ).toEqual({ effort: "high" });
  });

  it("preserves the largest valid Anthropic budget when reserving output tokens", () => {
    expect(
      encodeReasoning({
        surface: "ANTHROPIC_MESSAGES",
        selection: "max",
        config: {
          encoding: {
            kind: "anthropic_thinking",
            budgetByLevel: { max: ANTHROPIC_THINKING_BUDGET_MAX },
          },
        },
      }),
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: ANTHROPIC_THINKING_BUDGET_MAX },
      max_tokens: Number.MAX_SAFE_INTEGER,
    });
  });

  it("throws for an invalid cross-family config", () => {
    expect(() =>
      encodeReasoning({
        surface: "OPENAI_CHAT_COMPLETIONS",
        selection: "low",
        config: { encoding: { kind: "anthropic_thinking" } },
      }),
    ).toThrow("incompatible");
  });

  it("honors the full encoding matrix without leaking fields between families", () => {
    const openaiCases = [
      ["openai_reasoning_effort", { reasoning_effort: "high" }],
      ["openai_reasoning_object", { reasoning: { effort: "high" } }],
      ["openai_output_config_effort", { output_config: { effort: "high" } }],
      ["openai_top_level_effort", { effort: "high" }],
    ] as const;
    for (const [kind, expected] of openaiCases) {
      expect(
        encodeReasoning({
          surface: "OPENAI_CHAT_COMPLETIONS",
          selection: "high",
          config: { encoding: { kind } },
        }),
      ).toEqual(expected);
    }

    expect(
      encodeReasoning({
        surface: "ANTHROPIC_MESSAGES",
        selection: "medium",
        config: { encoding: { kind: "anthropic_thinking", budgetByLevel: { medium: 9000 } } },
      }),
    ).toEqual({ thinking: { type: "enabled", budget_tokens: 9000 }, max_tokens: 10024 });
    expect(
      encodeReasoning({
        surface: "ANTHROPIC_MESSAGES",
        selection: "high",
        config: { encoding: { kind: "anthropic_adaptive_thinking" } },
      }),
    ).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
    expect(
      encodeReasoning({
        surface: "ANTHROPIC_MESSAGES",
        selection: "none",
        config: { encoding: { kind: "anthropic_adaptive_thinking" } },
      }),
    ).toEqual({ thinking: { type: "disabled" } });
    expect(
      encodeReasoning({
        surface: "ANTHROPIC_MESSAGES",
        selection: "high",
        config: { encoding: { kind: "anthropic_output_config_effort" } },
      }),
    ).toEqual({ output_config: { effort: "high" } });
  });
});

describe("TypeScript/Rust reasoning inventory parity", () => {
  const validV3OpenAi = {
    version: 3,
    protocol: "openai-compatible",
    surfaces: {
      openaiChatCompletions: {
        source: "provider",
        confidence: "exact",
        supported: true,
        reasoning: true,
        reasoningConfig: { encoding: { kind: "openai_reasoning_effort" } },
      },
    },
  } as const;
  const validV4Anthropic = {
    version: 4,
    protocol: "anthropic-compatible",
    surfaces: {
      anthropicMessages: {
        source: "provider",
        confidence: "exact",
        operations: ["create"],
        protocolVersions: [{ version: "2023-06-01" }],
        reasoning: true,
        reasoningConfig: {
          supportedLevels: ["low"],
          defaultLevel: "low",
          encoding: { kind: "anthropic_thinking", budgetByLevel: { low: 2048 } },
        },
      },
    },
  } as const;

  it("accepts valid v3/v4 inventories for both encoding families", () => {
    expect(parseOpenAiCompatibleCapabilities(validV3OpenAi)).not.toBeNull();
    expect(parseOpenAiCompatibleCapabilities(validV4Anthropic)).not.toBeNull();
  });

  it("rejects the same invalid cross-fields as the Rust CLI contract", () => {
    const invalids = [
      {
        ...validV3OpenAi,
        surfaces: {
          openaiChatCompletions: {
            ...validV3OpenAi.surfaces.openaiChatCompletions,
            reasoning: undefined,
          },
        },
      },
      {
        ...validV3OpenAi,
        surfaces: {
          openaiChatCompletions: {
            ...validV3OpenAi.surfaces.openaiChatCompletions,
            reasoningConfig: { supportedLevels: ["low", "low"] },
          },
        },
      },
      {
        ...validV3OpenAi,
        surfaces: {
          openaiChatCompletions: {
            ...validV3OpenAi.surfaces.openaiChatCompletions,
            reasoningConfig: { supportedLevels: ["low"], defaultLevel: "high" },
          },
        },
      },
      {
        ...validV3OpenAi,
        surfaces: {
          openaiChatCompletions: {
            ...validV3OpenAi.surfaces.openaiChatCompletions,
            reasoningConfig: { encoding: { kind: "anthropic_thinking" } },
          },
        },
      },
      {
        ...validV4Anthropic,
        surfaces: {
          anthropicMessages: {
            ...validV4Anthropic.surfaces.anthropicMessages,
            reasoningConfig: { encoding: { kind: "openai_reasoning_effort" } },
          },
        },
      },
      {
        ...validV4Anthropic,
        surfaces: {
          anthropicMessages: {
            ...validV4Anthropic.surfaces.anthropicMessages,
            reasoningConfig: {
              encoding: { kind: "anthropic_thinking", budgetByLevel: { low: 1 } },
            },
          },
        },
      },
    ];
    for (const inventory of invalids)
      expect(parseOpenAiCompatibleCapabilities(inventory)).toBeNull();
  });
});

describe("reasoningSelectorState", () => {
  it("only shows native supported reasoning and warns for unknown ladders", () => {
    expect(
      reasoningSelectorState({
        surface: "OPENAI_CHAT_COMPLETIONS",
        routingMode: "REQUIRE_ADAPTED",
        reasoning: { supported: true },
      }),
    ).toEqual({ hidden: true });
    expect(
      reasoningSelectorState({
        surface: "ANTHROPIC_MESSAGES",
        routingMode: "PREFER_NATIVE",
        reasoning: { supported: true, supportedLevels: ["none", "medium"], defaultLevel: "medium" },
      }),
    ).toEqual({
      hidden: false,
      options: ["unset", "none", "medium"],
      levelsUnknown: false,
      defaultLevel: "medium",
    });
    expect(
      reasoningSelectorState({
        surface: "OPENAI_RESPONSES",
        routingMode: "PREFER_NATIVE",
        reasoning: { supported: true },
      }),
    ).toEqual({
      hidden: false,
      levelsUnknown: true,
      options: ["unset", "none", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
  });
});
