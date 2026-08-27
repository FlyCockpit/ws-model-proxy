import { z } from "zod";

export const reasoningLevels = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const reasoningLevelSchema = z.enum(reasoningLevels);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;
export type ChatTestReasoningSelection = "unset" | ReasoningLevel;

// The encoder reserves 1,024 tokens for visible output. Keeping the configured
// budget at or below this value means both the budget and `budget + 1024` remain
// exactly representable in JavaScript and on the Rust JSON wire contract.
export const ANTHROPIC_THINKING_BUDGET_MAX = Number.MAX_SAFE_INTEGER - 1024;

export const reasoningEncodingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("openai_reasoning_effort") }).strict(),
  z.object({ kind: z.literal("openai_reasoning_object") }).strict(),
  z.object({ kind: z.literal("openai_output_config_effort") }).strict(),
  z.object({ kind: z.literal("openai_top_level_effort") }).strict(),
  z
    .object({
      kind: z.literal("anthropic_thinking"),
      budgetByLevel: z
        .partialRecord(
          reasoningLevelSchema,
          z.number().int().min(1024).max(ANTHROPIC_THINKING_BUDGET_MAX),
        )
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("anthropic_adaptive_thinking") }).strict(),
  z.object({ kind: z.literal("anthropic_output_config_effort") }).strict(),
]);
export type ReasoningEncoding = z.infer<typeof reasoningEncodingSchema>;

export const reasoningConfigSchema = z
  .object({
    supportedLevels: z.array(reasoningLevelSchema).min(1).max(7).optional(),
    defaultLevel: reasoningLevelSchema.optional(),
    encoding: reasoningEncodingSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.supportedLevels === undefined &&
      value.defaultLevel === undefined &&
      value.encoding === undefined
    ) {
      context.addIssue({ code: "custom", message: "reasoningConfig cannot be empty." });
    }
    if (
      value.supportedLevels &&
      new Set(value.supportedLevels).size !== value.supportedLevels.length
    ) {
      context.addIssue({
        code: "custom",
        message: "reasoningConfig.supportedLevels must be unique.",
        path: ["supportedLevels"],
      });
    }
    if (
      value.defaultLevel &&
      value.supportedLevels &&
      !value.supportedLevels.includes(value.defaultLevel)
    ) {
      context.addIssue({
        code: "custom",
        message: "reasoningConfig.defaultLevel must be included in supportedLevels.",
        path: ["defaultLevel"],
      });
    }
  });
export type ReasoningConfig = z.infer<typeof reasoningConfigSchema>;

export type ReasoningContractSurface =
  | "openaiChatCompletions"
  | "openaiResponses"
  | "anthropicMessages"
  | "openaiCompletions";

const openAiSurfaces = new Set<ReasoningContractSurface>([
  "openaiChatCompletions",
  "openaiResponses",
  "openaiCompletions",
]);

export function validateSurfaceReasoningConfig(
  value: { reasoning?: boolean; reasoningConfig?: ReasoningConfig },
  surface: ReasoningContractSurface,
  context: z.RefinementCtx,
) {
  const config = value.reasoningConfig;
  if (!config) return;
  if (value.reasoning !== true) {
    context.addIssue({
      code: "custom",
      message: "reasoningConfig requires reasoning: true.",
      path: ["reasoningConfig"],
    });
  }
  const kind = config.encoding?.kind;
  if (!kind) return;
  const isOpenAiEncoding = kind.startsWith("openai_");
  if (isOpenAiEncoding !== openAiSurfaces.has(surface)) {
    context.addIssue({
      code: "custom",
      message: `${kind} is not valid for ${surface}.`,
      path: ["reasoningConfig", "encoding", "kind"],
    });
  }
}

export type ChatTestReasoningSurface =
  | "OPENAI_CHAT_COMPLETIONS"
  | "OPENAI_RESPONSES"
  | "ANTHROPIC_MESSAGES";

const defaultBudgets: Record<Exclude<ReasoningLevel, "none">, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

function defaultKind(surface: ChatTestReasoningSurface): ReasoningEncoding["kind"] {
  if (surface === "OPENAI_CHAT_COMPLETIONS") return "openai_reasoning_effort";
  if (surface === "OPENAI_RESPONSES") return "openai_reasoning_object";
  return "anthropic_thinking";
}

function assertEncodingSurface(surface: ChatTestReasoningSurface, kind: ReasoningEncoding["kind"]) {
  const openAiSurface = surface !== "ANTHROPIC_MESSAGES";
  if (kind.startsWith("openai_") !== openAiSurface) {
    throw new Error(`Reasoning encoding ${kind} is incompatible with ${surface}.`);
  }
}

export function encodeReasoning({
  surface,
  selection,
  config,
}: {
  surface: ChatTestReasoningSurface;
  selection: ChatTestReasoningSelection;
  config?: ReasoningConfig;
}): Record<string, unknown> {
  if (selection === "unset") return {};
  const encoding = config?.encoding;
  const kind = encoding?.kind ?? defaultKind(surface);
  assertEncodingSurface(surface, kind);
  if (kind === "openai_reasoning_effort") return { reasoning_effort: selection };
  if (kind === "openai_reasoning_object") return { reasoning: { effort: selection } };
  if (kind === "openai_output_config_effort") return { output_config: { effort: selection } };
  if (kind === "openai_top_level_effort") return { effort: selection };
  if (kind === "anthropic_output_config_effort") {
    return { output_config: { effort: selection } };
  }
  if (kind === "anthropic_adaptive_thinking") {
    return selection === "none"
      ? { thinking: { type: "disabled" } }
      : { thinking: { type: "adaptive" }, output_config: { effort: selection } };
  }
  if (selection === "none") return { thinking: { type: "disabled" }, max_tokens: 1024 };
  const budget =
    (encoding?.kind === "anthropic_thinking" ? encoding.budgetByLevel?.[selection] : undefined) ??
    defaultBudgets[selection];
  return {
    thinking: { type: "enabled", budget_tokens: budget },
    max_tokens: budget + 1024,
  };
}

export type ReasoningSelectorState =
  | { hidden: true }
  | {
      hidden: false;
      options: readonly ChatTestReasoningSelection[];
      levelsUnknown: boolean;
      defaultLevel?: ReasoningLevel;
    };

export function reasoningSelectorState({
  surface,
  routingMode,
  reasoning,
}: {
  surface: ChatTestReasoningSurface;
  routingMode: string;
  reasoning: { supported?: boolean; config?: ReasoningConfig };
}): ReasoningSelectorState {
  if (
    surface === "OPENAI_CHAT_COMPLETIONS" ||
    surface === "OPENAI_RESPONSES" ||
    surface === "ANTHROPIC_MESSAGES"
  ) {
    if (routingMode === "REQUIRE_ADAPTED" || reasoning.supported !== true) return { hidden: true };
    const levels = reasoning.config?.supportedLevels;
    return {
      hidden: false,
      options: ["unset", ...(levels ?? reasoningLevels)],
      levelsUnknown: levels === undefined,
      ...(reasoning.config?.defaultLevel ? { defaultLevel: reasoning.config.defaultLevel } : {}),
    };
  }
  return { hidden: true };
}
