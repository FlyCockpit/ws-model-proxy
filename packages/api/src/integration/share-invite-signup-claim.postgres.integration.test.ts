/**
 * An invite-link sign-up's claim and its release after a failed sign-up, against real
 * PostgreSQL with the schema hardening (`pnpm test:postgres`). Neither write may move the
 * invite's `updatedAt` (Prisma's `@updatedAt`, the owner's resend cooldown clock), so a sign-up
 * attempt that created no account leaves no trace the owner could see; and a release never
 * drops a claim whose e-mail has an account (a concurrent sign-up of that e-mail won).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

type Modules = {
  fixtures: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
  >;
  accept: typeof import("../lib/share-invite-accept");
  invites: typeof import("../lib/share-invites");
};

integration("share invite sign-up claim on PostgreSQL", () => {
  let modules: Modules | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let ownerId = "";
  let member = { id: "", email: "" };
  let poolId = "";

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    // CI sets these; a local run gets test-only values (never a real deployment's).
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const [fixtureClient, accept, invites] = await Promise.all([
      import("@ws-model-proxy/db/test-fixture-client"),
      import("../lib/share-invite-accept"),
      import("../lib/share-invites"),
    ]);
    modules = { fixtures: fixtureClient.createFixturePrismaClient(databaseUrl), accept, invites };
    const { fixtures } = modules;
    const person = async (name: string) => {
      const row = await fixtures.user.create({
        data: {
          name,
          email: `${name}-${suffix}@example.test`,
          emailVerified: true,
          slug: `${name}-${suffix}`,
        },
        select: { id: true, email: true },
      });
      userIds.push(row.id);
      return row;
    };
    ownerId = (await person("claim-owner")).id;
    member = await person("claim-member");
    const pool = await fixtures.pool.create({
      data: { userId: ownerId, slug: `claims-${suffix}`, name: "Claims", modelType: "LLM" },
      select: { id: true },
    });
    poolId = pool.id;
  });

  afterAll(async () => {
    if (!modules) return;
    const { fixtures } = modules;
    await fixtures.$transaction(async (tx) => {
      await tx.shareInvite.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await tx.pool.deleteMany({ where: { userId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    });
    await fixtures.$disconnect();
  });

  /** A pending invite opened by `token`, last changed by its owner a while ago. */
  async function invite(token: string) {
    if (!modules) throw new Error("modules unavailable");
    return modules.fixtures.shareInvite.create({
      data: {
        poolId,
        ownerUserId: ownerId,
        email: `invited-${crypto.randomUUID().slice(0, 8)}@example.test`,
        tokenDigest: modules.invites.shareInviteDigest(token),
        expiresAt: new Date(Date.now() + 86_400_000),
        updatedAt: new Date(Date.now() - 3_600_000),
      },
      select: { id: true, updatedAt: true },
    });
  }

  async function state(id: string) {
    if (!modules) throw new Error("modules unavailable");
    return modules.fixtures.shareInvite.findUniqueOrThrow({
      where: { id },
      select: { updatedAt: true, signupClaimedAt: true, signupClaimedEmail: true },
    });
  }

  it("claims and releases without moving the owner's cooldown clock", async () => {
    if (!modules) throw new Error("modules unavailable");
    const { accept, invites } = modules;
    const token = invites.generateShareInviteToken();
    const row = await invite(token);
    const email = `free-${suffix}@example.test`;
    const claimedAt = new Date();
    await expect(accept.claimShareInviteForSignup(token, email, claimedAt)).resolves.toBe(
      "claimed",
    );
    expect(await state(row.id)).toEqual({
      updatedAt: row.updatedAt,
      signupClaimedAt: claimedAt,
      signupClaimedEmail: email,
    });
    await accept.releaseShareInviteSignupClaim(token, email, claimedAt);
    expect(await state(row.id)).toEqual({
      updatedAt: row.updatedAt,
      signupClaimedAt: null,
      signupClaimedEmail: null,
    });
  });

  it("leaves a later claim, and a claim whose e-mail has an account, in place", async () => {
    if (!modules) throw new Error("modules unavailable");
    const { accept, invites } = modules;
    const token = invites.generateShareInviteToken();
    const row = await invite(token);
    const first = new Date(Date.now() - 1_000);
    const later = new Date();
    // The same e-mail took the claim over (a concurrent sign-up): the earlier one releases nothing.
    await accept.claimShareInviteForSignup(token, member.email, first);
    await accept.claimShareInviteForSignup(token, member.email, later);
    await accept.releaseShareInviteSignupClaim(token, member.email, first);
    expect((await state(row.id)).signupClaimedAt).toEqual(later);
    // The claimant has an account (its sign-up won): the losing request keeps its claim.
    await accept.releaseShareInviteSignupClaim(token, member.email, later);
    expect(await state(row.id)).toEqual({
      updatedAt: row.updatedAt,
      signupClaimedAt: later,
      signupClaimedEmail: member.email,
    });
  });
});
