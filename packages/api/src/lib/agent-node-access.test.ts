import type { Prisma } from "@ws-model-proxy/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallerAuth } from "../contracts/auth-context";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const occupancy = vi.hoisted(() => ({
  launchCleanupNodes: vi.fn(),
  occupiedNodes: vi.fn(),
}));
vi.mock("./instance-occupancy", () => ({
  OCCUPANCY_SELECT: {},
  launchCleanupNodes: occupancy.launchCleanupNodes,
  occupiedNodes: occupancy.occupiedNodes,
}));

const { assertAgentInstanceNodes } = await import("./agent-node-access");

const db = {} as Prisma.TransactionClient;
const instance = { id: "inst1", Ranks: [] } as never;
const agent = (nodeIds: string[] | null): CallerAuth => ({
  kind: "agent_token",
  userId: "owner",
  agentTokenId: "tok",
  access: { scopes: ["read", "runtimes"], nodeIds },
});

describe("assertAgentInstanceNodes", () => {
  beforeEach(() => {
    occupancy.occupiedNodes.mockReturnValue([]);
    // A live launch still names a node that was deleted (offline-node recovery): no row.
    occupancy.launchCleanupNodes.mockResolvedValue([{ nodeId: "gone", node: null }]);
  });

  it("lets an all-nodes agent past a deleted node a launch still names (as before)", async () => {
    await expect(
      assertAgentInstanceNodes(db, agent(null), "owner", instance),
    ).resolves.toBeUndefined();
  });

  it("still refuses an allowlisted agent: a deleted node is never in its list", async () => {
    await expect(assertAgentInstanceNodes(db, agent(["n1"]), "owner", instance)).rejects.toThrow(
      "That instance does not exist.",
    );
  });

  it("refuses a node of another person whatever the allowlist", async () => {
    occupancy.launchCleanupNodes.mockResolvedValue([
      { nodeId: "theirs", node: { id: "theirs", userId: "other" } },
    ]);
    await expect(assertAgentInstanceNodes(db, agent(null), "owner", instance)).rejects.toThrow(
      "That instance does not exist.",
    );
  });
});
