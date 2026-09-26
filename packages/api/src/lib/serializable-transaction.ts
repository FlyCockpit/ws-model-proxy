import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import {
  isRetryableCapacityTransactionError,
  runCapacityOrderedTransaction,
} from "@ws-model-proxy/db/capacity-lock-order";
import {
  ParentDeletionDrainPendingError,
  ParentDeletionInterruptedError,
  type ParentDeletionScope,
  prepareParentDeletion,
  RetainedHistoryError,
} from "@ws-model-proxy/db/parent-deletion";
import { deletionConflict } from "./deletion-conflict";

const RETRYABLE_CODES = new Set(["P2034", "40001", "40P01"]);
const TRANSACTION_WRITE_CONFLICT = "TransactionWriteConflict";

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || !(property in value)) return undefined;
  const propertyValue = Reflect.get(value, property);
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

/**
 * Prisma wraps database errors raised by raw queries in P2010 and preserves
 * the PostgreSQL SQLSTATE in `meta.code`. Normal Prisma serialization errors
 * expose P2034 directly, while some drivers expose the SQLSTATE directly.
 */
export function retryableSerializableTransactionCode(error: unknown): string | undefined {
  const code = stringProperty(error, "code");
  const directCause =
    error && typeof error === "object" && "cause" in error
      ? Reflect.get(error, "cause")
      : undefined;
  if (stringProperty(directCause, "kind") === TRANSACTION_WRITE_CONFLICT) return "40001";
  if (code === "P2010") {
    if (!error || typeof error !== "object" || !("meta" in error)) return undefined;
    const meta = Reflect.get(error, "meta");
    const driverAdapterError =
      meta && typeof meta === "object" && "driverAdapterError" in meta
        ? Reflect.get(meta, "driverAdapterError")
        : undefined;
    const cause =
      driverAdapterError && typeof driverAdapterError === "object" && "cause" in driverAdapterError
        ? Reflect.get(driverAdapterError, "cause")
        : undefined;
    if (stringProperty(cause, "kind") === TRANSACTION_WRITE_CONFLICT) return "40001";
    const sqlState = stringProperty(meta, "code") ?? stringProperty(cause, "originalCode");
    return sqlState && RETRYABLE_CODES.has(sqlState) ? sqlState : undefined;
  }
  return code && RETRYABLE_CODES.has(code) ? code : undefined;
}

export async function runSerializableTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (!retryableSerializableTransactionCode(error)) throw error;
      if (attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
  throw new ORPCError("CONFLICT", {
    message: "Configuration changed concurrently. Retry the request.",
  });
}

/**
 * READ COMMITTED transaction for ordered parent deletes (see
 * `lockCapacityGraphForDelete` in `@ws-model-proxy/db/capacity-lock-order`).
 * Deadlock, serialization and lock-set-change failures are retried with a
 * fresh transaction; exhausting the retries surfaces as CONFLICT, like
 * `runSerializableTransaction`.
 */
export async function runCapacityDeleteTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await runCapacityOrderedTransaction(prisma, work);
  } catch (error) {
    throwParentDeletionPendingConflict(error);
    if (!isRetryableCapacityTransactionError(error)) throw error;
    throw deletionConflict(
      "delete_contended",
      "Configuration changed concurrently. Retry the request.",
    );
  }
}

/**
 * Live or just-arrived history beyond what the final delete may take under
 * the capacity locks (PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS), found
 * by the pre-lock count or by the in-transaction recount of
 * `lockCapacityGraphForDelete`: CONFLICT, nothing deleted. Other errors pass.
 */
export function throwParentDeletionPendingConflict(error: unknown): void {
  if (!(error instanceof ParentDeletionDrainPendingError)) return;
  throw deletionConflict(
    "delete_pending",
    "This item still has requests in flight. Retry once they finish.",
  );
}

/**
 * Phases 1 and 2 of a parent delete (see @ws-model-proxy/db/parent-deletion):
 * refuses retained history before anything changes, then drains the request
 * history the cascade would delete or detach in short batches that take
 * their rows with SKIP LOCKED and bound every other lock wait (a timeout is
 * a `delete_pending` CONFLICT). Call it after the caller's own read-only checks
 * (ownership, staleness, attachment) and before
 * {@link runCapacityDeleteTransaction}, which then deletes only the capacity
 * graph and the residual under the capacity locks.
 */
export async function drainBeforeParentDelete(scope: ParentDeletionScope): Promise<void> {
  try {
    await prepareParentDeletion(prisma, scope);
  } catch (error) {
    if (error instanceof RetainedHistoryError) {
      throw deletionConflict(
        "retained_history",
        "This item has retained capacity or provider history and cannot be deleted. Disable it instead.",
      );
    }
    throwParentDeletionPendingConflict(error);
    if (error instanceof ParentDeletionInterruptedError) {
      throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message });
    }
    throw error;
  }
}
