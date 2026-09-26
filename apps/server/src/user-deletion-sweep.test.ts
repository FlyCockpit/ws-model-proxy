import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RetainedHistoryError } from "@ws-model-proxy/db/parent-deletion";
import { armDbShutdownFence, disarmDbShutdownFence } from "@ws-model-proxy/db/shutdown-fence";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import {
  USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS,
  USER_DELETION_SWEEP_JOIN_TIMEOUT_MS,
} from "./shutdown-timeouts.js";
import {
  shutDownUserDeletionSweep,
  startUserDeletionSweep,
  sweepPendingUserDeletions,
  USER_DELETION_SWEEP_BATCH,
  USER_DELETION_SWEEP_FAILED_TICKS_ESCALATION,
  USER_DELETION_SWEEP_GRACE_MS,
  type UserDeletionSweepResult,
} from "./user-deletion-sweep.js";

type SweepClient = Parameters<typeof sweepPendingUserDeletions>[0]["prisma"];

// The drain and the ordered delete run against real PostgreSQL (with the
// sweep's own statement-bounded client) in
// packages/api/src/lib/parent-deletion.postgres.integration.test.ts; here the
// sweep's queue, outcome handling, per-user isolation and fencing are
// exercised. The sweep takes its client explicitly: it has no fallback to the
// shared client.
const client = mockDeep<SweepClient>();
const prisma: SweepClient = client;
const db = client as unknown as {
  user: { findMany: MockInstance };
  $executeRaw: MockInstance;
};
const NOW = new Date("2026-09-25T12:00:00.000Z");

const REQUESTED = new Date("2026-09-25T11:00:00.000Z");

function row(id: string, attempts = 0, requestedAt = REQUESTED) {
  return {
    id,
    deletionGeneration: `generation-${id}`,
    deletionSweepAttempts: attempts,
    deletionRequestedAt: requestedAt,
  };
}

/** The eligibility filter of the queue read at NOW (unchanged by the cursor). */
const ELIGIBLE = {
  deletionRequestedAt: {
    not: null,
    lte: new Date(NOW.getTime() - USER_DELETION_SWEEP_GRACE_MS),
  },
  deletionGeneration: { not: null },
  OR: [{ deletionSweepNextAttemptAt: null }, { deletionSweepNextAttemptAt: { lte: NOW } }],
};
const QUEUE_READ = {
  orderBy: [{ deletionRequestedAt: "asc" }, { id: "asc" }],
  select: {
    id: true,
    deletionGeneration: true,
    deletionSweepAttempts: true,
    deletionRequestedAt: true,
  },
  take: USER_DELETION_SWEEP_BATCH,
};

describe("sweepPendingUserDeletions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disarmDbShutdownFence();
    db.$executeRaw.mockResolvedValue(1);
  });
  afterEach(() => disarmDbShutdownFence());

  it("reads only markers older than the grace period, oldest first, bounded", async () => {
    db.user.findMany.mockResolvedValue([]);
    const complete = vi.fn();
    await expect(sweepPendingUserDeletions({ prisma, now: NOW, complete })).resolves.toEqual({
      deleted: 0,
      abandoned: 0,
      failed: 0,
    });
    // Round-robin order over the immutable key (deletionRequestedAt, id),
    // from the oldest when the loop has no position yet.
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    expect(db.user.findMany).toHaveBeenCalledWith({ ...QUEUE_READ, where: ELIGIBLE });
    expect(complete).not.toHaveBeenCalled();
  });

  it("continues after the loop's position and wraps to the oldest on a short page (G2-01)", async () => {
    const later = new Date(REQUESTED.getTime() + 1_000);
    const queue = { after: { requestedAt: REQUESTED, userId: "b" } };
    // After the cursor: c; the wrap from the oldest returns a, b, c again.
    db.user.findMany
      .mockResolvedValueOnce([row("c", 0, later)])
      .mockResolvedValueOnce([row("a"), row("b"), row("c", 0, later)]);
    const complete = vi.fn(async (_db: unknown, _userId: string, _generation: string) => false);
    await sweepPendingUserDeletions({ prisma, now: NOW, complete, queue });
    expect(db.user.findMany.mock.calls).toEqual([
      [
        {
          ...QUEUE_READ,
          where: {
            AND: [
              ELIGIBLE,
              {
                OR: [
                  { deletionRequestedAt: { gt: REQUESTED } },
                  { deletionRequestedAt: REQUESTED, id: { gt: "b" } },
                ],
              },
            ],
          },
        },
      ],
      [{ ...QUEUE_READ, where: ELIGIBLE }],
    ]);
    // Each user once, in round-robin order, and the position is the last one.
    expect(complete.mock.calls.map((call) => call[1])).toEqual(["c", "a", "b"]);
    expect(queue.after).toEqual({ requestedAt: REQUESTED, userId: "b" });
  });

  it("moves the position past the page even when every user and every recovery write fails (G2-01)", async () => {
    const queue: { after?: { requestedAt: Date; userId: string } } = {};
    db.user.findMany.mockResolvedValueOnce(
      Array.from({ length: USER_DELETION_SWEEP_BATCH }, (_, index) => row(`u${index}`)),
    );
    db.$executeRaw.mockRejectedValue(
      Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
    );
    const complete = vi.fn(async () => {
      throw Object.assign(new Error("busy"), { code: "P2028" });
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await sweepPendingUserDeletions({ prisma, now: NOW, complete, queue });
    } finally {
      errors.mockRestore();
    }
    expect(queue.after).toEqual({
      requestedAt: REQUESTED,
      userId: `u${USER_DELETION_SWEEP_BATCH - 1}`,
    });
    // A full page needs no wrap read.
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
  });

  it("a failed queue read keeps the loop's position", async () => {
    const queue = { after: { requestedAt: REQUESTED, userId: "b" } };
    db.user.findMany.mockRejectedValueOnce(new Error("connect timeout"));
    await expect(sweepPendingUserDeletions({ prisma, now: NOW, queue })).rejects.toThrow(
      "connect timeout",
    );
    expect(queue.after).toEqual({ requestedAt: REQUESTED, userId: "b" });
  });

  it("completes each marked user, notifies deleted ones, and keeps transient failures", async () => {
    db.user.findMany.mockResolvedValue([row("deleted"), row("gone"), row("flaky", 3)]);
    const complete = vi.fn(async (_db: unknown, userId: string, _generation: string) => {
      if (userId === "flaky") throw Object.assign(new Error("timeout"), { code: "P2028" });
      return userId === "deleted";
    });
    const notify = vi.fn(async () => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      sweepPendingUserDeletions({ prisma, now: NOW, complete, notify }),
    ).resolves.toEqual({
      deleted: 1,
      abandoned: 0,
      failed: 1,
    });
    expect(notify.mock.calls).toEqual([["deleted"]]);
    // Each completion names the generation the sweep selected.
    expect(complete.mock.calls.map((call) => call[2])).toEqual([
      "generation-deleted",
      "generation-gone",
      "generation-flaky",
    ]);
    // A transient failure keeps the marker and records sweep backoff for the
    // selected generation only, counting this attempt (3 earlier + 1).
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = db.$executeRaw.mock.calls[0] ?? [];
    expect((sql as string[]).join("?")).toContain('"deletionGeneration" = ?');
    expect(values).toContain("generation-flaky");
    expect(values).toContain("flaky");
    const next = values.find((value): value is Date => value instanceof Date && value > NOW);
    // Attempt 4: backoff cap 30 s * 2^3 = 240 s, jittered into [120 s, 240 s].
    expect(next && next.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(120_000);
    expect(next && next.getTime() - NOW.getTime()).toBeLessThanOrEqual(240_000);
    expect(errors).toHaveBeenCalledWith("[auth] user deletion sweep will retry:", "Error");
    errors.mockRestore();
  });

  it("abandons the marker (the user stays archived) on a permanent refusal", async () => {
    db.user.findMany.mockResolvedValue([row("retained")]);
    const complete = vi.fn(async () => {
      throw new RetainedHistoryError("capacity lease");
    });
    const notify = vi.fn(async () => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      sweepPendingUserDeletions({ prisma, now: NOW, complete, notify }),
    ).resolves.toEqual({
      deleted: 0,
      abandoned: 1,
      failed: 0,
    });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = db.$executeRaw.mock.calls[0] ?? [];
    expect((sql as string[]).join("?")).toContain('"deletionGeneration" = ?');
    expect(values).toContain("generation-retained");
    expect(notify).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("does not count an abandon that matched no row (a newer generation replaced it)", async () => {
    db.user.findMany.mockResolvedValue([row("replaced")]);
    db.$executeRaw.mockResolvedValue(0);
    const complete = vi.fn(async () => {
      throw new RetainedHistoryError("capacity lease");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(sweepPendingUserDeletions({ prisma, now: NOW, complete })).resolves.toEqual({
      deleted: 0,
      abandoned: 0,
      failed: 0,
    });
    errors.mockRestore();
  });

  it("stops between users once the DB shutdown fence is armed", async () => {
    db.user.findMany.mockResolvedValue([row("a"), row("b")]);
    const complete = vi.fn(async () => {
      armDbShutdownFence();
      return true;
    });
    const notify = vi.fn(async () => undefined);

    const result = await sweepPendingUserDeletions({ prisma, now: NOW, complete, notify });
    expect(result.deleted).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("starts no further user once the stop flag is set (SWEEPER-STOP)", async () => {
    db.user.findMany.mockResolvedValue([row("a"), row("b"), row("c")]);
    let stopped = false;
    const complete = vi.fn(async () => {
      stopped = true;
      return true;
    });
    const notify = vi.fn(async () => undefined);
    const result = await sweepPendingUserDeletions({
      prisma,
      now: NOW,
      complete,
      notify,
      shouldStop: () => stopped,
    });
    expect(result.deleted).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("a failed backoff write does not end the tick for the other users (per-user isolation)", async () => {
    db.user.findMany.mockResolvedValue([row("stuck"), row("next")]);
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    db.$executeRaw.mockRejectedValueOnce(timeout);
    const complete = vi.fn(async (_db: unknown, userId: string) => {
      if (userId === "stuck") throw Object.assign(new Error("busy"), { code: "P2028" });
      return true;
    });
    const notify = vi.fn(async () => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      sweepPendingUserDeletions({ prisma, now: NOW, complete, notify }),
    ).resolves.toEqual({
      deleted: 1,
      abandoned: 0,
      failed: 1,
    });
    expect(complete.mock.calls.map((call) => call[1])).toEqual(["stuck", "next"]);
    expect(notify.mock.calls).toEqual([["next"]]);
    expect(errors).toHaveBeenCalledWith(
      "[auth] user deletion sweep could not record the outcome:",
      "Error",
    );
    errors.mockRestore();
  });

  it("a failed abandon write does not end the tick for the other users (per-user isolation)", async () => {
    db.user.findMany.mockResolvedValue([row("refused"), row("next")]);
    db.$executeRaw.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "57014" }));
    const complete = vi.fn(async (_db: unknown, userId: string) => {
      if (userId === "refused") throw new RetainedHistoryError("provider accounting");
      return true;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      sweepPendingUserDeletions({ prisma, now: NOW, complete, notify: async () => undefined }),
    ).resolves.toEqual({ deleted: 1, abandoned: 0, failed: 0 });
    expect(complete).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  // F2-07: once the shutdown fence is armed, a failure is shutdown stopping
  // the user in progress (the fence refused a statement or connect, or cut
  // the statement in flight off): no backoff or abandon write, no failure
  // count, no error-level log; the marker, generation and attempts stay.
  it.each([
    [
      "the method fence",
      () => Object.assign(new Error("fenced"), { name: "DbShutdownFenceError" }),
    ],
    ["the dispatch fence (wrapped by Prisma)", () => new Error("SQL dispatch refused")],
    [
      "a statement timeout of the statement in flight",
      () =>
        Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
    ],
    ["a permanent refusal", () => new RetainedHistoryError("provider accounting")],
  ])(
    "a completion failure after the fence armed (%s) stops the tick without a recovery write",
    async (_label, failure) => {
      db.user.findMany.mockResolvedValue([row("a"), row("b")]);
      const complete = vi.fn(async () => {
        armDbShutdownFence();
        throw failure();
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await expect(sweepPendingUserDeletions({ prisma, now: NOW, complete })).resolves.toEqual({
          deleted: 0,
          abandoned: 0,
          failed: 0,
        });
        expect(complete).toHaveBeenCalledTimes(1);
        expect(db.$executeRaw).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
        expect(logs).toHaveBeenCalledWith(expect.stringContaining("stopped by shutdown"));
      } finally {
        errors.mockRestore();
        logs.mockRestore();
      }
    },
  );

  it("a recovery write cut off after the fence armed stops the tick with the shutdown line", async () => {
    db.user.findMany.mockResolvedValue([row("a"), row("b")]);
    const complete = vi.fn(async () => {
      throw Object.assign(new Error("busy"), { code: "P2028" });
    });
    db.$executeRaw.mockImplementationOnce(async () => {
      armDbShutdownFence();
      throw Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "57014",
      });
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(sweepPendingUserDeletions({ prisma, now: NOW, complete })).resolves.toEqual({
        deleted: 0,
        abandoned: 0,
        failed: 1,
      });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(errors).not.toHaveBeenCalledWith(
        "[auth] user deletion sweep could not record the outcome:",
        expect.anything(),
      );
      expect(logs).toHaveBeenCalledWith(expect.stringContaining("stopped by shutdown"));
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  it("starts the deletion listeners without awaiting them, and logs their rejection", async () => {
    db.user.findMany.mockResolvedValue([row("a"), row("b")]);
    const complete = vi.fn(async () => true);
    let rejectFirst!: (error: Error) => void;
    const started: string[] = [];
    // The first listener never settles on its own: awaiting it would hang the
    // tick (and the shutdown join behind it).
    const notify = vi.fn((userId: string) => {
      started.push(userId);
      if (userId === "a")
        return new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      return Promise.resolve();
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      sweepPendingUserDeletions({ prisma, now: NOW, complete, notify }),
    ).resolves.toEqual({
      deleted: 2,
      abandoned: 0,
      failed: 0,
    });
    // Each listener was started (its synchronous part ran) before the next user.
    expect(started).toEqual(["a", "b"]);
    rejectFirst(new TypeError("listener"));
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith("[auth] user deletion listener failed", "TypeError"),
    );
    errors.mockRestore();
  });
});

describe("startUserDeletionSweep stop (SWEEPER-STOP)", () => {
  afterEach(() => vi.useRealTimers());

  it("stop sets the flag the tick in flight sees, joins that tick, and starts no new one", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const seen: Array<() => boolean> = [];
    const empty: UserDeletionSweepResult = { deleted: 0, abandoned: 0, failed: 0 };
    const sweep = vi.fn(async (options?: { shouldStop?: () => boolean }) => {
      if (options?.shouldStop) seen.push(options.shouldStop);
      if (sweep.mock.calls.length === 1) await finished;
      return empty;
    });
    const stop = startUserDeletionSweep({ prisma, intervalMs: 1_000, sweep });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(seen[0]?.()).toBe(false);

    let joined = false;
    const stopping = stop().then(() => {
      joined = true;
    });
    // The in-flight tick now sees the stop flag, and stop waits for it.
    expect(seen[0]?.()).toBe(true);
    await Promise.resolve();
    expect(joined).toBe(false);
    finish();
    await stopping;
    expect(joined).toBe(true);

    // No tick after stop.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("runs every tick on the client it was started with", async () => {
    const empty: UserDeletionSweepResult = { deleted: 0, abandoned: 0, failed: 0 };
    const sweep = vi.fn(async (_options: { prisma: SweepClient }) => empty);
    const stop = startUserDeletionSweep({ prisma, intervalMs: 60_000, sweep });
    await stop();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep.mock.calls[0]?.[0].prisma).toBe(prisma);
  });

  it("hands every tick the same queue position, starting from the oldest (G2-01)", async () => {
    vi.useFakeTimers();
    const empty: UserDeletionSweepResult = { deleted: 0, abandoned: 0, failed: 0 };
    const queues: unknown[] = [];
    const seen: unknown[] = [];
    const sweep = vi.fn(async (options: { queue?: { after?: unknown } }) => {
      queues.push(options.queue);
      seen.push(options.queue?.after);
      if (options.queue) options.queue.after = { tick: queues.length };
      return empty;
    });
    const stop = startUserDeletionSweep({ prisma, intervalMs: 1_000, sweep });
    try {
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      await stop();
    }
    expect(queues.length).toBeGreaterThanOrEqual(2);
    expect(queues[0]).toBeDefined();
    expect(new Set(queues).size).toBe(1);
    // The first tick starts from the oldest; each later one sees the
    // position the previous one left.
    expect(seen).toEqual(queues.map((_, index) => (index === 0 ? undefined : { tick: index })));
  });

  // F2-07d: a tick that fails outright (its queue read could not connect)
  // deletes nobody; after a few in a row the log escalates, and one good tick
  // resets the count.
  it("escalates the log after consecutive failed ticks and resets on success", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const empty: UserDeletionSweepResult = { deleted: 0, abandoned: 0, failed: 0 };
    const outcomes = [
      ...Array.from({ length: USER_DELETION_SWEEP_FAILED_TICKS_ESCALATION }, () => "fail"),
      "ok",
      "fail",
    ];
    const sweep = vi.fn(async () => {
      if (outcomes[sweep.mock.calls.length - 1] === "fail") throw new Error("connect timeout");
      return empty;
    });
    const alerts = () =>
      errors.mock.calls.filter((call) => String(call[0]).includes("ALERT")).length;
    const stop = startUserDeletionSweep({ prisma, intervalMs: 1_000, sweep });
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (let tick = 1; tick < USER_DELETION_SWEEP_FAILED_TICKS_ESCALATION; tick += 1) {
        // Failures below the threshold log the plain line.
        expect(alerts()).toBe(0);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(sweep).toHaveBeenCalledTimes(USER_DELETION_SWEEP_FAILED_TICKS_ESCALATION);
      // The escalation-th consecutive failure is the first alert.
      expect(alerts()).toBe(1);
      expect(errors.mock.calls.at(-1)?.[0]).toContain(
        `failed ${USER_DELETION_SWEEP_FAILED_TICKS_ESCALATION} consecutive ticks`,
      );
      await vi.advanceTimersByTimeAsync(1_000); // ok: resets
      await vi.advanceTimersByTimeAsync(1_000); // one failure again: no alert
      expect(sweep).toHaveBeenCalledTimes(USER_DELETION_SWEEP_FAILED_TICKS_ESCALATION + 2);
      expect(alerts()).toBe(1);
      expect(errors.mock.calls.at(-1)?.[0]).toBe("[auth] user deletion sweep failed:");
    } finally {
      await stop();
      errors.mockRestore();
    }
  });

  // F2-07: a tick the shutdown fence stopped (its queue read refused) is not
  // a failed tick: no error-level log and no step toward the escalation.
  it("does not count a tick stopped by the shutdown fence toward the escalation", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sweep = vi.fn(async (): Promise<UserDeletionSweepResult> => {
      armDbShutdownFence();
      throw new Error("SQL dispatch refused");
    });
    const stop = startUserDeletionSweep({ prisma, intervalMs: 1_000, sweep });
    try {
      for (let tick = 0; tick < USER_DELETION_SWEEP_FAILED_TICKS_ESCALATION + 1; tick += 1)
        await vi.advanceTimersByTimeAsync(tick === 0 ? 0 : 1_000);
      expect(sweep).toHaveBeenCalledTimes(USER_DELETION_SWEEP_FAILED_TICKS_ESCALATION + 1);
      expect(errors).not.toHaveBeenCalled();
      expect(logs).toHaveBeenCalledWith(expect.stringContaining("stopped by shutdown"));
      // The count did not advance: once the fence is gone, a single failure
      // logs the plain line, not the alert.
      disarmDbShutdownFence();
      sweep.mockImplementation(async () => {
        throw new Error("connect timeout");
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(errors.mock.calls.map((call) => call[0])).toEqual([
        "[auth] user deletion sweep failed:",
      ]);
    } finally {
      disarmDbShutdownFence();
      await stop();
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  it("a stopped sweep can be started again (a fresh instance)", async () => {
    const empty: UserDeletionSweepResult = { deleted: 0, abandoned: 0, failed: 0 };
    const sweep = vi.fn(async () => empty);
    const stop = startUserDeletionSweep({ prisma, intervalMs: 60_000, sweep });
    await stop();
    const again = startUserDeletionSweep({ prisma, intervalMs: 60_000, sweep });
    expect(again).not.toBe(stop);
    await again();
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});

// F2-07 (design e): shutdown waits on the sweep for at most the join
// deadline plus the disconnect deadline, whatever the database does; past
// the join deadline the pool is quarantined. The executed versions against
// PostgreSQL (a COMMIT stalled on synchronous replication, a healthy join
// that keeps its warm connection) are in
// packages/api/src/lib/parent-deletion.postgres.integration.test.ts.
describe("shutDownUserDeletionSweep", () => {
  type Handle = Parameters<typeof shutDownUserDeletionSweep>[0]["client"];
  function handle(disconnect: () => Promise<void>) {
    const events: string[] = [];
    const quarantine = vi.fn(() => {
      events.push("quarantine");
      return 1;
    });
    const $disconnect = vi.fn(async () => {
      events.push("disconnect");
      await disconnect();
    });
    const client = { prisma: { $disconnect }, quarantine } as unknown as Handle;
    return { client, quarantine, $disconnect, events };
  }
  const never = () => new Promise<void>(() => {});

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a join that settles in time disconnects gracefully and never quarantines", async () => {
    const h = handle(async () => undefined);
    const warn = vi.fn();
    const done = shutDownUserDeletionSweep({ stopped: async () => {}, client: h.client, warn });
    await expect(done).resolves.toEqual({ joined: true, quarantined: null, disconnected: true });
    expect(h.quarantine).not.toHaveBeenCalled();
    expect(h.events).toEqual(["disconnect"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a join past its deadline quarantines, then disconnects: at most join + disconnect deadlines", async () => {
    const h = handle(async () => undefined);
    const warn = vi.fn();
    let settled = false;
    const done = shutDownUserDeletionSweep({ stopped: never, client: h.client, warn }).then(
      (outcome) => {
        settled = true;
        return outcome;
      },
    );
    await vi.advanceTimersByTimeAsync(USER_DELETION_SWEEP_JOIN_TIMEOUT_MS - 1);
    expect(h.quarantine).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual({ joined: false, quarantined: 1, disconnected: true });
    // Quarantine strictly before the disconnect.
    expect(h.events).toEqual(["quarantine", "disconnect"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("user deletion sweep join"));
  });

  it("a disconnect that hangs is cut off at its deadline and quarantines", async () => {
    const h = handle(never);
    let settled = false;
    const done = shutDownUserDeletionSweep({
      stopped: never,
      client: h.client,
      warn: () => undefined,
    }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(
      USER_DELETION_SWEEP_JOIN_TIMEOUT_MS + USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS - 1,
    );
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual({ joined: false, quarantined: 2, disconnected: false });
    expect(h.events).toEqual(["quarantine", "disconnect", "quarantine"]);
  });

  it("a healthy join with a hanging disconnect still returns by the disconnect deadline", async () => {
    const h = handle(never);
    const done = shutDownUserDeletionSweep({
      stopped: async () => {},
      client: h.client,
      warn: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS);
    await expect(done).resolves.toEqual({ joined: true, quarantined: 1, disconnected: false });
    expect(h.events).toEqual(["disconnect", "quarantine"]);
  });
});

// F2-07 (design A): every statement of a sweep tick must run on the client the
// sweep was given (the statement-bounded sweep client), so no module on the
// sweep path may reach for the shared client. Every function on the path takes
// its client as a parameter; this guards against a later import of the shared
// client sneaking a statement past the bound.
describe("sweep path client routing", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const dbPackage = join(repoRoot, "packages/db");
  const sharedClientModule = join(dbPackage, "src/index.ts");
  // Roots of the sweep path; everything they import from the db package or
  // by relative path is followed transitively.
  const sweepPathRoots = [
    "apps/server/src/user-deletion-sweep.ts",
    "packages/db/src/parent-deletion.ts",
    "packages/db/src/parent-deletion-residual.ts",
    "packages/db/src/capacity-lock-order.ts",
    "packages/db/src/usage-rollup-requester-drain.ts",
  ].map((path) => join(repoRoot, path));
  const dbExports = (
    JSON.parse(readFileSync(join(dbPackage, "package.json"), "utf8")) as {
      exports: Record<string, { default: string }>;
    }
  ).exports;

  // Every module specifier of a source: static imports and re-exports (type
  // imports included, conservatively), side-effect imports, dynamic imports
  // and require.
  function specifiers(source: string): string[] {
    const found: string[] = [];
    const pattern =
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
    for (const match of source.matchAll(pattern)) if (match[1]) found.push(match[1]);
    return found;
  }

  type Resolved = { kind: "shared" } | { kind: "follow"; path: string } | { kind: "skip" };

  /**
   * Resolves a specifier the way the workspace does: `@ws-model-proxy/db`
   * (the package root) is the shared client; its subpath exports map to their
   * files; a relative specifier resolves with or without an extension, or to
   * a directory's index. Anything resolving to packages/db/src/index.ts is the
   * shared client whatever the spelling (`../index`, `./index.js`,
   * `../../packages/db/src/index`, `.`). Other packages (node:, @prisma, and
   * `@ws-model-proxy/auth/user-deletion-listeners`, the documented listener
   * exception whose status writes run on the shared client outside the join)
   * are not followed. The generated Prisma client holds no instance.
   */
  function resolve(
    specifier: string,
    importer: string,
    exists: (path: string) => boolean,
  ): Resolved {
    if (specifier === "@ws-model-proxy/db") return { kind: "shared" };
    if (specifier.startsWith("@ws-model-proxy/db/")) {
      const target = dbExports[`./${specifier.slice("@ws-model-proxy/db/".length)}`]?.default;
      if (!target) throw new Error(`unknown db export ${specifier}`);
      const path = join(dbPackage, target);
      return path === sharedClientModule ? { kind: "shared" } : { kind: "follow", path };
    }
    if (!specifier.startsWith(".")) return { kind: "skip" };
    const base = join(dirname(importer), specifier);
    const stem = base.replace(/\.(?:[cm]?js|tsx?)$/, "");
    const candidates = [
      base,
      `${stem}.ts`,
      `${stem}.tsx`,
      join(base, "index.ts"),
      join(stem, "index.ts"),
    ];
    if (candidates.includes(sharedClientModule)) return { kind: "shared" };
    if (base.startsWith(join(dbPackage, "prisma/generated"))) return { kind: "skip" };
    const path = candidates.find((candidate) => candidate !== base && exists(candidate));
    if (!path) throw new Error(`cannot resolve ${specifier} from ${importer}`);
    return { kind: "follow", path };
  }

  /** Import chains from `roots` that reach the shared client. */
  function sharedClientChains(
    roots: string[],
    read: (path: string) => string,
    exists: (path: string) => boolean,
  ): string[] {
    const chains: string[] = [];
    const seen = new Set<string>();
    const visit = (path: string, chain: string[]) => {
      if (seen.has(path)) return;
      seen.add(path);
      for (const specifier of specifiers(read(path))) {
        const resolved = resolve(specifier, path, exists);
        const step = [...chain, `${relative(repoRoot, path)} -> ${specifier}`];
        if (resolved.kind === "shared") chains.push(step.join(" | "));
        else if (resolved.kind === "follow") visit(resolved.path, step);
      }
    };
    for (const root of roots) visit(root, []);
    return chains;
  }

  it("no module on the sweep path imports the shared client, directly or transitively", () => {
    const visited: string[] = [];
    const chains = sharedClientChains(
      sweepPathRoots,
      (path) => {
        visited.push(relative(repoRoot, path));
        return readFileSync(path, "utf8");
      },
      existsSync,
    );
    expect(chains).toEqual([]);
    // The walk really followed the path (client factory and fence included).
    expect(visited).toEqual(
      expect.arrayContaining([
        "packages/db/src/client-factory.ts",
        "packages/db/src/shutdown-fence.ts",
        "packages/db/src/parent-deletion.ts",
      ]),
    );
  });

  it("the guard recognizes every spelling of a shared-client import, and follows helpers", () => {
    const sweepFile = join(repoRoot, "apps/server/src/user-deletion-sweep.ts");
    const dbFile = join(repoRoot, "packages/db/src/parent-deletion.ts");
    const nestedDbFile = join(repoRoot, "packages/db/src/nested/helper.ts");
    const shared = (specifier: string, importer: string) =>
      resolve(specifier, importer, () => true).kind === "shared";
    expect(shared("@ws-model-proxy/db", sweepFile)).toBe(true);
    expect(shared("../../../packages/db/src/index", sweepFile)).toBe(true);
    expect(shared("../../../packages/db/src/index.js", sweepFile)).toBe(true);
    expect(shared("../../../packages/db/src", sweepFile)).toBe(true);
    for (const specifier of [".", "./", "./index", "./index.js", "./index.ts"]) {
      expect(shared(specifier, dbFile)).toBe(true);
    }
    expect(shared("..", nestedDbFile)).toBe(true);
    expect(shared("../index", nestedDbFile)).toBe(true);
    expect(shared("../index.js", nestedDbFile)).toBe(true);
    // Not the shared client: another module, a subpath export, the generated
    // client, and the documented listener exception.
    expect(shared("./shutdown-fence", dbFile)).toBe(false);
    expect(shared("@ws-model-proxy/db/parent-deletion", sweepFile)).toBe(false);
    expect(shared("../prisma/generated/client", dbFile)).toBe(false);
    expect(shared("@ws-model-proxy/auth/user-deletion-listeners", sweepFile)).toBe(false);

    for (const [source, expected] of [
      ['import prisma from "@ws-model-proxy/db";', ["@ws-model-proxy/db"]],
      ['export { default } from "./index.js";', ["./index.js"]],
      ['const m = await import("../index");', ["../index"]],
      ['import "./index";', ["./index"]],
      ['import type { PrismaClient } from "@ws-model-proxy/db";', ["@ws-model-proxy/db"]],
    ] as const) {
      expect(specifiers(source)).toEqual(expected);
    }

    // Transitive: the root imports a helper that imports the shared client.
    const files: Record<string, string> = {
      [sweepFile]: [
        'import { notifyUserDeleted } from "@ws-model-proxy/auth/user-deletion-listeners";',
        'import { helper } from "./sweep-helper.js";',
      ].join("\n"),
      [join(repoRoot, "apps/server/src/sweep-helper.ts")]:
        'import { run } from "../../../packages/db/src/deep-helper";',
      [join(repoRoot, "packages/db/src/deep-helper.ts")]: 'import prisma from "./index.js";',
    };
    const chains = sharedClientChains(
      [sweepFile],
      (path) => files[path] ?? "",
      (path) => path in files,
    );
    expect(chains).toEqual([
      [
        "apps/server/src/user-deletion-sweep.ts -> ./sweep-helper.js",
        "apps/server/src/sweep-helper.ts -> ../../../packages/db/src/deep-helper",
        "packages/db/src/deep-helper.ts -> ./index.js",
      ].join(" | "),
    ]);
  });
});
