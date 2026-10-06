/**
 * Request settings shared by the member probe (`pool_member_test`) and the
 * background pool-member recovery probe, so a reasoning model answers both
 * the same way. Kept free of the relay and routing modules so both can
 * import it without a cycle.
 */

import { suggestedConnectionSurface } from "@ws-model-proxy/api/lib/model-connection-type";
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

/**
 * The background pool-member recovery probe's request: the member's suggested
 * surface with the same {@link PROBE_MAX_TOKENS} budget as `pool_member_test`
 * and, on chat completions only, its lowest reasoning level (an Anthropic
 * thinking budget could exceed the token budget and turn the probe into a
 * 400). Null when the member has no probeable surface.
 */
export function recoveryProbeRequest(
  upstreamModelId: string,
  capabilities: OpenAiCompatibleCapabilities | null,
) {
  const surface = suggestedConnectionSurface({ capabilities });
  if (!surface) return null;
  if (surface === "OPENAI_RESPONSES")
    return {
      surface,
      family: "responses" as const,
      path: "/v1/responses",
      body: {
        model: upstreamModelId,
        input: "Reply with pong.",
        max_output_tokens: PROBE_MAX_TOKENS,
      } as Record<string, unknown>,
    };
  if (surface === "ANTHROPIC_MESSAGES")
    return {
      surface,
      family: "messages" as const,
      path: "/v1/messages",
      body: {
        model: upstreamModelId,
        max_tokens: PROBE_MAX_TOKENS,
        messages: [{ role: "user", content: "Reply with pong." }],
      } as Record<string, unknown>,
    };
  return {
    surface,
    family: "chat.completions" as const,
    path: "/v1/chat/completions",
    body: {
      model: upstreamModelId,
      stream: false,
      max_tokens: PROBE_MAX_TOKENS,
      ...probeReasoningFields(capabilities),
      messages: [{ role: "user", content: "Reply with pong." }],
    } as Record<string, unknown>,
  };
}
