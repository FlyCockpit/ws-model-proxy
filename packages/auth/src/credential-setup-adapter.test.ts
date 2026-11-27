import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the pinned Prisma adapter; only the database checkout/delegates are fake.
const db = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  verification: { findMany: vi.fn(), deleteMany: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@ws-model-proxy/db", () => ({ default: db }));
vi.mock("@ws-model-proxy/db/capacity-lock-order", () => ({
  fenceOwners: vi.fn(async () => {}),
  requireOwnerFences: vi.fn(async () => {}),
}));
const { configureLockSlots } = await import("@ws-model-proxy/db/lock-slots");
configureLockSlots(3);
const { createCredentialSetupAdapter } = await import("./credential-setup-adapter");
const { releaseSlots, tryAcquireSlots } = await import("./lock-slots");
const adapter = createCredentialSetupAdapter()({});
type Selector = Parameters<typeof adapter.update>[0]["where"][number];
const user = { id: "InviteA", email: "InviteA@example.test", emailVerified: true };

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findFirst.mockResolvedValue(user);
  db.user.update.mockResolvedValue(user);
  db.user.updateMany.mockResolvedValue({ count: 1 });
  db.verification.findMany.mockResolvedValue([]);
  db.verification.deleteMany.mockResolvedValue({ count: 0 });
  db.$executeRaw.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => run(db));
});

describe.each(["update", "updateMany"] as const)("activation %s selectors", (method) => {
  const write = (where: Selector[]) =>
    adapter[method]({ model: "user", where, update: { emailVerified: true } });

  it.each(["id", "email"])(
    "rejects case-insensitive %s before lookup, checkout or writes",
    async (field) => {
      await expect(
        write([{ field, value: user[field as "id" | "email"], mode: "insensitive" }]),
      ).rejects.toThrow("Activation requires an exact user selector");
      expect(db.user.findFirst).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.user.updateMany).not.toHaveBeenCalled();
      expect(db.verification.deleteMany).not.toHaveBeenCalled();
      expect(tryAcquireSlots(2)).toBe(true);
      releaseSlots(2);
    },
  );

  it.each<{ value: Selector["value"] }>([
    { value: ["InviteA", "invitea"] },
    { value: [1, 2] },
    { value: null },
    { value: 12 },
    { value: true },
    { value: new Date(0) },
  ])("rejects non-string selector $value before lookup, checkout or writes", async ({ value }) => {
    await expect(write([{ field: "id", value, operator: "eq" }])).rejects.toThrow(
      "Activation requires an exact user selector",
    );
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  it.each<{ where: Selector[] }>([
    { where: [] },
    { where: [{ field: "name", value: "InviteA" }] },
    { where: [{ field: "id", value: "InviteA", operator: "ne" }] },
    { where: [{ field: "email", value: "InviteA", operator: "starts_with" }] },
    {
      where: [
        { field: "id", value: "InviteA" },
        { field: "email", value: user.email },
      ],
    },
  ])("rejects selectors that cannot identify exactly one user: $where", async ({ where }) => {
    await expect(write(where)).rejects.toThrow("Activation requires an exact user selector");
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it.each(["id", "email"] as const)(
    "accepts exact %s and invokes this method under the locks",
    async (field) => {
      await write([{ field, value: user[field], operator: "eq", mode: "sensitive" }]);
      expect(db.$transaction).toHaveBeenCalledOnce();
      expect(db.$executeRaw.mock.calls.map((args) => args[1])).toEqual(["password-write:InviteA"]);
      expect(db.user[method]).toHaveBeenCalledOnce();
      expect(db.user[method === "update" ? "updateMany" : "update"]).not.toHaveBeenCalled();
      expect(db.verification.deleteMany).toHaveBeenCalled();
    },
  );
});
