/**
 * Cloud spend against real PostgreSQL with the schema hardening applied (part of the preview
 * gate: `pnpm test:postgres`). The mocked unit tests see neither the spend SQL nor the graph
 * write fences, so this walks the spend paths through the real procedures and the model API's
 * spend functions:
 *
 *   provider account → model (its execution target) → price → account cap → pool → share cap
 *   → reservation (admitProviderBudget) → settlement (reconcileProviderBudget)
 *   → providerAccountSpend / shareSpend and the account and share views → cap refusals
 *   → own-key choice cleared by an equivalent change.
 */
import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";
import type { CallerAuth } from "../contracts/auth-context";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

type User = { id: string; email: string; name: string };
type Modules = {
  fixtures: ReturnType<typeof createFixturePrismaClient>;
  appRouter: typeof import("../routers/index")["appRouter"];
  prisma: typeof import("@ws-model-proxy/db")["default"];
  spend: typeof import("@ws-model-proxy/db/spend");
  budget: typeof import("../../../../apps/server/src/model-api/provider-budget");
};

integration("cloud spend on PostgreSQL with the schema hardening", () => {
  let modules: Modules | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  let owner: User;
  let grantee: User;
  /** Hot-path rows the test seeds (no foreign key to their user): removed by id afterwards. */
  const seeded = { requestIds: [] as string[], attemptIds: [] as string[] };

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    // CI sets these; a local run gets test-only values (never a real deployment's).
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    process.env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS ??= `v1:${Buffer.alloc(32, 7).toString("base64")}`;
    const [router, db, spend, budget] = await Promise.all([
      import("../routers/index"),
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/spend"),
      import("../../../../apps/server/src/model-api/provider-budget"),
    ]);
    modules = {
      fixtures: createFixturePrismaClient(databaseUrl),
      appRouter: router.appRouter,
      prisma: db.default,
      spend,
      budget,
    };
    const person = (name: string) =>
      modules!.fixtures.user.create({
        data: {
          name,
          email: `${name}-${suffix}@example.test`,
          emailVerified: true,
          // A direct share by e-mail needs the mailbox proved (the verify-email flow sets it).
          provedEmail: `${name}-${suffix}@example.test`,
          slug: `${name}-${suffix}`,
        },
        select: { id: true, email: true, name: true },
      });
    owner = await person("spender");
    grantee = await person("sharer");
  });

  afterAll(async () => {
    if (!modules) return;
    const { fixtures } = modules;
    const userIds = [owner?.id, grantee?.id].filter((id): id is string => Boolean(id));
    const attemptId = { in: seeded.attemptIds };
    await fixtures.$transaction(async (tx) => {
      // Spend history is append-only outside user deletion: clean up as that writer.
      await tx.$executeRaw`SELECT set_config('wsmp.user_deletion_writer', 'on', true)`;
      await tx.spendSettlement.deleteMany({ where: { attemptId } });
      await tx.usageLedger.deleteMany({ where: { attemptId } });
      await tx.spendReservation.deleteMany({ where: { attemptId } });
      await tx.attemptEvent.deleteMany({ where: { attemptId } });
      await tx.attempt.deleteMany({ where: { id: attemptId } });
      await tx.relayRequest.deleteMany({ where: { id: { in: seeded.requestIds } } });
      // The users' graph, NoAction edges first (`deleteUserGraphInOrder`).
      await tx.pool.deleteMany({ where: { userId: { in: userIds } } });
      await tx.spendCap.deleteMany({ where: { userId: { in: userIds } } });
      await tx.providerPricingVersion.deleteMany({ where: { userId: { in: userIds } } });
      // A replaced key points at its replacement: it goes first.
      await tx.providerCredential.deleteMany({
        where: { userId: { in: userIds }, replacedById: { not: null } },
      });
      await tx.providerAccount.deleteMany({ where: { userId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    });
    await fixtures.$disconnect();
  });

  function client(user: User) {
    const session = {
      user: { ...user, role: "user", emailVerified: true, twoFactorEnabled: false },
      session: { id: `s-${user.id}`, userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
    } as Session;
    const auth: CallerAuth = {
      kind: "cookie_session",
      userId: user.id,
      sessionId: `s-${user.id}`,
      csrfVerified: true,
    };
    const context: Context = { auth, session };
    if (!modules) throw new Error("modules unavailable");
    return createRouterClient(modules.appRouter, { context });
  }

  async function providerModel(user: User, label: string) {
    const me = client(user);
    const account = await me.providers.accounts.create({
      providerType: "generic",
      label,
      baseUrl: "https://provider.example.test",
      authType: "BEARER",
      secret: "sk-integration-test-only",
    });
    await me.providers.accounts.setEnabled({ accountId: account.id, enabled: true });
    const model = await me.providers.models.create({
      accountId: account.id,
      upstreamModelId: "vendor/model-1",
      type: "LLM",
    });
    await me.providers.models.update({ modelId: model.id, enabled: true });
    return { account, model };
  }

  it("reserves and settles under the caps, and every read agrees on the sums", async () => {
    if (!modules) throw new Error("modules unavailable");
    const { fixtures, prisma, spend, budget } = modules;
    const me = client(owner);

    // ── Provider account and model: the model's execution target exists at once ──
    const { account, model } = await providerModel(owner, `cloud-${suffix}`);
    const targets = await fixtures.executionTarget.findMany({
      where: { providerModelId: model.id },
      select: { userId: true, kind: true },
    });
    expect(targets).toEqual([{ userId: owner.id, kind: "PROVIDER_MODEL" }]);

    const draft = await me.providers.pricing.create({
      modelId: model.id,
      currency: "USD",
      pricing: { input: "1", output: "2" },
    });
    const price = await me.providers.pricing.activate({ versionId: draft.id });
    expect(price.status).toBe("ACTIVE");

    // ── Caps: the account's, then a share's ──
    await me.providers.spendCaps.set({
      accountId: account.id,
      monthlyLimit: "10",
      currency: "USD",
    });
    const pool = await me.pools.create({ slug: `spend-${suffix}`, name: "Spend", type: "LLM" });
    const created = await me.access.shares.create({
      poolId: pool.id,
      email: grantee.email,
      canUse: true,
      canContribute: false,
      priorityClass: null,
      protectionPercent: null,
      monthlyCap: { limit: "3", currency: "USD" },
    });
    if (created.kind !== "share") throw new Error("expected a share");
    const shareId = created.share.id;

    // ── Reservation: owner-paid share traffic reserves against both caps ──
    // The share holder's `:external` request the attempts serve (the relay stands in here).
    const request = await fixtures.relayRequest.create({
      data: { userId: grantee.id, source: "API_KEY", poolId: pool.id, external: true },
      select: { id: true },
    });
    seeded.requestIds.push(request.id);
    const attempt = (attemptId: string, liability: string) => ({
      userId: owner.id,
      providerAccountId: account.id,
      providerModelId: model.id,
      poolId: pool.id,
      shareId,
      granteeUserId: grantee.id,
      requestId: request.id,
      attemptId,
      fencingToken: 1n,
      liability: {
        spend: liability,
        currency: "USD",
        pricingVersion: price.version,
        accountingVersion: "provider-billable-v1",
      },
      expiresAt: new Date(Date.now() + 120_000),
    });
    const first = crypto.randomUUID();
    seeded.attemptIds.push(first);
    const admitted = await budget.admitProviderBudget(attempt(first, "0.5"));
    expect(admitted).toMatchObject({ admitted: true });
    if (!admitted.admitted) throw new Error("refused");
    expect(admitted.reservationIds).toHaveLength(2);

    const sums = async () => ({
      account: await spend.providerAccountSpend(prisma, {
        providerAccountId: account.id,
        currency: "USD",
      }),
      share: await spend.shareSpend(prisma, { shareId, currency: "USD" }),
    });
    const asStrings = (usage: { spentThisMonth: unknown; reservedNow: unknown }) => ({
      spent: String(usage.spentThisMonth),
      reserved: String(usage.reservedNow),
    });
    let now = await sums();
    expect(asStrings(now.account)).toEqual({ spent: "0", reserved: "0.5" });
    expect(asStrings(now.share)).toEqual({ spent: "0", reserved: "0.5" });

    // ── Settlement: the reported cost replaces the reservation ──
    await budget.reconcileProviderBudget({
      userId: owner.id,
      providerAccountId: account.id,
      providerModelId: model.id,
      poolId: pool.id,
      requestId: request.id,
      attemptId: first,
      fencingToken: 1n,
      reason: "COMPLETED",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
      observationComplete: true,
      usage: {
        inputTokens: 100n,
        outputTokens: 50n,
        reportedCost: "0.2",
        currency: "USD",
        pricingVersion: price.version,
        accountingVersion: "provider-billable-v1",
        confidence: "REPORTED",
        observationComplete: true,
      },
    });
    now = await sums();
    expect(asStrings(now.account)).toEqual({ spent: "0.2", reserved: "0" });
    expect(asStrings(now.share)).toEqual({ spent: "0.2", reserved: "0" });

    // The views read the same sums.
    const accounts = await me.providers.accounts.list();
    const listed = accounts.accounts.find((row) => row.id === account.id);
    expect(listed?.spend).toMatchObject({
      monthlyLimit: "10",
      currency: "USD",
      spentThisMonth: "0.2",
      reservedNow: "0",
    });
    const shares = await me.access.shares.list();
    expect(shares.byMe.find((row) => row.id === shareId)?.monthlyCap).toEqual({
      limit: "3",
      currency: "USD",
      spentThisMonth: "0.2",
    });

    // ── The share cap refuses what would pass it (0.2 settled + 3 > 3) ──
    const over = await budget.admitProviderBudget(attempt(crypto.randomUUID(), "3"));
    expect(over).toMatchObject({ admitted: false, reason: "GRANTEE_BUDGET_EXCEEDED" });

    // The batched share read agrees with the single one.
    const batched = await spend.sharesSpend(prisma, { shareIds: [shareId], currency: "USD" });
    expect(asStrings(batched.get(shareId) ?? { spentThisMonth: "?", reservedNow: "?" })).toEqual({
      spent: "0.2",
      reserved: "0",
    });
    expect(
      await spend.providerAccountSpendCurrencies(prisma, { providerAccountId: account.id }),
    ).toEqual(["USD"]);
    expect(await spend.shareSpendCurrencies(prisma, { shareId })).toEqual(["USD"]);

    // ── A cap names only the currency spent in this month ──
    const refused = { data: { reason: "cap_currency_has_spend" } };
    await expect(
      me.providers.spendCaps.set({ accountId: account.id, monthlyLimit: "10", currency: "EUR" }),
    ).rejects.toMatchObject(refused);
    await expect(
      me.access.shares.update({ shareId, monthlyCap: { limit: "3", currency: "EUR" } }),
    ).rejects.toMatchObject(refused);
    // A limit-only edit keeps the cap's currency (and changes under the spend fences).
    const kept = await me.providers.spendCaps.set({ accountId: account.id, monthlyLimit: "12" });
    expect(kept).toMatchObject({ monthlyLimit: "12", currency: "USD" });
    await me.access.shares.update({ shareId, monthlyCap: { limit: "4", currency: "USD" } });
    // Clearing and setting again is no way around it, for either cap.
    await me.providers.spendCaps.clear({ accountId: account.id });
    await expect(
      me.providers.spendCaps.set({ accountId: account.id, monthlyLimit: "10", currency: "EUR" }),
    ).rejects.toMatchObject(refused);
    const again = await me.providers.spendCaps.set({ accountId: account.id, monthlyLimit: "10" });
    expect(again).toMatchObject({ monthlyLimit: "10", currency: "USD" });
    await me.access.shares.update({ shareId, monthlyCap: null });
    await expect(
      me.access.shares.update({ shareId, monthlyCap: { limit: "3", currency: "EUR" } }),
    ).rejects.toMatchObject(refused);
    await me.access.shares.update({ shareId, monthlyCap: { limit: "3", currency: "USD" } });

    // ── Key rotation: the account's current key moves within one transaction ──
    const before = await fixtures.providerAccount.findUniqueOrThrow({
      where: { id: account.id },
      select: { currentCredentialId: true },
    });
    await me.providers.credentials.replace({
      accountId: account.id,
      secret: "sk-integration-test-only-rotated",
    });
    const after = await fixtures.providerAccount.findUniqueOrThrow({
      where: { id: account.id },
      select: { currentCredentialId: true },
    });
    expect(after.currentCredentialId).not.toBe(before.currentCredentialId);
    const previous = await fixtures.providerCredential.findUniqueOrThrow({
      where: { id: before.currentCredentialId ?? "" },
      select: { status: true, replacedById: true },
    });
    expect(previous).toMatchObject({ replacedById: after.currentCredentialId });
    expect(previous.status).not.toBe("ACTIVE");
  });

  it("an equivalent change clears a share holder's own-key choice", async () => {
    if (!modules) throw new Error("modules unavailable");
    const me = client(owner);
    const them = client(grantee);
    const pool = await me.pools.create({ slug: `own-key-${suffix}`, name: "Own key", type: "LLM" });
    const created = await me.access.shares.create({
      poolId: pool.id,
      email: grantee.email,
      canUse: true,
      canContribute: false,
      priorityClass: null,
      protectionPercent: null,
      monthlyCap: null,
    });
    if (created.kind !== "share") throw new Error("expected a share");
    const shareId = created.share.id;
    await me.pools.cloud.setOwnKeyEquivalent({ poolId: pool.id, model: "vendor/model-1" });

    // The share holder's choice: written under both owners' fences.
    const { model } = await providerModel(grantee, `mine-${suffix}`);
    const chosen = await them.access.shares.setOwnKey({
      shareId,
      providerModelId: model.id,
      protocolAdaptation: true,
    });
    expect(chosen).toMatchObject({
      ownKeyProviderModelId: model.id,
      ownKeyProtocolAdaptation: true,
    });

    // Re-saving the same equivalent keeps it; a new one clears it in the same transaction.
    await me.pools.cloud.setOwnKeyEquivalent({ poolId: pool.id, model: "vendor/model-1" });
    const kept = await modules.fixtures.share.findUniqueOrThrow({
      where: { id: shareId },
      select: { ownKeyProviderModelId: true },
    });
    expect(kept.ownKeyProviderModelId).toBe(model.id);
    await me.pools.cloud.setOwnKeyEquivalent({ poolId: pool.id, model: "vendor/model-2" });
    const cleared = await modules.fixtures.share.findUniqueOrThrow({
      where: { id: shareId },
      select: { ownKeyProviderModelId: true, ownKeyProtocolAdaptation: true },
    });
    expect(cleared).toEqual({ ownKeyProviderModelId: null, ownKeyProtocolAdaptation: false });
  });
});
