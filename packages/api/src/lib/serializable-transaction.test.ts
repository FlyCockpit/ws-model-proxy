import { beforeEach, describe, expect, it, vi } from "vitest";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@ws-model-proxy/db", () => ({
  default: { $transaction: transaction },
  Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
}));

import {
  retryableSerializableTransactionCode,
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

  it.each([
    null,
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
  });
});
