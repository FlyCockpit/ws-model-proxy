import { beforeEach, describe, expect, it, vi } from "vitest";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@ws-model-proxy/db", () => ({
  default: { $transaction: transaction },
  Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
}));

import { runSerializableTransaction } from "./serializable-transaction";

describe("serializable transaction retry", () => {
  beforeEach(() => transaction.mockReset());

  it("retries serialization and deadlock failures", async () => {
    transaction
      .mockRejectedValueOnce({ code: "40001" })
      .mockRejectedValueOnce({ code: "40P01" })
      .mockResolvedValueOnce("ok");
    await expect(runSerializableTransaction(async () => "unused")).resolves.toBe("ok");
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});
