import type { OpenAiCompatibleCapabilities } from "./openai-compatible-capabilities";

export const suggestedConnectionSurfaces = [
  "OPENAI_RESPONSES",
  "OPENAI_CHAT_COMPLETIONS",
  "ANTHROPIC_MESSAGES",
] as const;
export type SuggestedConnectionSurface = (typeof suggestedConnectionSurfaces)[number];

/**
 * Chooses the client connection users should start with.  Keep this deliberately
 * separate from routing: it is a presentation hint, not a compatibility gate.
 */
export function suggestedConnectionSurface({
  capabilities,
  surfaces,
}: {
  capabilities?: OpenAiCompatibleCapabilities | null;
  surfaces?: Partial<Record<SuggestedConnectionSurface, { native: number; adapted: number }>>;
}): SuggestedConnectionSurface | null {
  if (surfaces) {
    return (
      suggestedConnectionSurfaces.find((surface) => {
        const availability = surfaces[surface];
        return Boolean(availability && (availability.native > 0 || availability.adapted > 0));
      }) ?? null
    );
  }
  if (!capabilities) return null;
  if (capabilities.version === 4) {
    if (capabilities.surfaces.openaiResponses?.operations.includes("create")) {
      return "OPENAI_RESPONSES";
    }
    if (capabilities.surfaces.openaiChatCompletions?.operations.includes("create")) {
      return "OPENAI_CHAT_COMPLETIONS";
    }
    if (capabilities.surfaces.anthropicMessages?.operations.includes("create")) {
      return "ANTHROPIC_MESSAGES";
    }
    return null;
  }
  if (capabilities.responses?.supported) return "OPENAI_RESPONSES";
  if (capabilities.chatCompletions?.supported) return "OPENAI_CHAT_COMPLETIONS";
  return capabilities.protocol === "anthropic-compatible" ? "ANTHROPIC_MESSAGES" : null;
}
