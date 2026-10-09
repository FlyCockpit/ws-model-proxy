/**
 * The write paths' "retry" answers, honored the way callers honor them, for the PostgreSQL
 * suites.
 *
 * Capacity-ordered and serializable writes bound every lock wait (2 s) and every statement
 * (3 s) server-side and retry deadlocks and serialization failures a few times; past that they
 * roll back and answer CONFLICT {@link RETRY_CONFLICT_MESSAGE} (`delete_contended` for parent
 * deletes), and a node enrollment answers `rate_limited` (the code took no use). On a loaded
 * gate machine one slow statement trips those bounds with no contention at all, so a suite that
 * calls a write once and expects it to land fails on a contracted answer. The answer asks the
 * caller (or the person) to retry; these suites do, for a bounded time. Every other
 * outcome (a refusal by name, a crash) still fails at once, and so does a write that keeps
 * answering retry.
 */
import { ORPCError } from "@orpc/server";
import { RETRY_CONFLICT_MESSAGE } from "../lib/refuse";

/**
 * How long a write may keep answering retry. A loser of a race waits up to the 2 s fence bound
 * per attempt while the winner (up to 3 s per statement) commits, so on a loaded machine one
 * write can need several attempts; the budget stays well inside the suites' 60 s test timeout.
 */
const RETRY_BUDGET_MS = 25_000;
const BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 1_000;

/** The "nothing was written, retry" CONFLICT. */
export function isRetryAnswer(error: unknown): boolean {
  return (
    error instanceof ORPCError &&
    error.code === "CONFLICT" &&
    error.message === RETRY_CONFLICT_MESSAGE
  );
}

/**
 * Runs `write` until it answers something other than retry (a thrown retry CONFLICT, or a
 * result `retryResult` names), for at most {@link RETRY_BUDGET_MS}; the last answer is returned
 * or thrown as is.
 */
export async function untilAnswered<T>(
  write: () => Promise<T>,
  retryResult: (result: T) => boolean = () => false,
  budgetMs: number = RETRY_BUDGET_MS,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt += 1) {
    const last = Date.now() >= deadline;
    try {
      const result = await write();
      if (last || !retryResult(result)) return result;
    } catch (error) {
      if (last || !isRetryAnswer(error)) throw error;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(BACKOFF_MS * attempt, MAX_BACKOFF_MS)),
    );
  }
}

/** A router-client interceptor that retries every procedure call's retry answer. */
export function retryAnswers<T>({ next }: { next: () => Promise<T> }): Promise<T> {
  return untilAnswered(next);
}
