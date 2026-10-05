import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

/**
 * The agent audit log on real PostgreSQL: column defaults, owner-scoped
 * keyset listing that is stable under inserts, and the whole-user delete
 * (rows of that user go, another user's stay; a device delete keeps rows).
 */
const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

integration("cli agent action events with real PostgreSQL", () => {
  let prisma: typeof import("@ws-model-proxy/db").default;
  // Graph rows (user, device) are written through the fixture client, which the
  // graph-write fence triggers accept; the code under test uses `prisma`.
  let fixture: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client").createFixturePrismaClient
  >;
  let router: typeof import("./cli-agent-activity").cliAgentActivityRouter;
  let deletion: typeof import("@ws-model-proxy/db/parent-deletion");
  let sweeps: typeof import("@ws-model-proxy/db/hot-path-sweeps");
  const users: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [db, routerModule, deletionModule, sweepsModule] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("./cli-agent-activity"),
      import("@ws-model-proxy/db/parent-deletion"),
      import("@ws-model-proxy/db/hot-path-sweeps"),
    ]);
    prisma = db.default;
    fixture = (await import("@ws-model-proxy/db/test-fixture-client")).createFixturePrismaClient(
      databaseUrl,
    );
    router = routerModule.cliAgentActivityRouter;
    deletion = deletionModule;
    sweeps = sweepsModule;
  });

  afterAll(async () => {
    if (!prisma) return;
    for (const id of users) {
      await prisma.cliAgentActionEvent.deleteMany({ where: { userId: id } });
      await fixture.user.deleteMany({ where: { id } });
    }
    await fixture.$disconnect();
  });

  async function user(label: string) {
    const suffix = crypto.randomUUID();
    const row = await fixture.user.create({
      data: {
        name: `Audit ${label}`,
        email: `audit-${label}-${suffix}@example.test`,
        slug: `audit-${label}-${suffix}`,
      },
    });
    users.push(row.id);
    return row;
  }

  function client(owner: { id: string }) {
    const session = {
      user: owner,
      session: {
        id: `session-${crypto.randomUUID()}`,
        userId: owner.id,
        token: `token-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as unknown as Session;
    return createRouterClient(router, { context: { session } as Context });
  }

  const base = {
    kind: "command" as const,
    path: "hmac-sha256:abc pwd",
    outcome: "completed" as const,
    startedAt: new Date(),
  };

  it("fills the column defaults and keeps every optional column null", async () => {
    const owner = await user("defaults");
    const row = await prisma.cliAgentActionEvent.create({
      data: { userId: owner.id, cliDeviceId: "dev", ...base },
    });
    expect(row.id).toMatch(/^[a-z0-9]{20,}$/);
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(row).toMatchObject({
      mcpTokenId: null,
      etagBefore: null,
      etagAfter: null,
      bytes: null,
      reason: null,
      finishedAt: null,
    });
  });

  it("has no foreign keys and the documented indexes", async () => {
    const fks = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_constraint
       WHERE conrelid = 'cli_agent_action_event'::regclass AND contype = 'f'`;
    expect(Number(fks[0]?.n)).toBe(0);
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'cli_agent_action_event'`;
    const defs = indexes.map((row) => row.indexdef).join("\n");
    expect(defs).toContain('("userId", "createdAt")');
    expect(defs).toContain('("cliDeviceId", "createdAt")');
    expect(defs).toContain('("createdAt")');
  });

  it("lists only the caller's rows, filters by device, and pages stably under inserts", async () => {
    const owner = await user("list");
    const other = await user("other");
    const t0 = Date.UTC(2026, 0, 1);
    // Two rows share one createdAt: the id breaks the tie.
    const stamps = [0, 1, 1, 2, 3, 4];
    for (const [index, second] of stamps.entries())
      await prisma.cliAgentActionEvent.create({
        data: {
          userId: owner.id,
          cliDeviceId: index % 2 === 0 ? "dev-a" : "dev-b",
          ...base,
          createdAt: new Date(t0 + second * 1000),
        },
      });
    await prisma.cliAgentActionEvent.create({
      data: { userId: other.id, cliDeviceId: "dev-a", ...base },
    });

    const mine = client(owner);
    const seen: string[] = [];
    let cursor: string | undefined;
    let inserted = false;
    for (;;) {
      const page = await mine.list({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.events.map((event) => event.id));
      if (!inserted) {
        // A newer row arrives between pages: it must not shift or repeat the rest.
        await prisma.cliAgentActionEvent.create({
          data: {
            userId: owner.id,
            cliDeviceId: "dev-a",
            ...base,
            createdAt: new Date(t0 + 99_000),
          },
        });
        inserted = true;
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    const all = await mine.list({ limit: 100 });
    expect(all.events.every((event) => event.cliDeviceId.startsWith("dev-"))).toBe(true);
    expect(all.events).toHaveLength(7);

    const onlyA = await mine.list({ cliDeviceId: "dev-a", limit: 100 });
    expect(onlyA.events.every((event) => event.cliDeviceId === "dev-a")).toBe(true);
    // Another user's device id (or one that has rows only for someone else) returns nothing.
    const none = await client(await user("stranger")).list({ cliDeviceId: "dev-a" });
    expect(none.events).toEqual([]);
  });

  it("a whole-user delete removes that user's rows only, in batches, with no FK error", async () => {
    const doomed = await user("doomed");
    const kept = await user("kept");
    for (let i = 0; i < 7; i += 1) {
      await prisma.cliAgentActionEvent.create({
        data: { userId: doomed.id, cliDeviceId: "dev", ...base },
      });
    }
    await prisma.cliAgentActionEvent.create({
      data: { userId: kept.id, cliDeviceId: "dev", ...base },
    });
    await expect(deletion.deleteUserDurably(prisma, doomed.id, { batch: 3 })).resolves.toBe(
      "deleted",
    );
    expect(await prisma.cliAgentActionEvent.count({ where: { userId: doomed.id } })).toBe(0);
    expect(await prisma.cliAgentActionEvent.count({ where: { userId: kept.id } })).toBe(1);
  });

  it("purges a row written after the user delete, and keeps the entry while a skipped row is locked", async () => {
    const doomed = await user("late");
    // A row another transaction holds when the drain runs is skipped (SKIP LOCKED).
    const locked = await prisma.cliAgentActionEvent.create({
      data: { userId: doomed.id, cliDeviceId: "dev", ...base },
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locking: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      locking = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM cli_agent_action_event WHERE id = ${locked.id} FOR UPDATE`;
        locking();
        await released;
      },
      { timeout: 30_000 },
    );
    await held;
    await expect(deletion.deleteUserDurably(prisma, doomed.id, { batch: 3 })).resolves.toBe(
      "deleted",
    );
    // The user is gone, but the skipped (locked) row survived the drain.
    expect(await prisma.user.count({ where: { id: doomed.id } })).toBe(0);
    expect(await prisma.cliAgentActionEvent.count({ where: { userId: doomed.id } })).toBe(1);
    // A late event (queued write, other replica) lands after the delete.
    await prisma.cliAgentActionEvent.create({
      data: { userId: doomed.id, cliDeviceId: "dev", ...base },
    });
    // While the row is still locked the purge takes the late row but reports
    // the user's history as remaining, so the queue entry is not retired.
    const busy = await sweeps.purgeDeletedUserHistory(prisma, doomed.id, { batch: 3 });
    expect(busy.remaining).toBe(true);
    expect(await prisma.cliAgentActionEvent.count({ where: { userId: doomed.id } })).toBe(1);
    release();
    await holder;
    const done = await sweeps.purgeDeletedUserHistory(prisma, doomed.id, { batch: 3 });
    expect(done.remaining).toBe(false);
    expect(await prisma.cliAgentActionEvent.count({ where: { userId: doomed.id } })).toBe(0);
  }, 60_000);

  it("keeps the rows when a device is deleted (owner history until retention)", async () => {
    const owner = await user("device");
    const device = await fixture.cliDevice.create({
      data: { userId: owner.id, slug: `dev-${crypto.randomUUID().slice(0, 8)}` },
    });
    await prisma.cliAgentActionEvent.create({
      data: { userId: owner.id, cliDeviceId: device.id, ...base },
    });
    await fixture.cliDevice.delete({ where: { id: device.id } });
    expect(await prisma.cliAgentActionEvent.count({ where: { cliDeviceId: device.id } })).toBe(1);
  });
});

/**
 * The deployment operator audit log and the interactive step state on real
 * PostgreSQL: the audit table is a plain-id, append-only, user-drained log
 * like the agent audit log above, and the step/instance operator columns
 * follow the AWAITING_OPERATOR transition rules of schema-hardening.sql.
 */
integration("deployment operator events and step state with real PostgreSQL", () => {
  let prisma: typeof import("@ws-model-proxy/db").default;
  let fixture: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client").createFixturePrismaClient
  >;
  let deletion: typeof import("@ws-model-proxy/db/parent-deletion");
  let sweeps: typeof import("@ws-model-proxy/db/hot-path-sweeps");
  const users: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [db, deletionModule, sweepsModule] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/parent-deletion"),
      import("@ws-model-proxy/db/hot-path-sweeps"),
    ]);
    prisma = db.default;
    fixture = (await import("@ws-model-proxy/db/test-fixture-client")).createFixturePrismaClient(
      databaseUrl,
    );
    deletion = deletionModule;
    sweeps = sweepsModule;
  });

  afterAll(async () => {
    if (!prisma) return;
    for (const id of users) {
      await prisma.deploymentOperatorEvent.deleteMany({ where: { userId: id } });
      await fixture.user.deleteMany({ where: { id } });
    }
    await fixture.$disconnect();
  });

  async function user(label: string) {
    const suffix = crypto.randomUUID();
    const row = await fixture.user.create({
      data: {
        name: `Operator ${label}`,
        email: `operator-${label}-${suffix}@example.test`,
        slug: `operator-${label}-${suffix}`,
      },
    });
    users.push(row.id);
    return row;
  }

  function event(userId: string, overrides: Record<string, unknown> = {}) {
    return {
      userId,
      instanceId: "instance-x",
      stepId: "step-x",
      cliDeviceId: "dev",
      rank: 0,
      action: "start",
      outcome: "opened" as const,
      ...overrides,
    };
  }

  /** One instance of `owner` with an interactive start step and a plain start step. */
  async function deployment(owner: { id: string }) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const device = await fixture.cliDevice.create({
      data: { userId: owner.id, slug: `op-${suffix}` },
    });
    const pool = await fixture.modelPool.create({
      data: { userId: owner.id, slug: `op-${suffix}`, name: "Operator pool" },
    });
    const config = await fixture.deploymentConfig.create({
      data: { userId: owner.id, poolId: pool.id, slug: `op-${suffix}`, name: "Operator" },
    });
    const revision = await fixture.deploymentConfigRevision.create({
      data: {
        configId: config.id,
        revision: 1,
        editorId: owner.id,
        editorKind: "USER",
        contentHash: "hash",
        spec: {},
      },
    });
    const plan = await fixture.deploymentPlan.create({
      data: {
        userId: owner.id,
        requesterId: owner.id,
        requesterKind: "USER",
        expiresAt: new Date(Date.now() + 3_600_000),
        state: "APPLIED",
        fingerprint: "fp",
        contents: {},
      },
    });
    const run = await fixture.deploymentRun.create({ data: { planId: plan.id } });
    const instance = await fixture.deploymentInstance.create({
      data: {
        userId: owner.id,
        configId: config.id,
        revisionId: revision.id,
        runId: run.id,
        variantKey: "default",
        endpointSlug: `op-${suffix}`,
        startedBy: "USER",
      },
    });
    const base = {
      runId: run.id,
      instanceId: instance.id,
      cliDeviceId: device.id,
      rank: 0,
      phase: "start",
      intentHash: "h",
    };
    let sequence = 0;
    const stepOf = (intent: Record<string, unknown>, phase = "start") =>
      fixture.deploymentStep.create({
        data: {
          ...base,
          phase,
          sequence: sequence++,
          intent: { type: "deployment.job", ...intent },
        },
      });
    const interactive = await stepOf({ action: "start", interactive: true });
    const plain = await stepOf({ action: "start" });
    return { instance, interactive, plain, stepOf };
  }

  it("has no foreign keys, the documented indexes, and refuses updates", async () => {
    const fks = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_constraint
       WHERE conrelid = 'deployment_operator_event'::regclass AND contype = 'f'`;
    expect(Number(fks[0]?.n)).toBe(0);
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'deployment_operator_event'`;
    const defs = indexes.map((row) => row.indexdef).join("\n");
    expect(defs).toContain('("userId", "createdAt")');
    expect(defs).toContain('("instanceId", "createdAt")');
    expect(defs).toContain('("createdAt")');

    const owner = await user("append");
    const row = await prisma.deploymentOperatorEvent.create({
      data: event(owner.id, { outcome: "failed", exitCode: 2 }),
    });
    expect(row).toMatchObject({ outcome: "failed", exitCode: 2 });
    await expect(
      prisma.deploymentOperatorEvent.update({ where: { id: row.id }, data: { exitCode: 0 } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.deploymentOperatorEvent.create({ data: event(owner.id, { action: "health" }) }),
    ).rejects.toThrow();
    await expect(
      prisma.deploymentOperatorEvent.create({ data: event(owner.id, { exitCode: 1 }) }),
    ).rejects.toThrow();
  });

  it("a whole-user delete drains the user's operator events and the purge takes late ones", async () => {
    const doomed = await user("op-doomed");
    const kept = await user("op-kept");
    for (let i = 0; i < 5; i += 1)
      await prisma.deploymentOperatorEvent.create({ data: event(doomed.id) });
    await prisma.deploymentOperatorEvent.create({ data: event(kept.id) });
    await expect(deletion.deleteUserDurably(prisma, doomed.id, { batch: 2 })).resolves.toBe(
      "deleted",
    );
    expect(await prisma.deploymentOperatorEvent.count({ where: { userId: doomed.id } })).toBe(0);
    expect(await prisma.deploymentOperatorEvent.count({ where: { userId: kept.id } })).toBe(1);
    // A late event (a queued write) lands after the delete; the purge removes it.
    await prisma.deploymentOperatorEvent.create({ data: event(doomed.id) });
    const purge = await sweeps.purgeDeletedUserHistory(prisma, doomed.id, { batch: 2 });
    expect(purge.remaining).toBe(false);
    expect(await prisma.deploymentOperatorEvent.count({ where: { userId: doomed.id } })).toBe(0);
  });

  type StepData = Parameters<typeof fixture.deploymentStep.update>[0]["data"];
  const updateStep = (id: string, data: StepData) =>
    fixture.deploymentStep.update({ where: { id }, data });
  const minutes = (n: number) => new Date(Date.now() + n * 60_000);
  const awaiting = (terminal: string): StepData => ({
    state: "AWAITING_OPERATOR",
    deadline: null,
    operatorTerminalId: terminal,
    operatorSince: new Date(),
  });
  /** Dispatch with a terminal id, then the confirm screen is drawn. */
  async function open(id: string, terminal = "term-1") {
    await updateStep(id, { state: "RUNNING", deadline: minutes(1), operatorTerminalId: terminal });
    return updateStep(id, {
      state: "AWAITING_OPERATOR",
      deadline: null,
      operatorSince: new Date(),
    });
  }
  const accept = (id: string) =>
    updateStep(id, { state: "RUNNING", operatorAcceptedAt: new Date(), deadline: minutes(15) });

  it("allows AWAITING_OPERATOR only from RUNNING and out to RUNNING, PENDING, FAILED or an accepted SUCCEEDED", async () => {
    const owner = await user("steps");
    const { interactive, plain, stepOf } = await deployment(owner);

    // PENDING -> AWAITING_OPERATOR is refused; RUNNING -> AWAITING_OPERATOR works.
    await expect(updateStep(interactive.id, awaiting("term-1"))).rejects.toThrow(
      /only from RUNNING/,
    );
    await updateStep(interactive.id, { state: "RUNNING", deadline: minutes(1) });
    await updateStep(interactive.id, awaiting("term-1"));
    // A non-interactive step (missing flag or explicit false) never carries operator state.
    const explicitFalse = await stepOf({ action: "start", interactive: false });
    for (const id of [plain.id, explicitFalse.id]) {
      await updateStep(id, { state: "RUNNING", deadline: minutes(1) });
      await expect(updateStep(id, awaiting("term-p"))).rejects.toThrow(/operator_shape/);
    }

    // No unaccepted success, no new terminal while awaiting.
    await expect(updateStep(interactive.id, { state: "SUCCEEDED" })).rejects.toThrow(
      /only an accepted operator command can succeed/,
    );
    await expect(updateStep(interactive.id, { operatorTerminalId: "term-2" })).rejects.toThrow(
      /can only close/,
    );
    // Accept needs an acceptance time on the open terminal.
    await expect(updateStep(interactive.id, { state: "RUNNING" })).rejects.toThrow(
      /open operator terminal/,
    );
    await accept(interactive.id);
    // A retry in the same terminal keeps its open time.
    await expect(
      updateStep(interactive.id, {
        state: "AWAITING_OPERATOR",
        deadline: null,
        operatorSince: minutes(1),
      }),
    ).rejects.toThrow(/keeps its open time/);
    // Closed after a failed run; a closed terminal cannot be accepted.
    await updateStep(interactive.id, {
      state: "AWAITING_OPERATOR",
      deadline: null,
      operatorTerminalId: null,
      operatorLastExit: 1,
    });
    await expect(
      updateStep(interactive.id, { state: "RUNNING", operatorAcceptedAt: new Date() }),
    ).rejects.toThrow(/open operator terminal/);
    // Reopen through PENDING: the trigger clears every operator column.
    const reopened = await updateStep(interactive.id, { state: "PENDING" });
    expect(reopened).toMatchObject({
      operatorTerminalId: null,
      operatorSince: null,
      operatorAcceptedAt: null,
      operatorLastExit: null,
    });
    // A final result that overtook "operator running" settles with the acceptance.
    await open(interactive.id, "term-3");
    const settled = await updateStep(interactive.id, {
      state: "SUCCEEDED",
      operatorAcceptedAt: new Date(),
      operatorLastExit: 0,
    });
    expect(settled).toMatchObject({ state: "SUCCEEDED", operatorTerminalId: null });
    expect(settled.operatorSince).not.toBeNull();
    await expect(updateStep(interactive.id, awaiting("term-4"))).rejects.toThrow(
      /only from RUNNING/,
    );

    // prepare and after_join are interactive actions too.
    for (const intent of [
      { action: "prepare", interactive: true, phase: "prepare" },
      { action: "after_join", interactive: true, phase: "start" },
    ]) {
      const { phase, ...rest } = intent;
      const row = await stepOf(rest, phase);
      await open(row.id);
      await accept(row.id);
      await expect(updateStep(row.id, { state: "SUCCEEDED" })).resolves.toMatchObject({
        state: "SUCCEEDED",
        operatorTerminalId: null,
      });
    }
  });

  it("never lets leftover operator columns break the existing generic step writes", async () => {
    const owner = await user("sites");
    const { interactive } = await deployment(owner);
    // apps/server/src/deployments/reconciler.ts write shapes, which know nothing about
    // operator terminals, applied to a RUNNING interactive step carrying every column.
    const sites: Array<[string, StepData]> = [
      ["acceptResult:209", { state: "SUCCEEDED", leaseExpiresAt: null, errorCode: null }],
      ["acceptResult:209 failed", { state: "FAILED", leaseExpiresAt: null, errorCode: "x" }],
      ["result_lost:407", { state: "FAILED", errorCode: "result_lost", leaseExpiresAt: null }],
      ["stop reset:662", { state: "PENDING", ownerEpoch: null, leaseExpiresAt: null }],
      ["job_deadline:667/673/682", { state: "FAILED", errorCode: "job_deadline" }],
      ["undeliver:829", { state: "PENDING", ownerEpoch: null, leaseExpiresAt: null }],
    ];
    // Explicit contradictory values are refused, not silently dropped.
    await open(interactive.id, "term-explicit");
    await expect(
      updateStep(interactive.id, { state: "PENDING", operatorTerminalId: "term-new" }),
    ).rejects.toThrow(/operator_shape/);
    await expect(
      updateStep(interactive.id, { state: "FAILED", operatorTerminalId: "term-other" }),
    ).rejects.toThrow(/operator_shape/);
    for (const [label, data] of sites) {
      await updateStep(interactive.id, { state: "PENDING" });
      await open(interactive.id, "term-site");
      await accept(interactive.id);
      await updateStep(interactive.id, { operatorLastExit: 1 });
      const after = await updateStep(interactive.id, data);
      expect(after.operatorTerminalId, label).toBeNull();
      if (data.state === "PENDING") expect(after.operatorSince, label).toBeNull();
      else expect(after.operatorSince, label).not.toBeNull();
      if (data.state === "FAILED") {
        // Inventory adoption :357/:380 settles a FAILED step as SUCCEEDED.
        await expect(
          updateStep(interactive.id, { state: "SUCCEEDED", leaseExpiresAt: null, errorCode: null }),
        ).resolves.toMatchObject({ state: "SUCCEEDED" });
      }
    }
  });

  it("records an operator's accept for a banned owner but refuses a new dispatch", async () => {
    const owner = await user("banned");
    const { interactive, plain, stepOf } = await deployment(owner);
    const stop = await stepOf({ action: "stop", interactive: true }, "stop");
    await open(interactive.id);
    await open(stop.id);
    await fixture.user.update({ where: { id: owner.id }, data: { banned: true } });
    await expect(updateStep(plain.id, { state: "RUNNING", deadline: minutes(1) })).rejects.toThrow(
      /inactive owners cannot start deployment jobs/,
    );
    await expect(accept(interactive.id)).resolves.toMatchObject({ state: "RUNNING" });
    await expect(accept(stop.id)).resolves.toMatchObject({ state: "RUNNING" });
    await fixture.user.update({ where: { id: owner.id }, data: { banned: false } });
  });

  it("keeps needsOperator paired and clears RESTART when generic writers stop or start", async () => {
    const owner = await user("instance");
    const { instance } = await deployment(owner);
    const update = (data: Parameters<typeof fixture.deploymentInstance.update>[0]["data"]) =>
      fixture.deploymentInstance.update({ where: { id: instance.id }, data });
    await expect(update({ needsOperator: "STEP" })).rejects.toThrow(/operator_shape/);
    // An explicit lone timestamp, or RESTART written onto an instance that is not stopped
    // (e.g. still STOP_PENDING), fails; only a carried-over need is cleared.
    await expect(update({ needsOperatorSince: new Date() })).rejects.toThrow(/operator_shape/);
    await expect(
      update({
        observedState: "STOP_PENDING",
        needsOperator: "RESTART",
        needsOperatorSince: new Date(),
      }),
    ).rejects.toThrow(/operator_shape/);
    await update({ needsOperator: "STEP", needsOperatorSince: new Date() });
    await update({ observedState: "STOPPED", needsOperator: "RESTART" });
    // Maintenance's FAILED keeps it; the human stop (deployment-service.ts:656) clears it.
    await expect(update({ observedState: "FAILED" })).resolves.toMatchObject({
      needsOperator: "RESTART",
    });
    await expect(
      update({ desiredState: "STOPPED", observedState: "STOPPING" }),
    ).resolves.toMatchObject({ needsOperator: null, needsOperatorSince: null });
    await update({
      desiredState: "RUNNING",
      observedState: "STOPPED",
      needsOperator: "RESTART",
      needsOperatorSince: new Date(),
    });
    // The reconciler's start dispatch (reconciler.ts:796) clears it.
    await expect(
      update({ observedState: "STARTING", operatorRestartRequestedAt: new Date() }),
    ).resolves.toMatchObject({ needsOperator: null, needsOperatorSince: null });
    await update({ observedState: "STOPPED", desiredState: "STOPPED" });
  });
});
