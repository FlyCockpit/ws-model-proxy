import prisma from "@ws-model-proxy/db";

// The product spec requires bounded cooldown/half-open recovery but does not
// prescribe a duration. Cap both local backoff and untrusted Retry-After at
// five minutes so a provider response cannot disable a configured target
// indefinitely; repeated failures re-enter the same bounded cooldown.
export const PROVIDER_MAX_COOLDOWN_MS = 5 * 60_000;
// A half-open claim is a lease, not a permanent latch. Provider attempts are
// heartbeated every ten seconds, so one minute allows ample scheduling jitter
// while guaranteeing recovery after a worker dies between claim and outcome.
export const PROVIDER_HALF_OPEN_LEASE_MS = 60_000;
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
  return prisma.$transaction(async (tx) => {
    const attempt = await tx.providerAttempt.findUnique({
      where: {
        attemptId_fencingToken: {
          attemptId: input.attemptId,
          fencingToken: input.fencingToken,
        },
      },
      select: { userId: true, providerAccountId: true, providerModelId: true },
    });
    if (!attempt) return false;
    await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${attempt.providerAccountId} AND "userId" = ${attempt.userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${attempt.providerModelId} AND "userId" = ${attempt.userId} FOR UPDATE`;
    const [accountHealth, modelHealth] = await Promise.all([
      tx.providerAccount.findUniqueOrThrow({
        where: { id: attempt.providerAccountId, userId: attempt.userId },
        select: { healthHalfOpenAttemptId: true, healthHalfOpenFencingToken: true },
      }),
      tx.providerModel.findUniqueOrThrow({
        where: {
          id: attempt.providerModelId,
          userId: attempt.userId,
          providerAccountId: attempt.providerAccountId,
        },
        select: { healthHalfOpenAttemptId: true, healthHalfOpenFencingToken: true },
      }),
    ]);
    const owns = (health: typeof accountHealth) =>
      health.healthHalfOpenAttemptId === input.attemptId &&
      health.healthHalfOpenFencingToken === input.fencingToken;
    const unclaimed = (health: typeof accountHealth) => health.healthHalfOpenAttemptId === null;
    const ownsHalfOpen = owns(accountHealth) && owns(modelHealth);
    if (!ownsHalfOpen && !(unclaimed(accountHealth) && unclaimed(modelHealth))) return false;
    const updated = await tx.providerAttempt.updateMany({
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
    if (updated.count !== 1) return false;
    const owner = {
      healthHalfOpenAttemptId: input.attemptId,
      healthHalfOpenFencingToken: input.fencingToken,
    };
    if (!ownsHalfOpen) return true;
    const [account, model] = await Promise.all([
      tx.providerAccount.updateMany({
        where: { id: attempt.providerAccountId, userId: attempt.userId, ...owner },
        data: { healthHalfOpenAt: now },
      }),
      tx.providerModel.updateMany({
        where: { id: attempt.providerModelId, userId: attempt.userId, ...owner },
        data: { healthHalfOpenAt: now },
      }),
    ]);
    return account.count === 1 && model.count === 1;
  });
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
  return prisma.$executeRaw`
    UPDATE provider_attempt attempt
       SET state = 'EXPIRED', "terminalReason" = 'CRASH_RECOVERY', "terminalAt" = ${now}
     WHERE attempt.state = 'ACTIVE'
       AND (attempt."expiresAt" <= ${now} OR attempt."heartbeatAt" < ${new Date(now.getTime() - 60_000)})
       AND NOT EXISTS (
         SELECT 1 FROM provider_usage_ledger ledger
          WHERE ledger."attemptId" = attempt."attemptId"
            AND ledger."fencingToken" = attempt."fencingToken"
       )`;
}

/** Atomically excludes cooldown targets and grants at most one half-open probe. */
export async function claimProviderHealthTrial(input: {
  userId: string;
  providerAccountId: string;
  providerModelId: string;
  attemptId: string;
  fencingToken: bigint;
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
      select: {
        healthNextRetryAt: true,
        healthHalfOpenAt: true,
        healthFencingWatermark: true,
      },
    });
    const model = await tx.providerModel.findUniqueOrThrow({
      where: {
        id: input.providerModelId,
        userId: input.userId,
        providerAccountId: input.providerAccountId,
      },
      select: {
        healthNextRetryAt: true,
        healthHalfOpenAt: true,
        healthFencingWatermark: true,
      },
    });
    // The owner fields are intentionally nullable, but authority is not. A
    // completed successor leaves this watermark behind so a delayed outcome
    // from an older probe cannot become authoritative after owner cleanup.
    if (
      input.fencingToken <= account.healthFencingWatermark ||
      input.fencingToken <= model.healthFencingWatermark
    )
      return "COOLDOWN";
    const cooldowns = [account, model].filter((health) => health.healthNextRetryAt !== null);
    if (cooldowns.length === 0) return "READY";
    const liveLeaseCutoff = new Date(now.getTime() - PROVIDER_HALF_OPEN_LEASE_MS);
    if (
      cooldowns.some(
        (health) =>
          health.healthNextRetryAt! > now ||
          (health.healthHalfOpenAt !== null && health.healthHalfOpenAt > liveLeaseCutoff),
      )
    )
      return "COOLDOWN";
    await Promise.all([
      tx.providerAccount.update({
        where: { id: input.providerAccountId, userId: input.userId },
        data: {
          healthHalfOpenAt: now,
          healthHalfOpenAttemptId: input.attemptId,
          healthHalfOpenFencingToken: input.fencingToken,
          healthFencingWatermark: input.fencingToken,
        },
      }),
      tx.providerModel.update({
        where: { id: input.providerModelId, userId: input.userId },
        data: {
          healthHalfOpenAt: now,
          healthHalfOpenAttemptId: input.attemptId,
          healthHalfOpenFencingToken: input.fencingToken,
          healthFencingWatermark: input.fencingToken,
        },
      }),
    ]);
    return "HALF_OPEN";
  });
}

function backoffMs(failures: number, retryAfterMs?: number): number {
  const exponential = Math.min(
    PROVIDER_MAX_COOLDOWN_MS,
    BASE_COOLDOWN_MS * 2 ** Math.min(12, failures - 1),
  );
  return Math.min(PROVIDER_MAX_COOLDOWN_MS, Math.max(exponential, retryAfterMs ?? 0));
}

export async function recordProviderOutcome(input: {
  userId: string;
  providerAccountId: string;
  providerModelId: string;
  success: boolean;
  failureClass?: ProviderFailureClass;
  retryAfterMs?: number;
  attemptId?: string;
  fencingToken?: bigint;
  now?: Date;
}): Promise<boolean> {
  if ((input.attemptId === undefined) !== (input.fencingToken === undefined)) return false;
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    // Health mutations use one global lock order: account, model, attempt.
    // In particular, lock the attempt in this transaction rather than relying
    // on a heartbeat checked before entry: expiry or terminalization could win
    // that gap and allow an orphan to overwrite a successor's health state.
    await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.providerAccountId} AND "userId" = ${input.userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${input.providerModelId} AND "userId" = ${input.userId} FOR UPDATE`;
    if (input.attemptId !== undefined && input.fencingToken !== undefined) {
      const lockedAttempt = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM provider_attempt
        WHERE "attemptId" = ${input.attemptId}
          AND "fencingToken" = ${input.fencingToken}
          AND "userId" = ${input.userId}
          AND "providerAccountId" = ${input.providerAccountId}
          AND "providerModelId" = ${input.providerModelId}
        FOR UPDATE
      `;
      if (lockedAttempt.length !== 1) return false;

      // This must be a separate statement after FOR UPDATE. A transaction can
      // wait for the row lock long enough for the attempt to expire, so an app
      // timestamp captured before the wait is not authoritative.
      const authoritative = await tx.$queryRaw<Array<{ eligible: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM provider_attempt
          WHERE "attemptId" = ${input.attemptId}
            AND "fencingToken" = ${input.fencingToken}
            AND "userId" = ${input.userId}
            AND "providerAccountId" = ${input.providerAccountId}
            AND "providerModelId" = ${input.providerModelId}
            AND state = 'ACTIVE'::"ProviderAttemptState"
            AND "expiresAt" > clock_timestamp()
        ) AS eligible
      `;
      if (authoritative.length !== 1 || !authoritative[0]?.eligible) return false;
    }
    const [accountCurrent, current] = await Promise.all([
      tx.providerAccount.findUniqueOrThrow({
        where: { id: input.providerAccountId, userId: input.userId },
        select: {
          healthFailureCount: true,
          healthNextRetryAt: true,
          healthHalfOpenAttemptId: true,
          healthHalfOpenFencingToken: true,
          healthFencingWatermark: true,
        },
      }),
      tx.providerModel.findUniqueOrThrow({
        where: {
          id: input.providerModelId,
          userId: input.userId,
          providerAccountId: input.providerAccountId,
        },
        select: {
          healthFailureCount: true,
          healthHalfOpenAttemptId: true,
          healthHalfOpenFencingToken: true,
          healthFencingWatermark: true,
        },
      }),
    ]);
    const ownedByAnother = [accountCurrent, current].some(
      (health) =>
        health.healthHalfOpenAttemptId != null &&
        (health.healthHalfOpenAttemptId !== input.attemptId ||
          health.healthHalfOpenFencingToken !== input.fencingToken),
    );
    const superseded =
      input.fencingToken !== undefined &&
      [accountCurrent, current].some(
        (health) => input.fencingToken! < health.healthFencingWatermark,
      );
    if (ownedByAnother || superseded) return false;
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
          healthHalfOpenAttemptId: null,
          healthHalfOpenFencingToken: null,
          ...(input.fencingToken !== undefined
            ? { healthFencingWatermark: input.fencingToken }
            : {}),
        }
      : {
          healthStatus: modelHealth,
          healthCheckedAt: now,
          healthFailureCount: failures,
          healthNextRetryAt: new Date(now.getTime() + backoffMs(failures, input.retryAfterMs)),
          healthHalfOpenAt: null,
          healthHalfOpenAttemptId: null,
          healthHalfOpenFencingToken: null,
          ...(input.fencingToken !== undefined
            ? { healthFencingWatermark: input.fencingToken }
            : {}),
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
          ? {
              healthFailureCount: 0,
              healthNextRetryAt: null,
              healthHalfOpenAt: null,
              healthHalfOpenAttemptId: null,
              healthHalfOpenFencingToken: null,
              ...(input.fencingToken !== undefined
                ? { healthFencingWatermark: input.fencingToken }
                : {}),
            }
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
              healthHalfOpenAttemptId: null,
              healthHalfOpenFencingToken: null,
              ...(input.fencingToken !== undefined
                ? { healthFencingWatermark: input.fencingToken }
                : {}),
            }),
      },
    });
    return true;
  });
}

/** Releases only this exact half-open owner while retaining cooldown and watermark state. */
export async function releaseProviderHealthTrial(input: {
  userId: string;
  providerAccountId: string;
  providerModelId: string;
  attemptId: string;
  fencingToken: bigint;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.providerAccountId} AND "userId" = ${input.userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${input.providerModelId} AND "userId" = ${input.userId} FOR UPDATE`;
    const owner = {
      healthHalfOpenAttemptId: input.attemptId,
      healthHalfOpenFencingToken: input.fencingToken,
    };
    const [accountOwner, modelOwner] = await Promise.all([
      tx.providerAccount.findUniqueOrThrow({
        where: { id: input.providerAccountId, userId: input.userId },
        select: { healthHalfOpenAttemptId: true, healthHalfOpenFencingToken: true },
      }),
      tx.providerModel.findUniqueOrThrow({
        where: {
          id: input.providerModelId,
          userId: input.userId,
          providerAccountId: input.providerAccountId,
        },
        select: { healthHalfOpenAttemptId: true, healthHalfOpenFencingToken: true },
      }),
    ]);
    const owns = (health: typeof accountOwner) =>
      health.healthHalfOpenAttemptId === input.attemptId &&
      health.healthHalfOpenFencingToken === input.fencingToken;
    if (!owns(accountOwner) || !owns(modelOwner)) return false;
    const cleared = {
      healthHalfOpenAt: null,
      healthHalfOpenAttemptId: null,
      healthHalfOpenFencingToken: null,
    };
    const account = await tx.providerAccount.updateMany({
      where: { id: input.providerAccountId, userId: input.userId, ...owner },
      data: cleared,
    });
    const model = await tx.providerModel.updateMany({
      where: {
        id: input.providerModelId,
        userId: input.userId,
        providerAccountId: input.providerAccountId,
        ...owner,
      },
      data: cleared,
    });
    return account.count === 1 && model.count === 1;
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
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(PROVIDER_MAX_COOLDOWN_MS, seconds * 1_000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp)
    ? Math.min(PROVIDER_MAX_COOLDOWN_MS, Math.max(0, timestamp - now))
    : undefined;
}
