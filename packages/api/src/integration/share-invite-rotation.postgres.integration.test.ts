/**
 * An old invite link after a resend rotated its token (Codex finding 4), against real
 * PostgreSQL with the schema hardening (`pnpm test:postgres`). The rotation lands between the
 * link's first read and its fenced work: the presented token's digest is part of the fenced
 * re-read, the guarded acceptance write and the sign-up claim, so the old link opens nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

type Modules = {
  fixtures: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
  >;
  prisma: typeof import("@ws-model-proxy/db")["default"];
  accept: typeof import("../lib/share-invite-accept");
  invites: typeof import("../lib/share-invites");
};

integration("share invite token rotation on PostgreSQL", () => {
  let modules: Modules | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let ownerId = "";
  let friend = { id: "", email: "" };
  let poolId = "";

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    // CI sets these; a local run gets test-only values (never a real deployment's).
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const [fixtureClient, db, accept, invites] = await Promise.all([
      import("@ws-model-proxy/db/test-fixture-client"),
      import("@ws-model-proxy/db"),
      import("../lib/share-invite-accept"),
      import("../lib/share-invites"),
    ]);
    modules = {
      fixtures: fixtureClient.createFixturePrismaClient(databaseUrl),
      prisma: db.default,
      accept,
      invites,
    };
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
    ownerId = (await person("inviter")).id;
    friend = await person("invitee");
    const pool = await fixtures.pool.create({
      data: { userId: ownerId, slug: `invites-${suffix}`, name: "Invites", modelType: "LLM" },
      select: { id: true },
    });
    poolId = pool.id;
  });

  afterAll(async () => {
    if (!modules) return;
    const { fixtures } = modules;
    await fixtures.$transaction(async (tx) => {
      await tx.share.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await tx.shareInvite.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await tx.pool.deleteMany({ where: { userId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    });
    await fixtures.$disconnect();
  });

  /** A pending invite to an address with no account, opened by `token`. */
  async function invite(token: string, email: string) {
    if (!modules) throw new Error("modules unavailable");
    return modules.fixtures.shareInvite.create({
      data: {
        poolId,
        ownerUserId: ownerId,
        email,
        tokenDigest: modules.invites.shareInviteDigest(token),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      select: { id: true },
    });
  }

  /** What `invites.resend` writes: a new token, expiry, and a free claim. */
  async function rotate(inviteId: string, token: string) {
    if (!modules) throw new Error("modules unavailable");
    await modules.fixtures.shareInvite.update({
      where: { id: inviteId },
      data: {
        tokenDigest: modules.invites.shareInviteDigest(token),
        expiresAt: new Date(Date.now() + 86_400_000),
        signupClaimedAt: null,
        signupClaimedEmail: null,
      },
    });
  }

  /** The resend commits right after the link's first (unfenced) read of the invite. */
  function rotateAfterFirstRead(inviteId: string, token: string) {
    if (!modules) throw new Error("modules unavailable");
    const delegate = modules.prisma.shareInvite;
    const original = delegate.findFirst.bind(delegate);
    const spy = vi.spyOn(delegate, "findFirst");
    spy.mockImplementationOnce(((args: Parameters<typeof original>[0]) =>
      original(args).then(async (row) => {
        await rotate(inviteId, token);
        return row;
      })) as unknown as typeof original);
    return spy;
  }

  it("refuses the old link's acceptance when a resend lands mid-acceptance", async () => {
    if (!modules) throw new Error("modules unavailable");
    const { accept, invites, fixtures } = modules;
    const oldToken = invites.generateShareInviteToken();
    const newToken = invites.generateShareInviteToken();
    const row = await invite(oldToken, `accept-${suffix}@example.test`);
    const spy = rotateAfterFirstRead(row.id, newToken);
    try {
      await expect(accept.acceptShareInviteByLink(friend, oldToken)).resolves.toBe("invalid");
    } finally {
      spy.mockRestore();
    }
    const after = await fixtures.shareInvite.findUniqueOrThrow({
      where: { id: row.id },
      select: { acceptedAt: true, shareId: true },
    });
    expect(after).toEqual({ acceptedAt: null, shareId: null });
    expect(await fixtures.share.count({ where: { poolId, granteeUserId: friend.id } })).toBe(0);
    // The new link still works.
    await expect(accept.acceptShareInviteByLink(friend, newToken)).resolves.toBe("accepted");
    expect(await fixtures.share.count({ where: { poolId, granteeUserId: friend.id } })).toBe(1);
  });

  it("refuses the old link's sign-up claim when a resend lands mid-claim", async () => {
    if (!modules) throw new Error("modules unavailable");
    const { accept, invites, fixtures } = modules;
    const oldToken = invites.generateShareInviteToken();
    const newToken = invites.generateShareInviteToken();
    const row = await invite(oldToken, `claim-${suffix}@example.test`);
    const spy = rotateAfterFirstRead(row.id, newToken);
    try {
      await expect(
        accept.claimShareInviteForSignup(oldToken, `squatter-${suffix}@example.test`),
      ).resolves.toBe("invalid");
    } finally {
      spy.mockRestore();
    }
    const after = await fixtures.shareInvite.findUniqueOrThrow({
      where: { id: row.id },
      select: { signupClaimedAt: true, signupClaimedEmail: true },
    });
    expect(after).toEqual({ signupClaimedAt: null, signupClaimedEmail: null });
  });
});
