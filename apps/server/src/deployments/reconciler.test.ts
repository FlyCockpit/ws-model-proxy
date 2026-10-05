import type { DeploymentJobResult } from "@ws-model-proxy/config/deployment-protocol";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

import prisma from "@ws-model-proxy/db";
import { type DeploymentLiveSocket, DeploymentReconciler } from "./reconciler.js";

describe("deployment operator progress", () => {
  it("never settles, fails or touches a step until interactive dispatch exists", async () => {
    const socket: DeploymentLiveSocket = {
      userId: "owner",
      cliDeviceId: "node",
      generation: 1,
      inventoryComplete: true,
    };
    const db = vi.mocked(prisma);
    const reconciler = new DeploymentReconciler({ current: () => socket, send: () => true }, db);
    const base = {
      type: "deployment.job.result",
      stepId: "step",
      instanceId: "instance",
      rank: 0,
      intentHash: "a".repeat(64),
      ownerEpoch: "epoch:1",
      stopped: false,
      terminalId: "AAECAwQFBgcICQoLDA0ODw",
    } as const;
    const results: DeploymentJobResult[] = [
      { ...base, status: "awaiting_operator" },
      { ...base, status: "operator_running" },
      { ...base, status: "operator_closed", exitCode: 1 },
      { ...base, status: "operator_closed" },
    ];
    for (const result of results)
      expect(await reconciler.acceptResult(socket, result), result.status).toBe(false);
    // No transaction, so no step update, no gang stop and no claim release.
    expect(db.$transaction).not.toHaveBeenCalled();
    await reconciler.stop();
  });
});
