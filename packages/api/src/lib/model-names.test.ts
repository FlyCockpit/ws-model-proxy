import { ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

import { MissingOwnerFenceError } from "@ws-model-proxy/db/capacity-lock-order";
import { modelNameClashes, refuseCallableIdClash } from "./model-names";

/** A transaction double: the fence setting it reports, and the two reads the check makes. */
function txHolding(fences: string[]) {
  return {
    $queryRaw: vi.fn(async () => [{ held: `,${fences.join(",")},` }]),
    pool: { findFirst: vi.fn(async () => null as { id: string } | null) },
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
    tx.pool.findFirst.mockResolvedValueOnce({ id: "pool-1" });
    await expect(check(tx, [{ userId: "ann", alias: "bob/chat" }])).resolves.toEqual([
      { userId: "ann", name: "bob/chat" },
    ]);
    expect(tx.pool.findFirst).toHaveBeenCalledWith({
      where: {
        slug: "chat",
        User: { slug: "bob" },
        OR: [{ userId: "ann" }, { Shares: { some: { granteeUserId: "ann", canUse: true } } }],
      },
      select: { id: true },
    });
    // Any other shape can never be a callable ID.
    for (const alias of ["gpt-4o", "org/team/model", "/chat", "bob/"])
      await expect(check(tx, [{ userId: "ann", alias }])).resolves.toEqual([]);
    expect(tx.pool.findFirst).toHaveBeenCalledTimes(1);
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

  it("names the actor's own alias, and only says 'unavailable' for anyone else's", () => {
    expect(reason(() => refuseCallableIdClash([], "ann"))).toBeNull();
    expect(
      reason(() => refuseCallableIdClash([{ userId: "ann", name: "ann/chat" }], "ann"))?.reason,
    ).toBe("name_aliased");
    const other = reason(() => refuseCallableIdClash([{ userId: "bob", name: "ann/chat" }], "ann"));
    expect(other?.reason).toBe("name_unavailable");
    expect(other?.message).not.toMatch(/bob|ann\/chat/);
  });
});
