import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../../packages/db/prisma/generated/client";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => (key === "NODE_ENV" ? "test" : undefined),
  }),
}));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://resolve-aliases-test", NODE_ENV: "test" },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
const db = (await import("@ws-model-proxy/db")).default as unknown as ReturnType<
  typeof mockDeep<PrismaClient>
>;
const { listCallableTargetsForApiKey, listCallableTargetsForUser } = await import("./resolve.js");

const active = { banned: false, banExpires: null, deletionRequestedAt: null };
function pool(id: string) {
  return {
    id,
    slug: id,
    name: id,
    description: null,
    modelType: "LLM",
    userId: "u",
    User: { slug: "me", ...active },
    Fallback: null,
    Advanced: null,
    _count: { Members: 0 },
  };
}
const key = {
  id: "key-1",
  userId: "u",
  scope: "SELECTED_POOLS" as const,
  lookupPrefix: "p",
  expiresAt: null,
  lastUsedAt: null,
};

beforeEach(() => {
  mockReset(db);
  db.pool.findMany.mockResolvedValue([pool("a"), pool("b")] as never);
  db.share.findMany.mockResolvedValue([]);
  db.runtimeModel.findMany.mockResolvedValue([]);
  const rows = [
    { name: "gpt-4o", poolId: "a", apiKeyId: null },
    { name: "gpt-4o", poolId: "b", apiKeyId: "key-1" },
    { name: "claude", poolId: "a", apiKeyId: null },
  ];
  db.modelAlias.findMany.mockImplementation((async (args: {
    where: { OR: Array<{ apiKeyId: string | null }> };
  }) =>
    rows.filter((row) => args.where.OR.some((scope) => scope.apiKeyId === row.apiKeyId))) as never);
});

describe("caller aliases", () => {
  it("a key's alias wins over the user's, and only callable pools count", async () => {
    db.apiKeyPool.findMany.mockResolvedValue([{ poolId: "b" }] as never);
    const targets = await listCallableTargetsForApiKey(key);
    expect(db.modelAlias.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u", OR: [{ apiKeyId: null }, { apiKeyId: "key-1" }] },
      }),
    );
    expect(targets.pools.map((entry) => entry.id)).toEqual(["b"]);
    // "claude" names pool a, which this key cannot call: dropped.
    expect(targets.aliases).toEqual([{ name: "gpt-4o", poolId: "b" }]);
  });

  it("an alias for a pool the key cannot call never hides the user's alias", async () => {
    db.apiKeyPool.findMany.mockResolvedValue([{ poolId: "a" }] as never);
    const targets = await listCallableTargetsForApiKey(key);
    // The key's gpt-4o names pool b (not selected): the user-level gpt-4o -> a stays.
    expect(targets.aliases).toEqual([
      { name: "gpt-4o", poolId: "a" },
      { name: "claude", poolId: "a" },
    ]);
  });

  it("an alias named like a callable ID is never used, through any key (a clash from before the check)", async () => {
    const rows = [
      // Shadowed by the user's own pool a (`me/a`), which this key cannot call.
      { name: "me/a", poolId: "b", apiKeyId: null },
      // Shadowed by a share whose owner is inactive: still in the namespace.
      { name: "gone/x", poolId: "b", apiKeyId: "key-1" },
      { name: "free", poolId: "b", apiKeyId: null },
    ];
    db.modelAlias.findMany.mockResolvedValue(rows as never);
    db.share.findMany.mockResolvedValue([
      {
        id: "s1",
        ownKeyProviderModelId: null,
        Pool: {
          ...pool("x"),
          userId: "o",
          User: { slug: "gone", banned: true, banExpires: null, deletionRequestedAt: null },
        },
      },
    ] as never);
    db.apiKeyPool.findMany.mockResolvedValue([{ poolId: "b" }] as never);
    const viaKey = await listCallableTargetsForApiKey(key);
    expect(viaKey.pools.map((entry) => entry.id)).toEqual(["b"]);
    expect(viaKey.aliases).toEqual([{ name: "free", poolId: "b" }]);
    const viaSession = await listCallableTargetsForUser("u");
    expect(viaSession.aliases).toEqual([{ name: "free", poolId: "b" }]);
  });

  it("sessions see the user's aliases only", async () => {
    const targets = await listCallableTargetsForUser("u");
    expect(db.modelAlias.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u", OR: [{ apiKeyId: null }] } }),
    );
    expect(targets.aliases).toEqual([
      { name: "gpt-4o", poolId: "a" },
      { name: "claude", poolId: "a" },
    ]);
  });
});
