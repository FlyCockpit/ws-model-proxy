import { beforeEach, describe, expect, it, vi } from "vitest";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@ws-model-proxy/db", () => ({
  default: { $transaction: transaction },
  Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
}));

import {
  retryableSerializableTransactionCode,
  runSerializableCapacityCreationTransaction,
  runSerializableTransaction,
} from "./serializable-transaction";

describe("serializable transaction retry", () => {
  beforeEach(() => transaction.mockReset());

  it("retries serialization and deadlock failures", async () => {
    transaction
      .mockRejectedValueOnce({ code: "P2034" })
      .mockRejectedValueOnce({ code: "40001" })
      .mockRejectedValueOnce({ code: "40P01" })
      .mockResolvedValueOnce("ok");
    await expect(runSerializableTransaction(async () => "unused")).resolves.toBe("ok");
    expect(transaction).toHaveBeenCalledTimes(4);
  });

  it("retries SQLSTATE errors wrapped by Prisma P2010", async () => {
    transaction
      .mockRejectedValueOnce({ code: "P2010", meta: { code: "40001", message: "write conflict" } })
      .mockRejectedValueOnce({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
      })
      .mockResolvedValueOnce("ok");
    await expect(runSerializableTransaction(async () => "unused")).resolves.toBe("ok");
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("retries Prisma adapter transaction-write-conflict errors", async () => {
    transaction
      .mockRejectedValueOnce({
        name: "DriverAdapterError",
        cause: { kind: "TransactionWriteConflict" },
      })
      .mockRejectedValueOnce({
        code: "P2010",
        meta: { driverAdapterError: { cause: { kind: "TransactionWriteConflict" } } },
      })
      .mockResolvedValueOnce("ok");
    await expect(runSerializableTransaction(async () => "unused")).resolves.toBe("ok");
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it.each([
    { code: "23505", constraint: "inference_capacity_userId_label_key" },
    { code: "P2002", meta: { target: "inference_capacity_userId_label_key" } },
    {
      code: "P2002",
      meta: {
        modelName: "DiscoveredModel",
        driverAdapterError: {
          cause: {
            originalCode: "23505",
            constraint: { index: "inference_capacity_userId_label_key" },
          },
        },
      },
    },
    {
      code: "P2010",
      meta: {
        code: "23505",
        driverAdapterError: {
          cause: { constraint: { index: "inference_capacity_userId_label_key" } },
        },
      },
    },
  ])("retries only the capacity label unique index with a fresh transaction %#", async (error) => {
    transaction.mockRejectedValueOnce(error).mockResolvedValueOnce("allocated suffix");
    expect(retryableSerializableTransactionCode(error)).toBe("23505");
    await expect(runSerializableCapacityCreationTransaction(async () => "unused")).resolves.toBe(
      "allocated suffix",
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry explicit owner label conflicts in policy transactions", async () => {
    const error = { code: "P2002", meta: { target: "inference_capacity_userId_label_key" } };
    transaction.mockRejectedValueOnce(error);
    await expect(runSerializableTransaction(async () => "unused")).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    { code: "23505", constraint: "inference_capacity_userId_runtimeIdentityKey_key" },
    { code: "P2002", meta: { target: "provider_account_userId_label_key" } },
    {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: "23505",
            constraint: { index: "provider_model_providerAccountId_upstreamModelId_key" },
          },
        },
      },
    },
    "40001",
    {},
    { code: "P2010" },
    { code: "P2010", meta: null },
    { code: "P2010", meta: { code: "23505" } },
    {
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "23505" } } },
    },
    { code: "P2002", meta: { code: "40001" } },
    { code: 40001 },
  ])("does not classify a non-retryable error %#", async (error) => {
    expect(retryableSerializableTransactionCode(error)).toBeUndefined();
    transaction.mockRejectedValueOnce(error);
    await expect(runSerializableTransaction(async () => "unused")).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
    transaction.mockRejectedValueOnce(error);
    await expect(runSerializableCapacityCreationTransaction(async () => "unused")).rejects.toBe(
      error,
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
