/**
 * Request settings shared by the member probe (`pool_member_test`) and the
 * background pool-member recovery probe, so a reasoning model answers both
 * the same way. Kept free of the relay and routing modules so both can
 * import it without a cycle.
 */

import type { OpenAiCompatibleCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  encodeReasoning,
  type ReasoningLevel,
  reasoningLevels,
} from "@ws-model-proxy/api/lib/reasoning-contract";
import { reasoningControlForSurface } from "./protocols/request-controls.js";

/** Visible-token budget for a probe (room for a short reasoning preamble). */
export const PROBE_MAX_TOKENS = 64;

/**
 * The lowest reasoning level the member accepts: `none` unless its
 * `supportedLevels` exclude it. Undefined when reasoning is not controllable.
 */
function probeReasoningLevel(supportedLevels: readonly ReasoningLevel[] | undefined) {
  if (!supportedLevels) return "none" as const;
  return reasoningLevels.find((level) => supportedLevels.includes(level));
}

/**
 * Chat-completions reasoning control fields for a probe, built from the
 * member's own capability inventory so each encoding (effort field,
 * reasoning object, output_config, ...) is honoured. Empty when the member
 * does not advertise reasoning, or advertises an encoding the chat surface
 * cannot carry.
 */
export function probeReasoningFields(
  capabilities: OpenAiCompatibleCapabilities | null,
): Record<string, unknown> {
  const control = reasoningControlForSurface(capabilities, "openai-chat");
  if (!control.supported) return {};
  const selection = probeReasoningLevel(control.config?.supportedLevels);
  if (!selection) return {};
  try {
    return encodeReasoning({
      surface: "OPENAI_CHAT_COMPLETIONS",
      selection,
      ...(control.config ? { config: control.config } : {}),
    });
  } catch {
    return {};
  }
}
