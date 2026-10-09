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
  db.modelAlias.findMany.mockResolvedValue([
    { name: "gpt-4o", poolId: "a", apiKeyId: null },
    { name: "gpt-4o", poolId: "b", apiKeyId: "key-1" },
    { name: "claude", poolId: "a", apiKeyId: null },
    { name: "other-key", poolId: "a", apiKeyId: "key-2" },
  ] as never);
});

const sharedPool = (id: string, ownerSlug: string, user: Record<string, unknown> = {}) => ({
  id: `s-${id}`,
  ownKeyProviderModelId: null,
  Pool: { ...pool(id), userId: "o", User: { slug: ownerSlug, ...active, ...user } },
});

describe("caller aliases", () => {
  it("reads every alias of the person once, whatever the key", async () => {
    db.apiKeyPool.findMany.mockResolvedValue([{ poolId: "b" }] as never);
    await listCallableTargetsForApiKey(key);
    expect(db.modelAlias.findMany).toHaveBeenCalledTimes(1);
    expect(db.modelAlias.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u" } }),
    );
  });

  it("a key's alias wins over the user's, and only callable pools count", async () => {
    db.apiKeyPool.findMany.mockResolvedValue([{ poolId: "b" }] as never);
    const targets = await listCallableTargetsForApiKey(key);
    expect(targets.pools.map((entry) => entry.id)).toEqual(["b"]);
    // "claude" names pool a, which this key cannot call: dropped. Another key's alias never counts.
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

  it("sessions see the user's aliases only", async () => {
    const targets = await listCallableTargetsForUser("u");
    expect(targets.aliases).toEqual([
      { name: "gpt-4o", poolId: "a" },
      { name: "claude", poolId: "a" },
    ]);
  });
});

describe("an alias wins over the callable ID it is named like", () => {
  it("hides the shared pool's ID for the person, through every key, and keeps the alias", async () => {
    db.share.findMany.mockResolvedValue([sharedPool("chat", "ann")] as never);
    db.modelAlias.findMany.mockResolvedValue([
      // bob's alias from before ann shared `ann/chat` with him.
      { name: "ann/chat", poolId: "a", apiKeyId: null },
      // A key-scoped alias of another key hides it too: a name means the same everywhere.
      { name: "me/b", poolId: "a", apiKeyId: "key-2" },
      // Named like the pool it points at: hides nothing.
      { name: "me/a", poolId: "a", apiKeyId: null },
    ] as never);
    const viaSession = await listCallableTargetsForUser("u");
    expect([...viaSession.shadowed].sort()).toEqual(["ann/chat", "me/b"]);
    expect(viaSession.aliases).toEqual([
      { name: "ann/chat", poolId: "a" },
      { name: "me/a", poolId: "a" },
    ]);
    // The pools stay callable (by id, and as other aliases' targets).
    expect(viaSession.pools.map((entry) => entry.id)).toEqual(["a", "b", "chat"]);

    db.apiKeyPool.findMany.mockResolvedValue([{ poolId: "chat" }] as never);
    const viaKey = await listCallableTargetsForApiKey(key);
    // This key cannot call pool a, so the alias is not usable through it, and the ID stays hidden.
    expect(viaKey.aliases).toEqual([]);
    expect([...viaKey.shadowed].sort()).toEqual(["ann/chat", "me/b"]);
  });

  it("a share whose owner is inactive is not callable, so nothing of it is hidden", async () => {
    db.share.findMany.mockResolvedValue([sharedPool("x", "gone", { banned: true })] as never);
    db.modelAlias.findMany.mockResolvedValue([
      { name: "gone/x", poolId: "a", apiKeyId: null },
    ] as never);
    const targets = await listCallableTargetsForUser("u");
    expect(targets.pools.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(targets.shadowed.size).toBe(0);
    expect(targets.aliases).toEqual([{ name: "gone/x", poolId: "a" }]);
  });
});
