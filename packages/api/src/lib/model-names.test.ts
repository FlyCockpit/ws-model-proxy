import { ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

import { MissingOwnerFenceError } from "@ws-model-proxy/db/capacity-lock-order";
import {
  isCallableIdShaped,
  modelNameClashes,
  refuseCallableIdClash,
  sessionNames,
} from "./model-names";

/** A transaction double: the fence setting it reports, and the two reads the check makes. */
function txHolding(fences: string[]) {
  return {
    $queryRaw: vi.fn(async () => [{ held: `,${fences.join(",")},` }]),
    pool: {
      findFirst: vi.fn(
        async () =>
          null as {
            userId: string;
            User: { banned: boolean; banExpires: Date | null; deletionRequestedAt: Date | null };
          } | null,
      ),
    },
    modelAlias: {
      findMany: vi.fn(async () => [] as Array<{ userId: string; name: string }>),
    },
  };
}
type TxDouble = ReturnType<typeof txHolding>;
const check = (tx: TxDouble, claims: Parameters<typeof modelNameClashes>[1]) =>
  modelNameClashes(tx as unknown as Parameters<typeof modelNameClashes>[0], claims);

describe("modelNameClashes", () => {
  it("refuses to check without every claimant's owner fence", async () => {
    const tx = txHolding(["00:owner:ann"]);
    await expect(
      check(tx, [
        { userId: "ann", alias: "x" },
        { userId: "bob", callableIds: ["ann/chat"] },
      ]),
    ).rejects.toBeInstanceOf(MissingOwnerFenceError);
    expect(tx.pool.findFirst).not.toHaveBeenCalled();
    expect(tx.modelAlias.findMany).not.toHaveBeenCalled();
  });

  it("checks an `a/b` alias against the pools the person owns or may use", async () => {
    const tx = txHolding(["00:owner:ann"]);
    const active = { banned: false, banExpires: null, deletionRequestedAt: null };
    tx.pool.findFirst.mockResolvedValueOnce({ userId: "bob", User: active });
    await expect(check(tx, [{ userId: "ann", alias: "bob/chat" }])).resolves.toEqual([
      { userId: "ann", name: "bob/chat" },
    ]);
    expect(tx.pool.findFirst).toHaveBeenCalledWith({
      where: {
        slug: "chat",
        User: { slug: "bob" },
        OR: [{ userId: "ann" }, { Shares: { some: { granteeUserId: "ann", canUse: true } } }],
      },
      select: {
        userId: true,
        User: { select: { banned: true, banExpires: true, deletionRequestedAt: true } },
      },
    });
    // Any other shape can never be a callable ID.
    for (const alias of ["gpt-4o", "org/team/model", "/chat", "bob/"])
      await expect(check(tx, [{ userId: "ann", alias }])).resolves.toEqual([]);
    expect(tx.pool.findFirst).toHaveBeenCalledTimes(1);
  });

  it("an inactive owner's shared pool is not callable now: no clash", async () => {
    const tx = txHolding(["00:owner:ann"]);
    tx.pool.findFirst.mockResolvedValueOnce({
      userId: "bob",
      User: { banned: true, banExpires: null, deletionRequestedAt: null },
    });
    await expect(check(tx, [{ userId: "ann", alias: "bob/chat" }])).resolves.toEqual([]);
    tx.pool.findFirst.mockResolvedValueOnce({
      userId: "bob",
      User: { banned: false, banExpires: null, deletionRequestedAt: new Date() },
    });
    await expect(check(tx, [{ userId: "ann", alias: "bob/chat" }])).resolves.toEqual([]);
    // An expired ban no longer counts.
    tx.pool.findFirst.mockResolvedValueOnce({
      userId: "bob",
      User: { banned: true, banExpires: new Date(Date.now() - 1000), deletionRequestedAt: null },
    });
    await expect(check(tx, [{ userId: "ann", alias: "bob/chat" }])).resolves.toEqual([
      { userId: "ann", name: "bob/chat" },
    ]);
  });

  it("checks new callable IDs against every alias scope of each person, in one read", async () => {
    const tx = txHolding(["00:owner:ann", "00:owner:bob"]);
    // A key-level and a user-level alias of one name are one clash.
    tx.modelAlias.findMany.mockResolvedValueOnce([
      { userId: "bob", name: "ann/chat" },
      { userId: "bob", name: "ann/chat" },
    ]);
    await expect(
      check(tx, [
        { userId: "ann", callableIds: ["ann/chat", "ann/embed"] },
        { userId: "bob", callableIds: ["ann/chat"] },
        { userId: "bob", callableIds: ["ann/embed"] },
      ]),
    ).resolves.toEqual([{ userId: "bob", name: "ann/chat" }]);
    expect(tx.modelAlias.findMany).toHaveBeenCalledTimes(1);
    expect(tx.modelAlias.findMany.mock.calls[0]).toEqual([
      {
        where: {
          OR: [
            { userId: "ann", name: { in: ["ann/chat", "ann/embed"] } },
            { userId: "bob", name: { in: ["ann/chat", "ann/embed"] } },
          ],
        },
        select: { userId: true, name: true },
        orderBy: [{ userId: "asc" }, { name: "asc" }],
      },
    ]);
  });

  it("accepts the test fixtures' wildcard as every fence", async () => {
    const tx = txHolding(["*"]);
    await expect(check(tx, [{ userId: "zed", callableIds: ["a/b"] }])).resolves.toEqual([]);
  });
});

describe("refuseCallableIdClash", () => {
  const reason = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof ORPCError) return { reason: error.data?.reason, message: error.message };
      throw error;
    }
    return null;
  };

  it("refuses only with name_aliased, naming no one", () => {
    expect(reason(() => refuseCallableIdClash([]))).toBeNull();
    const refused = reason(() => refuseCallableIdClash([{ userId: "ann", name: "ann/chat" }]));
    expect(refused?.reason).toBe("name_aliased");
    expect(refused?.message).not.toMatch(/ann/);
  });
});

describe("sessionNames", () => {
  it("hides a callable ID an alias names when it points elsewhere, as a session routes", async () => {
    const findMany = vi.fn(async () => [
      { name: "ann/chat", poolId: "own", apiKeyId: null },
      { name: "ann/self", poolId: "self-pool", apiKeyId: null },
      // A key's alias elsewhere, but the alias for every key points at the pool: not hidden
      // for a session (which routes through that alias to the pool).
      { name: "ann/self", poolId: "own", apiKeyId: "key-1" },
      // Only a key's alias: the name is the alias's everywhere, and a session reaches nothing.
      { name: "ann/keyed", poolId: "own", apiKeyId: "key-1" },
      { name: "gpt-4o", poolId: "own", apiKeyId: null },
    ]);
    const names = await sessionNames(
      { modelAlias: { findMany } } as unknown as Parameters<typeof sessionNames>[0],
      "bob",
    );
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "bob" },
      select: { name: true, poolId: true, apiKeyId: true },
    });
    expect(names.hides("ann/chat", "ann-pool")).toBe(true);
    expect(names.aliasPool("ann/chat")).toBe("own");
    expect(names.hides("ann/self", "self-pool")).toBe(false);
    expect(names.hides("ann/keyed", "keyed-pool")).toBe(true);
    expect(names.aliasPool("ann/keyed")).toBeUndefined();
    expect(names.hides("ann/other", "x")).toBe(false);
  });

  it("only `a/b` names can be callable IDs", () => {
    expect(isCallableIdShaped("ann/chat")).toBe(true);
    for (const name of ["gpt-4o", "a/b/c", "/b", "a/"])
      expect(isCallableIdShaped(name)).toBe(false);
  });
});
