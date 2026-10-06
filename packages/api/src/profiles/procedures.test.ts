import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({
  default: mockDeep<PrismaClient>(),
  Prisma: { DbNull: "DbNull" },
}));
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import type { CallerAuth } from "../contracts/auth-context";
import { contextFor, FULL_AGENT, PERSON, READ_AGENT } from "../nodes/lane-b-test-helpers";
import { profilesRouter } from "../routers/profiles";

const db = vi.mocked(prisma, true);
const CSRF_LESS: CallerAuth = {
  kind: "cookie_session",
  userId: "owner-1",
  sessionId: "s-1",
  csrfVerified: false,
};

const client = (auth: CallerAuth = PERSON, services?: Parameters<typeof contextFor>[1]) =>
  createRouterClient(profilesRouter, { context: contextFor(auth, services) });

function planState(options: { trust?: "RELAY" | "FULL"; personHold?: boolean } = {}) {
  db.profileNode.findMany.mockResolvedValueOnce([{ nodeId: "a", hold: false, holdNote: null }]);
  db.profile.findFirst.mockResolvedValueOnce({
    id: "p-1",
    Nodes: [{ nodeId: "a", hold: false, holdNote: null }],
    Items: [],
  } as never);
  db.node.findMany.mockResolvedValueOnce([
    {
      id: "a",
      slug: "a",
      connection: "ONLINE",
      trust: options.trust ?? "FULL",
      trustChangedAt: null,
      trustLowerRequestedAt: null,
      labels: [],
      holdAt: options.personHold ? new Date() : null,
      holdProfileId: null,
      portStart: 30000,
      portEnd: 30010,
      heldDefinitions: [],
      declaredResources: null,
      nodeInfo: null,
      nodeMetrics: null,
      nodeMetricsAt: null,
    },
  ] as never);
  db.runtimeVersion.findMany.mockResolvedValueOnce([]);
  db.runtimeInstance.findMany.mockResolvedValueOnce([]);
  db.instanceRank.findMany.mockResolvedValueOnce([]);
  db.fabric.findMany.mockResolvedValueOnce([]);
}

beforeEach(() => {
  mockReset(db);
  db.$transaction.mockImplementation(((fn: (tx: typeof db) => unknown) => fn(db)) as never);
  // The apply transaction re-reads the owned nodes' holds; by default nobody holds them.
  db.node.findMany.mockResolvedValue([]);
  db.node.updateMany.mockResolvedValue({ count: 1 });
});

describe("profiles.apply", () => {
  it("previews without writing anything", async () => {
    planState();
    const out = await client().apply({ profileId: "p-1", preview: true });
    expect(out.mode).toBe("preview");
    expect(db.runtimeOperation.create).not.toHaveBeenCalled();
  });

  it("requires a person to echo the preview fingerprint", async () => {
    planState();
    await expect(client().apply({ profileId: "p-1" })).rejects.toMatchObject({
      data: { reason: "preview_required" },
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a stale fingerprint", async () => {
    planState();
    await expect(
      client().apply({ profileId: "p-1", fingerprint: "0".repeat(64) }),
    ).rejects.toMatchObject({ data: { reason: "preview_stale" } });
  });

  it("applies exactly the confirmed preview for a person", async () => {
    planState();
    const preview = await client().apply({ profileId: "p-1", preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    planState();
    db.runtimeOperation.create.mockResolvedValueOnce({
      id: "op-1",
      createdAt: new Date(),
    } as never);
    const profileApplied = vi.fn(async () => undefined);
    const out = await client(PERSON, { profileApplied }).apply({
      profileId: "p-1",
      fingerprint: preview.preview.fingerprint,
    });
    expect(out).toMatchObject({
      mode: "applied",
      operation: { id: "op-1", kind: "PROFILE_APPLY" },
    });
    expect(db.runtimeOperation.create.mock.calls[0]?.[0]?.data).toMatchObject({
      kind: "PROFILE_APPLY",
      actor: "USER",
      profileId: "p-1",
      fingerprint: preview.preview.fingerprint,
    });
    expect(profileApplied).toHaveBeenCalledWith("op-1");
    // The profile row and its owned node rows are locked before the holds are re-read.
    const locked = db.$queryRaw.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join("?"),
    );
    expect(locked[0]).toContain('FROM profile WHERE id = ? AND "userId" = ? FOR UPDATE');
    expect(locked[1]).toContain('FROM node WHERE id = ? AND "userId" = ? FOR UPDATE');
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.profileNode.findMany.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("lets an agent apply without a fingerprint", async () => {
    planState();
    db.runtimeOperation.create.mockResolvedValueOnce({
      id: "op-2",
      createdAt: new Date(),
    } as never);
    await expect(client(FULL_AGENT).apply({ profileId: "p-1" })).resolves.toMatchObject({
      mode: "applied",
    });
    expect(db.runtimeOperation.create.mock.calls[0]?.[0]?.data).toMatchObject({
      actor: "AGENT",
      agentTokenId: "tok-1",
    });
  });

  for (const [label, auth] of [
    ["Full agent token", FULL_AGENT],
    ["cookie without CSRF (agent rules apply)", CSRF_LESS],
  ] as const) {
    it(`refuses a ${label} whole when an owned node is Relay only`, async () => {
      planState({ trust: "RELAY" });
      await expect(client(auth).apply({ profileId: "p-1" })).rejects.toMatchObject({
        data: { reason: "trust_relay" },
      });
      expect(db.runtimeOperation.create).not.toHaveBeenCalled();
    });

    it(`refuses a ${label} when a person holds an owned node`, async () => {
      planState({ personHold: true });
      await expect(client(auth).apply({ profileId: "p-1" })).rejects.toMatchObject({
        data: { reason: "node_held" },
      });
    });
  }

  it("refuses a read-only agent before planning", async () => {
    await expect(client(READ_AGENT).apply({ profileId: "p-1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(db.profile.findFirst).not.toHaveBeenCalled();
  });
});

describe("profiles.save hold lines (people only)", () => {
  function saveState(existingHold: boolean) {
    db.node.findMany.mockResolvedValueOnce([{ id: "a" }] as never);
    db.profile.findFirst.mockResolvedValueOnce({
      id: "p-1",
      updatedAt: new Date("2026-10-06T09:00:00Z"),
      Nodes: [{ nodeId: "a", hold: existingHold, holdNote: null }],
      Items: [],
    } as never);
    db.runtime.findMany.mockResolvedValueOnce([]);
  }
  const base = { profileId: "p-1", slug: "evening", name: "Evening", nodeIds: ["a"], items: [] };

  for (const [label, auth] of [
    ["Full agent token", FULL_AGENT],
    ["cookie without CSRF", CSRF_LESS],
  ] as const) {
    it(`refuses a ${label} that adds a hold line`, async () => {
      saveState(false);
      await expect(client(auth).save({ ...base, holds: [{ nodeId: "a" }] })).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "human_only" },
      });
      expect(db.profile.updateMany).not.toHaveBeenCalled();
    });

    it(`refuses a ${label} that removes a hold line's node`, async () => {
      saveState(true);
      db.node.findMany.mockReset();
      db.node.findMany.mockResolvedValueOnce([{ id: "b" }] as never);
      await expect(client(auth).save({ ...base, nodeIds: ["b"] })).rejects.toMatchObject({
        data: { reason: "human_only" },
      });
    });
  }

  it("keeps existing hold lines when an agent omits them", async () => {
    saveState(true);
    db.profile.updateMany.mockResolvedValueOnce({ count: 1 });
    db.profile.findMany.mockResolvedValueOnce([]);
    await client(FULL_AGENT)
      .save(base)
      .catch(() => undefined);
    expect(db.profileNode.createMany.mock.calls[0]?.[0]?.data).toEqual([
      { profileId: "p-1", nodeId: "a", hold: true, holdNote: null },
    ]);
  });

  it("lets a person set hold lines", async () => {
    saveState(false);
    db.profile.updateMany.mockResolvedValueOnce({ count: 1 });
    db.profile.findMany.mockResolvedValueOnce([]);
    await client()
      .save({ ...base, holds: [{ nodeId: "a", note: "gaming" }] })
      .catch(() => undefined);
    expect(db.profileNode.createMany.mock.calls[0]?.[0]?.data).toEqual([
      { profileId: "p-1", nodeId: "a", hold: true, holdNote: "gaming" },
    ]);
  });

  it("refuses nodes the caller does not own", async () => {
    db.node.findMany.mockResolvedValueOnce([]);
    await expect(client().save(base)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.node.findMany.mock.calls[0]?.[0]?.where).toMatchObject({ userId: "owner-1" });
  });
});

describe("profiles.save validation", () => {
  const base = { slug: "evening", name: "Evening", nodeIds: ["a"], items: [] };

  it("refuses an agent creating a profile with hold lines", async () => {
    db.node.findMany.mockResolvedValueOnce([{ id: "a" }] as never);
    db.runtime.findMany.mockResolvedValueOnce([]);
    await expect(
      client(FULL_AGENT).save({ ...base, holds: [{ nodeId: "a" }] }),
    ).rejects.toMatchObject({ data: { reason: "human_only" } });
    expect(db.profile.create).not.toHaveBeenCalled();
  });

  it("refuses an agent changing only a hold note", async () => {
    db.node.findMany.mockResolvedValueOnce([{ id: "a" }] as never);
    db.profile.findFirst.mockResolvedValueOnce({
      id: "p-1",
      Nodes: [{ nodeId: "a", hold: true, holdNote: "old" }],
      Items: [],
    } as never);
    await expect(
      client(FULL_AGENT).save({ ...base, profileId: "p-1", holds: [{ nodeId: "a", note: "new" }] }),
    ).rejects.toMatchObject({ data: { reason: "human_only" } });
  });

  it("refuses updatePins together with an explicit version", async () => {
    db.node.findMany.mockResolvedValueOnce([{ id: "a" }] as never);
    db.runtime.findMany.mockResolvedValueOnce([
      { id: "rt-1", kind: "STARTABLE", currentVersionId: "v-2" },
    ] as never);
    db.runtimeVersion.findMany.mockResolvedValueOnce([{ id: "v-1", runtimeId: "rt-1" }] as never);
    await expect(
      client().save({
        ...base,
        updatePins: true,
        items: [{ runtimeId: "rt-1", versionId: "v-1", count: 1 }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses an always-on runtime as an item", async () => {
    db.node.findMany.mockResolvedValueOnce([{ id: "a" }] as never);
    db.runtime.findMany.mockResolvedValueOnce([
      { id: "rt-1", kind: "ALWAYS_ON", currentVersionId: "v-1" },
    ] as never);
    await expect(
      client().save({ ...base, items: [{ runtimeId: "rt-1", count: 1 }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("releases holds this profile set on nodes it no longer owns", async () => {
    db.node.findMany.mockResolvedValueOnce([{ id: "a" }] as never);
    db.profile.findFirst.mockResolvedValueOnce({
      id: "p-1",
      updatedAt: new Date(),
      Nodes: [],
      Items: [],
    } as never);
    db.runtime.findMany.mockResolvedValueOnce([]);
    db.profile.updateMany.mockResolvedValueOnce({ count: 1 });
    db.profile.findMany.mockResolvedValueOnce([]);
    await client()
      .save({ ...base, profileId: "p-1" })
      .catch(() => undefined);
    expect(db.node.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "owner-1", holdProfileId: "p-1", id: { notIn: ["a"] } },
      data: { holdAt: null, holdProfileId: null },
    });
  });
});

describe("profiles.delete", () => {
  it("leaves the profile's holds to become a person's (FK SET NULL), never released", async () => {
    db.profile.findFirst.mockResolvedValueOnce({ id: "p-1", Nodes: [{ nodeId: "a" }] } as never);
    db.profile.deleteMany.mockResolvedValueOnce({ count: 1 });
    await client().delete({ profileId: "p-1" });
    expect(db.profile.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "p-1",
      userId: "owner-1",
    });
    expect(db.profile.deleteMany).toHaveBeenCalled();
    expect(db.node.updateMany).not.toHaveBeenCalled();
  });

  for (const [label, auth] of [
    ["Full agent token", FULL_AGENT],
    ["cookie without CSRF", CSRF_LESS],
  ] as const) {
    it(`refuses a ${label} deleting a profile with hold lines`, async () => {
      db.profile.findFirst.mockResolvedValueOnce({ id: "p-1", Nodes: [{ nodeId: "a" }] } as never);
      db.node.count.mockResolvedValueOnce(0);
      await expect(client(auth).delete({ profileId: "p-1" })).rejects.toMatchObject({
        data: { reason: "human_only" },
      });
      expect(db.profile.deleteMany).not.toHaveBeenCalled();
    });

    it(`refuses a ${label} deleting a profile whose hold is still set`, async () => {
      db.profile.findFirst.mockResolvedValueOnce({ id: "p-1", Nodes: [] } as never);
      db.node.count.mockResolvedValueOnce(1);
      await expect(client(auth).delete({ profileId: "p-1" })).rejects.toMatchObject({
        data: { reason: "human_only" },
      });
    });
  }

  it("lets an agent delete a profile without holds", async () => {
    db.profile.findFirst.mockResolvedValueOnce({ id: "p-1", Nodes: [] } as never);
    db.node.count.mockResolvedValueOnce(0);
    await client(FULL_AGENT).delete({ profileId: "p-1" });
    expect(db.profile.deleteMany).toHaveBeenCalled();
  });

  it("refuses a read-only agent", async () => {
    await expect(client(READ_AGENT).delete({ profileId: "p-1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(db.profile.deleteMany).not.toHaveBeenCalled();
  });
});

describe("hold writes on apply", () => {
  function heldPlan(line: boolean, hold: { holdAt: Date | null; holdProfileId: string | null }) {
    db.profileNode.findMany.mockResolvedValueOnce([
      { nodeId: "a", hold: line, holdNote: line ? "games" : null },
    ]);
    db.profile.findFirst.mockResolvedValueOnce({
      id: "p-1",
      Nodes: [{ nodeId: "a", hold: line, holdNote: line ? "games" : null }],
      Items: [],
    } as never);
    db.node.findMany.mockResolvedValueOnce([
      {
        id: "a",
        slug: "a",
        connection: "ONLINE",
        trust: "FULL",
        trustChangedAt: null,
        trustLowerRequestedAt: null,
        labels: [],
        ...hold,
        portStart: 30000,
        portEnd: 30010,
        heldDefinitions: [],
        declaredResources: null,
        nodeInfo: null,
        nodeMetrics: null,
        nodeMetricsAt: null,
      },
    ] as never);
    db.runtimeVersion.findMany.mockResolvedValueOnce([]);
    db.runtimeInstance.findMany.mockResolvedValueOnce([]);
    db.instanceRank.findMany.mockResolvedValueOnce([]);
    db.fabric.findMany.mockResolvedValueOnce([]);
    db.runtimeOperation.create.mockResolvedValueOnce({
      id: "op-1",
      createdAt: new Date(),
    } as never);
  }
  const free = { holdAt: null, holdProfileId: null };
  const personHold = { holdAt: new Date(), holdProfileId: null };

  it("sets this profile's hold on a free hold-line node, only if it is still free or ours", async () => {
    heldPlan(true, free);
    db.node.findMany.mockResolvedValueOnce([{ id: "a", ...free }] as never);
    await client(FULL_AGENT).apply({ profileId: "p-1" });
    expect(db.node.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "a", userId: "owner-1", OR: [{ holdAt: null }, { holdProfileId: "p-1" }] },
      data: { holdNote: "games", holdProfileId: "p-1" },
    });
  });

  it("keeps a person's hold on a hold-line node as it is (never converted)", async () => {
    heldPlan(true, personHold);
    const preview = await client().apply({ profileId: "p-1", preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    heldPlan(true, personHold);
    db.node.findMany.mockResolvedValueOnce([{ id: "a", ...personHold }] as never);
    await client().apply({ profileId: "p-1", fingerprint: preview.preview.fingerprint });
    expect(db.node.updateMany).not.toHaveBeenCalled();
  });

  for (const [label, auth] of [
    ["Full agent token", FULL_AGENT],
    ["cookie without CSRF", CSRF_LESS],
  ] as const)
    it(`refuses a ${label} when a person's hold lands after the plan`, async () => {
      heldPlan(false, free);
      db.node.findMany.mockResolvedValueOnce([{ id: "a", ...personHold }] as never);
      await expect(client(auth).apply({ profileId: "p-1" })).rejects.toMatchObject({
        data: { reason: "node_held" },
      });
      expect(db.node.updateMany).not.toHaveBeenCalled();
    });

  it("makes a person's preview stale when a hold changed since", async () => {
    heldPlan(false, free);
    const preview = await client().apply({ profileId: "p-1", preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    heldPlan(false, free);
    db.node.findMany.mockResolvedValueOnce([{ id: "a", ...personHold }] as never);
    await expect(
      client().apply({ profileId: "p-1", fingerprint: preview.preview.fingerprint }),
    ).rejects.toMatchObject({ data: { reason: "preview_stale" } });
  });

  it("lets a person release another's hold on an owned node without a hold line", async () => {
    heldPlan(false, personHold);
    const preview = await client().apply({ profileId: "p-1", preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    heldPlan(false, personHold);
    db.node.findMany.mockResolvedValueOnce([{ id: "a", ...personHold }] as never);
    await client().apply({ profileId: "p-1", fingerprint: preview.preview.fingerprint });
    expect(db.node.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "a", holdProfileId: null, holdAt: { not: null } },
      data: { holdAt: null },
    });
  });

  it("records a cookie without CSRF as an agent", async () => {
    heldPlan(false, free);
    await client(CSRF_LESS).apply({ profileId: "p-1" });
    expect(db.runtimeOperation.create.mock.calls[0]?.[0]?.data).toMatchObject({ actor: "AGENT" });
  });
});

describe("apply write checks", () => {
  it("refuses an agent when a planned hold write lands on nothing (node_held)", async () => {
    db.profileNode.findMany.mockResolvedValueOnce([{ nodeId: "a", hold: true, holdNote: null }]);
    db.profile.findFirst.mockResolvedValueOnce({
      id: "p-1",
      Nodes: [{ nodeId: "a", hold: true, holdNote: null }],
      Items: [],
    } as never);
    db.node.findMany.mockResolvedValueOnce([
      {
        id: "a",
        slug: "a",
        connection: "ONLINE",
        trust: "FULL",
        trustChangedAt: null,
        trustLowerRequestedAt: null,
        labels: [],
        holdAt: null,
        holdProfileId: null,
        portStart: 30000,
        portEnd: 30010,
        heldDefinitions: [],
        declaredResources: null,
        nodeInfo: null,
        nodeMetrics: null,
        nodeMetricsAt: null,
      },
    ] as never);
    db.runtimeVersion.findMany.mockResolvedValueOnce([]);
    db.runtimeInstance.findMany.mockResolvedValueOnce([]);
    db.instanceRank.findMany.mockResolvedValueOnce([]);
    db.fabric.findMany.mockResolvedValueOnce([]);
    db.runtimeOperation.create.mockResolvedValueOnce({
      id: "op-1",
      createdAt: new Date(),
    } as never);
    db.node.findMany.mockResolvedValueOnce([
      { id: "a", holdAt: null, holdProfileId: null },
    ] as never);
    db.node.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(client(FULL_AGENT).apply({ profileId: "p-1" })).rejects.toMatchObject({
      data: { reason: "node_held" },
    });
  });

  it("refuses as stale when the profile's lines changed after the plan (agents too)", async () => {
    planState();
    db.profileNode.findMany.mockReset();
    db.profileNode.findMany.mockResolvedValueOnce([{ nodeId: "a", hold: true, holdNote: null }]);
    db.runtimeOperation.create.mockResolvedValueOnce({
      id: "op-1",
      createdAt: new Date(),
    } as never);
    await expect(client(FULL_AGENT).apply({ profileId: "p-1" })).rejects.toMatchObject({
      data: { reason: "preview_stale" },
    });
    expect(db.node.updateMany).not.toHaveBeenCalled();
  });
});

describe("profiles.save races and empty hold lists", () => {
  for (const [label, auth] of [
    ["Full agent token", FULL_AGENT],
    ["cookie without CSRF", CSRF_LESS],
  ] as const)
    it(`refuses a ${label} sending holds: [] on a profile with a hold line`, async () => {
      db.node.findMany.mockResolvedValueOnce([{ id: "a" }] as never);
      db.profile.findFirst.mockResolvedValueOnce({
        id: "p-1",
        updatedAt: new Date(),
        Nodes: [{ nodeId: "a", hold: true, holdNote: null }],
        Items: [],
      } as never);
      await expect(
        client(auth).save({
          profileId: "p-1",
          slug: "evening",
          name: "Evening",
          nodeIds: ["a"],
          items: [],
          holds: [],
        }),
      ).rejects.toMatchObject({ data: { reason: "human_only" } });
      expect(db.profileNode.deleteMany).not.toHaveBeenCalled();
      expect(db.profileNode.createMany).not.toHaveBeenCalled();
    });

  it("refuses a save that read an older profile (optimistic updatedAt)", async () => {
    db.node.findMany.mockResolvedValueOnce([{ id: "a" }] as never);
    db.profile.findFirst.mockResolvedValueOnce({
      id: "p-1",
      updatedAt: new Date(),
      Nodes: [{ nodeId: "a", hold: true, holdNote: null }],
      Items: [],
    } as never);
    db.runtime.findMany.mockResolvedValueOnce([]);
    db.profile.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      client(FULL_AGENT).save({
        profileId: "p-1",
        slug: "evening",
        name: "Evening",
        nodeIds: ["a"],
        items: [],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.profileNode.deleteMany).not.toHaveBeenCalled();
  });
});
