import type { OpenAiCompatibleCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  type ChatTestReasoningSurface,
  encodeReasoning,
  type ReasoningConfig,
  type ReasoningLevel,
  reasoningLevels,
} from "@ws-model-proxy/api/lib/reasoning-contract";
import type { CanonicalRequest, CanonicalThinking, ProtocolSurface } from "./canonical.js";
import { unsupported } from "./errors.js";

export type ReasoningRenderControl = {
  supported: boolean;
  config?: ReasoningConfig;
};

const reasoningSurface = {
  "openai-chat": "OPENAI_CHAT_COMPLETIONS",
  "openai-responses": "OPENAI_RESPONSES",
  "anthropic-messages": "ANTHROPIC_MESSAGES",
} as const satisfies Record<ProtocolSurface, ChatTestReasoningSurface>;

const surfaceInventoryKey = {
  "openai-chat": "openaiChatCompletions",
  "openai-responses": "openaiResponses",
  "anthropic-messages": "anthropicMessages",
} as const;

const reasoningWireFields = [
  "thinking",
  "reasoning",
  "reasoning_effort",
  "effort",
  "output_config",
] as const;

const budgetLevels = reasoningLevels.filter(
  (level): level is Exclude<ReasoningLevel, "none"> => level !== "none",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listsTopK(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.parameters)) return false;
  return value.parameters.includes("top_k");
}

/**
 * True only when an inventory object already lists `top_k` on a sampling
 * extension. Versions 1–4 do not declare that extension, so a parsed hosted
 * inventory returns false. This does not add a field to the wire schema.
 */
export function capabilityInventoryAcceptsTopK(inventory: unknown): boolean {
  if (!isRecord(inventory)) return false;
  if (listsTopK(inventory.sampling)) return true;
  if (isRecord(inventory.extensions) && listsTopK(inventory.extensions.sampling)) return true;
  if (!isRecord(inventory.surfaces)) return false;
  for (const feature of Object.values(inventory.surfaces)) {
    if (isRecord(feature) && listsTopK(feature.sampling)) return true;
  }
  return false;
}

export function executionTargetAcceptsTopK(input: {
  kind: "cli" | "hosted-provider";
  capabilityInventory?: unknown;
}): boolean {
  if (input.kind === "cli") return true;
  return capabilityInventoryAcceptsTopK(input.capabilityInventory);
}

export function reasoningControlForSurface(
  capabilities: OpenAiCompatibleCapabilities | null | undefined,
  surface: ProtocolSurface,
): ReasoningRenderControl {
  if (!capabilities || (capabilities.version !== 3 && capabilities.version !== 4)) {
    return { supported: false };
  }
  const feature = capabilities.surfaces[surfaceInventoryKey[surface]];
  if (feature?.reasoning !== true) return { supported: false };
  return {
    supported: true,
    ...(feature.reasoningConfig ? { config: feature.reasoningConfig } : {}),
  };
}

function enabledBudget(encoded: Record<string, unknown>): number | undefined {
  if (!isRecord(encoded.thinking)) return undefined;
  const budget = encoded.thinking.budget_tokens;
  return typeof budget === "number" ? budget : undefined;
}

function levelForAnthropicBudget(
  budget: number,
  config: ReasoningConfig | undefined,
): ReasoningLevel | undefined {
  const tables: Array<ReasoningConfig | undefined> =
    config?.encoding?.kind === "anthropic_thinking" ? [config, undefined] : [undefined];
  for (const table of tables) {
    for (const level of budgetLevels) {
      const encoded = encodeReasoning({
        surface: "ANTHROPIC_MESSAGES",
        selection: level,
        ...(table ? { config: table } : {}),
      });
      if (enabledBudget(encoded) === budget) return level;
    }
  }
  return undefined;
}

function selectionForThinking(
  thinking: CanonicalThinking,
  config: ReasoningConfig | undefined,
): Exclude<ReasoningLevel, never> {
  if (thinking.type === "disabled") return "none";
  if (thinking.type === "enabled") {
    const level = levelForAnthropicBudget(thinking.budgetTokens, config);
    if (!level) unsupported("thinking");
    if (config?.supportedLevels && !config.supportedLevels.includes(level)) unsupported("thinking");
    return level;
  }
  const fallback = config?.defaultLevel;
  if (!fallback || fallback === "none") unsupported("thinking");
  if (config?.supportedLevels && !config.supportedLevels.includes(fallback))
    unsupported("thinking");
  return fallback;
}

function pickReasoningWireFields(encoded: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of reasoningWireFields) {
    if (encoded[field] !== undefined) fields[field] = encoded[field];
  }
  return fields;
}

/**
 * Map Anthropic `thinking` through `encodeReasoning` and the member config.
 * Unsupported members drop `disabled` and reject `enabled` / `adaptive`.
 * `max_tokens` from the Anthropic encoder is not a reasoning field and is omitted.
 */
export function reasoningWireFieldsForRequest(
  request: CanonicalRequest,
  surface: ProtocolSurface,
  reasoning: ReasoningRenderControl | undefined,
): Record<string, unknown> {
  const thinking = request.thinking;
  if (!thinking) return {};
  if (reasoning?.supported !== true) {
    if (thinking.type === "disabled") return {};
    unsupported("thinking");
  }
  const selection = selectionForThinking(thinking, reasoning.config);
  try {
    return pickReasoningWireFields(
      encodeReasoning({
        surface: reasoningSurface[surface],
        selection,
        ...(reasoning.config ? { config: reasoning.config } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AdapterError") throw error;
    unsupported("thinking");
  }
}
