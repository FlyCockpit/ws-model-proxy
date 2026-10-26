import { describe, expect, it } from "vitest";
import {
  agentBlockedNode,
  currentReservations,
  type OccupancyRow,
  occupiedNodeIds,
  occupiedNodes,
  occupiesNodesWhere,
  placedOnNodesWhere,
} from "./instance-occupancy";

const node = (id: string, trust: "FULL" | "RELAY" | null = "FULL", pending = false) => ({
  id,
  trust,
  trustLowerRequestedAt: pending ? new Date("2026-10-01T00:00:00Z") : null,
});

function row(input: {
  ranks?: Array<{ nodeId: string | null; claim?: "HELD" | "HELD_UNKNOWN" | "RELEASED" }>;
  reservations?: Array<{ nodeId: string | null; superseded?: number }>;
  trust?: Record<string, ["FULL" | "RELAY" | null, boolean?]>;
}): OccupancyRow {
  const nodeOf = (id: string | null) => {
    if (id === null) return null;
    const [trust, pending] = input.trust?.[id] ?? ["FULL", false];
    return node(id, trust, pending);
  };
  return {
    Ranks: (input.ranks ?? [{ nodeId: "head" }]).map((rank, index) => ({
      rank: index,
      nodeId: rank.nodeId,
      claim: rank.claim ?? "HELD",
      Node: nodeOf(rank.nodeId),
    })),
    Reservations: (input.reservations ?? []).map((reservation, index) => ({
      index,
      nodeId: reservation.nodeId,
      supersededGeneration: reservation.superseded ?? null,
      Node: nodeOf(reservation.nodeId),
    })),
  };
}

describe("occupiedNodes", () => {
  const instance = row({
    ranks: [{ nodeId: "head" }],
    reservations: [{ nodeId: "w1" }, { nodeId: "w0", superseded: 2 }],
  });

  it("holding: held ranks and every reservation row while a rank holds", () => {
    expect(occupiedNodes(instance, "holding").map((entry) => [entry.role, entry.nodeId])).toEqual([
      ["rank", "head"],
      ["reservation", "w1"],
      ["reservation", "w0"],
    ]);
    expect(occupiedNodes(instance, "holding")[2]?.current).toBe(false);
  });

  it("current: every rank and the current plan's reservations", () => {
    expect(occupiedNodeIds(instance, "current")).toEqual(["head", "w1"]);
  });

  it("holding: nothing of a released instance, and a marked-stopped rank still holds", () => {
    const released = row({
      ranks: [{ nodeId: "head", claim: "RELEASED" }],
      reservations: [{ nodeId: "w1" }],
    });
    expect(occupiedNodes(released, "holding")).toEqual([]);
    // Its plan is still where it was.
    expect(occupiedNodeIds(released, "current")).toEqual(["head", "w1"]);
    const unknown = row({
      ranks: [{ nodeId: "head", claim: "HELD_UNKNOWN" }],
      reservations: [{ nodeId: "w1" }],
    });
    expect(occupiedNodeIds(unknown, "holding")).toEqual(["head", "w1"]);
  });

  it("leaves deleted nodes out of the ids and keeps them as entries", () => {
    const deleted = row({ ranks: [{ nodeId: null }], reservations: [{ nodeId: "w1" }] });
    expect(occupiedNodeIds(deleted, "holding")).toEqual(["w1"]);
    expect(occupiedNodes(deleted, "holding")[0]).toMatchObject({ nodeId: null, node: null });
  });

  it("currentReservations drops superseded rows", () => {
    expect(currentReservations(instance.Reservations).map((entry) => entry.nodeId)).toEqual(["w1"]);
  });
});

describe("agentBlockedNode", () => {
  it("is null when every rank and holding reservation node is at Full control", () => {
    expect(agentBlockedNode(row({ reservations: [{ nodeId: "w1" }] }))).toBeNull();
  });

  it("names a reservation node at Relay only, a pending lowering, or one that never said hello", () => {
    for (const trust of [
      ["RELAY", false],
      ["FULL", true],
      [null, false],
    ] as const)
      expect(
        agentBlockedNode(row({ reservations: [{ nodeId: "w1" }], trust: { w1: [...trust] } })),
      ).toMatchObject({ role: "reservation", nodeId: "w1" });
  });

  it("holding scope includes a replaced run's superseded row; current scope does not", () => {
    const instance = row({
      reservations: [{ nodeId: "w1" }, { nodeId: "w0", superseded: 1 }],
      trust: { w0: ["RELAY"] },
    });
    expect(agentBlockedNode(instance)?.nodeId).toBe("w0");
    expect(agentBlockedNode(instance, "current")).toBeNull();
  });

  it("ignores reservations of an instance that holds nothing (they hold nothing)", () => {
    const released = row({
      ranks: [{ nodeId: "head", claim: "RELEASED" }],
      reservations: [{ nodeId: "w1" }],
      trust: { w1: ["RELAY"] },
    });
    expect(agentBlockedNode(released)).toBeNull();
  });

  it("a deleted node blocks (agents refused, a person decides), rank or reservation", () => {
    // A head deleted while a reservation on a surviving node keeps its rank HELD.
    expect(
      agentBlockedNode(row({ ranks: [{ nodeId: null }], reservations: [{ nodeId: "w1" }] })),
    ).toMatchObject({ role: "rank", nodeId: null });
    expect(agentBlockedNode(row({ reservations: [{ nodeId: null }] }))).toMatchObject({
      role: "reservation",
      nodeId: null,
    });
  });

  it("checks every rank the caller passes, whatever its claim", () => {
    expect(
      agentBlockedNode(
        row({ ranks: [{ nodeId: "head", claim: "RELEASED" }], trust: { head: ["RELAY"] } }),
      )?.nodeId,
    ).toBe("head");
  });
});

describe("where clauses", () => {
  it("occupiesNodesWhere: a held rank there, or a reservation there while a rank holds", () => {
    expect(occupiesNodesWhere(["n"])).toEqual({
      OR: [
        { Ranks: { some: { nodeId: { in: ["n"] }, claim: { not: "RELEASED" } } } },
        {
          Reservations: { some: { nodeId: { in: ["n"] } } },
          Ranks: { some: { claim: { not: "RELEASED" } } },
        },
      ],
    });
  });

  it("placedOnNodesWhere: a rank there, or a current reservation there", () => {
    expect(placedOnNodesWhere(["n"])).toEqual({
      OR: [
        { Ranks: { some: { nodeId: { in: ["n"] } } } },
        { Reservations: { some: { nodeId: { in: ["n"] }, supersededGeneration: null } } },
      ],
    });
  });
});
