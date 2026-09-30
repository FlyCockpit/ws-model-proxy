import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

// Commit-point races of user and parent deletion on real PostgreSQL (cycle-9
// DEL-STATE and DL1-TXBOUND findings). Each test pauses one side at the exact
// statement a plain read-then-act would race, with an advisory-lock trigger
// or a held row lock, and lets the other side commit in the gap:
//  - a session INSERT against the deletion mark, in both orders;
//  - an admin unban write landing after the mark, then an abandon;
//  - producers committing while a parent delete waits for its owner fence
//    (user and pool deletes; DL-1 (d) leaves their rows as orphans);
//  - the index behind the user drain's relay keyset.

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

/**
 * The hook cold-imports the auth and router module graphs (Vite transforms
 * them on first use); on a contended host that alone exceeded vitest's 10 s
 * default hook timeout.
 */
const HOOK_TIMEOUT_MS = 120_000;

integration("deletion commit points under concurrency", () => {
  let modules:
    | {
        prisma: Db;
        deletion: typeof import("@ws-model-proxy/db/parent-deletion");
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
    const [, deletion, order, forwarder, auth, factory] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/parent-deletion"),
      import("@ws-model-proxy/db/capacity-lock-order"),
      import("../routers/forwarder-management"),
      import("@ws-model-proxy/auth"),
      import("@ws-model-proxy/db/client-factory"),
    ]);
    modules = {
      prisma: createFixturePrismaClient(databaseUrl!),
      deletion,
      order,
      forwarder,
      auth,
      blocker: factory.createPrismaClient(databaseUrl),
      observer: factory.createPrismaClient(databaseUrl),
    };
  }, HOOK_TIMEOUT_MS);

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

  /** Holds the owner fence of `userId` in a blocker transaction until released. */
  async function holdOwnerFence(userId: string) {
    const { blocker, order } = required();
    const held = gate();
    const release = gate();
    const holding = blocker.$transaction(
      async (tx) => {
        await order.acquireFences(tx, [order.fences.owner(userId)]);
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

  /**
   * Rows committed while the delete waits for the owner fence. The delete's own
   * fence wait is bounded by CAPACITY_ORDERED_LOCK_TIMEOUT_MS (2 s, by design: it
   * rolls back and answers CONFLICT), and that clock keeps running while the test
   * works. So the rows are inserted in an open transaction BEFORE the delete
   * starts (nothing in it takes a lock the delete needs) and only the O(1) COMMIT
   * happens inside the wait window: ordering, not a race against the clock. This
   * many rows still spans more than one 1,000-row sweep batch.
   */
  const LATE_PRODUCER_ROWS = 1_200;

  async function stageLateProducers(g: {
    suffix: string;
    user: { id: string };
    pool: { id: string };
  }) {
    const { observer } = required();
    const staged = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const tx = observer
      .$transaction(
        async (client) => {
          await client.$executeRawUnsafe(
            `INSERT INTO relay_request (id, "userId", status, "requestedModelPoolId")
             SELECT '${g.suffix}-late-' || n, '${g.user.id}', 'FAILED', '${g.pool.id}'
               FROM generate_series(1, ${LATE_PRODUCER_ROWS}) n`,
          );
          staged.resolve();
          await gate.promise;
        },
        { timeout: 60_000, maxWait: 60_000 },
      )
      .catch((error: unknown) => {
        staged.reject(error);
        throw error;
      });
    await staged.promise;
    return async () => {
      gate.resolve();
      await tx;
    };
  }

  // DL-1 (d): the final parent delete touches no hot-path row (no foreign key
  // crosses the boundary), so producers committing while it waits for its
  // owner fence no longer need a residual recount or refusal. Their rows stay
  // as orphaned history; the purge queue removes a deleted user's terminal
  // rows after the grace period.
  it("user delete: producers committed while it waits for the owner fence stay as orphans for the purge", async () => {
    const { prisma, deletion } = required();
    const sweeps = await import("@ws-model-proxy/db/hot-path-sweeps");
    const g = await graph("late-producers-user");
    const commitLate = await stageLateProducers(g);
    const mark = await deletion.requestUserDeletion(prisma, g.user.id);
    const release = await holdOwnerFence(g.user.id);
    const completing = deletion.completeUserDeletion(prisma, g.user.id, mark!.generation).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitForLockWait("%wsmp_acquire_fences%", "advisory");
    await commitLate();
    const late = LATE_PRODUCER_ROWS;
    await release();
    expect(await completing).toEqual({ value: true });
    expect(await prisma.user.count({ where: { id: g.user.id } })).toBe(0);
    expect(await prisma.modelPool.count({ where: { id: g.pool.id } })).toBe(0);
    expect(await prisma.relayRequest.count({ where: { userId: g.user.id } })).toBe(late);
    // Within the grace period the purge removes rows but keeps the entry.
    await sweeps.purgeDeletedUserHistory(prisma, g.user.id);
    expect(await prisma.relayRequest.count({ where: { userId: g.user.id } })).toBe(0);
    expect(await prisma.deletedUserPurge.count({ where: { userId: g.user.id } })).toBe(1);
  }, 60_000);

  it("pool delete: producers committed while it waits for the owner fence do not refuse it", async () => {
    const { prisma, forwarder } = required();
    const g = await graph("late-producers-pool");
    const commitLate = await stageLateProducers(g);
    const release = await holdOwnerFence(g.user.id);
    const client = createRouterClient(forwarder.forwarderManagementRouter, {
      context: sessionFor(g.user),
    });
    const deleting = client.deleteModelPool({ id: g.pool.id }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitForLockWait("%wsmp_acquire_fences%", "advisory");
    await commitLate();
    const late = LATE_PRODUCER_ROWS;
    await release();
    const outcome = await deleting;
    expect("error" in outcome ? String(outcome.error) : "deleted").toBe("deleted");
    expect(await prisma.modelPool.count({ where: { id: g.pool.id } })).toBe(0);
    // The requests keep naming the deleted pool (a dangling id, no FK). They
    // are terminal so later suites' abandoned-request reaper has no backlog.
    expect(await prisma.relayRequest.count({ where: { requestedModelPoolId: g.pool.id } })).toBe(
      late,
    );
  }, 60_000);

  it("the user drain's relay keyset uses the (userId, createdAt, id) index without a sort", async () => {
    const { prisma } = required();
    const g = await graph("drain-keyset-index");
    await prisma.$executeRawUnsafe(
      `INSERT INTO relay_request (id, "userId", status, "createdAt")
       SELECT '${g.suffix}-k-' || n, '${g.user.id}', 'SUCCEEDED',
              timestamp '2026-01-01' + (n / 3) * interval '1 second'
         FROM generate_series(1, 3000) n`,
    );
    await prisma.$executeRawUnsafe("ANALYZE relay_request");
    const plan = await prisma.$transaction(async (tx) => {
      // Proves the index serves the keyset order. Cost-based choice between
      // this index and `relay_request_createdAt_idx` + an incremental sort
      // depends on sampled statistics (ANALYZE samples randomly, and the table
      // holds other files' rows), so it flaked. Disabling the sort node types
      // leaves the composite index as the only plan that can deliver the order,
      // whatever the statistics say; a missing or mis-ordered index would still
      // fail here (no plan without a sort, or a different index).
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_sort = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_incremental_sort = off");
      const rows = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
        `EXPLAIN (FORMAT JSON)
         SELECT id, "createdAt" FROM relay_request
          WHERE "userId" = $1 AND status IN ('SUCCEEDED', 'FAILED', 'CANCELED')
            AND ("createdAt", id) > ($2::timestamp, $3)
          ORDER BY "createdAt", id
          LIMIT 500`,
        g.user.id,
        new Date("2026-01-01T00:05:00.000Z"),
        `${g.suffix}-k-900`,
      );
      return JSON.stringify(rows[0]?.["QUERY PLAN"]);
    });
    expect(plan).toContain('"Index Name":"relay_request_userId_createdAt_id_idx"');
    expect(plan).not.toMatch(/"Node Type":"(Incremental )?Sort"/);
  }, 60_000);
});
