import { requestUserDeletion } from "@ws-model-proxy/db/parent-deletion";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => ({
  default: (await import("vitest-mock-extended")).mockDeep(),
}));

import prisma from "@ws-model-proxy/db";
import { assertAdminRemovalAllowed } from "./admin-presence";

const tx = {
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  user: { findUnique: vi.fn() },
  session: { deleteMany: vi.fn() },
};
const transaction = vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
// Script the existing owner-fence and deletion mark SQL; no live database.
const db = { ...prisma, $transaction: transaction } as unknown as Parameters<
  typeof requestUserDeletion
>[0];
beforeEach(() => {
  vi.clearAllMocks();
  tx.user.findUnique.mockResolvedValue({
    id: "target",
    role: "admin",
    emailVerified: true,
    banned: false,
    banExpires: null,
    deletionRequestedAt: null,
  });
  tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) =>
    sql.join("?").includes("count(*)") ? [{ count: 1 }] : [{ generation: "mark" }],
  );
});
describe("durable deletion's last-admin guard", () => {
  it("checks after the owner fence, before marking or deleting sessions, in Serializable isolation", async () => {
    await expect(
      requestUserDeletion(db, "target", (client) => assertAdminRemovalAllowed(client, "target")),
    ).rejects.toMatchObject({ data: { reason: "LAST_ACTIVE_ADMIN" } });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(tx.$queryRaw.mock.calls[0]?.[0].join("?")).toContain("wsmp_acquire_fences");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.user.findUnique.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("marks and revokes on the same transaction after the fresh admin count admits it", async () => {
    tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) =>
      sql.join("?").includes("count(*)") ? [{ count: 2 }] : [{ generation: "mark" }],
    );
    await expect(
      requestUserDeletion(db, "target", (client) => assertAdminRemovalAllowed(client, "target")),
    ).resolves.toMatchObject({ generation: "mark" });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.session.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { OR: [{ userId: "target" }, { impersonatedBy: "target" }] },
    });
  });
});
