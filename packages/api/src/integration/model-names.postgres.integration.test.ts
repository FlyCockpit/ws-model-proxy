/**
 * Model-name collisions cannot be raced (lib/model-names.ts), against real PostgreSQL with the
 * schema hardening (`pnpm test:postgres`). Every writer that adds a name to a person's
 * namespace holds that person's owner fence while it checks and writes, so of two concurrent
 * writers that would each pass the check alone, exactly one wins and the other is refused.
 *
 * Each race starts both writers while a blocker transaction holds the share holder's owner
 * fence, so both have read their plan and wait at the same point; the blocker then lets go.
 * Before the fences, both passed the check and both committed.
 */
import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

type Person = { id: string; email: string; name: string; slug: string };

type Modules = {
  fixtures: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
  >;
  prisma: typeof import("@ws-model-proxy/db")["default"];
  lockOrder: typeof import("@ws-model-proxy/db/capacity-lock-order");
  appRouter: typeof import("../routers/index")["appRouter"];
};

integration("model-name collisions on PostgreSQL", () => {
  let modules: Modules | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  const people: Person[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    // CI sets these; a local run gets test-only values (never a real deployment's).
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const [fixtureClient, db, lockOrder, router] = await Promise.all([
      import("@ws-model-proxy/db/test-fixture-client"),
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/capacity-lock-order"),
      import("../routers/index"),
    ]);
    modules = {
      fixtures: fixtureClient.createFixturePrismaClient(databaseUrl),
      prisma: db.default,
      lockOrder,
      appRouter: router.appRouter,
    };
  });

  afterAll(async () => {
    if (!modules) return;
    const { fixtures } = modules;
    const ids = people.map((person) => person.id);
    await fixtures.$transaction(async (tx) => {
      await tx.modelAlias.deleteMany({ where: { userId: { in: ids } } });
      await tx.share.deleteMany({ where: { ownerUserId: { in: ids } } });
      await tx.shareInvite.deleteMany({ where: { ownerUserId: { in: ids } } });
      await tx.pool.deleteMany({ where: { userId: { in: ids } } });
      await tx.auditEvent.deleteMany({ where: { userId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });
    });
    await fixtures.$disconnect();
  });

  function need(): Modules {
    if (!modules) throw new Error("modules unavailable");
    return modules;
  }

  async function person(name: string): Promise<Person> {
    const email = `${name}-${suffix}@example.test`;
    const row = await need().fixtures.user.create({
      data: {
        name,
        email,
        emailVerified: true,
        provedEmail: email,
        slug: `${name}-${suffix}`,
      },
      select: { id: true, email: true, name: true, slug: true },
    });
    people.push(row);
    return row;
  }

  async function pool(owner: Person, slug: string) {
    return need().fixtures.pool.create({
      data: { userId: owner.id, slug, name: slug, modelType: "LLM" },
      select: { id: true },
    });
  }

  async function share(owner: Person, grantee: Person, poolId: string) {
    await need().fixtures.share.create({
      data: { poolId, ownerUserId: owner.id, granteeUserId: grantee.id, canUse: true },
    });
  }

  function as(user: Person) {
    const session = {
      user: { ...user, role: "user", emailVerified: true, twoFactorEnabled: false },
      session: { id: `s-${user.id}`, userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
    } as unknown as Session;
    const context: Context = {
      auth: {
        kind: "cookie_session",
        userId: user.id,
        sessionId: `s-${user.id}`,
        csrfVerified: true,
      },
      session,
    };
    return createRouterClient(need().appRouter, { context });
  }

  /**
   * Runs both writers while a blocker holds `holder`'s owner fence (so both have planned and
   * wait at it), then lets go. Returns how each ended.
   */
  async function race(
    holder: Person,
    writers: readonly [() => Promise<unknown>, () => Promise<unknown>],
  ): Promise<PromiseSettledResult<unknown>[]> {
    const { prisma, lockOrder } = need();
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fenced = new Promise<void>((resolve) => {
      held = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      await lockOrder.acquireFences(tx, [lockOrder.fences.owner(holder.id)]);
      held();
      await released;
    });
    await fenced;
    let settled = 0;
    const outcomes = Promise.allSettled(
      writers.map((writer) =>
        writer().finally(() => {
          settled += 1;
        }),
      ),
    );
    // Long enough for both to reach the fence; well inside the 2 s fence wait bound.
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Both wait on the holder's fence: neither could check or write meanwhile.
    expect(settled).toBe(0);
    release();
    await blocker;
    return outcomes;
  }

  function reasonOf(outcome: PromiseSettledResult<unknown> | undefined): string | undefined {
    if (outcome?.status !== "rejected") return undefined;
    const error = outcome.reason as { data?: { reason?: string }; code?: string };
    return error.data?.reason ?? error.code;
  }

  /**
   * Exactly one writer won; the other got one of `refusals` (by which side lost), or CONFLICT
   * when its wait on the winner's fence passed the 2 s bound (a cold first run): asked to retry,
   * never written.
   */
  function oneWon(outcomes: PromiseSettledResult<unknown>[], refusals: readonly string[]) {
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const lost = outcomes.find((outcome) => outcome.status === "rejected");
    expect([...refusals, "CONFLICT"]).toContain(reasonOf(lost));
  }

  /** Whether `user` has an alias named like one of their callable IDs (the invariant). */
  async function clashes(user: Person): Promise<string[]> {
    const { fixtures } = need();
    const [aliases, pools] = await Promise.all([
      fixtures.modelAlias.findMany({ where: { userId: user.id }, select: { name: true } }),
      fixtures.pool.findMany({
        where: {
          OR: [{ userId: user.id }, { Shares: { some: { granteeUserId: user.id, canUse: true } } }],
        },
        select: { slug: true, User: { select: { slug: true } } },
      }),
    ]);
    const ids = new Set(pools.map((row) => `${row.User.slug}/${row.slug}`));
    return aliases.map((alias) => alias.name).filter((name) => ids.has(name));
  }

  it("a pool rename and a share holder's alias of the new callable ID: one wins", async () => {
    const ann = await person("ann1");
    const bob = await person("bob1");
    const chat = await pool(ann, "chat");
    await share(ann, bob, chat.id);
    const outcomes = await race(bob, [
      () => as(ann).pools.update({ poolId: chat.id, slug: "talk" }),
      () => as(bob).pools.aliases.set({ name: `${ann.slug}/talk`, poolId: chat.id }),
    ]);
    oneWon(outcomes, ["name_unavailable", "alias_shadowed"]);
    expect(await clashes(bob)).toEqual([]);
  });

  it("a share grant and the recipient's alias of the pool's callable ID: one wins", async () => {
    const ann = await person("ann2");
    const bob = await person("bob2");
    const chat = await pool(ann, "chat");
    const own = await pool(bob, "own");
    const outcomes = await race(bob, [
      () =>
        as(ann).access.shares.create({
          poolId: chat.id,
          email: bob.email,
          canUse: true,
          canContribute: false,
          priorityClass: null,
          protectionPercent: null,
          monthlyCap: null,
        }),
      () => as(bob).pools.aliases.set({ name: `${ann.slug}/chat`, poolId: own.id }),
    ]);
    oneWon(outcomes, ["name_unavailable", "alias_shadowed"]);
    expect(await clashes(bob)).toEqual([]);
  });

  it("an account slug change and a holder's alias of a renamed callable ID: one wins", async () => {
    const ann = await person("ann3");
    const bob = await person("bob3");
    const chat = await pool(ann, "chat");
    await share(ann, bob, chat.id);
    const renamed = `ann3-new-${suffix}`;
    people.push({ ...ann, slug: renamed });
    const outcomes = await race(bob, [
      () => as(ann).settings.update({ slug: renamed }),
      () => as(bob).pools.aliases.set({ name: `${renamed}/chat`, poolId: chat.id }),
    ]);
    // The alias is not a callable ID until the rename commits, so if it went first the rename
    // is refused; if the rename went first, the alias is.
    oneWon(outcomes, ["name_unavailable", "alias_shadowed"]);
    expect(await clashes(bob)).toEqual([]);
  });

  it("an invite link acceptance and the recipient's alias of the pool's callable ID: one wins", async () => {
    const { fixtures } = need();
    const { acceptShareInviteByLink } = await import("../lib/share-invite-accept");
    const { generateShareInviteToken, shareInviteDigest } = await import("../lib/share-invites");
    const ann = await person("ann5");
    const bob = await person("bob5");
    const chat = await pool(ann, "chat");
    const own = await pool(bob, "own");
    const token = generateShareInviteToken();
    await fixtures.shareInvite.create({
      data: {
        poolId: chat.id,
        ownerUserId: ann.id,
        email: `someone-${suffix}@example.test`,
        tokenDigest: shareInviteDigest(token),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    let accepted: unknown;
    const outcomes = await race(bob, [
      async () => {
        accepted = await acceptShareInviteByLink(bob, token);
        if (accepted === "name_taken")
          throw Object.assign(new Error("taken"), { code: "name_taken" });
      },
      () => as(bob).pools.aliases.set({ name: `${ann.slug}/chat`, poolId: own.id }),
    ]);
    oneWon(outcomes, ["name_taken", "alias_shadowed"]);
    expect(await clashes(bob)).toEqual([]);
  });

  it("turning can use on and the holder's alias of the pool's callable ID: one wins", async () => {
    const { fixtures } = need();
    const ann = await person("ann6");
    const bob = await person("bob6");
    const chat = await pool(ann, "chat");
    const own = await pool(bob, "own");
    const row = await fixtures.share.create({
      data: {
        poolId: chat.id,
        ownerUserId: ann.id,
        granteeUserId: bob.id,
        canUse: false,
        canContribute: true,
      },
      select: { id: true },
    });
    const outcomes = await race(bob, [
      () => as(ann).access.shares.update({ shareId: row.id, canUse: true }),
      () => as(bob).pools.aliases.set({ name: `${ann.slug}/chat`, poolId: own.id }),
    ]);
    oneWon(outcomes, ["name_unavailable", "alias_shadowed"]);
    expect(await clashes(bob)).toEqual([]);
  });

  it("the check refuses to run without the claimant's owner fence", async () => {
    const { prisma, lockOrder } = need();
    const { modelNameClashes } = await import("../lib/model-names");
    const ann = await person("ann7");
    await expect(
      prisma.$transaction((tx) =>
        modelNameClashes(tx, [{ userId: ann.id, callableIds: [`${ann.slug}/x`] }]),
      ),
    ).rejects.toBeInstanceOf(lockOrder.MissingOwnerFenceError);
    await expect(
      prisma.$transaction(async (tx) => {
        await lockOrder.acquireFences(tx, [lockOrder.fences.owner(ann.id)]);
        return modelNameClashes(tx, [{ userId: ann.id, callableIds: [`${ann.slug}/x`] }]);
      }),
    ).resolves.toEqual([]);
  });

  it("refuses every writer against a name already taken", async () => {
    const ann = await person("ann4");
    const bob = await person("bob4");
    const chat = await pool(ann, "chat");
    const own = await pool(bob, "own");
    await as(bob).pools.aliases.set({ name: `${ann.slug}/chat`, poolId: own.id });
    await expect(
      as(ann).access.shares.create({
        poolId: chat.id,
        email: bob.email,
        canUse: true,
        canContribute: false,
        priorityClass: null,
        protectionPercent: null,
        monthlyCap: null,
      }),
    ).rejects.toMatchObject({ data: { reason: "name_unavailable" } });
    // A can-contribute share names nothing; turning can use on is refused.
    const created = await as(ann).access.shares.create({
      poolId: chat.id,
      email: bob.email,
      canUse: false,
      canContribute: true,
      priorityClass: null,
      protectionPercent: null,
      monthlyCap: null,
    });
    if (created.kind !== "share") throw new Error("expected a direct share");
    await expect(
      as(ann).access.shares.update({ shareId: created.share.id, canUse: true }),
    ).rejects.toMatchObject({ data: { reason: "name_unavailable" } });
    // The owner's own alias is named as theirs.
    await as(ann).pools.aliases.set({ name: `${ann.slug}/next`, poolId: chat.id });
    await expect(as(ann).pools.update({ poolId: chat.id, slug: "next" })).rejects.toMatchObject({
      data: { reason: "name_aliased" },
    });
    await expect(
      as(ann).pools.create({ slug: "next", name: "Next", type: "LLM" }),
    ).rejects.toMatchObject({ data: { reason: "name_aliased" } });
    expect(await clashes(ann)).toEqual([]);
    expect(await clashes(bob)).toEqual([]);
  });
});
