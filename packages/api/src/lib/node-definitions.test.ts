import type { Prisma } from "@ws-model-proxy/db";
import { beforeEach, describe, expect, it } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import { RUN_START_PHASES, RUNTIME_JOB_PRE_ADMISSION_ERRORS } from "./instance-run";
import { requiredDefinitionsByNode } from "./node-definitions";

const db = mockDeep<Prisma.TransactionClient>();
const OWNER = "u-1";

function intent(launchVersionId: string) {
  return {
    operationId: null,
    runtimeId: "rt-1",
    launchVersionId,
    launchHash: "h",
    rank: 0,
    nnodes: 1,
    handle: "i-abcdefabcdef",
    unitName: "wsmp-rt-i-abcdefabcdef-0.service",
    port: 30000,
    distPort: null,
    fabricId: null,
    placeholders: {},
    timeoutMs: 60_000,
    interactive: false,
  };
}

/** The owner's server-origin versions (what the version filter returns). */
function serverVersions(...ids: string[]) {
  db.runtimeVersion.findMany.mockImplementation((async (args: {
    where: { id: { in: string[] } };
  }) => args.where.id.in.filter((id) => ids.includes(id)).map((id) => ({ id }))) as never);
}

beforeEach(() => {
  mockReset(db);
  db.instanceRank.findMany.mockResolvedValue([]);
  db.instanceStep.findMany.mockResolvedValue([]);
  db.$queryRaw.mockResolvedValue([] as never);
});

describe("requiredDefinitionsByNode", () => {
  it("counts live claims' launch versions, unfinished steps' versions and physical launches", async () => {
    db.instanceRank.findMany.mockResolvedValue([
      { nodeId: "n1", Instance: { launchVersionId: "v-current" } },
    ] as never);
    db.$queryRaw.mockResolvedValue([
      { instanceId: "i-1", rank: 0, nodeId: "n1", intent: intent("v-old") },
    ] as never);
    // v-foreign is another owner's or a node-origin runtime's: the filter leaves it out.
    db.instanceStep.findMany.mockResolvedValue([
      { nodeId: "n1", intent: intent("v-step") },
      { nodeId: "n1", intent: intent("v-foreign") },
      { nodeId: "n2", intent: intent("v-step-2") },
      { nodeId: "n2", intent: { unreadable: true } },
    ] as never);
    serverVersions("v-current", "v-step", "v-step-2", "v-old");
    const required = await requiredDefinitionsByNode(db, {
      userId: OWNER,
      nodeIds: ["n1", "n2", "n3"],
    });
    expect([...(required.get("n1") ?? [])].sort()).toEqual(["v-current", "v-old", "v-step"]);
    expect([...(required.get("n2") ?? [])]).toEqual(["v-step-2"]);
    expect(required.get("n3")?.size).toBe(0);

    // Live claims only, unfinished steps only, the owner's instances, server-origin versions.
    expect(db.instanceRank.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        nodeId: { in: ["n1", "n2", "n3"] },
        claim: { in: ["HELD", "HELD_UNKNOWN"] },
        Instance: { userId: OWNER },
      },
    });
    expect(db.instanceStep.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        state: { in: ["PENDING", "RUNNING", "AWAITING_OPERATOR"] },
        Instance: { userId: OWNER },
      },
    });
    expect(db.runtimeVersion.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { Runtime: { userId: OWNER, origin: "SERVER" } },
    });
  });

  it("reads every live rank's physical launch in one owner-bound query", async () => {
    db.instanceRank.findMany.mockResolvedValue(
      Array.from({ length: 200 }, (_, index) => ({
        nodeId: `n${index % 4}`,
        Instance: { launchVersionId: "v-new" },
      })) as never,
    );
    db.$queryRaw.mockResolvedValue(
      Array.from({ length: 200 }, (_, rank) => ({
        instanceId: "i-1",
        rank,
        nodeId: `n${rank % 4}`,
        intent: intent("v-old"),
      })) as never,
    );
    serverVersions("v-new", "v-old");
    const required = await requiredDefinitionsByNode(db, {
      userId: OWNER,
      nodeIds: ["n0", "n1", "n2", "n3"],
    });
    for (const id of ["n0", "n1", "n2", "n3"])
      expect([...(required.get(id) ?? [])].sort()).toEqual(["v-new", "v-old"]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.instanceStep.findFirst).not.toHaveBeenCalled();
    // The same filter as `physicalLaunch`: start phases, dispatched, not refused pre-admission.
    const [sql, ...values] = db.$queryRaw.mock.calls[0] ?? [];
    const text = Array.isArray(sql) ? sql.join("?") : String(sql);
    expect(text).toContain(`i."userId" =`);
    expect(text).toContain("DISTINCT ON");
    expect(values).toContainEqual(OWNER);
    expect(values).toContainEqual(["n0", "n1", "n2", "n3"]);
    expect(values).toContainEqual(["HELD", "HELD_UNKNOWN"]);
    expect(values).toContainEqual([...RUN_START_PHASES]);
    expect(values).toContainEqual([...RUNTIME_JOB_PRE_ADMISSION_ERRORS]);
    expect(values).toContainEqual(1);
  });

  it("reads no physical launch without a live rank, and nothing without nodes", async () => {
    const required = await requiredDefinitionsByNode(db, { userId: OWNER, nodeIds: ["n1"] });
    expect(required.get("n1")?.size).toBe(0);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.runtimeVersion.findMany).not.toHaveBeenCalled();
    db.instanceRank.findMany.mockClear();
    expect((await requiredDefinitionsByNode(db, { userId: OWNER, nodeIds: [] })).size).toBe(0);
    expect(db.instanceRank.findMany).not.toHaveBeenCalled();
  });
});
