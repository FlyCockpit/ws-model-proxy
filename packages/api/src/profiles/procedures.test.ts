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
      expect(db.profile.update).not.toHaveBeenCalled();
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
    db.profile.update.mockResolvedValueOnce({ id: "p-1" } as never);
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
    db.profile.update.mockResolvedValueOnce({ id: "p-1" } as never);
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
