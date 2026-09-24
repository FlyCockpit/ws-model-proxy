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
    const [db, dbFactory, access] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/client-factory"),
      import("./cli-credential-access"),
    ]);
    modules = { prisma: db.default, access };
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
          AND query ILIKE ${`%${table}%`}
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
      data: { name: "Work laptop", allowHumanTerminal: true, allowMcpCommands: true },
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
        select: { name: true, allowHumanTerminal: true, allowMcpCommands: true },
      }),
    ).toEqual({ name: "Work laptop", allowHumanTerminal: true, allowMcpCommands: true });
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
});
