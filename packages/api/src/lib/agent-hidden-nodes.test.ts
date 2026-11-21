import type { Prisma } from "@ws-model-proxy/db";
import { describe, expect, it, vi } from "vitest";
import type { CallerAuth } from "../contracts/auth-context";
import { hiddenNodeIds, instanceVisible, visibleInstancesWhere } from "./agent-hidden-nodes";

const agent = (nodeIds: string[] | null): CallerAuth => ({
  kind: "agent_token",
  userId: "owner",
  agentTokenId: "t",
  access: { scopes: ["read"], nodeIds },
});

describe("hidden node predicate", () => {
  it("queries only owned nodes once and never treats someone else's node as hidden", async () => {
    const findMany = vi.fn(async () => [{ id: "allowed" }, { id: "hidden" }]);
    const db = { node: { findMany } } as unknown as Prisma.TransactionClient;
    expect(await hiddenNodeIds(db, agent(["allowed"]))).toEqual(["hidden"]);
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "owner" },
      select: { id: true },
    });
    expect(await hiddenNodeIds(db, agent(null))).toEqual([]);
    expect(
      await hiddenNodeIds(db, {
        kind: "cookie_session",
        userId: "owner",
        sessionId: "s",
        csrfVerified: true,
      }),
    ).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("hides rankless always-on instances by their runtime binding", () => {
    const instance = { Ranks: [], Reservations: [] };
    expect(instanceVisible(instance, new Set(["hidden"]), "hidden")).toBe(false);
    expect(instanceVisible(instance, new Set(["hidden"]), "allowed")).toBe(true);
    expect(instanceVisible(instance, new Set(["hidden"]), "another-owner")).toBe(true);
    expect(instanceVisible(instance, new Set(), "hidden")).toBe(true);
    expect(instanceVisible(instance, new Set(["hidden"]), null)).toBe(true);
  });

  it("excludes the whole instance for a hidden rank or reservation, including superseded holds", () => {
    const hidden = new Set(["hidden"]);
    expect(
      instanceVisible({ Ranks: [{ nodeId: "allowed" }, { nodeId: "hidden" }] }, hidden, null),
    ).toBe(false);
    expect(
      instanceVisible(
        { Ranks: [{ nodeId: "allowed" }], Reservations: [{ nodeId: "hidden" }] },
        hidden,
        null,
      ),
    ).toBe(false);
    expect(
      instanceVisible({ Ranks: [{ nodeId: null }, { nodeId: "another-owner" }] }, hidden, null),
    ).toBe(true);
    expect(instanceVisible({ Ranks: [{ nodeId: "hidden" }] }, new Set(), null)).toBe(true);
    expect(visibleInstancesWhere(["hidden"])).toEqual({
      NOT: {
        OR: [
          { Runtime: { nodeId: { in: ["hidden"] } } },
          { Ranks: { some: { nodeId: { in: ["hidden"] } } } },
          { Reservations: { some: { nodeId: { in: ["hidden"] } } } },
        ],
      },
    });
    expect(visibleInstancesWhere([])).toEqual({});
  });
});
