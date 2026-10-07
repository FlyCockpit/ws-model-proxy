/**
 * Runtime sharing under the proved-mailbox rule, against real PostgreSQL with the schema
 * hardening (`pnpm test:postgres`): `runtimes.shares.create` shares directly only with a proved
 * mailbox and otherwise writes a runtime invite (graph-write fences, the partial unique index
 * per runtime and e-mail), the link becomes a runtime share, a resend rotates the link, and
 * deleting the runtime removes its invites. The hardening's own refusals for runtime invites
 * (one target, no pool settings, the runtime's owner, a share of its runtime) are checked on
 * the fixture client.
 *
 * Every row is removed afterwards, each delete scoped to this run's users.
 */
import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

type Modules = {
  fixtures: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
  >;
  appRouter: typeof import("../routers/index")["appRouter"];
  accept: typeof import("../lib/share-invite-accept");
};

const RUN = `rsi${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function sessionOf(user: { id: string; email: string }): Session {
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.id,
      role: "user",
      emailVerified: true,
      twoFactorEnabled: false,
    },
    session: { id: `s-${user.id}`, userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  } as Session;
}

integration("runtime share invites on PostgreSQL", () => {
  let modules: Modules | undefined;
  const userIds: string[] = [];
  const owner = { id: `${RUN}-owner`, email: `${RUN}-owner@example.test` };
  const proved = { id: `${RUN}-proved`, email: `${RUN}-proved@example.test` };
  const squatter = { id: `${RUN}-squatter`, email: `${RUN}-squatter@example.test` };
  const other = { id: `${RUN}-other`, email: `${RUN}-other@example.test` };
  let runtimeId = "";
  let otherRuntimeId = "";
  let poolId = "";

  function ownerClient() {
    const context: Context = {
      auth: { kind: "cookie_session", userId: owner.id, sessionId: "s", csrfVerified: true },
      session: sessionOf(owner),
    };
    if (!modules) throw new Error("modules unavailable");
    return createRouterClient(modules.appRouter, { context });
  }

  async function runtimeOf(userId: string, slug: string) {
    if (!modules) throw new Error("modules unavailable");
    const row = await modules.fixtures.runtime.create({
      data: { userId, slug, name: `Runtime ${slug}`, kind: "STARTABLE", origin: "SERVER" },
      select: { id: true },
    });
    return row.id;
  }

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    // CI sets these; a local run gets test-only values (never a real deployment's).
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const [fixtureClient, router, accept] = await Promise.all([
      import("@ws-model-proxy/db/test-fixture-client"),
      import("../routers/index"),
      import("../lib/share-invite-accept"),
    ]);
    modules = {
      fixtures: fixtureClient.createFixturePrismaClient(databaseUrl),
      appRouter: router.appRouter,
      accept,
    };
    const { fixtures } = modules;
    for (const [user, provedEmail] of [
      [owner, null],
      [proved, proved.email],
      [squatter, null],
      [other, null],
    ] as const) {
      await fixtures.user.create({
        data: {
          id: user.id,
          name: user.id,
          email: user.email,
          emailVerified: true,
          provedEmail,
          slug: user.id,
        },
      });
      userIds.push(user.id);
    }
    runtimeId = await runtimeOf(owner.id, "shared");
    otherRuntimeId = await runtimeOf(other.id, "theirs");
    poolId = (
      await fixtures.pool.create({
        data: { userId: owner.id, slug: `${RUN}-pool`, name: "Pool", modelType: "LLM" },
        select: { id: true },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    if (!modules) return;
    const { fixtures } = modules;
    try {
      const users = { in: userIds };
      await fixtures.shareInvite.deleteMany({ where: { ownerUserId: users } });
      await fixtures.runtimeShare.deleteMany({ where: { ownerUserId: users } });
      await fixtures.pool.deleteMany({ where: { userId: users } });
      await fixtures.runtime.deleteMany({ where: { userId: users } });
      await fixtures.user.deleteMany({ where: { id: users } });
    } finally {
      await fixtures.$disconnect();
    }
  }, 60_000);

  it("shares directly with a proved mailbox", async () => {
    if (!modules) throw new Error("modules unavailable");
    const result = await ownerClient().runtimes.shares.create({
      runtimeId,
      email: proved.email,
    });
    expect(result).toMatchObject({ kind: "share", share: { runtimeId, email: proved.email } });
    expect(
      await modules.fixtures.runtimeShare.count({
        where: { runtimeId, granteeUserId: proved.id },
      }),
    ).toBe(1);
    expect(await modules.fixtures.shareInvite.count({ where: { email: proved.email } })).toBe(0);
  });

  it("answers an unproved account and an unknown e-mail alike, with an invite", async () => {
    if (!modules) throw new Error("modules unavailable");
    const unproved = await ownerClient().runtimes.shares.create({
      runtimeId,
      email: squatter.email,
    });
    const unknown = await ownerClient().runtimes.shares.create({
      runtimeId,
      email: `${RUN}-nobody@example.test`,
    });
    for (const result of [unproved, unknown]) {
      if (result.kind !== "invite") throw new Error("expected an invite");
      expect(Object.keys(result).sort()).toEqual(["invite", "kind", "link"]);
      expect(result.invite.target).toEqual({ kind: "runtime", runtimeId, name: "Runtime shared" });
      expect(result.link).toMatch(/\/signup\?invite=wsmp_inv_[A-Z2-7]{26}$/);
    }
    // No runtime share for the squatter that registered the address.
    expect(
      await modules.fixtures.runtimeShare.count({
        where: { runtimeId, granteeUserId: squatter.id },
      }),
    ).toBe(0);
    // A second pending invite to the same runtime and e-mail is refused.
    await expect(
      ownerClient().runtimes.shares.create({ runtimeId, email: squatter.email }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("turns the link into a runtime share, after a resend only through the new link", async () => {
    if (!modules) throw new Error("modules unavailable");
    const created = await ownerClient().runtimes.shares.create({
      runtimeId,
      email: `${RUN}-friend@example.test`,
    });
    if (created.kind !== "invite" || !created.link) throw new Error("expected an invite link");
    const oldToken = new URL(created.link).searchParams.get("invite") ?? "";
    // The resend cooldown counts from the last write: age the invite past it.
    await modules.fixtures
      .$executeRaw`UPDATE share_invite SET "updatedAt" = now() - interval '2 minutes' WHERE id = ${created.invite.id}`;
    const resent = await ownerClient().access.invites.resend({ inviteId: created.invite.id });
    expect(resent.invite.target).toMatchObject({ kind: "runtime", runtimeId });
    const newToken = new URL(resent.link ?? "").searchParams.get("invite") ?? "";
    await expect(modules.accept.acceptShareInviteByLink(other, oldToken)).resolves.toBe("invalid");
    await expect(modules.accept.acceptShareInviteByLink(owner, newToken)).resolves.toBe("own");
    await expect(modules.accept.acceptShareInviteByLink(other, newToken)).resolves.toBe("accepted");
    const share = await modules.fixtures.runtimeShare.findUniqueOrThrow({
      where: { runtimeId_granteeUserId: { runtimeId, granteeUserId: other.id } },
      select: { id: true, ownerUserId: true },
    });
    expect(share.ownerUserId).toBe(owner.id);
    expect(
      await modules.fixtures.shareInvite.findUniqueOrThrow({
        where: { id: created.invite.id },
        select: { runtimeShareId: true, shareId: true, acceptedAt: true },
      }),
    ).toEqual({ runtimeShareId: share.id, shareId: null, acceptedAt: expect.any(Date) });
    // Stopping the share keeps the accepted invite as history, its link nulled.
    await ownerClient().runtimes.shares.delete({ shareId: share.id });
    expect(
      await modules.fixtures.shareInvite.findUniqueOrThrow({
        where: { id: created.invite.id },
        select: { runtimeShareId: true },
      }),
    ).toEqual({ runtimeShareId: null });
  });

  it("refuses runtime invite rows the hardening forbids", async () => {
    if (!modules) throw new Error("modules unavailable");
    const { fixtures } = modules;
    const base = {
      ownerUserId: owner.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    const digest = (char: string) => char.repeat(64);
    // Neither or both targets.
    await expect(
      fixtures.shareInvite.create({
        data: { ...base, email: `${RUN}-x@example.test`, tokenDigest: digest("1") },
      }),
    ).rejects.toThrow(/share_invite_target_shape/);
    await expect(
      fixtures.shareInvite.create({
        data: {
          ...base,
          poolId,
          runtimeId,
          email: `${RUN}-x@example.test`,
          tokenDigest: digest("2"),
        },
      }),
    ).rejects.toThrow(/share_invite_target_shape/);
    // A runtime invite carries no pool settings.
    await expect(
      fixtures.shareInvite.create({
        data: {
          ...base,
          runtimeId,
          email: `${RUN}-x@example.test`,
          tokenDigest: digest("3"),
          canContribute: true,
        },
      }),
    ).rejects.toThrow(/share_invite_target_shape/);
    // Only the runtime's owner invites to it (composite foreign key).
    await expect(
      fixtures.shareInvite.create({
        data: {
          ...base,
          runtimeId: otherRuntimeId,
          email: `${RUN}-x@example.test`,
          tokenDigest: digest("4"),
        },
      }),
    ).rejects.toThrow();
    // A pool invite and a runtime invite to one e-mail may both be pending.
    const email = `${RUN}-both@example.test`;
    await fixtures.shareInvite.create({
      data: { ...base, poolId, email, tokenDigest: digest("5") },
    });
    const runtimeInvite = await fixtures.shareInvite.create({
      data: { ...base, runtimeId, email, tokenDigest: digest("6") },
      select: { id: true },
    });
    await expect(
      fixtures.shareInvite.create({
        data: { ...base, runtimeId, email, tokenDigest: digest("7") },
      }),
    ).rejects.toThrow(/share_invite_one_pending_runtime|Unique constraint/);
    // The accepted invite names a share of its own runtime.
    const elsewhere = await runtimeOf(owner.id, "elsewhere");
    const wrongShare = await fixtures.runtimeShare.create({
      data: { runtimeId: elsewhere, ownerUserId: owner.id, granteeUserId: squatter.id },
      select: { id: true },
    });
    await expect(
      fixtures.shareInvite.update({
        where: { id: runtimeInvite.id },
        data: { acceptedAt: new Date(), runtimeShareId: wrongShare.id },
      }),
    ).rejects.toThrow(/share of its runtime/);
  });

  it("deleting the runtime removes its invites", async () => {
    if (!modules) throw new Error("modules unavailable");
    const doomed = await runtimeOf(owner.id, "doomed");
    const created = await ownerClient().runtimes.shares.create({
      runtimeId: doomed,
      email: `${RUN}-late@example.test`,
    });
    if (created.kind !== "invite" || !created.link) throw new Error("expected an invite link");
    const token = new URL(created.link).searchParams.get("invite") ?? "";
    await ownerClient().runtimes.delete({ runtimeId: doomed });
    expect(await modules.fixtures.shareInvite.count({ where: { runtimeId: doomed } })).toBe(0);
    await expect(modules.accept.isPendingShareInvite(token)).resolves.toBe(false);
  });
});
