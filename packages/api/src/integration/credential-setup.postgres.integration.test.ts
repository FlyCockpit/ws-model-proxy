/** Actual shared pool/client, owner fences, selective adapter and pinned reset handler.
 * Discovered by the existing test:postgres gate. Delivery alone is replaced.
 * Run only on Boat's disposable schema-validation database with hardening applied.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;
const delivery = vi.hoisted(() => ({ verified: undefined as ((url: string) => void) | undefined }));
vi.mock("@ws-model-proxy/mailer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ws-model-proxy/mailer")>()),
  isEmailConfigured: () => true,
  renderVerifyEmail: ({ url }: { url: string }) => {
    delivery.verified?.(url);
    return { subject: "Disposable verification", html: "" };
  },
  sendEmail: async () => {},
}));

type Modules = {
  fixtures: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
  >;
  prisma: typeof import("@ws-model-proxy/db")["default"];
  observer: ReturnType<typeof import("@ws-model-proxy/db/client-factory")["createPrismaClient"]>;
  auth: typeof import("@ws-model-proxy/auth")["auth"];
  handler: typeof import("@ws-model-proxy/auth/password-auth-handler")["handlePasswordAuthRequest"];
  links: typeof import("@ws-model-proxy/auth/password-reset-links");
  fences: typeof import("@ws-model-proxy/db/capacity-lock-order");
};
const origin = "https://activation.example.test";
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

integration("credential activation on PostgreSQL at pool 3", () => {
  let modules: Modules | undefined;
  const userIds: string[] = [];
  const identifiers: string[] = [];
  let poolId = "";
  let ownerId = "";
  const requireModules = () => {
    if (!modules) throw new Error("modules unavailable");
    return modules;
  };
  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.DATABASE_POOL_MAX = "3";
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET = "disposable-activation-postgres-secret-at-least-32";
    process.env.BETTER_AUTH_URL = origin;
    process.env.WMP_MCP_ENABLED = "false";
    const [fixture, db, auth, handler, links, fences] = await Promise.all([
      import("@ws-model-proxy/db/test-fixture-client"),
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/auth"),
      import("@ws-model-proxy/auth/password-auth-handler"),
      import("@ws-model-proxy/auth/password-reset-links"),
      import("@ws-model-proxy/db/capacity-lock-order"),
      import("../lib/share-invite-accept"), // Registers the actual idempotent share acceptor.
    ]);
    const { createPrismaClient } = await import("@ws-model-proxy/db/client-factory");
    modules = {
      observer: createPrismaClient(databaseUrl, { maxConnections: 2 }),
      fixtures: fixture.createFixturePrismaClient(databaseUrl),
      prisma: db.default,
      auth: auth.auth,
      handler: handler.handlePasswordAuthRequest,
      links,
      fences,
    };
    expect((await import("@ws-model-proxy/env/shared")).env.DATABASE_POOL_MAX).toBe(3);
    const settings = await modules.prisma.$queryRaw<
      Array<{ held: string | null }>
    >`SELECT current_setting('wsmp.fences', true) AS held`;
    expect(settings[0]?.held ?? "").not.toContain(",*,");
    const owner = await modules.fixtures.user.create({
      data: {
        name: "Activation owner",
        email: `activation-owner-${crypto.randomUUID()}@example.test`,
        emailVerified: true,
        slug: `ao-${crypto.randomUUID()}`,
      },
    });
    ownerId = owner.id;
    userIds.push(ownerId);
    poolId = (
      await modules.fixtures.pool.create({
        data: {
          userId: ownerId,
          slug: `activation-${crypto.randomUUID().slice(0, 8)}`,
          name: "Activation",
          modelType: "LLM",
        },
      })
    ).id;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delivery.verified = undefined;
  });
  afterAll(async () => {
    if (!modules) return;
    const { fixtures, prisma } = modules;
    try {
      await fixtures.$transaction(async (tx) => {
        await tx.verification.deleteMany({
          where: { OR: [{ identifier: { in: identifiers } }, { value: { in: userIds } }] },
        });
        await tx.shareInvite.deleteMany({ where: { ownerUserId: ownerId } });
        await tx.share.deleteMany({ where: { ownerUserId: ownerId } });
        await tx.pool.deleteMany({ where: { id: poolId } });
        await tx.user.deleteMany({ where: { id: { in: userIds } } });
      });
    } finally {
      await Promise.all([
        fixtures.$disconnect(),
        prisma.$disconnect(),
        modules.observer.$disconnect(),
      ]);
    }
  });

  async function invitee() {
    const { fixtures, auth } = requireModules();
    const context = await auth.$context;
    const user = await fixtures.user.create({
      data: {
        name: "Activation invitee",
        email: `activation-${crypto.randomUUID()}@example.test`,
        slug: `ai-${crypto.randomUUID()}`,
        emailVerified: false,
      },
    });
    userIds.push(user.id);
    const password = `prior-${crypto.randomUUID()}`;
    await fixtures.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: await context.password.hash(password),
      },
    });
    const identifier = `admin-invited:${user.id}`;
    identifiers.push(identifier);
    await fixtures.verification.create({
      data: { identifier, value: user.id, expiresAt: new Date("9999-12-31") },
    });
    await fixtures.shareInvite.create({
      data: {
        poolId,
        ownerUserId: ownerId,
        email: user.email,
        tokenDigest: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return { ...user, password };
  }
  async function link(user: { id: string; email: string }, mailed: boolean) {
    const { fixtures, links } = requireModules();
    const token = crypto.randomUUID();
    const identifier = `reset-password:${token}`;
    identifiers.push(identifier);
    await fixtures.verification.create({
      data: { identifier, value: user.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    if (mailed) {
      expect(await links.recordResetLinkMailed({ token, userId: user.id, email: user.email })).toBe(
        true,
      );
      const marks = await fixtures.verification.findMany({
        where: { value: JSON.stringify({ userId: user.id, email: user.email }) },
        select: { identifier: true },
      });
      identifiers.push(...marks.map((mark) => mark.identifier));
    }
    return token;
  }
  const reset = (token: string, password: string) => {
    const { auth, handler } = requireModules();
    return handler(
      auth,
      new Request(`${origin}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ token, newPassword: password }),
      }),
    );
  };
  const state = async (id: string) =>
    requireModules().prisma.user.findUniqueOrThrow({
      where: { id },
      select: { emailVerified: true, provedEmail: true, email: true },
    });
  async function passwordWorks(id: string, password: string) {
    const { prisma, auth } = requireModules();
    const account = await prisma.account.findFirstOrThrow({
      where: { userId: id, providerId: "credential" },
    });
    return (
      !!account.password &&
      (await auth.$context).password.verify({ hash: account.password, password })
    );
  }
  const shares = (id: string) =>
    requireModules().prisma.share.count({ where: { granteeUserId: id, poolId } });

  it("rolls back proof, password, token and sibling links on actual password-write failure, then retries with postcommit hooks at pool 3", async () => {
    const { auth, prisma, fences } = requireModules();
    const user = await invitee();
    const token = await link(user, true);
    const sibling = await link(user, false);
    const context = await auth.$context;
    const update = context.internalAdapter.updatePassword.bind(context.internalAdapter);
    const afterHooks = context.options.databaseHooks!.account!.update!;
    const after = afterHooks.after!;
    const afterSpy = vi.spyOn(afterHooks, "after").mockImplementation(async (...args) => {
      // Requires the nested reservation returned by the spend before queued hooks run.
      await fences.runCapacityOrderedTransaction(prisma, async (tx) => {
        await fences.fenceOwners(tx, [user.id]);
      });
      await after(...args);
    });
    const fail = vi
      .spyOn(context.internalAdapter, "updatePassword")
      .mockImplementationOnce(async (...args) => {
        await update(...args);
        throw new Error("disposable password-write rollback");
      });
    expect((await reset(token, "rollback-password-12345")).status).toBe(500);
    fail.mockRestore();
    expect(await passwordWorks(user.id, user.password)).toBe(true);
    expect(await passwordWorks(user.id, "rollback-password-12345")).toBe(false);
    expect(await state(user.id)).toMatchObject({ emailVerified: false, provedEmail: null });
    expect(
      await prisma.verification.count({
        where: { identifier: { in: [`reset-password:${token}`, `reset-password:${sibling}`] } },
      }),
    ).toBe(2);
    expect(await shares(user.id)).toBe(0);
    expect(afterSpy).not.toHaveBeenCalled();
    expect((await reset(token, "committed-password-12345")).status).toBe(200);
    expect(await passwordWorks(user.id, "committed-password-12345")).toBe(true);
    expect(await state(user.id)).toMatchObject({ emailVerified: true, provedEmail: user.email });
    expect(
      await prisma.verification.count({
        where: { value: user.id, identifier: { startsWith: "reset-password:" } },
      }),
    ).toBe(0);
    expect(afterSpy).toHaveBeenCalledOnce();
    expect(await shares(user.id)).toBe(1);
  });

  it("bound verification asserts owner before writing and never reacquires after the reset's xid", async () => {
    const { auth, prisma } = requireModules();
    const { withPasswordWriteLock } = await import("../../../auth/src/password-write-lock");
    const user = await invitee();
    const token = await link(user, true);
    const row = await prisma.verification.findFirstOrThrow({
      where: { identifier: `reset-password:${token}` },
    });
    const context = await auth.$context;
    const request = new Request(`${origin}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: "unused-password-12345" }),
    });
    await withPasswordWriteLock(
      "/reset-password",
      request,
      async () => {
        await context.adapter.transaction(async (bound) => {
          await expect(
            bound.update({
              model: "user",
              where: [{ field: "id", value: user.id }],
              update: { emailVerified: true },
            }),
          ).rejects.toMatchObject({ code: "MISSING_OWNER_FENCE" });
          expect(
            await bound.consumeOne({
              model: "verification",
              where: [{ field: "id", value: row.id }],
            }),
          ).not.toBeNull();
          // Admission has written proof and assigned an xid. wsmp_acquire_fences
          // would now raise WMPF1 even for this same owner; only the read-only check works.
          await bound.update({
            model: "user",
            where: [{ field: "id", value: user.id }],
            update: { emailVerified: true },
          });
        });
        return new Response();
      },
      { getSession: async () => null },
    );
    expect(await state(user.id)).toMatchObject({ emailVerified: true, provedEmail: user.email });
    expect(await passwordWorks(user.id, user.password)).toBe(true);
    expect(await shares(user.id)).toBe(0); // No committed reset callback ran at this adapter seam.
  });

  it.each(["shown", "mailed"] as const)(
    "commits only the %s winner's password and proof",
    async (first) => {
      const { auth } = requireModules();
      const user = await invitee();
      const shown = await link(user, false);
      const mailed = await link(user, true);
      const context = await auth.$context;
      const entered = deferred();
      const release = deferred();
      const hash = context.password.hash;
      vi.spyOn(context.password, "hash").mockImplementationOnce(async (password) => {
        entered.resolve();
        await release.promise;
        return hash(password);
      });
      const winner = reset(first === "shown" ? shown : mailed, `${first}-password-12345`);
      await entered.promise;
      const loserToken = first === "shown" ? mailed : shown;
      const loser = reset(loserToken, "losing-password-12345");
      release.resolve();
      expect((await winner).status).toBe(200);
      expect((await loser).status).toBe(400);
      expect(await passwordWorks(user.id, `${first}-password-12345`)).toBe(true);
      expect(await passwordWorks(user.id, "losing-password-12345")).toBe(false);
      expect(await state(user.id)).toMatchObject({
        emailVerified: first === "mailed",
        provedEmail: first === "mailed" ? user.email : null,
      });
      expect(await shares(user.id)).toBe(first === "mailed" ? 1 : 0);
    },
  );

  it.each(["shown", "verify"] as const)(
    "orders %s before the competing verify-email/reset handler",
    async (first) => {
      const { auth, observer, fences } = requireModules();
      const user = await invitee();
      const token = await link(user, false);
      const sent = deferred<string>();
      delivery.verified = sent.resolve;
      await auth.api.sendVerificationEmail({ body: { email: user.email } });
      const verificationUrl = new URL(await sent.promise);
      verificationUrl.searchParams.delete("callbackURL");
      const verify = () => auth.handler(new Request(verificationUrl));
      const context = await auth.$context;
      const entered = deferred();
      const release = deferred();
      let holder: Promise<unknown> | undefined;
      if (first === "shown") {
        const hash = context.password.hash;
        vi.spyOn(context.password, "hash").mockImplementationOnce(async (password) => {
          entered.resolve();
          await release.promise;
          return hash(password);
        });
      } else {
        // A separate ordinary connection holds the real owner fence; the real
        // verifier acquires password-write before blocking on that owner.
        holder = observer.$transaction(
          async (tx) => {
            await fences.fenceOwners(tx, [user.id]);
            entered.resolve();
            await release.promise;
          },
          { timeout: 15_000 },
        );
      }
      if (holder) await entered.promise;
      const winner = first === "shown" ? reset(token, "shown-password-12345") : verify();
      let loser: Promise<Response> | undefined;
      try {
        if (first === "shown") await entered.promise;
        else {
          await vi.waitFor(
            async () => {
              const waiting = await observer.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
             WHERE locktype = 'advisory' AND NOT granted
               AND classid = ((hashtextextended(${"owner:" + user.id}, 0) >> 32) & 4294967295)::oid
               AND objid = (hashtextextended(${"owner:" + user.id}, 0) & 4294967295)::oid
          ) AS waiting`;
              expect(waiting[0]?.waiting).toBe(true);
            },
            { timeout: 5_000, interval: 20 },
          );
        }
        loser = first === "shown" ? verify() : reset(token, "refused-password-12345");
        release.resolve();
        await holder;
        expect((await winner).status).toBe(200);
        expect((await loser).status).toBe(first === "shown" ? 200 : 400);
      } finally {
        release.resolve();
        await Promise.allSettled([winner, ...(loser ? [loser] : []), ...(holder ? [holder] : [])]);
      }
      expect(await state(user.id)).toMatchObject({ emailVerified: true, provedEmail: user.email });
      expect(await passwordWorks(user.id, "refused-password-12345")).toBe(false);
      expect(await passwordWorks(user.id, "shown-password-12345")).toBe(first === "shown");
    },
  );
});
