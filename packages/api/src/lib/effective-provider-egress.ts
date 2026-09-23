/**
 * PRIMARY members whose execution target is a provider model.
 * `ProviderModel: { isNot: null }` is not equivalent: that relation also
 * includes `userId`, which is never null, so the check matches every target.
 * Routing status is intentionally omitted so a non-active primary still
 * requires the same acknowledgement as an active one.
 */
export const providerPrimaryMemberWhere = {
  tier: "PRIMARY" as const,
  ExecutionTarget: { providerModelId: { not: null } },
};

export function providerPrimaryMemberCount(
  members: ReadonlyArray<{
    tier: string;
    ExecutionTarget?: { providerModelId?: string | null } | null;
  }>,
): number {
  let count = 0;
  for (const member of members) {
    if (member.tier === "PRIMARY" && member.ExecutionTarget?.providerModelId != null) count += 1;
  }
  return count;
}

/** Single acknowledgement rule shared by grants, pool lists, and token visibility. */
export function effectiveProviderEgress(input: {
  publicEgressEnabled: boolean;
  providerPrimaryMemberCount: number;
}): boolean {
  return input.publicEgressEnabled || input.providerPrimaryMemberCount > 0;
}

/**
 * Account labels that can receive pool traffic. Overflow members count only
 * when public overflow is on. Labels are display names, never credentials.
 */
export function egressProviderAccountLabels(input: {
  publicEgressEnabled: boolean;
  members: ReadonlyArray<{ tier: string; accountLabel?: string | null }>;
}): string[] {
  const labels = new Set<string>();
  for (const member of input.members) {
    const label = member.accountLabel;
    if (!label) continue;
    if (member.tier === "PRIMARY" || input.publicEgressEnabled) labels.add(label);
  }
  return [...labels].sort((left, right) => left.localeCompare(right));
}

/** Owner must resubmit with the confirm flag before a shared pool becomes non-private. */
export const GRANTEE_PRIVACY_CONFIRMATION_REQUIRED = "GRANTEE_PRIVACY_CONFIRMATION_REQUIRED";

export const grantPoolAccessServerMessages = {
  userNotFound: "User not found.",
  cannotGrantToSelf: "Cannot grant a pool to yourself.",
  egressAcknowledgementRequired: "Provider egress acknowledgement is required for this grant.",
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
