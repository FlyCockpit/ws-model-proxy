import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../../packages/db/prisma/generated/client";
import type { LocalSendBinding } from "./local-send.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-local-send-secret-0123456789", NODE_ENV: "test" },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const actual = await import("../../../../packages/db/prisma/generated/client");
  return { default: mockDeep<PrismaClient>(), Prisma: actual.Prisma };
});
vi.mock("@ws-model-proxy/db/capacity-lock-order", () => ({
  acquireFences: vi.fn(async () => undefined),
  fenceOwners: vi.fn(async () => undefined),
  fences: { capacityPolicy: (id: string) => id },
}));

const { default: prisma } = await import("@ws-model-proxy/db");
const { withAuthorizedLocalSend } = await import("./local-send.js");
const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;

const binding: LocalSendBinding = {
  requesterUserId: "caller",
  engineOwnerUserId: "caller",
  runtimeModelId: "model",
  executionTargetId: "target",
  capacityId: "instance",
  nodeId: "head",
  handle: "handle",
  upstreamModelId: "m",
  agentAccess: { scopes: ["read", "models:test"], nodeIds: ["head", "worker"] },
};

beforeEach(() => {
  mockReset(db);
  db.$transaction.mockImplementation((async (work: unknown) =>
    typeof work === "function" ? work(db) : Promise.all(work as Promise<unknown>[])) as never);
  db.executionTarget.findUnique.mockResolvedValue({
    userId: "caller",
    instanceId: "instance",
    runtimeModelId: "model",
    RuntimeModel: { upstreamModelId: "m", embeddingContract: null },
    Instance: {
      handle: "handle",
      phase: "READY",
      Runtime: { kind: "STARTABLE" },
      Ranks: [{ nodeId: "head" }],
    },
  } as never);
  db.node.findUnique.mockResolvedValue({
    userId: "caller",
    connection: "ONLINE",
    lastHeartbeatAt: new Date(),
  } as never);
  db.instanceRank.findMany.mockResolvedValue([{ nodeId: "head" }, { nodeId: "worker" }] as never);
  db.node.count.mockResolvedValue(2);
  db.user.findUnique.mockResolvedValue({
    banned: false,
    banExpires: null,
    deletionRequestedAt: null,
  } as never);
});

describe("agent model-test local dispatch", () => {
  it("refuses another user's node even when it is a member of a shared pool", async () => {
    const send = vi.fn();
    await expect(
      withAuthorizedLocalSend(
        {
          ...binding,
          engineOwnerUserId: "other-owner",
          pool: {
            id: "shared-pool",
            ownerUserId: "other-owner",
            shareId: "can-use",
            memberId: "member",
          },
        },
        send,
      ),
    ).rejects.toMatchObject({ denial: "ACCESS_REVOKED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a head node outside the allowlist before any dispatch", async () => {
    const send = vi.fn();
    await expect(
      withAuthorizedLocalSend(
        { ...binding, agentAccess: { scopes: ["read", "models:test"], nodeIds: [] } },
        send,
      ),
    ).rejects.toMatchObject({ denial: "ACCESS_REVOKED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a distributed worker outside the allowlist", async () => {
    const send = vi.fn();
    await expect(
      withAuthorizedLocalSend(
        { ...binding, agentAccess: { scopes: ["read", "models:test"], nodeIds: ["head"] } },
        send,
      ),
    ).rejects.toMatchObject({ denial: "ACCESS_REVOKED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a distributed worker owned by someone else", async () => {
    db.node.count.mockResolvedValueOnce(1);
    const send = vi.fn();
    await expect(withAuthorizedLocalSend(binding, send)).rejects.toMatchObject({
      denial: "ACCESS_REVOKED",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an instance whose distributed worker has lost its node", async () => {
    db.instanceRank.findMany.mockResolvedValueOnce([{ nodeId: "head" }, { nodeId: null }] as never);
    const send = vi.fn();
    await expect(withAuthorizedLocalSend(binding, send)).rejects.toMatchObject({
      denial: "MEMBER_UNAVAILABLE",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends when every runtime node is owned and allowed", async () => {
    const send = vi.fn(() => "sent");
    await expect(withAuthorizedLocalSend(binding, send)).resolves.toBe("sent");
    expect(send).toHaveBeenCalledOnce();
  });
});
