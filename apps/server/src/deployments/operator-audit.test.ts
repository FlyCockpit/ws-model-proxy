import { armDbShutdownFence, disarmDbShutdownFence } from "@ws-model-proxy/db/shutdown-fence";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const {
  DEPLOYMENT_OPERATOR_AUDIT_FLUSH_DELAY_MS,
  DEPLOYMENT_OPERATOR_AUDIT_QUEUE_CAP,
  deploymentOperatorAuditDroppedCount,
  flushDeploymentOperatorAudit,
  queuedDeploymentOperatorEventsForTests,
  recordDeploymentOperatorEvent,
  resetDeploymentOperatorAuditForTests,
} = await import("./operator-audit.js");
type Input = Parameters<typeof recordDeploymentOperatorEvent>[0];

const createMany = (prisma as unknown as { deploymentOperatorEvent: { createMany: MockInstance } })
  .deploymentOperatorEvent.createMany;
const findUsers = (prisma as unknown as { user: { findMany: MockInstance } }).user.findMany;

function event(overrides: Partial<Input> = {}): Input {
  return {
    userId: "user-1",
    instanceId: "instance-1",
    stepId: "step-1",
    cliDeviceId: "device-1",
    rank: 0,
    action: "start",
    outcome: "opened",
    ...overrides,
  };
}

function written(): Array<Record<string, unknown>> {
  return createMany.mock.calls.flatMap(
    ([args]) => (args as { data: Array<Record<string, unknown>> }).data,
  );
}

describe("recordDeploymentOperatorEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDeploymentOperatorAuditForTests();
    createMany.mockReset();
    createMany.mockResolvedValue({ count: 0 });
    findUsers.mockReset();
    findUsers.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id })),
    );
  });
  afterEach(() => {
    disarmDbShutdownFence();
    vi.useRealTimers();
  });

  it("writes metadata rows in a batch after the flush delay", async () => {
    recordDeploymentOperatorEvent(event());
    recordDeploymentOperatorEvent(event({ outcome: "closed", exitCode: 2 }));
    expect(createMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEPLOYMENT_OPERATOR_AUDIT_FLUSH_DELAY_MS);
    expect(written()).toEqual([
      {
        userId: "user-1",
        instanceId: "instance-1",
        stepId: "step-1",
        cliDeviceId: "device-1",
        rank: 0,
        action: "start",
        outcome: "opened",
        exitCode: null,
      },
      expect.objectContaining({ outcome: "closed", exitCode: 2 }),
    ]);
  });

  it("drops rows the schema CHECK would refuse and exit codes it does not allow", () => {
    recordDeploymentOperatorEvent(event({ action: "health" }));
    recordDeploymentOperatorEvent(event({ rank: 64 }));
    recordDeploymentOperatorEvent(event({ stepId: "" }));
    recordDeploymentOperatorEvent(event({ userId: "x".repeat(129) }));
    expect(queuedDeploymentOperatorEventsForTests()).toEqual([]);
    expect(deploymentOperatorAuditDroppedCount()).toBe(4);
    recordDeploymentOperatorEvent(event({ outcome: "declined", exitCode: 1 }));
    recordDeploymentOperatorEvent(event({ outcome: "closed", exitCode: 256 }));
    expect(queuedDeploymentOperatorEventsForTests().map((row) => row.exitCode)).toEqual([
      null,
      null,
    ]);
  });

  it("skips rows of deleted users and bounds the queue", async () => {
    findUsers.mockResolvedValue([{ id: "user-1" }]);
    recordDeploymentOperatorEvent(event({ userId: "gone" }));
    recordDeploymentOperatorEvent(event());
    await flushDeploymentOperatorAudit();
    expect(written()).toHaveLength(1);
    for (let i = 0; i < DEPLOYMENT_OPERATOR_AUDIT_QUEUE_CAP + 5; i += 1)
      recordDeploymentOperatorEvent(event());
    expect(queuedDeploymentOperatorEventsForTests()).toHaveLength(
      DEPLOYMENT_OPERATOR_AUDIT_QUEUE_CAP,
    );
  });

  it("drops instead of writing once the shutdown fence is armed, and never rejects", async () => {
    recordDeploymentOperatorEvent(event());
    armDbShutdownFence();
    await flushDeploymentOperatorAudit();
    expect(createMany).not.toHaveBeenCalled();
    disarmDbShutdownFence();
    createMany.mockRejectedValue(new Error("boom"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    recordDeploymentOperatorEvent(event());
    await expect(flushDeploymentOperatorAudit()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith("[audit] deployment operator audit write failed:", "Error");
    errors.mockRestore();
  });
});
