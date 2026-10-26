import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));

import { toProfileView } from "./procedures";

const row = {
  id: "p-1",
  slug: "evening",
  name: "Evening",
  description: null,
  editor: "USER" as const,
  editorUserId: "owner-1",
  updatedAt: new Date("2026-10-06T10:00:00Z"),
  Nodes: [
    { nodeId: "a", hold: false, holdNote: null },
    { nodeId: "b", hold: true, holdNote: "games" },
  ],
  Items: [
    {
      id: "it-1",
      position: 0,
      runtimeId: "rt-1",
      versionId: "v-1",
      count: 1,
      nodeIds: [],
      Runtime: { slug: "qwen", currentVersionId: "v-2" },
      Version: { version: 1 },
    },
  ],
  Operations: [],
};

function instance(
  id: string,
  runtimeId: string,
  launchVersionId: string,
  nodes: string[],
  reserved: Array<{ nodeId: string; supersededGeneration?: number }> = [],
) {
  const node = (nodeId: string) => ({
    id: nodeId,
    slug: nodeId,
    trust: "FULL" as const,
    trustLowerRequestedAt: null,
  });
  return {
    id,
    runtimeId,
    launchVersionId,
    desiredState: "RUNNING" as const,
    phase: "READY" as const,
    Ranks: nodes.map((nodeId, rank) => ({
      rank,
      nodeId,
      claim: "HELD" as const,
      Node: node(nodeId),
    })),
    Reservations: reserved.map((row, index) => ({
      index,
      nodeId: row.nodeId,
      supersededGeneration: row.supersededGeneration ?? null,
      Node: node(row.nodeId),
    })),
  };
}

describe("toProfileView", () => {
  it("is satisfied when the pinned item runs and nothing else does", () => {
    const view = toProfileView(row, [instance("i-1", "rt-1", "v-1", ["a"])]);
    expect(view.items[0]).toMatchObject({ runningNow: 1, pinOutdated: true, versionNumber: 1 });
    expect(view.satisfied).toBe(true);
    expect(view.holds).toEqual([{ nodeId: "b", note: "games" }]);
  });

  it("is not satisfied while another runtime runs on an owned node", () => {
    const view = toProfileView(row, [
      instance("i-1", "rt-1", "v-1", ["a"]),
      instance("i-2", "rt-9", "v-9", ["a"]),
    ]);
    expect(view.satisfied).toBe(false);
  });

  it("does not count an instance on a hold-line node or outside the profile", () => {
    const view = toProfileView(row, [
      instance("i-1", "rt-1", "v-1", ["b"]),
      instance("i-2", "rt-1", "v-1", ["elsewhere", "a"]),
    ]);
    expect(view.items[0]?.runningNow).toBe(0);
    expect(view.satisfied).toBe(false);
  });

  it("does not count an instance whose current reservation is on a hold-line node", () => {
    const view = toProfileView(row, [instance("i-1", "rt-1", "v-1", ["a"], [{ nodeId: "b" }])]);
    expect(view.items[0]?.runningNow).toBe(0);
    expect(view.satisfied).toBe(false);
    // A replaced run's superseded row there is not the instance's plan.
    const replaced = toProfileView(row, [
      instance("i-1", "rt-1", "v-1", ["a"], [{ nodeId: "b", supersededGeneration: 1 }]),
    ]);
    expect(replaced.items[0]?.runningNow).toBe(1);
  });

  it("is not satisfied while an instance from outside reserves an owned node", () => {
    const view = toProfileView(row, [
      instance("i-1", "rt-1", "v-1", ["a"]),
      instance("i-2", "rt-9", "v-9", ["elsewhere"], [{ nodeId: "a" }]),
    ]);
    expect(view.items[0]?.runningNow).toBe(1);
    expect(view.satisfied).toBe(false);
  });
});
