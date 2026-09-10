import type { OpenAiCompatibleCapabilities } from "./openai-compatible-capabilities";

export const MAX_DECLARED_CONTEXT_WINDOW = 2 ** 31 - 1;

export type ContextWindowSeedDependent =
  | {
      kind: "direct";
      contextCeiling: number | null;
      contextMargin: number | null;
    }
  | {
      kind: "member";
      contextCeilingMode: "INHERIT" | "LIMITED" | "UNLIMITED";
      contextCeiling: number | null;
      contextMargin: number | null;
      poolContextCeiling: number | null;
      poolContextMargin: number | null;
    };

/**
 * A declared window can become a physical cap only when every configured
 * policy that shares that capacity already fits. A null ceiling means no
 * policy was configured, so it does not block adoption of the runtime's
 * declared physical limit.
 */
export function isContextWindowSeedAdmissible(
  declaredWindow: number | null | undefined,
  dependents: readonly ContextWindowSeedDependent[],
): boolean {
  if (
    typeof declaredWindow !== "number" ||
    !Number.isInteger(declaredWindow) ||
    declaredWindow < 1 ||
    declaredWindow > MAX_DECLARED_CONTEXT_WINDOW
  ) {
    return false;
  }
  return dependents.every((dependent) => {
    const ceiling =
      dependent.kind === "direct"
        ? dependent.contextCeiling
        : dependent.contextCeilingMode === "LIMITED"
          ? dependent.contextCeiling
          : dependent.contextCeilingMode === "UNLIMITED"
            ? null
            : dependent.poolContextCeiling;
    const margin =
      dependent.kind === "direct"
        ? (dependent.contextMargin ?? 0)
        : (dependent.contextMargin ?? dependent.poolContextMargin ?? 0);
    return ceiling === null || ceiling + margin <= declaredWindow;
  });
}

/**
 * Returns the largest context window explicitly declared by an inventory.
 * Surface inventories describe the same runtime model but can expose different
 * protocol entry points; a missing declaration is intentionally not guessed.
 */
export function declaredContextWindow(
  capabilities: OpenAiCompatibleCapabilities | null | undefined,
): number | null {
  if (!capabilities) return null;
  const values =
    capabilities.version === 3 || capabilities.version === 4
      ? Object.values(capabilities.surfaces).flatMap((surface) =>
          typeof surface?.maxContextTokens === "number" &&
          Number.isInteger(surface.maxContextTokens) &&
          surface.maxContextTokens >= 1 &&
          surface.maxContextTokens <= MAX_DECLARED_CONTEXT_WINDOW
            ? [surface.maxContextTokens]
            : [],
        )
      : [];
  return values.length === 0 ? null : Math.max(...values);
}
