import type { DeploymentJobResult } from "@ws-model-proxy/config/deployment-protocol";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

import prisma from "@ws-model-proxy/db";
import { type DeploymentLiveSocket, DeploymentReconciler } from "./reconciler.js";

describe("deployment operator progress", () => {
  it("drops operator progress that names no terminal before touching the database", async () => {
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

  it("applies one step's results strictly in arrival order", async () => {
    const socket: DeploymentLiveSocket = {
      userId: "owner",
      cliDeviceId: "node",
      generation: 1,
      inventoryComplete: true,
    };
    const db = vi.mocked(prisma);
    const releases: Array<() => void> = [];
    db.$transaction.mockImplementation(
      (() =>
        new Promise((resolve) => {
          releases.push(() => resolve(false));
        })) as unknown as typeof db.$transaction,
    );
    const reconciler = new DeploymentReconciler({ current: () => socket, send: () => true }, db);
    const result = (status: DeploymentJobResult["status"]): DeploymentJobResult => ({
      type: "deployment.job.result",
      stepId: "step",
      instanceId: "instance",
      rank: 0,
      intentHash: "a".repeat(64),
      ownerEpoch: "epoch:1",
      stopped: false,
      status,
      terminalId: "AAECAwQFBgcICQoLDA0ODw",
    });
    const first = reconciler.acceptResult(socket, result("awaiting_operator"));
    const second = reconciler.acceptResult(socket, result("operator_running"));
    const other = reconciler.acceptResult(socket, { ...result("awaiting_operator"), stepId: "x" });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    // The running report waits for its screen report; another step does not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(releases).toHaveLength(2);
    releases[0]?.();
    await first;
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[1]?.();
    releases[2]?.();
    await Promise.all([second, other]);
    db.$transaction.mockReset();
    await reconciler.stop();
  });
});
