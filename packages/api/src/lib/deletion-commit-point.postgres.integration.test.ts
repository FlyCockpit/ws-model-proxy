import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

// Commit-point races of user and parent deletion on real PostgreSQL (cycle-9
// DEL-STATE and DL1-TXBOUND findings). Each test pauses one side at the exact
// statement a plain read-then-act would race, with an advisory-lock trigger
// or a held row lock, and lets the other side commit in the gap:
//  - a session INSERT against the deletion mark, in both orders;
//  - an admin unban write landing after the mark, then an abandon;
//  - producers committing after the pre-lock residual count, while the
//    ordered delete waits for its locks (user and pool deletes);
//  - the cost and index use of the in-transaction residual recount.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

// The admin-restore guard wrapped with a pause after its (real) read, so a
// test can land the deletion mark between that read and the route's write:
// the interleaving the guard, being read-then-act, cannot exclude.
const guardPause = vi.hoisted(() => ({
  path: null as string | null,
  reached: null as (() => void) | null,
  proceed: null as Promise<void> | null,
}));
vi.mock("@ws-model-proxy/auth/user-deletion-access-guard", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@ws-model-proxy/auth/user-deletion-access-guard")>();
  return {
    ...original,
    refuseAdminRestoreOfDeletingUser: async (ctx: { path?: string; body?: unknown }) => {
      await original.refuseAdminRestoreOfDeletingUser(ctx);
      if (guardPause.path !== null && ctx.path === guardPause.path) {
        guardPause.reached?.();
        await guardPause.proceed;
      }
    },
  };
});

type Db = typeof import("@ws-model-proxy/db").default;
type Client = ReturnType<typeof import("@ws-model-proxy/db/client-factory").createPrismaClient>;

function sessionFor(user: { id: string; email: string; name: string }): Context {
  return {
    session: {
      user: { ...user, emailVerified: true, role: "user" },
      session: {
        id: `session-${user.id}`,
        userId: user.id,
        token: `token-${user.id}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "commit-point-test",
      },
    } as Session,
  } as Context;
}

/** A promise with its resolver, for handing control between the two sides. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

integration("deletion commit points under concurrency", () => {
  let modules:
    | {
        prisma: Db;
        deletion: typeof import("@ws-model-proxy/db/parent-deletion");
        residual: typeof import("@ws-model-proxy/db/parent-deletion-residual");
        order: typeof import("@ws-model-proxy/db/capacity-lock-order");
        forwarder: typeof import("../routers/forwarder-management");
        auth: typeof import("@ws-model-proxy/auth");
        blocker: Client;
        observer: Client;
      }
    | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [db, deletion, residual, order, forwarder, auth, factory] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/parent-deletion"),
      import("@ws-model-proxy/db/parent-deletion-residual"),
      import("@ws-model-proxy/db/capacity-lock-order"),
      import("../routers/forwarder-management"),
      import("@ws-model-proxy/auth"),
      import("@ws-model-proxy/db/client-factory"),
    ]);
    modules = {
      prisma: db.default,
      deletion,
      residual,
      order,
      forwarder,
      auth,
      blocker: factory.createPrismaClient(databaseUrl),
      observer: factory.createPrismaClient(databaseUrl),
    };
  });

  afterAll(async () => {
    await Promise.all([modules?.blocker.$disconnect(), modules?.observer.$disconnect()]);
  });

  function required() {
    if (!modules) throw new Error("modules unavailable");
    return modules;
  }

  /** Waits until some backend waits on a lock and its query matches `pattern`. */
  async function waitForLockWait(pattern: string, waitEvent?: string): Promise<void> {
    const { observer } = required();
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [row] = await observer.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query ILIKE $1 ${waitEvent ? "AND wait_event = $2" : ""}`,
        ...(waitEvent ? [pattern, waitEvent] : [pattern]),
      );
      if (Number(row?.n ?? 0n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no backend waited on a lock for ${pattern}`);
  }

  /**
   * Installs a BEFORE INSERT ON session trigger named `name` that waits for
   * advisory lock `key`. BEFORE triggers fire in name order, so a name before
   * `session_refuse_deleting_user` pauses the insert before the commit-point
   * check, a name after it pauses it after the check took its FOR SHARE lock.
   */
  async function pauseSessionInserts(name: string, key: number) {
    const { observer } = required();
    await observer.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        PERFORM pg_advisory_xact_lock(${key});
        RETURN NEW;
      END
      $fn$`);
    await observer.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    return async () => {
      await observer.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON session`);
      await observer.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    };
  }

  /** Holds advisory lock `key` in a transaction of the blocker client until released. */
  async function holdAdvisory(key: number) {
    const { blocker } = required();
    const held = gate();
    const release = gate();
    const holding = blocker.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${key})`);
        held.open();
        await release.promise;
      },
      { timeout: 60_000 },
    );
    await held.promise;
    return async () => {
      release.open();
      await holding;
    };
  }

  async function userWithPassword(tag: string, role = "user") {
    const { prisma, auth } = required();
    const context = await auth.auth.$context;
    const suffix = `${tag}-${crypto.randomUUID()}`;
    const password = `Commit-${crypto.randomUUID()}`;
    const user = await prisma.user.create({
      data: {
        name: tag,
        email: `${suffix}@example.test`,
        slug: `cp-${suffix}`.slice(0, 60),
        emailVerified: true,
        role,
      },
    });
    await prisma.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: await context.password.hash(password),
      },
    });
    return { user, password };
  }

  /** Sign-in through Better Auth's HTTP handler (router, hooks, onAPIError). */
  function signIn(email: string, password: string) {
    return required().auth.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  function cookieOf(response: Response): string {
    return response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
  }

  it("a session insert paused after the hook's read is refused once the mark commits (mark first)", async () => {
    const { prisma, deletion } = required();
    const { user, password } = await userWithPassword("session-mark-first");
    const dropPause = await pauseSessionInserts("a_cp_pause_session_insert", 61_001);
    const releaseAdvisory = await holdAdvisory(61_001);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // The Better Auth hook has read "not pending"; the INSERT waits.
      const signingIn = signIn(user.email, password);
      await waitForLockWait("%session%", "advisory");
      const mark = await deletion.requestUserDeletion(prisma, user.id);
      expect(mark?.created).toBe(true);
      await releaseAdvisory();
      const response = await signingIn;
      // The trigger refused the INSERT; onAPIError answers the hook's 403.
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "USER_DELETION_PENDING" });
    } finally {
      errors.mockRestore();
      await dropPause();
    }
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  }, 30_000);

  it("a session inserted before the mark is removed by the mark (session first)", async () => {
    const { prisma, deletion, auth } = required();
    const { user, password } = await userWithPassword("session-insert-first");
    // Pause after session_refuse_deleting_user took its FOR SHARE lock.
    const dropPause = await pauseSessionInserts("z_cp_pause_session_insert", 61_002);
    const releaseAdvisory = await holdAdvisory(61_002);
    let response: Response;
    try {
      const signingIn = signIn(user.email, password);
      await waitForLockWait("%session%", "advisory");
      // The mark's UPDATE conflicts with the insert's FOR SHARE and waits.
      const marking = deletion.requestUserDeletion(prisma, user.id);
      await waitForLockWait('%UPDATE "user"%');
      await releaseAdvisory();
      response = await signingIn;
      const mark = await marking;
      expect(mark?.created).toBe(true);
    } finally {
      await dropPause();
    }
    // The insert committed first (sign-in succeeded) and the mark's own
    // DELETE removed it: no session survives, and the cookie is dead.
    expect(response.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    const session = await auth.auth.api.getSession({
      headers: new Headers({ cookie: cookieOf(response) }),
    });
    expect(session).toBeNull();
  }, 30_000);

  it("the mark revokes the sessions the marked admin impersonates through (IMP-MARK)", async () => {
    const { prisma, deletion, auth } = required();
    const admin = await userWithPassword("imp-admin", "admin");
    const target = await userWithPassword("imp-target");
    const login = await signIn(admin.user.email, admin.password);
    expect(login.status).toBe(200);
    const impersonating = await auth.auth.handler(
      new Request("http://localhost:3000/api/auth/admin/impersonate-user", {
        method: "POST",
        headers: {
          cookie: cookieOf(login),
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId: target.user.id }),
      }),
    );
    expect(impersonating.status).toBe(200);
    // The route clears the admin's session cookie, then sets the impersonation
    // one: keep the last non-empty value per cookie name.
    const jar = new Map<string, string>();
    for (const line of impersonating.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      if (at > 0 && pair.slice(at + 1) !== "") jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const headers = new Headers({
      cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    });
    const before = await auth.auth.api.getSession({ headers });
    expect(before?.user.id).toBe(target.user.id);
    expect(before?.session.impersonatedBy).toBe(admin.user.id);
    const impersonationId = before!.session.id;
    // The target's own session is not the admin's and survives the mark.
    const targetLogin = await signIn(target.user.email, target.password);
    expect(targetLogin.status).toBe(200);

    await deletion.requestUserDeletion(prisma, admin.user.id);

    // Dashboard: Better Auth no longer resolves the impersonation cookie.
    expect(await auth.auth.api.getSession({ headers })).toBeNull();
    // Browser terminal: the admission read (same query as
    // admitBrowserConnection) finds no session, so a straddling socket is
    // refused; the terminal middleware's own getSession is the check above.
    expect(
      await prisma.session.findUnique({
        where: { id: impersonationId },
        select: { userId: true, expiresAt: true },
      }),
    ).toBeNull();
    expect(await prisma.session.count({ where: { impersonatedBy: admin.user.id } })).toBe(0);
    expect(
      await auth.auth.api.getSession({ headers: new Headers({ cookie: cookieOf(targetLogin) }) }),
    ).not.toBeNull();

    // No impersonation session commits for a marked or a deleted admin.
    const { isSessionRefusedForDeletingUser } = await import(
      "@ws-model-proxy/auth/user-deletion-access-guard"
    );
    for (const impersonatedBy of [admin.user.id, `gone-${crypto.randomUUID()}`]) {
      const failure = await prisma.session
        .create({
          data: {
            userId: target.user.id,
            impersonatedBy,
            token: `imp-${crypto.randomUUID()}`,
            expiresAt: new Date(Date.now() + 60_000),
          },
        })
        .catch((error: unknown) => error);
      expect(isSessionRefusedForDeletingUser(failure)).toBe(true);
    }
    // The admin's own session went with the mark: no new impersonation.
    const again = await auth.auth.handler(
      new Request("http://localhost:3000/api/auth/admin/impersonate-user", {
        method: "POST",
        headers: {
          cookie: cookieOf(login),
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId: target.user.id }),
      }),
    );
    expect(again.status).toBe(401);
  }, 30_000);

  it("completion also removes impersonation sessions that predate the mark's cleanup", async () => {
    const { prisma, deletion, observer } = required();
    const admin = await userWithPassword("imp-legacy-admin", "admin");
    const target = await userWithPassword("imp-legacy-target");
    const mark = await deletion.requestUserDeletion(prisma, admin.user.id);
    // A session left by a mark taken before this cleanup existed (the trigger
    // is bypassed to plant it).
    await observer.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`
        INSERT INTO session (id, "userId", "impersonatedBy", token, "expiresAt", "updatedAt")
        VALUES (${`legacy-${admin.user.id}`}, ${target.user.id}, ${admin.user.id},
                ${`legacy-token-${admin.user.id}`}, now() + interval '1 hour', now())`;
    });
    expect(await prisma.session.count({ where: { impersonatedBy: admin.user.id } })).toBe(1);
    await expect(
      deletion.completeUserDeletion(prisma, admin.user.id, mark!.generation),
    ).resolves.toBe(true);
    expect(await prisma.session.count({ where: { impersonatedBy: admin.user.id } })).toBe(0);
  }, 30_000);

  it("the trigger refuses a raw session insert for a marked user with WMPD1", async () => {
    const { prisma, deletion } = required();
    const { user } = await userWithPassword("session-raw");
    await deletion.requestUserDeletion(prisma, user.id);
    const failure = await prisma.session
      .create({
        data: {
          userId: user.id,
          token: `raw-${user.id}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      })
      .catch((error: unknown) => error);
    const { isSessionRefusedForDeletingUser } = await import(
      "@ws-model-proxy/auth/user-deletion-access-guard"
    );
    expect(isSessionRefusedForDeletingUser(failure)).toBe(true);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("an admin unban that lands after the mark cannot un-archive an abandoned user", async () => {
    const { prisma, deletion, auth } = required();
    const admin = await userWithPassword("abandon-admin", "admin");
    const victim = await userWithPassword("abandon-victim");
    const login = await signIn(admin.user.email, admin.password);
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);
    await prisma.user.update({
      where: { id: victim.user.id },
      data: { banned: true, banReason: "archived", banExpires: null },
    });
    const reached = gate();
    const proceed = gate();
    guardPause.path = "/admin/unban-user";
    guardPause.reached = reached.open;
    guardPause.proceed = proceed.promise;
    let unbanStatus = 0;
    let abandoned = false;
    try {
      const unban = auth.auth.handler(
        new Request("http://localhost:3000/api/auth/admin/unban-user", {
          method: "POST",
          headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" },
          body: JSON.stringify({ userId: victim.user.id }),
        }),
      );
      // The guard has read "not pending"; the mark commits before the write.
      await reached.promise;
      const mark = await deletion.requestUserDeletion(prisma, victim.user.id);
      expect(mark?.created).toBe(true);
      proceed.open();
      unbanStatus = (await unban).status;
      // The unban's write landed after the mark: banned is false under it.
      expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.user.id } })).banned).toBe(
        false,
      );
      // A permanent refusal abandons the generation.
      abandoned = await deletion.abandonUserDeletion(prisma, victim.user.id, mark!.generation);
    } finally {
      guardPause.path = null;
      guardPause.reached = null;
      guardPause.proceed = null;
      proceed.open();
    }
    expect(unbanStatus).toBe(200);
    expect(abandoned).toBe(true);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: victim.user.id },
      select: {
        banned: true,
        banExpires: true,
        banReason: true,
        deletionRequestedAt: true,
        deletionGeneration: true,
      },
    });
    expect(row).toEqual({
      banned: true,
      banExpires: null,
      banReason: deletion.USER_DELETION_FAILED_BAN_REASON,
      deletionRequestedAt: null,
      deletionGeneration: null,
    });
    // And the archived user cannot sign in.
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await signIn(victim.user.email, victim.password)).status).toBe(403);
    } finally {
      errors.mockRestore();
    }
  }, 30_000);

  it("an abandon re-archives a user whose ban was made temporary and expired while pending", async () => {
    const { prisma, deletion } = required();
    const { user } = await userWithPassword("abandon-expired");
    const mark = await deletion.requestUserDeletion(prisma, user.id);
    await prisma.user.update({
      where: { id: user.id },
      data: { banned: true, banExpires: new Date(Date.now() - 60_000) },
    });
    await expect(deletion.abandonUserDeletion(prisma, user.id, mark!.generation)).resolves.toBe(
      true,
    );
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { banned: true, banExpires: true },
    });
    expect(row).toEqual({ banned: true, banExpires: null });
  });

  /** A user with a device, endpoint, model (-> target) and a pool. */
  async function graph(tag: string) {
    const { prisma } = required();
    const suffix = `${tag}-${crypto.randomUUID()}`;
    const user = await prisma.user.create({
      data: { name: tag, email: `${suffix}@example.test`, slug: `cpg-${suffix}`.slice(0, 60) },
    });
    const device = await prisma.cliDevice.create({ data: { userId: user.id, slug: "device" } });
    const endpoint = await prisma.endpoint.create({
      data: { userId: user.id, cliDeviceId: device.id, slug: "endpoint", label: "endpoint" },
    });
    const model = await prisma.discoveredModel.create({
      data: { userId: user.id, endpointId: endpoint.id, upstreamModelId: "m", encodedModelId: "m" },
    });
    const pool = await prisma.modelPool.create({
      data: { userId: user.id, slug: `pool-${suffix}`.slice(0, 60), name: "pool" },
    });
    return { suffix, user, device, endpoint, model, pool };
  }

  it("user delete: producers committed after the pre-lock count leave it pending (r2 residual race)", async () => {
    const { prisma, deletion, blocker, observer } = required();
    const g = await graph("residual-race-user");
    const mark = await deletion.requestUserDeletion(prisma, g.user.id);
    const held = gate();
    const release = gate();
    // Hold L0 (the device row) so the ordered delete waits after its count.
    const holding = blocker.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM cli_device WHERE id = ${g.device.id} FOR UPDATE`;
        held.open();
        await release.promise;
      },
      { timeout: 60_000 },
    );
    await held.promise;
    const completing = deletion.completeUserDeletion(prisma, g.user.id, mark!.generation).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitForLockWait("%cli_device%");
    const parents = await deletion.resolveDeletedParents(prisma, {
      userId: g.user.id,
      wholeUser: true,
    });
    expect(await deletion.countFinalPhaseResidualRows(prisma, parents)).toBe(0);
    const late = deletion.PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS + 1;
    await observer.$executeRawUnsafe(
      `INSERT INTO relay_request (id, "userId", status)
       SELECT '${g.suffix}-late-' || n, '${g.user.id}', 'PENDING'
         FROM generate_series(1, ${late}) n`,
    );
    release.open();
    await holding;
    const outcome = await completing;
    expect("error" in outcome && outcome.error).toBeInstanceOf(
      deletion.ParentDeletionDrainPendingError,
    );
    // Nothing deleted; the marker (and generation) stays for the sweeper.
    expect(await prisma.user.count({ where: { id: g.user.id } })).toBe(1);
    expect(await prisma.relayRequest.count({ where: { userId: g.user.id } })).toBe(late);
    expect(await prisma.cliDevice.count({ where: { id: g.device.id } })).toBe(1);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: g.user.id } })).deletionGeneration,
    ).toBe(mark!.generation);
    // The durable entry point reports pending, not an abandon.
    await expect(deletion.deleteUserDurably(prisma, g.user.id)).resolves.toBe("pending");
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: g.user.id } })).deletionGeneration,
    ).toBe(mark!.generation);
  }, 60_000);

  it("pool delete: producers committed after the pre-lock count answer CONFLICT, nothing deleted", async () => {
    const { prisma, forwarder, blocker, observer } = required();
    const g = await graph("residual-race-pool");
    const held = gate();
    const release = gate();
    // FOR NO KEY UPDATE on the pool: the ordered delete's L1 waits on it, a
    // producer's FOR KEY SHARE (relay insert naming the pool) does not.
    const holding = blocker.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${g.pool.id} FOR NO KEY UPDATE`;
        held.open();
        await release.promise;
      },
      { timeout: 60_000 },
    );
    await held.promise;
    const client = createRouterClient(forwarder.forwarderManagementRouter, {
      context: sessionFor(g.user),
    });
    const deleting = client.deleteModelPool({ id: g.pool.id }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitForLockWait("%model_pool%");
    const late = 20_001;
    await observer.$executeRawUnsafe(
      `INSERT INTO relay_request (id, "userId", status, "requestedModelPoolId")
       SELECT '${g.suffix}-late-' || n, '${g.user.id}', 'PENDING', '${g.pool.id}'
         FROM generate_series(1, ${late}) n`,
    );
    release.open();
    await holding;
    const outcome = await deleting;
    expect("error" in outcome && outcome.error).toMatchObject({ code: "CONFLICT" });
    expect(await prisma.modelPool.count({ where: { id: g.pool.id } })).toBe(1);
    expect(await prisma.relayRequest.count({ where: { requestedModelPoolId: g.pool.id } })).toBe(
      late,
    );
  }, 60_000);

  it("the in-transaction recount stays cheap at the cap and filters on indexed columns", async () => {
    const { prisma, residual, order } = required();
    // Every column the recount filters on leads some index.
    const columns = new Set<string>();
    for (const [table, edges] of Object.entries(residual.HISTORY_DRAIN_EDGES))
      for (const [column] of [...edges.cascade, ...edges.setNull])
        columns.add(`${table}.${column}`);
    columns.add("capacity_waiter.admissionRequestId");
    columns.add("admission_request.relayRequestId");
    columns.add("usage_rollup_minute.requesterUserId");
    columns.add("usage_rollup_hour.requesterUserId");
    const leading = await prisma.$queryRaw<Array<{ entry: string }>>`
      SELECT c.relname || '.' || a.attname AS entry
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]`;
    const indexed = new Set(leading.map((row) => row.entry));
    expect([...columns].filter((column) => !indexed.has(column)).sort()).toEqual([]);

    // At the cap (20 000 live rows over several edges) the recount under the
    // ordered delete's locks passes, well inside the 15 s transaction cap.
    const g = await graph("recount-cost");
    const cap = residual.PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS;
    await prisma.$executeRawUnsafe(
      `INSERT INTO relay_request (id, "userId", status, "requestedModelPoolId")
       SELECT '${g.suffix}-live-' || n, '${g.user.id}', 'PENDING',
              CASE WHEN n % 2 = 0 THEN '${g.pool.id}' END
         FROM generate_series(1, ${cap / 2}) n`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO response_stickiness_record (id, "userId", "routingKeyDigest")
       SELECT '${g.suffix}-s-' || n, '${g.user.id}', '${g.suffix}-d-' || n
         FROM generate_series(1, ${cap / 4}) n`,
    );
    const scope = { userId: g.user.id, wholeUser: true } as const;
    const parents = await residual.resolveDeletedParents(prisma, scope);
    // relay rows (userId edge, counted once per matching edge) + stickiness.
    expect(await residual.countFinalPhaseResidualRows(prisma, parents)).toBeGreaterThanOrEqual(
      (cap * 3) / 4,
    );
    const started = Date.now();
    await order.runCapacityOrderedTransaction(prisma, async (tx) => {
      await residual.assertFinalPhaseResidualWithinBound(tx, scope, cap);
    });
    const elapsed = Date.now() - started;
    process.stdout.write(`[commit-point] in-transaction recount at the cap: ${elapsed} ms\n`);
    // One row over the cap is refused.
    await expect(
      order.runCapacityOrderedTransaction(prisma, (tx) =>
        residual.assertFinalPhaseResidualWithinBound(tx, scope, 100),
      ),
    ).rejects.toBeInstanceOf(residual.ParentDeletionDrainPendingError);
  }, 60_000);
});
