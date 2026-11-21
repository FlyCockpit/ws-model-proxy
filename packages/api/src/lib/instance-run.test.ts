import prisma, { type RuntimeInstance } from "@ws-model-proxy/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import { beginRun, resolveRun } from "./instance-run";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
const db = prisma as unknown as ReturnType<typeof mockDeep<typeof prisma>>;

describe("stored instance run", () => {
  beforeEach(() => mockReset(db));

  it("returns zero only when the instance does not exist", async () => {
    db.runtimeInstance.findUnique.mockResolvedValue(null);
    await expect(resolveRun(db, "missing")).resolves.toBe(0);
  });

  it.each([1, 5])("returns an existing positive run %s", async (runGeneration) => {
    db.runtimeInstance.findUnique.mockResolvedValue({
      ...mockDeep<RuntimeInstance>(),
      runGeneration,
    });
    await expect(resolveRun(db, "instance")).resolves.toBe(runGeneration);
  });

  it.each([0, -1])(
    "refuses an unbackfilled run %s before a restart can adopt old steps",
    async (runGeneration) => {
      db.runtimeInstance.findUnique.mockResolvedValue({
        ...mockDeep<RuntimeInstance>(),
        runGeneration,
      });
      await expect(resolveRun(db, "instance")).rejects.toThrow(
        "Runtime instance schema backfill not applied: the 1.0 upgrade migration has not run (see UPGRADING.md).",
      );
      await expect(beginRun(db, "instance")).rejects.toThrow("schema backfill not applied");
      expect(db.runtimeInstance.update).not.toHaveBeenCalled();
    },
  );
});
