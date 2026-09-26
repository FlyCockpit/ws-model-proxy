/**
 * External fallback members: PUBLIC_OVERFLOW members whose execution target is
 * a provider model. PRIMARY members are always local (enforced by the schema
 * hardening tier trigger), so this is every provider member of a pool.
 * `ProviderModel: { isNot: null }` is not equivalent: that relation also
 * includes `userId`, which is never null, so the check matches every target.
 */
export const externalFallbackMemberWhere = {
  tier: "PUBLIC_OVERFLOW" as const,
  ExecutionTarget: { providerModelId: { not: null } },
};

/**
 * Whether a pool can serve `owner/pool:external` for some caller: the owner
 * enabled fallback and at least one external member is configured. Plain pool
 * names never leave the deployment, so this is the badge rule shared by pool
 * lists and token visibility.
 */
export function effectiveProviderEgress(input: {
  fallbackEnabled: boolean;
  externalMemberCount: number;
}): boolean {
  return input.fallbackEnabled && input.externalMemberCount > 0;
}

/**
 * Account labels that can receive `:external` pool traffic. Only external
 * fallback members count, and only while fallback is on. Labels are display
 * names, never credentials.
 */
export function egressProviderAccountLabels(input: {
  fallbackEnabled: boolean;
  members: ReadonlyArray<{ tier: string; accountLabel?: string | null }>;
}): string[] {
  if (!input.fallbackEnabled) return [];
  const labels = new Set<string>();
  for (const member of input.members) {
    const label = member.accountLabel;
    if (!label || member.tier !== "PUBLIC_OVERFLOW") continue;
    labels.add(label);
  }
  return [...labels].sort((left, right) => left.localeCompare(right));
}

/** Owner must resubmit with the confirm flag before a shared pool becomes non-private. */
export const GRANTEE_PRIVACY_CONFIRMATION_REQUIRED = "GRANTEE_PRIVACY_CONFIRMATION_REQUIRED";

export const grantPoolAccessServerMessages = {
  userNotFound: "User not found.",
  cannotGrantToSelf: "Cannot grant a pool to yourself.",
} as const;

const grantPoolAccessServerMessageList: readonly string[] = Object.values(
  grantPoolAccessServerMessages,
);

/** Allowlisted grant failures safe to show verbatim. Anything else stays hidden. */
export function grantPoolAccessServerMessage(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("message" in error)) return null;
  const { message } = error;
  return typeof message === "string" && grantPoolAccessServerMessageList.includes(message)
    ? message
    : null;
}
