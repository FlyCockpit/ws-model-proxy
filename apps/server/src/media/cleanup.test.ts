import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaStore } from "./store.js";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));
const { sweepExpiredMedia } = await import("./cleanup.js");

const NOW = new Date("2026-11-12T12:00:00Z");

function fixture(count: number) {
  let rows = Array.from({ length: count }, (_, i) => ({ id: `asset-${i}`, expiresAt: NOW }));
  const mediaAsset = {
    findMany: vi.fn(async ({ where, take }: { where: { id: { notIn: string[] } }; take: number }) =>
      rows.filter((row) => !where.id.notIn.includes(row.id)).slice(0, take),
    ),
    deleteMany: vi.fn(async ({ where }: { where: { id: string; expiresAt: { lte: Date } } }) => {
      const before = rows.length;
      rows = rows.filter((row) => row.id !== where.id || row.expiresAt > where.expiresAt.lte);
      return { count: before - rows.length };
    }),
  };
  const prisma = {
    mediaAsset,
    $transaction: vi.fn(async (run: (tx: { mediaAsset: typeof mediaAsset }) => Promise<number>) => {
      const before = rows;
      try {
        return await run({ mediaAsset });
      } catch (error) {
        rows = before;
        throw error;
      }
    }),
  };
  const store = {
    delete: vi.fn(async (_id: string) => {}),
    stage: vi.fn<MediaStore["stage"]>(),
    getStream: vi.fn<MediaStore["getStream"]>(),
    sweepStaleTmp: vi.fn<MediaStore["sweepStaleTmp"]>(),
  };
  return { prisma, store, rows: () => rows };
}

afterEach(() => vi.restoreAllMocks());

describe("sweepExpiredMedia", () => {
  it("keeps bytes when expiry was refreshed before the conditional delete", async () => {
    const { prisma, store, rows } = fixture(1);
    const row = rows()[0]!;
    prisma.mediaAsset.findMany.mockImplementationOnce(async () => {
      row.expiresAt = new Date(NOW.getTime() + 60_000);
      return [row];
    });
    expect(await sweepExpiredMedia({ prisma: prisma as never, store, now: NOW })).toBe(0);
    expect(store.delete).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    expect(prisma.mediaAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: row.id, expiresAt: { lte: NOW } },
    });
  });

  it("rolls back unlink failures, excludes failed ids, and finishes a full batch", async () => {
    const { prisma, store, rows } = fixture(501);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.delete.mockImplementation(async (id) => {
      if (id === "asset-0") throw new Error("secret path or database credentials");
    });
    expect(await sweepExpiredMedia({ prisma: prisma as never, store, now: NOW })).toBe(500);
    expect(rows().map((row) => row.id)).toEqual(["asset-0"]);
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.mediaAsset.findMany).toHaveBeenLastCalledWith({
      where: { expiresAt: { lte: NOW }, id: { notIn: ["asset-0"] } },
      select: { id: true },
      take: 500,
    });
    expect(store.delete.mock.calls.filter(([id]) => id === "asset-0")).toHaveLength(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[media] expired asset deletion failed; retained for retry.",
    );
  });

  it("unlinks only after a successful conditional row delete within the transaction", async () => {
    const { prisma, store, rows } = fixture(1);
    store.delete.mockImplementation(async () => {
      expect(rows()).toEqual([]);
      expect(prisma.$transaction).toHaveBeenCalledOnce();
    });
    expect(await sweepExpiredMedia({ prisma: prisma as never, store, now: NOW })).toBe(1);
  });
});
