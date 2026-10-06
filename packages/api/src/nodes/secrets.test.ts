import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({
  default: mockDeep<PrismaClient>(),
  Prisma: { DbNull: "DbNull" },
}));
vi.mock("@ws-model-proxy/db/node-security", () => ({ credentialDigest: vi.fn() }));
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import type { CallerAuth } from "../contracts/auth-context";
import type { NodeRelayServices } from "../lib/node-relay-services";
import { nodesRouter } from "../routers/nodes";
import { contextFor, FULL_AGENT, PERSON, READ_AGENT } from "./lane-b-test-helpers";

const db = vi.mocked(prisma, true);
const SECRET = "hf_very_secret_value";

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-1",
    connection: "ONLINE",
    trust: "FULL",
    trustChangedAt: null,
    trustLowerRequestedAt: null,
    ...overrides,
  };
}

const client = (auth: CallerAuth, services?: NodeRelayServices) =>
  createRouterClient(nodesRouter, { context: contextFor(auth, services) });

beforeEach(() => mockReset(db));

describe("nodes.secrets", () => {
  it("sends the value to the node and audits the name only", async () => {
    const writeSecrets = vi.fn<NonNullable<NodeRelayServices["writeSecrets"]>>(async () => [
      { name: "WSMP_SECRET_HF", status: "set", updatedAt: "2026-10-06T10:00:00.000Z" },
    ]);
    db.node.findFirst.mockResolvedValueOnce(node() as never);
    const out = await client(FULL_AGENT, { writeSecrets }).secrets.set({
      nodeId: "node-1",
      name: "WSMP_SECRET_HF",
      value: SECRET,
    });
    expect(out).toEqual({ name: "WSMP_SECRET_HF", updatedAt: "2026-10-06T10:00:00.000Z" });
    expect(writeSecrets).toHaveBeenCalledWith({
      nodeId: "node-1",
      set: [{ name: "WSMP_SECRET_HF", value: SECRET }],
      delete: [],
    });
    const audit = db.nodeAuditEvent.create.mock.calls[0]?.[0]?.data;
    expect(audit).toMatchObject({ subject: "secret:set:WSMP_SECRET_HF", actor: "AGENT" });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("refuses a Relay-only node (secret_needs_node) without sending anything", async () => {
    const writeSecrets = vi.fn();
    db.node.findFirst.mockResolvedValueOnce(node({ trust: "RELAY" }) as never);
    await expect(
      client(PERSON, { writeSecrets }).secrets.set({
        nodeId: "node-1",
        name: "WSMP_SECRET_HF",
        value: SECRET,
      }),
    ).rejects.toMatchObject({ data: { reason: "secret_needs_node" } });
    expect(writeSecrets).not.toHaveBeenCalled();
  });

  it("refuses an offline node (node_offline)", async () => {
    db.node.findFirst.mockResolvedValueOnce(node({ connection: "OFFLINE" }) as never);
    await expect(
      client(PERSON, { writeSecrets: vi.fn() }).secrets.delete({
        nodeId: "node-1",
        name: "WSMP_SECRET_HF",
      }),
    ).rejects.toMatchObject({ data: { reason: "node_offline" } });
  });

  it("refuses when the server has no relay hook yet, and never stores the value", async () => {
    db.node.findFirst.mockResolvedValueOnce(node() as never);
    await expect(
      client(PERSON).secrets.set({ nodeId: "node-1", name: "WSMP_SECRET_HF", value: SECRET }),
    ).rejects.toMatchObject({ data: { reason: "secret_needs_node" } });
    expect(db.nodeAuditEvent.create).not.toHaveBeenCalled();
    expect(db.node.update).not.toHaveBeenCalled();
    expect(db.node.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a read-only agent before reading the node", async () => {
    await expect(
      client(READ_AGENT).secrets.set({ nodeId: "node-1", name: "WSMP_SECRET_HF", value: SECRET }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.node.findFirst).not.toHaveBeenCalled();
  });

  it("reports a node refusal without the value", async () => {
    db.node.findFirst.mockResolvedValueOnce(node() as never);
    const writeSecrets = vi.fn<NonNullable<NodeRelayServices["writeSecrets"]>>(async () => [
      { name: "WSMP_SECRET_HF", status: "refused", reason: "store_failed" },
    ]);
    const error = await client(PERSON, { writeSecrets })
      .secrets.set({ nodeId: "node-1", name: "WSMP_SECRET_HF", value: SECRET })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });
});
