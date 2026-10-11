/**
 * settings.update with a new account slug: it renames every callable ID of the person's pools,
 * so it claims the new names in their own namespace (lib/model-names.ts) under their owner
 * fence. Share holders' aliases are never looked at: one with a renamed ID wins for its holder.
 */
import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));
const fenceLog = vi.hoisted(() => ({ held: [] as string[] }));
vi.mock("@ws-model-proxy/db/capacity-lock-order", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ws-model-proxy/db/capacity-lock-order")>();
  return {
    ...real,
    acquireFences: vi.fn(async (_tx: unknown, requested: Iterable<string>) => {
      fenceLog.held.push(...requested);
      return true;
    }),
    requireOwnerFences: vi.fn(async (_tx: unknown, userIds: Iterable<string>) => {
      const missing = [...userIds].filter((id) => !fenceLog.held.includes(`00:owner:${id}`));
      if (missing.length > 0) throw new real.MissingOwnerFenceError(missing);
    }),
    runCapacityOrderedTransaction: vi.fn(
      (db: { $transaction: (work: unknown) => unknown }, work: (tx: unknown) => unknown) =>
        db.$transaction(work),
    ),
  };
});

import prisma from "@ws-model-proxy/db";
import type { Context } from "../context";
import { settingsRouter } from "./settings";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const ME = "user-1";

function client() {
  const context: Context = {
    auth: { kind: "cookie_session", userId: ME, sessionId: "s", csrfVerified: true },
    session: {
      user: {
        id: ME,
        email: "u@example.test",
        name: "U",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
      },
      session: { id: "s", userId: ME, expiresAt: new Date(Date.now() + 60_000) },
    } as Session,
  };
  return createRouterClient(settingsRouter, { context });
}

const settingsRow = {
  name: "U",
  email: "u@example.test",
  slug: "ann",
  locale: "en-US",
  operationalAlerts: true,
  twoFactorEnabled: null,
  onboardingDoneAt: null,
};

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError)
      return (error.data as { reason?: string } | undefined)?.reason ?? error.code;
    throw error;
  }
  return undefined;
}

beforeEach(() => {
  mockReset(db);
  fenceLog.held.length = 0;
  db.$transaction.mockImplementation(((work: (tx: PrismaClient) => unknown) => work(db)) as never);
  db.user.findUnique.mockResolvedValue(settingsRow as never);
  db.pool.findMany.mockResolvedValue([
    { id: "pool-1", slug: "chat" },
    { id: "pool-2", slug: "embed" },
  ] as never);
  db.share.findMany.mockResolvedValue([
    { poolId: "pool-1", granteeUserId: "bob" },
    { poolId: "pool-2", granteeUserId: "cy" },
  ] as never);
  db.modelAlias.findMany.mockResolvedValue([]);
});

describe("settings.update slug", () => {
  it("claims every renamed callable ID in the person's own namespace, under their fence only", async () => {
    await client().update({ slug: "anna" });
    expect(fenceLog.held).toEqual(["00:owner:user-1"]);
    expect(db.modelAlias.findMany.mock.calls[0]?.[0]?.where).toEqual({
      OR: [{ userId: ME, name: { in: ["anna/chat", "anna/embed"] } }],
    });
    // Share holders are not even listed.
    expect(db.share.findMany).not.toHaveBeenCalled();
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: ME }, data: { slug: "anna" } });
  });

  it("refuses a slug that renames onto the person's own alias, rolling everything back", async () => {
    db.modelAlias.findMany.mockResolvedValue([{ userId: ME, name: "anna/embed" }] as never);
    expect(await reasonOf(client().update({ slug: "anna", name: "Anna" }))).toBe("name_aliased");
    // The refusal rolls the transaction back: no audit, nothing else written after the slug.
    expect(db.auditEvent.create).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: "Anna" } }),
    );
  });

  it("answers slug_taken for another account's slug before looking at any alias", async () => {
    db.user.update.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    // Even when the person's own alias would clash: the unique slug decides first.
    db.modelAlias.findMany.mockResolvedValue([{ userId: ME, name: "anna/chat" }] as never);
    expect(await reasonOf(client().update({ slug: "anna" }))).toBe("slug_taken");
    expect(db.modelAlias.findMany).not.toHaveBeenCalled();
  });

  it("writes the slug, the other fields and an audit event in one transaction", async () => {
    await client().update({ slug: "anna", locale: "es-MX" });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.user.update.mock.calls.map((call) => call[0]?.data)).toEqual([
      { slug: "anna" },
      { locale: "es-MX" },
    ]);
    expect(db.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: ME,
        actor: "USER",
        action: "account.slug_change",
        resourceType: "user",
        resourceId: ME,
        before: { slug: "ann" },
        after: { slug: "anna" },
      }),
    });
  });

  it("re-sending the current slug writes and claims nothing", async () => {
    await client().update({ slug: "ann" });
    expect(db.modelAlias.findMany).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });

  it("refuses a reserved or malformed slug before any read", async () => {
    expect(await reasonOf(client().update({ slug: "Bad Slug" }))).toBe("BAD_REQUEST");
    expect(await reasonOf(client().update({ slug: "admin" }))).toBe("BAD_REQUEST");
    expect(db.pool.findMany).not.toHaveBeenCalled();
  });
});
