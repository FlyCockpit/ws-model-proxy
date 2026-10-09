/**
 * Model-name collisions (lib/model-names.ts), against real PostgreSQL with the schema hardening
 * (`pnpm test:postgres`).
 *
 * - A person's own actions cannot be raced into a clash in their own namespace: each writer
 *   holds their owner fence while it checks and writes, so of two concurrent writers that would
 *   each pass the check alone, exactly one wins and the other is refused.
 * - Someone else's alias never refuses an action (sharing, can use, invites, renames): an alias
 *   named like a pool ID shared with its person wins for them, and they see it marked.
 *
 * Each race starts both writers while a blocker transaction holds a fence both need, so they
 * usually have read their plan and wait at the same point; the blocker then lets go. The
 * assertions are the invariants, whatever the interleaving: each writer retries the "retry"
 * answer as callers do (./retry-answers.ts; on a loaded machine a fence wait or statement can pass
 * its server-side bound), so a race ends with one winner and the other refused by name, or with
 * the share landing.
 */
import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";
import { retryAnswers, untilAnswered } from "./retry-answers";

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
    return createRouterClient(need().appRouter, { context, interceptors: [retryAnswers] });
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
    // A test fixture, not a bounded write: its own client-side limits must not end it early on
    // a slow machine (the writers' bounds are the ones under test).
    const blocker = prisma.$transaction(
      async (tx) => {
        await lockOrder.acquireFences(tx, [lockOrder.fences.owner(holder.id)]);
        held();
        await released;
      },
      { maxWait: 30_000, timeout: 30_000 },
    );
    await fenced;
    let settled = 0;
    const outcomes = Promise.allSettled(
      writers.map((writer) =>
        writer().finally(() => {
          settled += 1;
        }),
      ),
    );
    // Usually long enough for both to reach the fence. A writer that waits past its 2 s bound
    // answers retry and tries again; the assertions do not depend on who got there first.
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Nothing can be written while the holder's fence is held.
      expect(settled).toBe(0);
    } finally {
      // Never left holding the fence into the next test.
      release();
      await blocker;
    }
    return outcomes;
  }

  function reasonOf(outcome: PromiseSettledResult<unknown> | undefined): string | undefined {
    if (outcome?.status !== "rejected") return undefined;
    const error = outcome.reason as { data?: { reason?: string }; code?: string };
    return error.data?.reason ?? error.code;
  }

  /**
   * Exactly one writer won; the other was refused by name, one of `refusals` (by which side
   * lost). A "retry" answer is never the end of a race: the writer retried it.
   */
  function oneWon(outcomes: PromiseSettledResult<unknown>[], refusals: readonly string[]) {
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const lost = outcomes.find((outcome) => outcome.status === "rejected");
    expect(refusals).toContain(reasonOf(lost));
  }

  /** Aliases of `user` named like one of their OWN pools' callable IDs (the invariant). */
  async function ownClashes(user: Person): Promise<string[]> {
    const { fixtures } = need();
    const [aliases, pools] = await Promise.all([
      fixtures.modelAlias.findMany({ where: { userId: user.id }, select: { name: true } }),
      fixtures.pool.findMany({
        where: { userId: user.id },
        select: { slug: true, User: { select: { slug: true } } },
      }),
    ]);
    const ids = new Set(pools.map((row) => `${row.User.slug}/${row.slug}`));
    return aliases.map((alias) => alias.name).filter((name) => ids.has(name));
  }

  it("a person's pool rename and their own alias of the new callable ID: one wins", async () => {
    const ann = await person("ann1");
    const chat = await pool(ann, "chat");
    const other = await pool(ann, "other");
    const outcomes = await race(ann, [
      () => as(ann).pools.update({ poolId: chat.id, slug: "talk" }),
      () => as(ann).pools.aliases.set({ name: `${ann.slug}/talk`, poolId: other.id }),
    ]);
    oneWon(outcomes, ["name_aliased", "alias_shadowed"]);
    expect(await ownClashes(ann)).toEqual([]);
  });

  it("a person's pool create and their own alias of its callable ID: one wins", async () => {
    const ann = await person("ann2");
    const other = await pool(ann, "other");
    const outcomes = await race(ann, [
      () => as(ann).pools.create({ slug: "next", name: "Next", type: "LLM" }),
      () => as(ann).pools.aliases.set({ name: `${ann.slug}/next`, poolId: other.id }),
    ]);
    oneWon(outcomes, ["name_aliased", "alias_shadowed"]);
    expect(await ownClashes(ann)).toEqual([]);
  });

  it("a person's account slug change and their own alias of a renamed callable ID: one wins", async () => {
    const ann = await person("ann3");
    await pool(ann, "chat");
    const other = await pool(ann, "other");
    const renamed = `ann3-new-${suffix}`;
    people.push({ ...ann, slug: renamed });
    const outcomes = await race(ann, [
      () => as(ann).settings.update({ slug: renamed }),
      () => as(ann).pools.aliases.set({ name: `${renamed}/chat`, poolId: other.id }),
    ]);
    // The alias is not a callable ID until the rename commits, so if it went first the rename
    // is refused; if the rename went first, the alias is.
    oneWon(outcomes, ["name_aliased", "alias_shadowed"]);
    expect(await ownClashes(ann)).toEqual([]);
  });

  /**
   * The share (or can use, or accepted invite) always lands; the recipient's alias either came
   * first and now wins for them (marked as hiding the pool; models.list names the alias's pool
   * under that ID), or came second and was refused. Never both refused, never an unmarked clash.
   */
  async function shareAlwaysLands(
    bob: Person,
    callableId: string,
    pools: { shared: string; own: string },
    outcomes: PromiseSettledResult<unknown>[],
  ) {
    expect(outcomes[0]?.status).toBe("fulfilled");
    const aliasOutcome = outcomes[1];
    const { aliases } = await as(bob).pools.aliases.list({});
    const { models } = await as(bob).models.list();
    const listed = models.filter((model) => model.callableId === callableId);
    if (aliasOutcome?.status === "fulfilled") {
      expect(aliases.find((alias) => alias.name === callableId)?.hides).toEqual({
        callableId,
        shared: true,
      });
      expect(listed.map((model) => model.poolId)).toEqual([pools.own]);
    } else {
      expect(reasonOf(aliasOutcome)).toBe("alias_shadowed");
      expect(aliases.some((alias) => alias.name === callableId)).toBe(false);
      expect(listed.map((model) => model.poolId)).toEqual([pools.shared]);
    }
  }

  it("a share grant racing the recipient's alias of its callable ID: the share always lands", async () => {
    const ann = await person("ann4");
    const bob = await person("bob4");
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
    await shareAlwaysLands(bob, `${ann.slug}/chat`, { shared: chat.id, own: own.id }, outcomes);
  });

  it("turning can use on racing the holder's alias of its callable ID: it always lands", async () => {
    const { fixtures } = need();
    const ann = await person("ann5");
    const bob = await person("bob5");
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
    await shareAlwaysLands(bob, `${ann.slug}/chat`, { shared: chat.id, own: own.id }, outcomes);
  });

  it("an invite link acceptance racing the recipient's alias: the accept always lands", async () => {
    const { fixtures } = need();
    const { acceptShareInviteByLink } = await import("../lib/share-invite-accept");
    const { generateShareInviteToken, shareInviteDigest } = await import("../lib/share-invites");
    const ann = await person("ann6");
    const bob = await person("bob6");
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
    const outcomes = await race(bob, [
      async () => {
        const accepted = await untilAnswered(() => acceptShareInviteByLink(bob, token));
        if (accepted !== "accepted") throw new Error(`not accepted: ${accepted}`);
      },
      () => as(bob).pools.aliases.set({ name: `${ann.slug}/chat`, poolId: own.id }),
    ]);
    await shareAlwaysLands(bob, `${ann.slug}/chat`, { shared: chat.id, own: own.id }, outcomes);
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

  it("never refuses an owner over a recipient's alias; still refuses the person's own", async () => {
    const ann = await person("ann8");
    const bob = await person("bob8");
    const chat = await pool(ann, "chat");
    const own = await pool(bob, "own");
    await as(bob).pools.aliases.set({ name: `${ann.slug}/chat`, poolId: own.id });
    await as(bob).pools.aliases.set({ name: `${ann.slug}/talk`, poolId: own.id });
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
    // Can use on, then a rename onto bob's other alias: neither looks at bob's names.
    await as(ann).access.shares.update({ shareId: created.share.id, canUse: true });
    await as(ann).pools.update({ poolId: chat.id, slug: "talk" });
    const { aliases } = await as(bob).pools.aliases.list({});
    expect(
      aliases.map((alias) => [alias.name, alias.hides?.callableId ?? null, alias.usable]).sort(),
    ).toEqual([
      [`${ann.slug}/chat`, null, true],
      [`${ann.slug}/talk`, `${ann.slug}/talk`, true],
    ]);
    // `ann/talk` is listed once, as the pool bob's alias reaches.
    expect(
      (await as(bob).models.list()).models.map((model) => [model.callableId, model.poolId]),
    ).toEqual([
      [`${bob.slug}/own`, own.id],
      [`${ann.slug}/talk`, own.id],
    ]);
    const { sharedWithMe } = await as(bob).pools.list();
    expect(sharedWithMe.find((entry) => entry.poolId === chat.id)?.hiddenByAlias).toBe(true);

    // The person's own aliases still refuse their own renames and creates.
    await as(ann).pools.aliases.set({ name: `${ann.slug}/next`, poolId: chat.id });
    await expect(as(ann).pools.update({ poolId: chat.id, slug: "next" })).rejects.toMatchObject({
      data: { reason: "name_aliased" },
    });
    await expect(
      as(ann).pools.create({ slug: "next", name: "Next", type: "LLM" }),
    ).rejects.toMatchObject({ data: { reason: "name_aliased" } });
    // And a new alias may not take a pool ID the person can call now.
    await expect(
      as(bob).pools.aliases.set({ name: `${bob.slug}/own`, poolId: own.id }),
    ).rejects.toMatchObject({ data: { reason: "alias_shadowed" } });
    expect(await ownClashes(ann)).toEqual([]);
    expect(await ownClashes(bob)).toEqual([]);
  });
});
