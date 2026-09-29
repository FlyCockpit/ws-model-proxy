import { ORPCError } from "@orpc/server";
import { FenceSetChangedError } from "@ws-model-proxy/db/capacity-lock-order";
import { ParentDeletionDrainPendingError } from "@ws-model-proxy/db/parent-deletion";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: { $transaction: vi.fn() } }));

const { runCapacityOrderedTransaction } = vi.hoisted(() => ({
  runCapacityOrderedTransaction: vi.fn(),
}));
vi.mock("@ws-model-proxy/db/capacity-lock-order", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ws-model-proxy/db/capacity-lock-order")>()),
  runCapacityOrderedTransaction,
}));

import {
  runCapacityDeleteTransaction,
  throwParentDeletionPendingConflict,
} from "./serializable-transaction";

describe("deletion CONFLICT reasons from the shared parent-delete helpers", () => {
  beforeEach(() => {
    runCapacityOrderedTransaction.mockReset();
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

  it("runCapacityDeleteTransaction: an owner set that kept changing is delete_contended", async () => {
    runCapacityOrderedTransaction.mockRejectedValueOnce(new FenceSetChangedError());
    await expect(runCapacityDeleteTransaction(async () => "unused")).rejects.toMatchObject({
      code: "CONFLICT",
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
