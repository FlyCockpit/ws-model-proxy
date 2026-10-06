import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));

import prisma from "@ws-model-proxy/db";
import type { Context } from "../context";
import { inferenceContributionsRouter } from "./inference-contributions";

function client(services: Context["services"]) {
  return createRouterClient(inferenceContributionsRouter, {
    context: {
      session: {
        user: { id: "contributor", email: "c@example.test", name: "C", role: "user" },
        session: { id: "s", userId: "contributor", expiresAt: new Date(Date.now() + 60_000) },
      },
      services,
    } as unknown as Context,
  });
}

describe("inference contribution consent", () => {
  it("refuses an agent offering this user's machine to another pool, before any read", async () => {
    await expect(
      client({ deploymentActor: { kind: "AGENT", id: "token" } } as Context["services"]).offer({
        poolId: "pool",
        discoveredModelId: "model",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(vi.mocked(prisma).$transaction).not.toHaveBeenCalled();
  });
});
