import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../../packages/db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
vi.mock("@ws-model-proxy/db/capacity-lock-order", () => ({
  acquireFences: vi.fn(async () => true),
  fences: { owner: (userId: string) => `owner:${userId}` },
  runCapacityOrderedTransaction: vi.fn(
    (db: { $transaction: (work: unknown) => unknown }, work: unknown) => db.$transaction(work),
  ),
}));

import prisma from "@ws-model-proxy/db";
import { DbNull } from "@ws-model-proxy/db/json-null";
import { type NodeHelloFacts, registerNodeHello } from "./registration.js";

const db = vi.mocked(prisma, true);
const identity = { credentialId: "cred-1", nodeId: "node-1", userId: "owner-1" } as never;

function hello(extra: Partial<NodeHelloFacts> = {}): NodeHelloFacts {
  return {
    slug: "box-1",
    version: "0.4.3",
    identityPublicKey: "key",
    trust: "full",
    features: {} as never,
    definitions: [],
    heldMetricCommandsHash: null,
    heldFabricsHash: null,
    ...extra,
  };
}

beforeEach(() => {
  mockReset(db);
  db.$transaction.mockImplementation((async (work: (tx: unknown) => unknown) => work(db)) as never);
  db.nodeCredential.findUnique.mockResolvedValue({
    revokedAt: null,
    identityPublicKey: "key",
    User: { banned: false, banExpires: null, deletionRequestedAt: null },
    Node: {
      id: "node-1",
      userId: "owner-1",
      slug: "box-1",
      trust: "FULL",
      trustLowerRequestedAt: null,
    },
  } as never);
  db.node.updateMany.mockResolvedValue({ count: 1 });
  db.node.update.mockResolvedValue({ connectionGeneration: 4 } as never);
  db.nodeCredential.update.mockResolvedValue({} as never);
});

describe("registerNodeHello stores the self-update facts", () => {
  it("writes the reported build and environment", async () => {
    const build = {
      commit: "0123456789abcdef0123456789abcdef01234567",
      installMethod: "script" as const,
      target: "x86_64-unknown-linux-gnu",
    };
    await registerNodeHello({
      identity,
      hello: hello({ build, environment: { wsl: true } }),
      protocolVersion: "3.0",
    });
    expect(db.node.update.mock.calls[0]?.[0].data).toMatchObject({
      cliVersion: "0.4.3",
      cliBuild: build,
      environment: { wsl: true },
    });
  });

  it("clears them for a hello without them (an older or downgraded wsmp)", async () => {
    await registerNodeHello({ identity, hello: hello(), protocolVersion: "3.0" });
    expect(db.node.update.mock.calls[0]?.[0].data).toMatchObject({
      cliBuild: DbNull,
      environment: DbNull,
    });
  });
});
