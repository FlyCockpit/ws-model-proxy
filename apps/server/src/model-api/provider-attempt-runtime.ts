import prisma from "@ws-model-proxy/db";

// The product spec requires bounded cooldown/half-open recovery but does not
// prescribe a duration. Cap both local backoff and untrusted Retry-After at
// five minutes so a provider response cannot disable a configured target
// indefinitely; repeated failures re-enter the same bounded cooldown.
const MAX_COOLDOWN_MS = 5 * 60_000;
const BASE_COOLDOWN_MS = 1_000;

export type ProviderFailureClass =
  | "TIMEOUT"
  | "CONFLICT"
  | "RATE_LIMIT"
  | "SERVER"
  | "TRANSPORT"
  | "PROTOCOL";

export async function allocateProviderFence(input: {
  userId: string;
  providerAccountId: string;
}): Promise<bigint> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.providerAccountId} AND "userId" = ${input.userId} FOR UPDATE`;
    const account = await tx.providerAccount.update({
      where: { id: input.providerAccountId, userId: input.userId },
      data: { nextFencingToken: { increment: 1n } },
      select: { nextFencingToken: true },
    });
    return account.nextFencingToken;
  });
}

export async function heartbeatProviderAttempt(input: {
  attemptId: string;
  fencingToken: bigint;
  extensionMs: number;
}): Promise<boolean> {
  const now = new Date();
  const updated = await prisma.providerAttempt.updateMany({
    where: {
      attemptId: input.attemptId,
      fencingToken: input.fencingToken,
      state: "ACTIVE",
      expiresAt: { gt: now },
    },
    data: {
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + Math.max(1_000, input.extensionMs)),
    },
  });
  return updated.count === 1;
}

export async function finishProviderAttempt(input: {
  attemptId: string;
  fencingToken: bigint;
  state: "COMPLETED" | "FAILED" | "CANCELLED";
  reason: string;
}): Promise<boolean> {
  const now = new Date();
  const updated = await prisma.providerAttempt.updateMany({
    where: { attemptId: input.attemptId, fencingToken: input.fencingToken, state: "ACTIVE" },
    data: { state: input.state, terminalReason: input.reason, terminalAt: now, heartbeatAt: now },
  });
  return updated.count === 1;
}

export async function expireProviderAttempts(now = new Date()): Promise<number> {
  const result = await prisma.providerAttempt.updateMany({
    where: {
      state: "ACTIVE",
      OR: [{ expiresAt: { lte: now } }, { heartbeatAt: { lt: new Date(now.getTime() - 60_000) } }],
    },
    data: { state: "EXPIRED", terminalReason: "CRASH_RECOVERY", terminalAt: now },
  });
  return result.count;
}

/** Atomically excludes cooldown targets and grants at most one half-open probe. */
export async function claimProviderHealthTrial(input: {
  userId: string;
  providerAccountId: string;
  providerModelId: string;
  now?: Date;
}): Promise<"READY" | "HALF_OPEN" | "COOLDOWN"> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    // Every health mutation takes the shared account lock before its model
    // lock. This serializes sibling models and avoids account/model deadlocks.
    await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.providerAccountId} AND "userId" = ${input.userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${input.providerModelId} AND "userId" = ${input.userId} FOR UPDATE`;
    const account = await tx.providerAccount.findUniqueOrThrow({
      where: { id: input.providerAccountId, userId: input.userId },
      select: { healthNextRetryAt: true, healthHalfOpenAt: true },
    });
    const model = await tx.providerModel.findUniqueOrThrow({
      where: {
        id: input.providerModelId,
        userId: input.userId,
        providerAccountId: input.providerAccountId,
      },
      select: { healthNextRetryAt: true, healthHalfOpenAt: true },
    });
    const cooldowns = [account, model].filter((health) => health.healthNextRetryAt !== null);
    if (cooldowns.length === 0) return "READY";
    if (
      cooldowns.some(
        (health) => health.healthNextRetryAt! > now || health.healthHalfOpenAt !== null,
      )
    )
      return "COOLDOWN";
    await Promise.all([
      tx.providerAccount.update({
        where: { id: input.providerAccountId, userId: input.userId },
        data: { healthHalfOpenAt: now },
      }),
      tx.providerModel.update({
        where: { id: input.providerModelId, userId: input.userId },
        data: { healthHalfOpenAt: now },
      }),
    ]);
    return "HALF_OPEN";
  });
}

function backoffMs(failures: number, retryAfterMs?: number): number {
  const exponential = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** Math.min(12, failures - 1));
  return Math.min(MAX_COOLDOWN_MS, Math.max(exponential, retryAfterMs ?? 0));
}

export async function recordProviderOutcome(input: {
  userId: string;
  providerAccountId: string;
  providerModelId: string;
  success: boolean;
  failureClass?: ProviderFailureClass;
  retryAfterMs?: number;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.providerAccountId} AND "userId" = ${input.userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${input.providerModelId} AND "userId" = ${input.userId} FOR UPDATE`;
    const [accountCurrent, current] = await Promise.all([
      tx.providerAccount.findUniqueOrThrow({
        where: { id: input.providerAccountId, userId: input.userId },
        select: { healthFailureCount: true, healthNextRetryAt: true },
      }),
      tx.providerModel.findUniqueOrThrow({
        where: {
          id: input.providerModelId,
          userId: input.userId,
          providerAccountId: input.providerAccountId,
        },
        select: { healthFailureCount: true },
      }),
    ]);
    const failures = input.success ? 0 : current.healthFailureCount + 1;
    const modelHealth = input.success
      ? ("HEALTHY" as const)
      : failures >= 3
        ? ("UNAVAILABLE" as const)
        : ("DEGRADED" as const);
    const data = input.success
      ? {
          healthStatus: modelHealth,
          healthCheckedAt: now,
          healthFailureCount: 0,
          healthNextRetryAt: null,
          healthHalfOpenAt: null,
        }
      : {
          healthStatus: modelHealth,
          healthCheckedAt: now,
          healthFailureCount: failures,
          healthNextRetryAt: new Date(now.getTime() + backoffMs(failures, input.retryAfterMs)),
          healthHalfOpenAt: null,
        };
    await tx.providerModel.update({
      where: { id: input.providerModelId, userId: input.userId },
      data,
    });
    await tx.providerAccount.update({
      where: { id: input.providerAccountId, userId: input.userId },
      data: {
        healthStatus: input.success ? "HEALTHY" : "DEGRADED",
        healthCheckedAt: now,
        ...(input.success
          ? { healthFailureCount: 0, healthNextRetryAt: null, healthHalfOpenAt: null }
          : {
              healthFailureCount: { increment: 1 },
              healthNextRetryAt: new Date(
                Math.max(
                  accountCurrent.healthNextRetryAt?.getTime() ?? 0,
                  now.getTime() +
                    backoffMs(accountCurrent.healthFailureCount + 1, input.retryAfterMs),
                ),
              ),
              healthHalfOpenAt: null,
            }),
      },
    });
  });
}

export async function recordProviderAttemptEvent(input: {
  userId: string;
  providerAccountId: string;
  providerModelId: string;
  providerAttemptId?: string;
  requestId: string;
  attemptId: string;
  fencingToken?: bigint;
  eventType: string;
  reason?: string;
  requestedSurface?: string;
  nativeSurface?: string;
  adapterMode?: string;
  adapterVersion?: string;
  poolId?: string;
  poolMemberId?: string;
  executionTargetId?: string;
  memberTier?: string;
  triggerReason?: string;
  affinityOutcome?: string;
  contextCountMethod?: string;
  contextCountConfidence?: string;
  waitDurationMs?: number;
  reservationId?: string;
  reservationIds?: readonly string[];
  contextTokens?: bigint;
  firstClientByteAt?: Date;
  streamCommitted?: boolean;
  terminalState?: string;
  usage?: Record<string, string | number | boolean | null>;
  metadata?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  await prisma.publicProviderAttemptEvent.create({
    data: {
      ...input,
      reservationIds: input.reservationIds ? [...input.reservationIds] : undefined,
    },
  });
}

export function classifyProviderFailure(status?: number): ProviderFailureClass {
  if (status === 408) return "TIMEOUT";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMIT";
  if (status !== undefined && status >= 500) return "SERVER";
  if (status !== undefined) return "PROTOCOL";
  return "TRANSPORT";
}

export function parseRetryAfter(
  value: string | string[] | undefined,
  now = Date.now(),
): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_COOLDOWN_MS, seconds * 1_000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp)
    ? Math.min(MAX_COOLDOWN_MS, Math.max(0, timestamp - now))
    : undefined;
}
