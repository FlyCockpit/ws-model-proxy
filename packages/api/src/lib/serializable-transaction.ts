import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import {
  CapacityOrderedTransactionTimeoutError,
  isRetryableCapacityTransactionError,
  runCapacityOrderedTransaction,
} from "@ws-model-proxy/db/capacity-lock-order";
import { ParentDeletionDrainPendingError } from "@ws-model-proxy/db/parent-deletion";
import { deletionConflict } from "./deletion-conflict";
import { RETRY_CONFLICT_MESSAGE } from "./refuse";

const RETRYABLE_CODES = new Set(["P2034", "40001", "40P01"]);
const TRANSACTION_WRITE_CONFLICT = "TransactionWriteConflict";

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || !(property in value)) return undefined;
  const propertyValue = Reflect.get(value, property);
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function objectProperty(value: unknown, property: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, property) : undefined;
}

/** A SERIALIZABLE snapshot may predate the owner fence's wait and label allocation. */
function isCapacityLabelCollision(error: unknown): boolean {
  const meta = objectProperty(error, "meta");
  const cause =
    objectProperty(objectProperty(meta, "driverAdapterError"), "cause") ??
    objectProperty(error, "cause");
  const code = stringProperty(error, "code");
  const sqlState = code === "P2010" ? stringProperty(meta, "code") : code;
  if (code !== "P2002" && sqlState !== "23505" && stringProperty(cause, "originalCode") !== "23505")
    return false;
  const index = "inference_capacity_userId_label_key";
  return (
    stringProperty(error, "constraint") === index ||
    stringProperty(meta, "target") === index ||
    stringProperty(objectProperty(cause, "constraint"), "index") === index
  );
}

/**
 * Prisma wraps database errors raised by raw queries in P2010 and preserves
 * the PostgreSQL SQLSTATE in `meta.code`. Normal Prisma serialization errors
 * expose P2034 directly, while some drivers expose the SQLSTATE directly.
 * The capacity-label index is classified separately; only automatic creators
 * opt into retrying that unique conflict.
 */
export function retryableSerializableTransactionCode(error: unknown): string | undefined {
  if (isCapacityLabelCollision(error)) return "23505";
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
  options: { maxWait?: number; timeout?: number; retryCapacityLabels?: boolean } = {},
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: "Serializable",
        ...(options.maxWait !== undefined ? { maxWait: options.maxWait } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      });
    } catch (error) {
      const code = retryableSerializableTransactionCode(error);
      if (!code || (code === "23505" && !options.retryCapacityLabels)) throw error;
      if (attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
  throw new ORPCError("CONFLICT", {
    message: RETRY_CONFLICT_MESSAGE,
  });
}

/** Automatic creators only: explicit owner label conflicts keep their usual error. */
export function runSerializableCapacityCreationTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { maxWait?: number; timeout?: number } = {},
): Promise<T> {
  return runSerializableTransaction(work, { ...options, retryCapacityLabels: true });
}

/**
 * READ COMMITTED transaction for parent deletes under owner fences (see
 * `fenceParentDelete` in `@ws-model-proxy/db/capacity-lock-order`).
 * Deadlock, serialization and fence-set-change failures are retried with a
 * fresh transaction; exhausting the retries surfaces as CONFLICT, like
 * `runSerializableTransaction`. Every statement is bounded server-side by
 * the transaction's `lock_timeout` / `statement_timeout`; a timeout rolls it
 * back and is the same `delete_contended` CONFLICT
 * ({@link throwCapacityDeleteConflict}).
 */
export async function runCapacityDeleteTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await runCapacityOrderedTransaction(prisma, work);
  } catch (error) {
    throwCapacityDeleteConflict(error);
    throw error;
  }
}

/**
 * Maps the failures of a capacity-ordered delete transaction that mean
 * "nothing was deleted, retry" to their CONFLICT reasons: a user-deletion
 * drain that could not finish now (`ParentDeletionDrainPendingError`, a busy
 * row past its lock bound or the drain's work bound) is `delete_pending`;
 * exhausted deadlock / serialization / lock-set-change retries and the
 * transaction's own server-side timeouts (a lock wait or statement past its
 * bound, live traffic holding the capacity locks) are `delete_contended`.
 * Other errors pass.
 */
export function throwCapacityDeleteConflict(error: unknown): void {
  throwParentDeletionPendingConflict(error);
  if (
    error instanceof CapacityOrderedTransactionTimeoutError ||
    isRetryableCapacityTransactionError(error)
  ) {
    throw deletionConflict("delete_contended", RETRY_CONFLICT_MESSAGE);
  }
}

/**
 * A user-deletion drain that could not finish now (a busy row past its lock
 * bound, or its work bound): CONFLICT, nothing deleted. Other errors pass.
 */
export function throwParentDeletionPendingConflict(error: unknown): void {
  if (!(error instanceof ParentDeletionDrainPendingError)) return;
  throw deletionConflict(
    "delete_pending",
    "This item still has requests in flight. Retry once they finish.",
  );
}
