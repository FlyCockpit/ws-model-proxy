import { ORPCError } from "@orpc/server";
import {
  ParentDeletionDrainPendingError,
  ParentDeletionInterruptedError,
  RetainedHistoryError,
} from "@ws-model-proxy/db/parent-deletion";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: { $transaction: vi.fn() } }));

const { prepareParentDeletion, runCapacityOrderedTransaction } = vi.hoisted(() => ({
  prepareParentDeletion: vi.fn(),
  runCapacityOrderedTransaction: vi.fn(),
}));
vi.mock("@ws-model-proxy/db/parent-deletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ws-model-proxy/db/parent-deletion")>()),
  prepareParentDeletion,
}));
vi.mock("@ws-model-proxy/db/capacity-lock-order", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ws-model-proxy/db/capacity-lock-order")>()),
  runCapacityOrderedTransaction,
}));

import {
  drainBeforeParentDelete,
  runCapacityDeleteTransaction,
  throwParentDeletionPendingConflict,
} from "./serializable-transaction";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("deletion CONFLICT reasons from the shared parent-delete helpers", () => {
  beforeEach(() => {
    prepareParentDeletion.mockReset();
    runCapacityOrderedTransaction.mockReset();
  });

  it("drainBeforeParentDelete: retained history is retained_history", async () => {
    prepareParentDeletion.mockRejectedValueOnce(new RetainedHistoryError("capacity lease"));
    const error = await rejection(drainBeforeParentDelete({ userId: "u", poolIds: ["p"] }));
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: "CONFLICT",
      message:
        "This item has retained capacity or provider history and cannot be deleted. Disable it instead.",
      data: { reason: "retained_history" },
    });
  });

  it("drainBeforeParentDelete: a residual above the bound is delete_pending", async () => {
    prepareParentDeletion.mockRejectedValueOnce(new ParentDeletionDrainPendingError("busy"));
    await expect(
      drainBeforeParentDelete({ userId: "u", capacityIds: ["c"] }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This item still has requests in flight. Retry once they finish.",
      data: { reason: "delete_pending" },
    });
  });

  it("drainBeforeParentDelete: an interrupted drain stays SERVICE_UNAVAILABLE", async () => {
    prepareParentDeletion.mockRejectedValueOnce(new ParentDeletionInterruptedError());
    await expect(drainBeforeParentDelete({ userId: "u", poolIds: ["p"] })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("runCapacityDeleteTransaction: the in-transaction recount is delete_pending", async () => {
    runCapacityOrderedTransaction.mockRejectedValueOnce(
      new ParentDeletionDrainPendingError("recount"),
    );
    await expect(runCapacityDeleteTransaction(async () => "unused")).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "delete_pending" },
    });
  });

  it("runCapacityDeleteTransaction: exhausted lock retries are delete_contended", async () => {
    runCapacityOrderedTransaction.mockRejectedValueOnce({ code: "40P01" });
    await expect(runCapacityDeleteTransaction(async () => "unused")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Configuration changed concurrently. Retry the request.",
      data: { reason: "delete_contended" },
    });
  });

  it("runCapacityDeleteTransaction: other errors pass through untouched", async () => {
    const notFound = new ORPCError("NOT_FOUND");
    runCapacityOrderedTransaction.mockRejectedValueOnce(notFound);
    await expect(runCapacityDeleteTransaction(async () => "unused")).rejects.toBe(notFound);
  });

  it("throwParentDeletionPendingConflict ignores other errors", () => {
    expect(() => throwParentDeletionPendingConflict(new Error("other"))).not.toThrow();
    expect(() =>
      throwParentDeletionPendingConflict(new ParentDeletionDrainPendingError("x")),
    ).toThrow(expect.objectContaining({ data: { reason: "delete_pending" } }));
  });
});
