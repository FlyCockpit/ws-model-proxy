import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import { modelAliasesRouter } from "./aliases";
import { CALLERS, contextFor, OWNER } from "./lane-c-test-helpers";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

function client(auth = CALLERS.fullAgent()) {
  return createRouterClient(modelAliasesRouter, { context: contextFor(auth) });
}

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

const ACTIVE = { banned: false, banExpires: null, deletionRequestedAt: null };
const POOLS = [
  { id: "pool-own", slug: "chat", userId: OWNER, User: { slug: "me", ...ACTIVE } },
  { id: "pool-shared", slug: "big", userId: "friend-id", User: { slug: "friend", ...ACTIVE } },
];

function aliasRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "alias-1",
    name: "gpt-4o",
    poolId: "pool-own",
    apiKeyId: null,
    Pool: { slug: "chat", User: { slug: "me" } },
    ApiKey: null,
    ...overrides,
  };
}

/** Every fence requested through `wsmp_acquire_fences`, in request order. */
function heldFences(): string[] {
  return db.$queryRaw.mock.calls.flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
}

beforeEach(() => {
  mockReset(db);
  db.pool.findMany.mockResolvedValue(POOLS as never);
  db.pool.findFirst.mockResolvedValue(null);
  db.$transaction.mockImplementation((async (work: unknown) =>
    typeof work === "function" ? work(db) : undefined) as never);
  // The fence protocol: requireOwnerFences reads back what acquireFences took.
  db.$queryRaw.mockImplementation((async (query: TemplateStringsArray) =>
    query.join("").includes("current_setting('wsmp.fences'")
      ? [{ held: `,${heldFences().join(",")},` }]
      : [{ acquired: true }]) as never);
});

describe("model-name aliases", () => {
  it("lists the caller's aliases with the callable ID and whether they still work", async () => {
    db.modelAlias.findMany.mockResolvedValue([
      aliasRow(),
      aliasRow({
        id: "alias-2",
        name: "claude-sonnet-4-5",
        poolId: "pool-gone",
        Pool: { slug: "old", User: { slug: "ex" } },
      }),
      aliasRow({
        id: "alias-3",
        apiKeyId: "key-1",
        poolId: "pool-shared",
        ApiKey: {
          name: "ci",
          scope: "SELECTED_POOLS",
          revokedAt: null,
          expiresAt: null,
          Pools: [{ poolId: "pool-own" }],
        },
      }),
    ] as never);
    const { aliases } = await client().list({});
    expect(db.modelAlias.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: OWNER } }),
    );
    expect(aliases.map((alias) => [alias.name, alias.callableId, alias.usable])).toEqual([
      ["gpt-4o", "me/chat", true],
      ["claude-sonnet-4-5", null, false],
      ["gpt-4o", "friend/big", false],
    ]);
    // Keys are for people: an agent sees the key id, not its name.
    expect(aliases[2]?.apiKeyName).toBeNull();
    const asPerson = await client(CALLERS.person()).list({});
    expect(asPerson.aliases[2]?.apiKeyName).toBe("ci");
  });

  it("an agent sets an alias to a pool it can use, audited, in its own namespace", async () => {
    db.modelAlias.findUnique.mockResolvedValue(null);
    db.modelAlias.count.mockResolvedValue(3);
    db.modelAlias.upsert.mockResolvedValue(aliasRow({ poolId: "pool-shared" }) as never);
    const view = await client().set({ name: "gpt-4o", poolId: "pool-shared", note: "harness" });
    expect(view).toMatchObject({ callableId: "friend/big", usable: true });
    expect(db.modelAlias.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_scopeKey_name: { userId: OWNER, scopeKey: "", name: "gpt-4o" } },
        create: {
          userId: OWNER,
          apiKeyId: null,
          scopeKey: "",
          name: "gpt-4o",
          poolId: "pool-shared",
        },
        update: { poolId: "pool-shared" },
      }),
    );
    expect(db.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: OWNER,
        actor: "AGENT",
        action: "model_alias.set",
        resourceType: "model_alias",
        after: { name: "gpt-4o", poolId: "pool-shared", apiKeyId: null, note: "harness" },
      }),
    });
  });

  it("never points an alias at a pool the caller cannot use", async () => {
    expect(await reasonOf(client().set({ name: "gpt-4o", poolId: "pool-other" }))).toBe(
      "NOT_FOUND",
    );
    expect(db.modelAlias.upsert).not.toHaveBeenCalled();
  });

  it("refuses a name that is a callable ID, a key it cannot use, and past the limit", async () => {
    db.pool.findFirst.mockResolvedValueOnce({ userId: OWNER, User: ACTIVE } as never);
    expect(await reasonOf(client().set({ name: "me/chat", poolId: "pool-own" }))).toBe(
      "alias_shadowed",
    );
    // Checked under the caller's owner fence, against pools they own or may use.
    expect(heldFences()).toEqual([`00:owner:${OWNER}`]);
    expect(db.pool.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      slug: "chat",
      User: { slug: "me" },
      OR: [{ userId: OWNER }, { Shares: { some: { granteeUserId: OWNER, canUse: true } } }],
    });
    db.apiKey.findFirst.mockResolvedValueOnce(null);
    expect(
      await reasonOf(client().set({ name: "gpt-4o", poolId: "pool-own", apiKeyId: "key-x" })),
    ).toBe("NOT_FOUND");
    expect(db.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "key-x",
          userId: OWNER,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        },
      }),
    );
    db.apiKey.findFirst.mockResolvedValueOnce({ scope: "SELECTED_POOLS", Pools: [] } as never);
    expect(
      await reasonOf(client().set({ name: "gpt-4o", poolId: "pool-own", apiKeyId: "key-1" })),
    ).toBe("alias_key_not_allowed");
    db.modelAlias.findUnique.mockResolvedValue(null);
    db.modelAlias.count.mockResolvedValue(64);
    expect(await reasonOf(client().set({ name: "new-name", poolId: "pool-own" }))).toBe(
      "alias_limit",
    );
    expect(db.modelAlias.upsert).not.toHaveBeenCalled();
  });

  it("checks only `a/b` names against callable IDs", async () => {
    db.modelAlias.findUnique.mockResolvedValue(null);
    db.modelAlias.count.mockResolvedValue(0);
    db.modelAlias.upsert.mockResolvedValue(aliasRow({ name: "org/team/model" }) as never);
    await client().set({ name: "org/team/model", poolId: "pool-own" });
    await client().set({ name: "gpt-4o", poolId: "pool-own" });
    expect(db.pool.findFirst).not.toHaveBeenCalled();
    expect(db.modelAlias.upsert).toHaveBeenCalledTimes(2);
  });

  it("marks an alias named like a pool it hides (the alias wins), keeping it usable", async () => {
    db.modelAlias.findMany.mockResolvedValue([
      // Hides friend's pool shared with the caller.
      aliasRow({ name: "friend/big" }),
      // Hides the caller's own pool (a clash from before the check).
      aliasRow({ id: "alias-2", name: "me/chat", poolId: "pool-shared" }),
      // Named like the pool it points at: hides nothing.
      aliasRow({ id: "alias-3", name: "me/chat" }),
      aliasRow({ id: "alias-4", name: "gpt-4o" }),
    ] as never);
    const { aliases } = await client().list({});
    expect(aliases.map(({ id, usable, hides }) => ({ id, usable, hides }))).toEqual([
      { id: "alias-1", usable: true, hides: { callableId: "friend/big", shared: true } },
      { id: "alias-2", usable: true, hides: { callableId: "me/chat", shared: false } },
      { id: "alias-3", usable: true, hides: null },
      { id: "alias-4", usable: true, hides: null },
    ]);
  });

  it("an inactive owner's pool is neither hidden nor reachable now", async () => {
    db.pool.findMany.mockResolvedValue([
      POOLS[0],
      { ...POOLS[1], User: { slug: "friend", ...ACTIVE, deletionRequestedAt: new Date() } },
    ] as never);
    db.modelAlias.findMany.mockResolvedValue([
      aliasRow({ name: "friend/big" }),
      aliasRow({ id: "alias-2", name: "gpt-4o", poolId: "pool-shared" }),
    ] as never);
    const { aliases } = await client().list({});
    expect(aliases.map(({ id, usable, hides }) => ({ id, usable, hides }))).toEqual([
      { id: "alias-1", usable: true, hides: null },
      { id: "alias-2", usable: false, hides: null },
    ]);
  });

  it("refuses names that are variants or direct tests", async () => {
    for (const name of ["gpt-4o:external", "runtime:x:y", "-bad", "a b"])
      expect(await reasonOf(client().set({ name, poolId: "pool-own" }))).toBe("BAD_REQUEST");
  });

  it("deletes only the caller's own alias", async () => {
    db.modelAlias.findFirst.mockResolvedValue(null);
    expect(await reasonOf(client().delete({ aliasId: "alias-x" }))).toBe("NOT_FOUND");
    expect(db.modelAlias.deleteMany).not.toHaveBeenCalled();
    db.modelAlias.findFirst.mockResolvedValue({ id: "alias-1" } as never);
    await client().delete({ aliasId: "alias-1" });
    expect(db.modelAlias.deleteMany).toHaveBeenCalledWith({
      where: { id: "alias-1", userId: OWNER },
    });
  });
});
