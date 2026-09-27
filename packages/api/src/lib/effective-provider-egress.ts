import { providerProtocolForType } from "./provider-protocol";

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

/** Viewer-scoped display metadata. Account labels are owner-private. */
export function poolProviderDisclosure(input: {
  isOwner: boolean;
  hasLiveGrant: boolean;
  providerEgressEnabled: boolean;
  fallbackEnabled: boolean;
  fallbackForGrantees: boolean;
  members: ReadonlyArray<{
    tier: string;
    accountLabel?: string | null;
    providerType?: string | null;
  }>;
}) {
  const members = input.members.filter((member) => member.tier === "PUBLIC_OVERFLOW");
  const eligible =
    input.providerEgressEnabled &&
    (input.isOwner || (input.hasLiveGrant && input.fallbackForGrantees)) &&
    effectiveProviderEgress({
      fallbackEnabled: input.fallbackEnabled,
      externalMemberCount: members.length,
    });
  const sorted = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  return {
    effectiveProviderEgress: eligible,
    providerAccountLabels:
      input.isOwner && input.fallbackEnabled
        ? sorted(members.flatMap((member) => (member.accountLabel ? [member.accountLabel] : [])))
        : [],
    // Never pass through arbitrary free-text provider types from stored rows.
    providerTypes: eligible
      ? sorted(
          members.flatMap((member) => {
            const type = member.providerType?.trim().toLowerCase();
            return type && providerProtocolForType(type) ? [type] : [];
          }),
        )
      : [],
  };
}

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
