import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

integration("device-code exchange with real PostgreSQL", () => {
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        access: typeof import("./cli-credential-access");
        deletion: typeof import("@ws-model-proxy/db/parent-deletion");
      }
    | undefined;
  let blocker: ReturnType<typeof import("@ws-model-proxy/db/client-factory").createPrismaClient>;
  let observer: ReturnType<typeof import("@ws-model-proxy/db/client-factory").createPrismaClient>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-at-least-thirty-two";
    process.env.BETTER_AUTH_URL = "https://proxy.example.test";
    const [db, dbFactory, access, deletion] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/client-factory"),
      import("./cli-credential-access"),
      import("@ws-model-proxy/db/parent-deletion"),
    ]);
    modules = { prisma: db.default, access, deletion };
    blocker = dbFactory.createPrismaClient(databaseUrl);
    observer = dbFactory.createPrismaClient(databaseUrl);
  });

  afterAll(async () => {
    // Fixtures use unique identities and are left in place, like the other
    // integration suites.
    await Promise.all([blocker?.$disconnect(), observer?.$disconnect()]);
  });

  function required() {
    if (!modules) throw new Error("modules unavailable");
    return modules;
  }

  async function createUser() {
    const suffix = crypto.randomUUID();
    return required().prisma.user.create({
      data: {
        name: "Device login integration",
        email: `device-login-${suffix}@example.test`,
        slug: `device-login-${suffix}`,
      },
    });
  }

  async function approvedCode(userId: string, slug: string) {
    const suffix = crypto.randomUUID();
    await required().prisma.deviceCode.create({
      data: {
        deviceCode: `device-${suffix}`,
        userCode: `USER-${suffix}`,
        userId,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        status: "approved",
        pollingInterval: 5000,
        clientId: "ws-model-proxy",
        scope: `cli-slug:${slug}`,
      },
    });
    return `device-${suffix}`;
  }

  /**
   * Holds a row lock on `table.id = id` until `operations` are all waiting on
   * a lock, so they contend instead of running one after the other.
   */
  async function contendBehindRowLock<T>(
    table: "device_code" | "cli_device",
    id: string,
    operations: Array<() => Promise<T>>,
  ): Promise<PromiseSettledResult<T>[]> {
    // Waiters are counted on either table: an operation queued behind another
    // one's device row waits there, not on `table`.
    let release: (() => void) | undefined;
    let reportLocked: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const blockerTransaction = blocker.$transaction(
      async (tx) => {
        if (table === "device_code") {
          await tx.$queryRaw`SELECT id FROM device_code WHERE id = ${id} FOR UPDATE`;
        } else {
          await tx.$queryRaw`SELECT id FROM cli_device WHERE id = ${id} FOR UPDATE`;
        }
        reportLocked?.();
        await released;
      },
      { timeout: 20_000 },
    );
    await locked;
    const outcomes = Promise.allSettled(operations.map((operation) => operation()));
    let waiters = 0;
    for (let attempt = 0; attempt < 500 && waiters < operations.length; attempt++) {
      const rows = await observer.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND (query ILIKE '%device_code%' OR query ILIKE '%cli_device%')
      `;
      waiters = Number(rows[0]?.count ?? 0n);
    }
    release?.();
    await blockerTransaction;
    if (waiters < operations.length) {
      throw new Error(`Expected ${operations.length} lock waiters on ${table}, saw ${waiters}.`);
    }
    return outcomes;
  }

  // Exchanges take the device row before the code row (the ordered user
  // delete's order), so the second redeemer may wait on either.
  it("mints once when two exchanges race for one approved code", async () => {
    const { prisma, access } = required();
    const user = await createUser();
    const deviceCode = await approvedCode(user.id, "race-once");
    const row = await prisma.deviceCode.findUniqueOrThrow({ where: { deviceCode } });

    const exchange = () =>
      access.mintCliDeviceCredentialFromApprovedDeviceCode({ deviceCode, cliSlug: "race-once" });
    const outcomes = await contendBehindRowLock("device_code", row.id, [exchange, exchange]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await prisma.cliDeviceCredential.count({ where: { userId: user.id, revokedAt: null } }),
    ).toBe(1);
    expect(await prisma.deviceCode.count({ where: { id: row.id } })).toBe(0);
  });

  it("reattaches a re-login, keeps the device, and revokes the old credential", async () => {
    const { prisma, access } = required();
    const user = await createUser();
    const first = await access.mintCliDeviceCredentialFromApprovedDeviceCode({
      deviceCode: await approvedCode(user.id, "desk-01"),
      cliSlug: "desk-01",
    });
    await prisma.cliDevice.update({
      where: { id: first.cliDeviceId },
      data: { name: "Work laptop", allowHumanTerminal: true, mcpCommandMode: "SUPERVISED" },
    });

    const second = await access.mintCliDeviceCredentialFromApprovedDeviceCode({
      deviceCode: await approvedCode(user.id, "desk-01"),
      cliSlug: "desk-01",
    });

    expect(second.cliDeviceId).toBe(first.cliDeviceId);
    expect(second.revoked).toEqual({ kind: "deviceCredential", ids: [first.credentialId] });
    expect(
      await prisma.cliDevice.findUniqueOrThrow({
        where: { id: first.cliDeviceId },
        select: { name: true, allowHumanTerminal: true, mcpCommandMode: true },
      }),
    ).toEqual({ name: "Work laptop", allowHumanTerminal: true, mcpCommandMode: "SUPERVISED" });
    const credentials = await prisma.cliDeviceCredential.findMany({
      where: { cliDeviceId: first.cliDeviceId },
      select: { id: true, revokedAt: true },
    });
    expect(credentials.filter((credential) => credential.revokedAt === null)).toEqual([
      { id: second.credentialId, revokedAt: null },
    ]);
    expect(await prisma.cliDevice.count({ where: { userId: user.id } })).toBe(1);
  });

  it("leaves one active credential when two re-logins of one device race", async () => {
    const { prisma, access } = required();
    const user = await createUser();
    const first = await access.mintCliDeviceCredentialFromApprovedDeviceCode({
      deviceCode: await approvedCode(user.id, "desk-02"),
      cliSlug: "desk-02",
    });
    const codes = [await approvedCode(user.id, "desk-02"), await approvedCode(user.id, "desk-02")];

    const outcomes = await contendBehindRowLock(
      "cli_device",
      first.cliDeviceId,
      codes.map(
        (deviceCode) => () =>
          access.mintCliDeviceCredentialFromApprovedDeviceCode({ deviceCode, cliSlug: "desk-02" }),
      ),
    );

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect(
      await prisma.cliDeviceCredential.count({
        where: { cliDeviceId: first.cliDeviceId, revokedAt: null },
      }),
    ).toBe(1);
  });

  it("lets two concurrent first logins of a new slug both finish; the later one wins", async () => {
    const { prisma, access } = required();
    const user = await createUser();
    const codes = [await approvedCode(user.id, "desk-03"), await approvedCode(user.id, "desk-03")];

    // An uncommitted row with the same (userId, slug) makes both upserts wait
    // on it; rolling it back lets them race for the insert.
    let release: (() => void) | undefined;
    let reportInserted: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      reportInserted = resolve;
    });
    const blockerTransaction = blocker
      .$transaction(
        async (tx) => {
          await tx.cliDevice.create({ data: { userId: user.id, slug: "desk-03" } });
          reportInserted?.();
          await released;
          throw new Error("roll back the blocking device row");
        },
        { timeout: 20_000 },
      )
      .catch(() => undefined);
    await inserted;
    const outcomes = Promise.allSettled(
      codes.map((deviceCode) =>
        access.mintCliDeviceCredentialFromApprovedDeviceCode({ deviceCode, cliSlug: "desk-03" }),
      ),
    );
    let waiters = 0;
    for (let attempt = 0; attempt < 500 && waiters < codes.length; attempt++) {
      const rows = await observer.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%cli_device%'
      `;
      waiters = Number(rows[0]?.count ?? 0n);
    }
    release?.();
    await blockerTransaction;
    expect(waiters).toBe(codes.length);
    const settled = await outcomes;

    // No CONFLICT: Prisma runs the upsert as INSERT … ON CONFLICT DO UPDATE.
    expect(settled.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const minted = settled.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    expect(await prisma.cliDevice.count({ where: { userId: user.id } })).toBe(1);
    expect(new Set(minted.map((result) => result.cliDeviceId)).size).toBe(1);
    const active = await prisma.cliDeviceCredential.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { id: true },
    });
    expect(active).toHaveLength(1);
    // The winner revoked the other login's credential.
    const winner = minted.find((result) => result.credentialId === active[0]?.id);
    const loser = minted.find((result) => result.credentialId !== active[0]?.id);
    expect(winner?.revoked.ids).toEqual([loser?.credentialId]);
  });

  it("paces pending polls against the millisecond interval Better Auth stores", async () => {
    const { prisma, access } = required();
    const user = await createUser();
    const suffix = crypto.randomUUID();
    const start = new Date();
    await prisma.deviceCode.create({
      data: {
        deviceCode: `device-${suffix}`,
        userCode: `USER-${suffix}`,
        expiresAt: new Date(start.getTime() + 10 * 60_000),
        status: "pending",
        // What Better Auth 1.7 writes for `interval: "5s"`.
        pollingInterval: 5000,
        clientId: "ws-model-proxy",
        scope: "cli-slug:desk-04",
      },
    });
    const poll = (offsetMs: number) =>
      access
        .mintCliDeviceCredentialFromApprovedDeviceCode({
          deviceCode: `device-${suffix}`,
          cliSlug: "desk-04",
          now: new Date(start.getTime() + offsetMs),
        })
        .then(
          () => "minted",
          (error: { data?: { deviceFlowError?: string } }) => error.data?.deviceFlowError,
        );

    expect(await poll(0)).toBe("authorization_pending");
    expect(await poll(1_000)).toBe("slow_down");
    expect(await poll(5_000)).toBe("authorization_pending");
    expect(await poll(10_500)).toBe("authorization_pending");
    expect(await prisma.cliDevice.count({ where: { userId: user.id } })).toBe(0);
  });

  it("refuses an existing device credential after the owner is marked for deletion", async () => {
    const { prisma, access } = required();
    const user = await createUser();
    const minted = await access.mintCliDeviceCredentialFromApprovedDeviceCode({
      deviceCode: await approvedCode(user.id, "marked-user"),
      cliSlug: "marked-user",
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { deletionRequestedAt: new Date(), banned: true },
    });

    expect(await access.authenticateCliWebsocketSecret(minted.secret)).toBeNull();
  });

  it("refuses a slug the approver did not see and keeps the code", async () => {
    const { prisma, access } = required();
    const user = await createUser();
    const deviceCode = await approvedCode(user.id, "approved-slug");

    await expect(
      access.mintCliDeviceCredentialFromApprovedDeviceCode({ deviceCode, cliSlug: "other-slug" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await prisma.deviceCode.count({ where: { deviceCode } })).toBe(1);
    expect(await prisma.cliDevice.count({ where: { userId: user.id } })).toBe(0);
  });
  async function deadlocks(): Promise<number> {
    const rows = await observer.$queryRaw<Array<{ deadlocks: bigint }>>`
      SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
    return Number(rows[0]?.deadlocks ?? 0n);
  }

  async function lockWaiters(pattern: string): Promise<number> {
    const rows = await observer.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`;
    return Number(rows[0]?.count ?? 0n);
  }

  /** Resolves once `pattern` waits on a lock or `settled` settles, whichever is first. */
  async function waitingOrSettled(pattern: string, settled: Promise<unknown>): Promise<void> {
    let done = false;
    void settled.finally(() => {
      done = true;
    });
    for (let attempt = 0; attempt < 500 && !done; attempt++) {
      if ((await lockWaiters(pattern)) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function outcome<T>(work: Promise<T>) {
    return work.then(
      (value) => ({ ok: true as const, value }),
      (error: { code?: string; data?: { deviceFlowError?: string } }) => ({
        ok: false as const,
        code: error.code,
        deviceFlowError: error.data?.deviceFlowError,
        error,
      }),
    );
  }

  /**
   * Pauses, inside the exchange's transaction, right after `event` on
   * `table` for this test's rows (a disposable trigger waiting on an
   * advisory lock that `blocker` holds). Removed by `drop()`.
   */
  async function pauseAfter(
    table: "device_code" | "cli_device",
    event: "DELETE" | "INSERT",
    userId: string,
    key: number,
  ) {
    const { prisma } = required();
    const name = `p16_pause_${table}_${event.toLowerCase()}`;
    const row = event === "DELETE" ? "OLD" : "NEW";
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
       BEGIN
         IF ${row}."userId" = '${userId}' THEN
           PERFORM set_config('deadlock_timeout', '100ms', true);
           PERFORM pg_advisory_xact_lock(${key});
         END IF;
         RETURN ${row};
       END $f$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${name} AFTER ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const isHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holding = blocker.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${key})`);
        held();
        await released;
      },
      { timeout: 30_000 },
    );
    await isHeld;
    return {
      release: async () => {
        release();
        await holding;
      },
      drop: async () => {
        release();
        await holding.catch(() => undefined);
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
      },
    };
  }

  it("refuses an exchange for an account marked for deletion (f1-F1)", async () => {
    const { prisma, access, deletion } = required();
    const user = await createUser();
    const deviceCode = await approvedCode(user.id, "marked-login");
    await deletion.requestUserDeletion(prisma, user.id);

    await expect(
      access.mintCliDeviceCredentialFromApprovedDeviceCode({ deviceCode, cliSlug: "marked-login" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { deviceFlowError: "access_denied" } });
    expect(await prisma.cliDevice.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.cliDeviceCredential.count({ where: { userId: user.id } })).toBe(0);
  });

  it("an exchange racing the ordered delete of its marked user: no deadlock, a typed refusal (F2-04)", async () => {
    const { prisma, access, deletion } = required();
    const user = await createUser();
    await prisma.cliDevice.create({ data: { userId: user.id, slug: "delete-race" } });
    const deviceCode = await approvedCode(user.id, "delete-race");
    const mark = await deletion.requestUserDeletion(prisma, user.id);
    const before = await deadlocks();
    // Where the pre-fix exchange held the code row while it went for the device.
    const pause = await pauseAfter("device_code", "DELETE", user.id, 16_004_001);
    try {
      const login = outcome(
        access.mintCliDeviceCredentialFromApprovedDeviceCode({
          deviceCode,
          cliSlug: "delete-race",
        }),
      );
      await waitingOrSettled("%device_code%", login);
      const deleting = outcome(deletion.completeUserDeletion(prisma, user.id, mark!.generation));
      await waitingOrSettled('%DELETE FROM "public"."user"%', deleting);
      await pause.release();
      const [loginResult, deleteResult] = await Promise.all([login, deleting]);

      expect(deleteResult).toEqual({ ok: true, value: true });
      expect(loginResult).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
        deviceFlowError: "access_denied",
      });
      expect(await deadlocks()).toBe(before);
      expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
      expect(await prisma.cliDeviceCredential.count({ where: { userId: user.id } })).toBe(0);
    } finally {
      await pause.drop();
    }
  });

  it("an exchange in flight when the user is marked finishes first; the delete then removes it (F2-04)", async () => {
    const { prisma, access, deletion } = required();
    const user = await createUser();
    await prisma.cliDevice.create({ data: { userId: user.id, slug: "mark-race" } });
    const deviceCode = await approvedCode(user.id, "mark-race");
    const before = await deadlocks();
    const pause = await pauseAfter("device_code", "DELETE", user.id, 16_004_002);
    try {
      const login = outcome(
        access.mintCliDeviceCredentialFromApprovedDeviceCode({ deviceCode, cliSlug: "mark-race" }),
      );
      await waitingOrSettled("%device_code%", login);
      // The exchange holds the device and has read the owner FOR SHARE: the
      // mark waits for it instead of deleting around it.
      const deleting = outcome(deletion.deleteUserDurably(prisma, user.id));
      await waitingOrSettled('%UPDATE "user"%', deleting);
      await pause.release();
      const [loginResult, deleteResult] = await Promise.all([login, deleting]);

      expect(loginResult.ok).toBe(true);
      expect(deleteResult).toEqual({ ok: true, value: "deleted" });
      expect(await deadlocks()).toBe(before);
      expect(await prisma.cliDeviceCredential.count({ where: { userId: user.id } })).toBe(0);
      expect(await prisma.cliDevice.count({ where: { userId: user.id } })).toBe(0);
    } finally {
      await pause.drop();
    }
  });

  it("a first login inserting its device while the ordered delete waits on the user row (F2-04)", async () => {
    const { prisma, access, deletion } = required();
    const user = await createUser();
    const deviceCode = await approvedCode(user.id, "new-slug-race");
    const mark = await deletion.requestUserDeletion(prisma, user.id);
    const before = await deadlocks();
    // After the device insert and its foreign-key check (FOR KEY SHARE on the
    // user), before the exchange's own FOR SHARE read of the user row.
    const pause = await pauseAfter("cli_device", "INSERT", user.id, 16_004_003);
    try {
      const login = outcome(
        access.mintCliDeviceCredentialFromApprovedDeviceCode({
          deviceCode,
          cliSlug: "new-slug-race",
        }),
      );
      await waitingOrSettled("%cli_device%", login);
      const deleting = outcome(deletion.completeUserDeletion(prisma, user.id, mark!.generation));
      await waitingOrSettled('%FROM "user"%', deleting);
      await pause.release();
      const [loginResult, deleteResult] = await Promise.all([login, deleting]);

      expect(loginResult).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
        deviceFlowError: "access_denied",
      });
      expect(deleteResult).toEqual({ ok: true, value: true });
      expect(await deadlocks()).toBe(before);
      expect(await prisma.cliDevice.count({ where: { userId: user.id } })).toBe(0);
    } finally {
      await pause.drop();
    }
  });
  it("an exchange arriving while the ordered delete holds its device: no deadlock, a typed refusal (F2-04)", async () => {
    const { prisma, access, deletion } = required();
    const user = await createUser();
    await prisma.cliDevice.create({ data: { userId: user.id, slug: "delete-first" } });
    const deviceCode = await approvedCode(user.id, "delete-first");
    const mark = await deletion.requestUserDeletion(prisma, user.id);
    const before = await deadlocks();
    // Inside the ordered delete's cascade: it holds the device (L0), the user
    // row (L7) and is deleting the device.
    const pause = await pauseAfter("cli_device", "DELETE", user.id, 16_004_004);
    try {
      const deleting = outcome(deletion.completeUserDeletion(prisma, user.id, mark!.generation));
      await waitingOrSettled('%DELETE FROM "public"."user"%', deleting);
      const login = outcome(
        access.mintCliDeviceCredentialFromApprovedDeviceCode({
          deviceCode,
          cliSlug: "delete-first",
        }),
      );
      await waitingOrSettled("%cli_device%", login);
      await pause.release();
      const [loginResult, deleteResult] = await Promise.all([login, deleting]);

      expect(deleteResult).toEqual({ ok: true, value: true });
      // The upsert waited for the device, then found no user for its foreign key.
      expect(loginResult).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
        deviceFlowError: "access_denied",
      });
      expect(await deadlocks()).toBe(before);
      expect(await prisma.cliDevice.count({ where: { userId: user.id } })).toBe(0);
    } finally {
      await pause.drop();
    }
  });
});
