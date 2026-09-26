/**
 * Finishes accepted user deletions (DL1-TXBOUND durable intent).
 *
 * `users.remove` and Better Auth's remove-user mark the user
 * (`deletionRequestedAt`, a ban, sessions revoked) before draining its request
 * history and deleting its capacity graph (@ws-model-proxy/db/parent-deletion).
 * When that completion fails transiently, or the process stops mid-drain, the
 * marker survives. This sweep resumes every marked user: the drain is
 * idempotent (only rows still present are processed) and the ordered delete
 * re-plans under its own locks, so resuming after any crash point is safe.
 *
 * Outcomes per user:
 *  - deleted: listeners are notified (live relay sessions of the user close);
 *  - already gone: nothing to do (the marker went with the row);
 *  - permanent refusal (retained history appeared after the preflight, or a
 *    database invariant refused the delete): the marker is cleared and the
 *    user is archived (an indefinite ban set in the same statement,
 *    `abandonUserDeletion`), the fallback the refusal recommends;
 *  - transient failure, or a residual above the final-phase bound found by
 *    the in-transaction recount: logged, retried after an exponential backoff
 *    (per generation attempt count) so other pending users get a turn.
 *
 * Concurrency: a sweep and a request (or two replicas) completing the same
 * user interleave safely. Drain batches take rows with SKIP LOCKED, the
 * ordered delete serializes on the user row, and the loser finds the user
 * gone. Each batch first takes the user row FOR SHARE on its generation, so
 * a worker whose generation was abandoned (and the user restored or marked
 * again) deletes nothing more. The grace period keeps the sweep from joining
 * a request that is still completing the delete itself.
 *
 * Shutdown: no permit. Stopping the sweep (the first shutdown step) prevents
 * any further user from being started by it: the stop flag is checked before
 * every user and before a tick begins. The user already in progress runs on
 * until the DB shutdown fence stops it. The sweep runs on its own client
 * ({@link createUserDeletionSweepClient}), never the shared one, and that
 * client is fenced at dispatch: once the fence arms, its connections send no
 * further statement and open no connection, except the `COMMIT` or
 * `ROLLBACK` that ends a transaction (@ws-model-proxy/db/client-factory).
 * That holds inside one Prisma operation too (a relation read is several
 * queries, a transaction several statements), so what is left is the
 * statement or the connect already in flight at the fence, in whichever
 * stage of the tick it is, plus the end of its transaction. Every connection
 * carries a server-side `statement_timeout`
 * (`USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS`), which bounds that statement
 * wherever it is, and the pool's connect timeout bounds the connect; a
 * cancelled statement rolls back and the marker keeps the rest for the next
 * process. The end of a transaction has no server-side bound (a `COMMIT`
 * can wait on synchronous replication or run deferred triggers after
 * `statement_timeout` is disarmed), so shutdown does not rely on one:
 * {@link shutDownUserDeletionSweep} joins the tick for at most the join
 * deadline, quarantines the sweep's pool if it has not settled (every socket
 * destroyed; the tick then fails at once and stops as a shutdown stop), and
 * disconnects under its own short deadline. Shutdown therefore waits on the
 * sweep for at most `USER_DELETION_SWEEP_JOIN_TIMEOUT_MS +
 * USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS` (./shutdown-timeouts.ts). The
 * server work a quarantine leaves behind resolves by commit or rollback
 * after the process leaves; the marker and generation make either outcome
 * recoverable. That work can still hold row locks a shared-client operation
 * admitted before the fence waits on; the shared client's disconnect is
 * therefore bounded too (`disconnectDatabaseClients`, ./graceful-shutdown.ts),
 * so the process never waits on sweep work beyond the join plus the two
 * disconnect deadlines, and the process watchdog
 * (`PROCESS_SHUTDOWN_DEADLINE_MS`) bounds everything else.
 * A failure once the fence is armed is a shutdown stop, not a sweep failure:
 * it is logged as such, records no backoff or abandon, and does not count
 * toward the failed-tick escalation. Request paths (users.remove, Better
 * Auth) keep the shared client and its behavior.
 *
 * The deletion listeners (relay sockets of the deleted user) are started, not
 * awaited, by the tick: their synchronous part (closing the sockets) runs
 * before the next user, and their status writes run on the shared client,
 * outside the join (see {@link sweepPendingUserDeletions}).
 */
import { notifyUserDeleted } from "@ws-model-proxy/auth/user-deletion-listeners";
import {
  createStatementBoundedPrismaClient,
  type StatementBoundedClientOptions,
  type StatementBoundedPrismaClient,
} from "@ws-model-proxy/db/client-factory";
import {
  abandonUserDeletion,
  completeUserDeletion,
  isPermanentParentDeletionFailure,
  listPendingUserDeletions,
  recordUserDeletionSweepFailure,
} from "@ws-model-proxy/db/parent-deletion";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";
import { runWithDeadline } from "./graceful-shutdown.js";
import {
  USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS,
  USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS,
  USER_DELETION_SWEEP_JOIN_TIMEOUT_MS,
  USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS,
} from "./shutdown-timeouts.js";

export const USER_DELETION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** A marker younger than this is still being completed by its request. */
export const USER_DELETION_SWEEP_GRACE_MS = 2 * 60 * 1000;
/** Users completed per tick; the rest wait for the next tick. */
export const USER_DELETION_SWEEP_BATCH = 10;
/** `application_name` of the sweep's connections (visible in `pg_stat_activity`). */
export const USER_DELETION_SWEEP_APPLICATION_NAME = "wsmp-user-deletion-sweep";
/**
 * TCP keepalive delay of the sweep's held connection: well under common NAT
 * and load-balancer idle timeouts (4 to 6 minutes), which the 5-minute tick
 * interval alone would exceed.
 */
export const USER_DELETION_SWEEP_KEEPALIVE_DELAY_MS = 30_000;
/**
 * Consecutive failed ticks (the tick itself failed, e.g. the queue read could
 * not connect) after which the failure is logged as an escalation: no marked
 * user is being deleted while this persists.
 */
export const USER_DELETION_SWEEP_FAILED_TICKS_ESCALATION = 3;

type SweepPrisma = Parameters<typeof completeUserDeletion>[0];

/**
 * Options of the sweep's own client (see {@link createUserDeletionSweepClient}).
 */
export const USER_DELETION_SWEEP_CLIENT_OPTIONS = {
  statementTimeoutMs: USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS,
  connectTimeoutMs: USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS,
  applicationName: USER_DELETION_SWEEP_APPLICATION_NAME,
  maxConnections: 2,
  minIdleConnections: 1,
  keepAliveInitialDelayMs: USER_DELETION_SWEEP_KEEPALIVE_DELAY_MS,
} as const satisfies StatementBoundedClientOptions;

/**
 * The sweep's own client: fenced per operation and at dispatch (no statement
 * or connect after the shutdown fence arms, except `COMMIT` / `ROLLBACK`),
 * every statement on its connections bounded server-side by
 * `USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS`, no connection returned to the
 * pool unless it is idle, and a quarantine handle for shutdown (see the
 * module docblock). Two connections at most: the tick is sequential and every
 * statement of a transaction uses that transaction's connection.
 *
 * One connection stays open between ticks (`minIdleConnections: 1`): with
 * pg-pool's default 10 s idle timeout the 5-minute interval would reconnect
 * on every tick, so every tick would pay (and could fail on) a cold connect.
 * The held connection counts against the server's `max_connections` for the
 * life of the process (one backend, `application_name`
 * {@link USER_DELETION_SWEEP_APPLICATION_NAME}); a second one, if a tick ever
 * opens it, closes after the idle timeout. TCP keepalive keeps the held
 * connection's NAT mapping alive and detects a vanished peer; a connection
 * the server or a proxy closed is dropped by the pool and the next tick
 * connects again, bounded by `USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS`.
 *
 * The caller shuts it down with {@link shutDownUserDeletionSweep}
 * (apps/server/src/index.ts).
 */
export function createUserDeletionSweepClient(
  connectionString: string,
): StatementBoundedPrismaClient {
  return createStatementBoundedPrismaClient(connectionString, USER_DELETION_SWEEP_CLIENT_OPTIONS);
}

export type UserDeletionSweepShutdown = {
  /** The tick in flight settled before the join deadline. */
  joined: boolean;
  /** Sockets the quarantine destroyed, or null when no quarantine was needed. */
  quarantined: number | null;
  /** The client's disconnect settled before its deadline. */
  disconnected: boolean;
};

/**
 * The sweep's part of shutdown (apps/server/src/index.ts), after the sweep was
 * stopped and the DB shutdown fence armed. Waits at most `joinTimeoutMs` for
 * `stopped` (the stop's join of the tick in flight). If the tick has not
 * settled by then, quarantines the client's pool (every socket destroyed,
 * reconnects refused), which fails whatever the tick awaits so it ends as a
 * shutdown stop with no further write. Then disconnects the client, waiting
 * at most `disconnectTimeoutMs`, and quarantines if that runs out too. A tick
 * that settled in time is never quarantined: its warm connection closes
 * gracefully.
 *
 * So this step waits on the sweep for at most `joinTimeoutMs +
 * disconnectTimeoutMs`, even when the database never finishes the
 * transaction in flight (see ./shutdown-timeouts.ts for why that can happen
 * and why both of its outcomes are recoverable). Called through
 * `disconnectDatabaseClients` (./graceful-shutdown.ts), which then bounds the
 * shared client's disconnect as well.
 */
export async function shutDownUserDeletionSweep({
  stopped,
  client,
  joinTimeoutMs = USER_DELETION_SWEEP_JOIN_TIMEOUT_MS,
  disconnectTimeoutMs = USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS,
  warn,
}: {
  /** The join of the stopped sweep (what {@link StopUserDeletionSweep} returns). */
  stopped: () => Promise<void>;
  client: StatementBoundedPrismaClient;
  joinTimeoutMs?: number;
  disconnectTimeoutMs?: number;
  warn?: (message: string) => void;
}): Promise<UserDeletionSweepShutdown> {
  const joined =
    (await runWithDeadline(stopped, joinTimeoutMs, "user deletion sweep join", { warn })) ===
    "done";
  let quarantined: number | null = null;
  if (!joined) {
    quarantined = client.quarantine();
    console.warn(
      `[auth] user deletion sweep quarantined at shutdown (${quarantined} connection(s) closed); a transaction in flight commits or rolls back on the server, and a kept marker resumes in the next process.`,
    );
  }
  const disconnected =
    (await runWithDeadline(
      () => client.prisma.$disconnect(),
      disconnectTimeoutMs,
      "user deletion sweep disconnect",
      { warn },
    )) === "done";
  if (!disconnected) quarantined = (quarantined ?? 0) + client.quarantine();
  return { joined, quarantined, disconnected };
}

export type UserDeletionSweepResult = {
  deleted: number;
  abandoned: number;
  failed: number;
};

function errorClass(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

/**
 * Logs that shutdown stopped the user in progress. Once the DB shutdown fence
 * is armed (it never disarms in production), a failure is the fence refusing
 * the tick's next statement or connect, or the statement in flight at the
 * fence being cut off (the transaction rolled back, and the user's marker,
 * generation and backoff state are exactly as before, for the next process),
 * or the shutdown quarantine destroying the connection
 * ({@link shutDownUserDeletionSweep}): then the transaction in flight commits
 * or rolls back on the server after the process leaves, and the sweep writes
 * nothing more. A committed final delete removed the user and its marker; any
 * other outcome leaves the marker and generation for the next process.
 */
function logShutdownStop(): void {
  console.log(
    "[auth] user deletion sweep stopped by shutdown; a marked user not yet deleted stays marked for the next process.",
  );
}

/**
 * One sweep tick over the marked users, on `prisma` (the sweep's own client,
 * {@link createUserDeletionSweepClient}; there is deliberately no default, so
 * no caller falls back to the shared client).
 *
 * Per-user isolation: a failure of one user's recovery write (the abandon or
 * the backoff; e.g. a statement timeout, 57014) is logged by class and the
 * tick goes on with the next user, unless shutdown began. The failed write
 * rolled back, so the user keeps its marker, generation and backoff state and
 * is retried by a later tick or process.
 *
 * Listeners for a completed delete are started, not awaited: their
 * synchronous part (revoking the user's terminal access and closing their
 * relay sockets) runs before the next user, and their device status writes
 * (on the shared client, to rows the cascade already removed) cannot hold up
 * the tick or the shutdown join. `notifyUserDeleted` logs listener failures.
 */
export async function sweepPendingUserDeletions({
  prisma,
  now = new Date(),
  complete = completeUserDeletion,
  notify = notifyUserDeleted,
  shouldStop = () => false,
}: {
  prisma: SweepPrisma;
  now?: Date;
  complete?: typeof completeUserDeletion;
  notify?: (userId: string) => Promise<void>;
  /** True once shutdown began: no further user is started. */
  shouldStop?: () => boolean;
}): Promise<UserDeletionSweepResult> {
  const result: UserDeletionSweepResult = { deleted: 0, abandoned: 0, failed: 0 };
  const pending = await listPendingUserDeletions(prisma, {
    before: new Date(now.getTime() - USER_DELETION_SWEEP_GRACE_MS),
    limit: USER_DELETION_SWEEP_BATCH,
    now,
  });
  // Every transition below acts on the generation this sweep selected: a
  // deletion abandoned and requested again meanwhile is left to its own
  // generation (completion returns false, abandon and backoff match nothing).
  for (const { userId, generation, attempts } of pending) {
    if (shouldStop() || isDbShutdownFenceArmed()) break;
    let failure: unknown;
    try {
      if (await complete(prisma, userId, generation)) {
        result.deleted += 1;
        void notify(userId).catch((error: unknown) => {
          console.error("[auth] user deletion listener failed", errorClass(error));
        });
      }
      continue;
    } catch (error) {
      failure = error;
    }
    if (isDbShutdownFenceArmed()) {
      // Shutdown, not a failure of this user: no backoff or abandon write.
      logShutdownStop();
      break;
    }
    try {
      if (isPermanentParentDeletionFailure(failure)) {
        if (await abandonUserDeletion(prisma, userId, generation)) result.abandoned += 1;
        console.error(
          "[auth] user deletion refused; the user stays archived:",
          errorClass(failure),
        );
      } else {
        result.failed += 1;
        console.error("[auth] user deletion sweep will retry:", errorClass(failure));
        await recordUserDeletionSweepFailure(prisma, userId, generation, {
          now,
          attempt: attempts + 1,
        });
      }
    } catch (error) {
      // The recovery write rolled back: marker, generation and backoff state
      // are unchanged, so a later tick (or process) retries this user.
      if (isDbShutdownFenceArmed()) {
        logShutdownStop();
        break;
      }
      console.error("[auth] user deletion sweep could not record the outcome:", errorClass(error));
    }
  }
  return result;
}

/**
 * Stops the sweep: no tick and no user starts afterwards. Resolves when the
 * tick in flight (if any) has finished.
 */
export type StopUserDeletionSweep = () => Promise<void>;

let activeUserDeletionSweepStop: StopUserDeletionSweep | null = null;

/**
 * Starts the periodic sweep on `prisma`, the sweep's own client
 * ({@link createUserDeletionSweepClient}). The caller keeps the client and
 * shuts it down with {@link shutDownUserDeletionSweep} (shutdown order: stop,
 * arm the DB fence, join bounded, quarantine if the join ran out, disconnect
 * bounded).
 */
export function startUserDeletionSweep({
  prisma,
  intervalMs = USER_DELETION_SWEEP_INTERVAL_MS,
  sweep = sweepPendingUserDeletions,
}: {
  prisma: SweepPrisma;
  intervalMs?: number;
  sweep?: typeof sweepPendingUserDeletions;
}): StopUserDeletionSweep {
  if (activeUserDeletionSweepStop !== null) return activeUserDeletionSweepStop;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let failedTicks = 0;
  const tick = async () => {
    try {
      const result = await sweep({ prisma, shouldStop: () => stopped });
      failedTicks = 0;
      if (result.deleted + result.abandoned > 0)
        console.log(
          `[auth] user deletion sweep: deleted ${result.deleted}, archived ${result.abandoned} after a refusal.`,
        );
    } catch (error) {
      if (isDbShutdownFenceArmed()) {
        // Shutdown stopped the tick (typically the fence refused its queue
        // read): not a failure, and not counted toward the escalation.
        logShutdownStop();
        return;
      }
      failedTicks += 1;
      if (failedTicks >= USER_DELETION_SWEEP_FAILED_TICKS_ESCALATION) {
        // A tick that fails outright (typically its queue read: the database
        // is unreachable or connects slower than the connect bound) deletes
        // nobody, so marked users stay banned but are not deleted until it
        // recovers.
        console.error(
          `[auth] ALERT: user deletion sweep failed ${failedTicks} consecutive ticks; marked users are not being deleted:`,
          errorClass(error),
        );
      } else {
        console.error("[auth] user deletion sweep failed:", errorClass(error));
      }
    }
  };
  const run = () => {
    if (stopped || inFlight !== null) return;
    inFlight = tick().finally(() => {
      inFlight = null;
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  const stop: StopUserDeletionSweep = async () => {
    stopped = true;
    clearInterval(timer);
    if (activeUserDeletionSweepStop === stop) activeUserDeletionSweepStop = null;
    await inFlight;
  };
  activeUserDeletionSweepStop = stop;
  return stop;
}
