import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({
  default: mockDeep<PrismaClient>(),
  Prisma: { DbNull: "DbNull" },
}));
vi.mock("@ws-model-proxy/db/node-security", () => ({
  credentialDigest: vi.fn((_purpose: string, secret: string) => `digest(${secret.length})`),
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.com" },
}));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import { nodesRouter } from "../routers/nodes";
import {
  contextFor,
  FULL_AGENT,
  NOT_A_PERSON,
  PERSON,
  procedureAt,
  READ_AGENT,
} from "./lane-b-test-helpers";
import { nodeTrustView } from "./trust";

const db = vi.mocked(prisma, true);

function nodeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-1",
    slug: "box",
    name: null,
    connection: "ONLINE",
    lastHeartbeatAt: new Date("2026-10-06T10:00:00Z"),
    cliVersion: "0.4.0",
    rejectedProtocolVersion: null,
    trust: "FULL",
    trustChangedAt: null,
    trustLowerRequestedAt: null,
    labels: ["gpu"],
    declaredResources: null,
    nodeInfo: { memoryTotalMiB: 65536, nodeKind: "discrete" },
    nodeMetrics: null,
    nodeMetricsAt: null,
    holdAt: null,
    holdNote: null,
    holdProfileId: null,
    removeAfterOfflineMs: null,
    Ranks: [],
    _count: { Runtimes: 1, QueuedCommands: 2 },
    hostname: "box.local",
    features: null,
    heldDefinitions: [],
    portStart: 30000,
    portEnd: 30999,
    metricCommands: [],
    metricCommandsHash: null,
    heldMetricCommandsHash: null,
    fabricsHash: null,
    heldFabricsHash: null,
    commandMaxMs: 86_400_000,
    detectedServers: null,
    detectedServersAt: null,
    FabricMembers: [],
    QueuedCommands: [],
    ...overrides,
  };
}

function client(auth = PERSON, services?: Parameters<typeof contextFor>[1]) {
  return createRouterClient(nodesRouter, { context: contextFor(auth, services) });
}

beforeEach(() => {
  mockReset(db);
  db.$transaction.mockImplementation(((fn: (tx: typeof db) => unknown) => fn(db)) as never);
  db.runtime.findMany.mockResolvedValue([]);
  db.node.findMany.mockResolvedValue([]);
});

describe("nodeTrustView", () => {
  it("treats a node that never said hello as Relay only, not frozen", () => {
    expect(
      nodeTrustView({ trust: null, trustChangedAt: null, trustLowerRequestedAt: null }),
    ).toMatchObject({ effective: "RELAY", frozen: false, lowerPending: false });
  });
  it("applies a person's lower request before the node confirms", () => {
    expect(
      nodeTrustView({ trust: "FULL", trustChangedAt: null, trustLowerRequestedAt: new Date() }),
    ).toMatchObject({ reported: "FULL", effective: "RELAY", lowerPending: true, frozen: true });
  });
  it("is Full only when the node reports Full and nothing is pending", () => {
    expect(
      nodeTrustView({ trust: "FULL", trustChangedAt: null, trustLowerRequestedAt: null }).effective,
    ).toBe("FULL");
  });
});

describe("human-only node procedures", () => {
  const HUMAN_CALLS: ReadonlyArray<[string, unknown]> = [
    ["setHold", { nodeId: "node-1", hold: true }],
    ["setTemporary", { nodeId: "node-1", removeAfterOfflineMs: 3_600_000 }],
    ["rename", { nodeId: "node-1", name: "x" }],
    ["delete", { nodeId: "node-1" }],
    ["lowerTrustPreview", { nodeId: "node-1" }],
    ["lowerTrust", { nodeId: "node-1" }],
    ["fabrics.rename", { fabricId: "f-1", name: "qsfp" }],
    ["fabrics.delete", { fabricId: "f-1" }],
    ["enrollmentCodes.create", {}],
    ["enrollmentCodes.revoke", { codeId: "c-1" }],
    ["credentials.revoke", { credentialId: "cr-1" }],
  ];
  for (const [label, auth] of NOT_A_PERSON)
    for (const [path, input] of HUMAN_CALLS)
      it(`refuses ${path} for a ${label} before touching the database`, async () => {
        await expect(procedureAt(client(auth as typeof PERSON), path)(input)).rejects.toMatchObject(
          {
            code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND|UNAUTHORIZED)$/),
          },
        );
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(db.node.updateMany).not.toHaveBeenCalled();
        expect(db.nodeEnrollmentCode.create).not.toHaveBeenCalled();
        expect(db.node.findFirst).not.toHaveBeenCalled();
      });
});

describe("nodes.list / get", () => {
  it("lists summaries for the caller's nodes only (agents too)", async () => {
    db.node.findMany.mockResolvedValueOnce([nodeRow()] as never);
    const out = await client(FULL_AGENT).list({});
    expect(db.node.findMany.mock.calls[0]?.[0]?.where).toEqual({ userId: "owner-1" });
    expect(out.nodes[0]).toMatchObject({
      slug: "box",
      hardwareKind: "discrete",
      alwaysOnRuntimes: 1,
      needsYou: 2,
      trust: { effective: "FULL" },
    });
  });

  it("answers NOT_FOUND for another user's node", async () => {
    db.node.findFirst.mockResolvedValueOnce(null);
    await expect(client().get({ nodeId: "node-x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.node.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "node-x",
      userId: "owner-1",
    });
  });

  it("builds the detail: hardware with sources, fabrics, held definitions", async () => {
    db.node.findFirst.mockResolvedValueOnce(
      nodeRow({
        declaredResources: { reservedMemoryGb: 8 },
        heldDefinitions: [{ runtimeId: "rt-1", versionId: "v-2", launchHash: "a".repeat(64) }],
        FabricMembers: [
          {
            ip: "10.0.0.1",
            Fabric: {
              id: "f-1",
              name: "qsfp",
              Members: [
                { nodeId: "node-1", ip: "10.0.0.1", Node: { slug: "box" } },
                { nodeId: "node-2", ip: "10.0.0.2", Node: { slug: "box2" } },
              ],
            },
          },
        ],
      }) as never,
    );
    db.runtime.findMany.mockResolvedValueOnce([{ id: "rt-1", currentVersionId: "v-2" }] as never);
    const detail = await client().get({ nodeId: "node-1" });
    expect(detail.hardware.memoryGb).toEqual({ value: 64, source: "detected" });
    expect(detail.hardware.reservedMemoryGb).toEqual({ value: 8, source: "browser" });
    expect(detail.hardware.usableMemoryGb).toBe(56);
    expect(detail.fabrics).toEqual([
      {
        fabricId: "f-1",
        name: "qsfp",
        ip: "10.0.0.1",
        peers: [{ nodeId: "node-2", slug: "box2", ip: "10.0.0.2" }],
      },
    ]);
    expect(detail.heldDefinitions[0]?.current).toBe(true);
    expect(detail.portRange).toEqual([30000, 30999]);
  });
});

describe("nodes.update", () => {
  const trustRow = {
    id: "node-1",
    trust: "FULL",
    trustChangedAt: null,
    trustLowerRequestedAt: null,
    heldMetricCommandsHash: null,
  };

  it("refuses everyone on a Relay-only node (trust_relay)", async () => {
    db.node.findFirst.mockResolvedValueOnce({ ...trustRow, trust: "RELAY" } as never);
    await expect(client().update({ nodeId: "node-1", labels: ["a"] })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "trust_relay" },
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("treats a pending lower as Relay only", async () => {
    db.node.findFirst.mockResolvedValueOnce({
      ...trustRow,
      trustLowerRequestedAt: new Date(),
    } as never);
    await expect(
      client(FULL_AGENT).update({ nodeId: "node-1", portRange: [31000, 31010] }),
    ).rejects.toMatchObject({ data: { reason: "trust_relay" } });
  });

  it("refuses a read-only agent before reading the node", async () => {
    await expect(
      client(READ_AGENT).update({ nodeId: "node-1", labels: ["a"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.node.findFirst).not.toHaveBeenCalled();
  });

  it("takes no secrets (they have their own procedures)", async () => {
    await expect(
      client().update({
        nodeId: "node-1",
        secrets: { set: [{ name: "WSMP_SECRET_HF", value: "hf_x" }] },
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.node.findFirst).not.toHaveBeenCalled();
  });

  it("writes the definition, audits the agent and pushes to the node", async () => {
    const definitionChanged = vi.fn(async () => undefined);
    db.node.findFirst
      .mockResolvedValueOnce(trustRow as never)
      .mockResolvedValueOnce(nodeRow() as never);
    db.node.updateMany.mockResolvedValueOnce({ count: 1 });
    await client(FULL_AGENT, { definitionChanged }).update({
      nodeId: "node-1",
      labels: ["gpu", "big"],
      portRange: [31000, 31099],
      note: "more ports",
    });
    expect(db.node.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "node-1", userId: "owner-1", trust: "FULL", trustLowerRequestedAt: null },
      data: { labels: ["gpu", "big"], portStart: 31000, portEnd: 31099 },
    });
    expect(db.nodeAuditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      actor: "AGENT",
      agentTokenId: "tok-1",
      kind: "node_update",
      subject: "node:labels,portRange",
      reason: "more ports",
    });
    expect(definitionChanged).toHaveBeenCalledWith(["node-1"]);
  });

  it("replaces fabric memberships and refreshes every affected member's hash", async () => {
    db.node.findFirst
      .mockResolvedValueOnce(trustRow as never)
      .mockResolvedValueOnce(nodeRow() as never);
    db.fabricMember.findMany
      // current memberships of node-1
      .mockResolvedValueOnce([] as never)
      // members of the touched fabric
      .mockResolvedValueOnce([{ nodeId: "node-1" }, { nodeId: "node-2" }] as never)
      // memberships for hashing
      .mockResolvedValueOnce([
        {
          nodeId: "node-1",
          ip: "10.0.0.1",
          fabricId: "f-1",
          Fabric: { name: "qsfp", Members: [{ ip: "10.0.0.2" }, { ip: "10.0.0.1" }] },
        },
      ] as never);
    db.fabric.upsert.mockResolvedValueOnce({ id: "f-1" } as never);
    db.node.updateMany.mockResolvedValueOnce({ count: 1 });
    await client().update({ nodeId: "node-1", fabrics: [{ name: "qsfp", ip: "10.0.0.1" }] });
    expect(db.fabricMember.create.mock.calls[0]?.[0]?.data).toEqual({
      userId: "owner-1",
      fabricId: "f-1",
      nodeId: "node-1",
      ip: "10.0.0.1",
    });
    const hashed = db.node.updateMany.mock.calls.slice(1).map((call) => call[0]?.where);
    expect(hashed).toEqual([
      { id: "node-1", userId: "owner-1" },
      { id: "node-2", userId: "owner-1" },
    ]);
  });

  it("refuses when trust was lowered between the read and the write", async () => {
    db.node.findFirst.mockResolvedValueOnce(trustRow as never);
    db.node.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(client().update({ nodeId: "node-1", labels: ["a"] })).rejects.toMatchObject({
      data: { reason: "trust_relay" },
    });
    expect(db.nodeAuditEvent.create).not.toHaveBeenCalled();
  });

  it("refuses an OAuth connection without Full level", async () => {
    await expect(
      client({
        kind: "oauth_access_token",
        userId: "owner-1",
        grantId: "g",
        level: "READ",
      } as never).update({ nodeId: "node-1", labels: ["a"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses changing an address a running multi-node instance uses (fabric_in_use)", async () => {
    db.node.findFirst.mockResolvedValueOnce(trustRow as never);
    db.node.updateMany.mockResolvedValueOnce({ count: 1 });
    db.fabricMember.findMany.mockResolvedValueOnce([
      { id: "m-1", fabricId: "f-1", ip: "10.0.0.1", Fabric: { name: "qsfp" } },
    ] as never);
    db.runtimeInstance.findFirst.mockResolvedValueOnce({ fabricId: "f-1" } as never);
    await expect(
      client().update({ nodeId: "node-1", fabrics: [{ name: "qsfp", ip: "10.0.0.9" }] }),
    ).rejects.toMatchObject({ data: { reason: "fabric_in_use" } });
    expect(db.fabricMember.update).not.toHaveBeenCalled();
  });

  it("maps a duplicate fabric address to CONFLICT", async () => {
    db.node.findFirst.mockResolvedValueOnce(trustRow as never);
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(
      client().update({ nodeId: "node-1", fabrics: [{ name: "qsfp", ip: "10.0.0.2" }] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("hold, temporary, rename", () => {
  it("a person's hold clears any profile attribution", async () => {
    db.node.updateMany.mockResolvedValueOnce({ count: 1 });
    db.node.findFirst.mockResolvedValueOnce(nodeRow({ holdAt: new Date() }) as never);
    await client().setHold({ nodeId: "node-1", hold: true, note: "maintenance" });
    expect(db.node.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "node-1", userId: "owner-1" },
      data: { holdNote: "maintenance", holdProfileId: null },
    });
  });

  it("answers NOT_FOUND when the node is not the caller's", async () => {
    db.node.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      client().setTemporary({ nodeId: "node-x", removeAfterOfflineMs: null }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("delete", () => {
  it("refuses while a profile pins one of the node's runtimes", async () => {
    db.node.findFirst.mockResolvedValueOnce({ id: "node-1" } as never);
    db.profileItem.findFirst.mockResolvedValueOnce({ Profile: { id: "p-1" } } as never);
    await expect(client().delete({ nodeId: "node-1" })).rejects.toMatchObject({
      data: { reason: "pinned_by_profile" },
    });
    expect(db.node.delete).not.toHaveBeenCalled();
  });

  it("lists the instances that stop and tells the relay", async () => {
    const disconnect = vi.fn(async () => undefined);
    db.node.findFirst.mockResolvedValueOnce({ id: "node-1" } as never);
    db.instanceRank.findMany.mockResolvedValueOnce([
      { instanceId: "i-1" },
      { instanceId: "i-1" },
      { instanceId: "i-2" },
    ] as never);
    db.fabricMember.findMany.mockResolvedValueOnce([] as never);
    const out = await client(PERSON, { disconnect }).delete({ nodeId: "node-1" });
    expect(out).toEqual({ deleted: true, stoppedInstances: ["i-1", "i-2"] });
    expect(db.node.delete).toHaveBeenCalledWith({ where: { id: "node-1" } });
    expect(disconnect).toHaveBeenCalledWith("node-1", "node_deleted");
  });
});

describe("trust lowering", () => {
  it("records the request, refuses queued commands and audits", async () => {
    const lowerTrust = vi.fn(async () => undefined);
    db.node.findFirst.mockResolvedValueOnce({
      id: "node-1",
      trust: "FULL",
      trustChangedAt: null,
      trustLowerRequestedAt: null,
      heldDefinitions: [{ runtimeId: "rt-1", versionId: "v-1", launchHash: "b".repeat(64) }],
      metricCommands: [],
    } as never);
    db.runtimeVersion.findMany.mockResolvedValueOnce([
      { id: "v-1", runtimeId: "rt-1", editor: "AGENT", Runtime: { name: "Qwen" } },
    ] as never);
    db.instanceRank.findMany.mockResolvedValueOnce([] as never);
    db.nodeAuditEvent.findFirst.mockResolvedValueOnce(null);
    db.node.updateMany.mockResolvedValueOnce({ count: 1 });
    const out = await client(PERSON, { lowerTrust }).lowerTrust({ nodeId: "node-1" });
    expect(db.node.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { trustLowerRequestedAt: null, NOT: { trust: "RELAY" } },
      data: { trustLowerRequestedBy: "owner-1" },
    });
    expect(db.queuedNodeCommand.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { state: "QUEUED", nodeId: "node-1" },
      data: { state: "REFUSED", outcome: "trust_relay" },
    });
    expect(db.nodeAuditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      kind: "trust_lower",
      actor: "USER",
    });
    expect(out.trust).toMatchObject({ effective: "RELAY", lowerPending: true });
    expect(out.frozenAgentWritten).toEqual([{ kind: "runtime", id: "rt-1@v-1", label: "Qwen" }]);
    expect(lowerTrust).toHaveBeenCalledWith("node-1");
  });

  it("does nothing new when the node is already Relay only", async () => {
    db.node.findFirst.mockResolvedValueOnce({
      id: "node-1",
      trust: "RELAY",
      trustChangedAt: null,
      trustLowerRequestedAt: null,
      heldDefinitions: [],
      metricCommands: [],
    } as never);
    db.instanceRank.findMany.mockResolvedValueOnce([] as never);
    db.nodeAuditEvent.findFirst.mockResolvedValueOnce(null);
    await client().lowerTrust({ nodeId: "node-1" });
    expect(db.node.updateMany).not.toHaveBeenCalled();
    expect(db.nodeAuditEvent.create).not.toHaveBeenCalled();
  });
});

describe("fabrics", () => {
  it("refuses to delete a fabric a multi-node instance runs on (fabric_in_use)", async () => {
    db.fabric.findFirst.mockResolvedValueOnce({
      id: "f-1",
      Members: [{ nodeId: "node-1" }, { nodeId: "node-2" }],
    } as never);
    db.runtimeInstance.count.mockResolvedValueOnce(1);
    await expect(client().fabrics.delete({ fabricId: "f-1" })).rejects.toMatchObject({
      data: { reason: "fabric_in_use" },
    });
    expect(db.runtimeInstance.count.mock.calls[0]?.[0]?.where).toEqual({
      userId: "owner-1",
      fabricId: "f-1",
    });
    expect(db.fabric.delete).not.toHaveBeenCalled();
  });

  it("maps the database's fabric_member_in_use (WMPP1) to fabric_in_use", async () => {
    db.fabric.findFirst.mockResolvedValueOnce({ id: "f-1", Members: [] } as never);
    db.runtimeInstance.count.mockResolvedValueOnce(0);
    db.fabric.delete.mockRejectedValueOnce(
      Object.assign(new Error("raw"), { code: "P2010", meta: { code: "WMPP1" } }),
    );
    await expect(client().fabrics.delete({ fabricId: "f-1" })).rejects.toMatchObject({
      data: { reason: "fabric_in_use" },
    });
  });

  it("maps a duplicate name on rename to slug_taken", async () => {
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(client().fabrics.rename({ fabricId: "f-1", name: "taken" })).rejects.toMatchObject(
      { data: { reason: "slug_taken" } },
    );
  });
});

describe("activity", () => {
  it("refuses a cursor that is not one of the caller's rows", async () => {
    db.nodeAuditEvent.findFirst.mockResolvedValueOnce(null);
    await expect(client().activity.list({ cursor: "foreign" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(db.nodeAuditEvent.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "foreign",
      userId: "owner-1",
    });
    expect(db.nodeAuditEvent.findMany).not.toHaveBeenCalled();
  });

  it("pages with a next cursor", async () => {
    const row = (id: string) => ({
      id,
      createdAt: new Date("2026-10-06T10:00:00Z"),
      userId: "owner-1",
      nodeId: "node-1",
      actor: "USER",
      agentTokenId: null,
      kind: "node_update",
      subject: "node:labels",
      outcome: "completed",
      reason: null,
      exitCode: null,
      startedAt: new Date("2026-10-06T10:00:00Z"),
      finishedAt: null,
    });
    db.nodeAuditEvent.findMany.mockResolvedValueOnce([row("a"), row("b"), row("c")] as never);
    const out = await client().activity.list({ limit: 2 });
    expect(out.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(out.nextCursor).toBe("b");
  });
});
