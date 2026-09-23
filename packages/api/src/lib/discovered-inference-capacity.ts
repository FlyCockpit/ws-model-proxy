import prisma, { type Prisma } from "@ws-model-proxy/db";
import { retryableSerializableTransactionCode } from "./serializable-transaction";

/**
 * Initial hard concurrency for a discovered model that did not report one.
 * Matches the guarded pool wizard's `memberConcurrencyLimit` default.
 */
export const DISCOVERED_MODEL_DEFAULT_HARD_CONCURRENCY = 1;

const HARD_CONCURRENCY_MAX = 10_000;
const CAPACITY_LABEL_MAX = 120;
const RUNTIME_MODEL_MAX = 500;
const BACKFILL_ATTEMPTS = 3;

export function discoveredRuntimeIdentityKey(discoveredModelId: string): string {
  return `discovered-model:${discoveredModelId}`;
}

/** Key written by schema-hardening.sql for rows that predate this helper. */
export function legacyExecutionTargetRuntimeIdentityKey(executionTargetId: string): string {
  return `execution-target:${executionTargetId}`;
}

/** Auto keys this helper and schema-hardening create. Any other key is a user choice. */
function autoDiscoveredCapacityRuntimeKeys(input: {
  discoveredModelId: string;
  executionTargetId?: string | null;
}): string[] {
  const keys: string[] = [];
  if (input.executionTargetId) {
    keys.push(legacyExecutionTargetRuntimeIdentityKey(input.executionTargetId));
  }
  keys.push(discoveredRuntimeIdentityKey(input.discoveredModelId));
  return keys;
}

function isExactAutoDiscoveredRuntimeKey(input: {
  runtimeIdentityKey: string;
  discoveredModelId: string;
  executionTargetId: string;
}): boolean {
  return autoDiscoveredCapacityRuntimeKeys(input).includes(input.runtimeIdentityKey);
}

function updatedRowCount(result: unknown): number {
  if (!result || typeof result !== "object" || !("count" in result)) return 0;
  const count = Reflect.get(result, "count");
  return typeof count === "number" ? count : 0;
}

export function discoveredCapacityLabel(discoveredModelId: string): string {
  const label = `Discovered model ${discoveredModelId}`;
  if (label.length <= CAPACITY_LABEL_MAX) return label;
  const compact = `dm:${discoveredModelId}`;
  if (compact.length <= CAPACITY_LABEL_MAX) return compact;
  throw new Error("Discovered model id exceeds the inference capacity label limit.");
}

export function discoveredHardConcurrencyLimit(reported: number | null | undefined): number {
  if (
    typeof reported === "number" &&
    Number.isInteger(reported) &&
    reported >= 1 &&
    reported <= HARD_CONCURRENCY_MAX
  ) {
    return reported;
  }
  return DISCOVERED_MODEL_DEFAULT_HARD_CONCURRENCY;
}

function runtimeModelName(upstreamModelId: string, discoveredModelId: string): string {
  const trimmed = upstreamModelId.trim();
  const value = trimmed.length > 0 ? trimmed : discoveredModelId;
  return value.length <= RUNTIME_MODEL_MAX ? value : value.slice(0, RUNTIME_MODEL_MAX);
}

export function isUniqueConstraintConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return Reflect.get(error, "code") === "P2002";
}

export function isInferenceCapacityWriteRetryable(error: unknown): boolean {
  return (
    retryableSerializableTransactionCode(error) !== undefined || isUniqueConstraintConflict(error)
  );
}

/**
 * Fills a null hard limit on an auto-created discovered capacity. The null
 * predicate loses to a concurrent writer who already stored a number. A
 * different runtime key does not match. Schema-hardening inserts the row
 * without a limit because that trigger cannot see the CLI-reported number.
 */
export async function fillNullAutoDiscoveredCapacityLimit(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    capacityId: string;
    discoveredModelId: string;
    executionTargetId?: string | null;
    reportedConcurrency?: number | null;
  },
): Promise<number> {
  const updated = await tx.inferenceCapacity.updateMany({
    where: {
      id: input.capacityId,
      userId: input.userId,
      hardConcurrencyLimit: null,
      runtimeIdentityKey: {
        in: autoDiscoveredCapacityRuntimeKeys({
          discoveredModelId: input.discoveredModelId,
          executionTargetId: input.executionTargetId,
        }),
      },
    },
    data: {
      hardConcurrencyLimit: discoveredHardConcurrencyLimit(input.reportedConcurrency),
    },
  });
  return updatedRowCount(updated);
}

/**
 * Returns the capacity id for one discovered model. An existing legacy row is
 * reused. A new row copies the provider capacity shape and stores a finite
 * hard concurrency so admission does not treat the target as unconfigured.
 * Keeping an auto row whose limit is still null fills that limit. A different
 * runtime key and a non-null limit are left unchanged. Does not set the target FK.
 */
export async function ensureDiscoveredInferenceCapacity(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    discoveredModelId: string;
    upstreamModelId: string;
    reportedConcurrency?: number | null;
    executionTargetId?: string | null;
  },
): Promise<string> {
  if (input.executionTargetId) {
    const legacy = await tx.inferenceCapacity.findUnique({
      where: {
        userId_runtimeIdentityKey: {
          userId: input.userId,
          runtimeIdentityKey: legacyExecutionTargetRuntimeIdentityKey(input.executionTargetId),
        },
      },
      select: { id: true },
    });
    if (legacy) {
      await fillNullAutoDiscoveredCapacityLimit(tx, {
        userId: input.userId,
        capacityId: legacy.id,
        discoveredModelId: input.discoveredModelId,
        executionTargetId: input.executionTargetId,
        reportedConcurrency: input.reportedConcurrency,
      });
      return legacy.id;
    }
  }
  const runtimeIdentityKey = discoveredRuntimeIdentityKey(input.discoveredModelId);
  const capacity = await tx.inferenceCapacity.upsert({
    where: {
      userId_runtimeIdentityKey: {
        userId: input.userId,
        runtimeIdentityKey,
      },
    },
    update: {},
    create: {
      userId: input.userId,
      label: discoveredCapacityLabel(input.discoveredModelId),
      runtimeIdentityKey,
      runtimeModel: runtimeModelName(input.upstreamModelId, input.discoveredModelId),
      hardConcurrencyLimit: discoveredHardConcurrencyLimit(input.reportedConcurrency),
      countStrategy: "CONSERVATIVE_ESTIMATE",
    },
    select: { id: true },
  });
  await fillNullAutoDiscoveredCapacityLimit(tx, {
    userId: input.userId,
    capacityId: capacity.id,
    discoveredModelId: input.discoveredModelId,
    executionTargetId: input.executionTargetId,
    reportedConcurrency: input.reportedConcurrency,
  });
  return capacity.id;
}

export async function linkExecutionTargetCapacity(
  tx: Prisma.TransactionClient,
  input: { executionTargetId: string; userId: string; inferenceCapacityId: string },
): Promise<number> {
  const updated = await tx.executionTarget.updateMany({
    where: {
      id: input.executionTargetId,
      userId: input.userId,
      inferenceCapacityId: null,
    },
    data: { inferenceCapacityId: input.inferenceCapacityId },
  });
  return updated.count;
}

async function attachBackfillTarget(input: {
  executionTargetId: string;
  userId: string;
  discoveredModelId: string;
  upstreamModelId: string;
}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    // Target row first, then the capacity row. Registration upserts the target
    // before creating a capacity, so the same order cannot deadlock.
    await tx.$queryRaw`SELECT id FROM execution_target WHERE id = ${input.executionTargetId} AND "userId" = ${input.userId} FOR UPDATE`;
    const current = await tx.executionTarget.findUnique({
      where: { id: input.executionTargetId },
      select: {
        id: true,
        userId: true,
        kind: true,
        discoveredModelId: true,
        inferenceCapacityId: true,
      },
    });
    if (
      !current ||
      current.userId !== input.userId ||
      current.kind !== "DISCOVERED_MODEL" ||
      current.discoveredModelId !== input.discoveredModelId ||
      current.inferenceCapacityId
    ) {
      return 0;
    }
    const capacityId = await ensureDiscoveredInferenceCapacity(tx, {
      userId: current.userId,
      discoveredModelId: input.discoveredModelId,
      upstreamModelId: input.upstreamModelId,
      executionTargetId: current.id,
      reportedConcurrency: null,
    });
    return linkExecutionTargetCapacity(tx, {
      executionTargetId: current.id,
      userId: current.userId,
      inferenceCapacityId: capacityId,
    });
  });
}

async function fillAttachedAutoCapacityLimit(input: {
  executionTargetId: string;
  userId: string;
  discoveredModelId: string;
  inferenceCapacityId: string;
}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    // Same lock order as attach: the target row, then the capacity row.
    // A foreign key that is already set is not replaced.
    await tx.$queryRaw`SELECT id FROM execution_target WHERE id = ${input.executionTargetId} AND "userId" = ${input.userId} FOR UPDATE`;
    const current = await tx.executionTarget.findUnique({
      where: { id: input.executionTargetId },
      select: {
        id: true,
        userId: true,
        kind: true,
        discoveredModelId: true,
        inferenceCapacityId: true,
      },
    });
    if (
      !current ||
      current.userId !== input.userId ||
      current.kind !== "DISCOVERED_MODEL" ||
      current.discoveredModelId !== input.discoveredModelId ||
      current.inferenceCapacityId !== input.inferenceCapacityId
    ) {
      return 0;
    }
    return fillNullAutoDiscoveredCapacityLimit(tx, {
      userId: current.userId,
      capacityId: input.inferenceCapacityId,
      discoveredModelId: input.discoveredModelId,
      executionTargetId: current.id,
      reportedConcurrency: null,
    });
  });
}

async function withCapacityWriteRetries(work: () => Promise<number>): Promise<number> {
  for (let attempt = 1; attempt <= BACKFILL_ATTEMPTS; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isInferenceCapacityWriteRetryable(error) || attempt === BACKFILL_ATTEMPTS) throw error;
    }
  }
  return 0;
}

/**
 * Idempotent startup repair for discovered execution targets. Null foreign
 * keys are attached. An attached auto capacity (`execution-target:<id>` or
 * `discovered-model:<id>`) whose hard limit is still null is set to the
 * discovered default, because startup has no CLI report. Does not delete
 * rows, does not replace a foreign key that is already set, and does not
 * change a non-null limit or a different runtime key.
 */
export async function backfillDiscoveredInferenceCapacities(): Promise<{
  attached: number;
  unchanged: number;
}> {
  const targets = await prisma.executionTarget.findMany({
    where: {
      inferenceCapacityId: null,
      kind: "DISCOVERED_MODEL",
      discoveredModelId: { not: null },
    },
    select: {
      id: true,
      userId: true,
      discoveredModelId: true,
      DiscoveredModel: { select: { upstreamModelId: true } },
    },
  });
  let attached = 0;
  let unchanged = 0;
  for (const target of targets) {
    const discoveredModelId = target.discoveredModelId;
    if (!discoveredModelId) {
      unchanged += 1;
      continue;
    }
    const linked = await withCapacityWriteRetries(() =>
      attachBackfillTarget({
        executionTargetId: target.id,
        userId: target.userId,
        discoveredModelId,
        upstreamModelId: target.DiscoveredModel?.upstreamModelId ?? discoveredModelId,
      }),
    );
    if (linked > 0) attached += 1;
    else unchanged += 1;
  }
  await fillNullLimitsOnAttachedAutoCapacities();
  return { attached, unchanged };
}

async function fillNullLimitsOnAttachedAutoCapacities(): Promise<void> {
  const targets = await prisma.executionTarget.findMany({
    where: {
      kind: "DISCOVERED_MODEL",
      discoveredModelId: { not: null },
      inferenceCapacityId: { not: null },
      InferenceCapacity: {
        is: {
          hardConcurrencyLimit: null,
          OR: [
            { runtimeIdentityKey: { startsWith: "execution-target:" } },
            { runtimeIdentityKey: { startsWith: "discovered-model:" } },
          ],
        },
      },
    },
    select: {
      id: true,
      userId: true,
      discoveredModelId: true,
      inferenceCapacityId: true,
      InferenceCapacity: {
        select: { runtimeIdentityKey: true, hardConcurrencyLimit: true },
      },
    },
  });
  for (const target of targets) {
    const discoveredModelId = target.discoveredModelId;
    const capacityId = target.inferenceCapacityId;
    const capacity = target.InferenceCapacity;
    if (!discoveredModelId || !capacityId || !capacity) continue;
    if (capacity.hardConcurrencyLimit !== null) continue;
    if (
      !isExactAutoDiscoveredRuntimeKey({
        runtimeIdentityKey: capacity.runtimeIdentityKey,
        discoveredModelId,
        executionTargetId: target.id,
      })
    ) {
      continue;
    }
    await withCapacityWriteRetries(() =>
      fillAttachedAutoCapacityLimit({
        executionTargetId: target.id,
        userId: target.userId,
        discoveredModelId,
        inferenceCapacityId: capacityId,
      }),
    );
  }
}
