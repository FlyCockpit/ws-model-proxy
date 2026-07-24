import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const { deleteAllMedia, getMediaStats } = await import("./admin.js");
const { LocalMediaStore } = await import("./store.js");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44]);

function fakePrisma() {
  return {
    mediaAsset: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "media-admin-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("getMediaStats", () => {
  it("returns aggregate counts, total bytes, and expired-pending count", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.aggregate.mockResolvedValue({
      _count: { _all: 7 },
      _sum: { sizeBytes: 4096 },
    });
    prisma.mediaAsset.count.mockResolvedValue(2);

    const now = new Date("2025-01-01T00:00:00Z");
    const stats = await getMediaStats({ prisma: prisma as never, now });

    expect(stats).toEqual({ assetCount: 7, totalBytes: 4096, expiredCount: 2 });
    expect(prisma.mediaAsset.count).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now } },
    });
  });

  it("reports zero bytes when the store is empty (null _sum)", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.aggregate.mockResolvedValue({
      _count: { _all: 0 },
      _sum: { sizeBytes: null },
    });
    prisma.mediaAsset.count.mockResolvedValue(0);

    const stats = await getMediaStats({ prisma: prisma as never });
    expect(stats).toEqual({ assetCount: 0, totalBytes: 0, expiredCount: 0 });
  });
});

describe("deleteAllMedia", () => {
  async function seedFile(store: InstanceType<typeof LocalMediaStore>, id: string): Promise<void> {
    const staged = await store.stage(Readable.from([PNG]));
    await staged.commit(id);
  }

  it("removes every asset's bytes and rows, returning row + byte counts", async () => {
    const store = new LocalMediaStore(root);
    await seedFile(store, "a");
    await seedFile(store, "b");

    const prisma = fakePrisma();
    // First findMany returns the two rows; second returns empty to end the loop.
    prisma.mediaAsset.findMany
      .mockResolvedValueOnce([
        { id: "a", sizeBytes: 10 },
        { id: "b", sizeBytes: 20 },
      ])
      .mockResolvedValueOnce([]);
    prisma.mediaAsset.deleteMany.mockResolvedValue({ count: 2 });

    const result = await deleteAllMedia({ store, prisma: prisma as never });

    expect(result).toEqual({ removed: 2, bytes: 30 });
    // Bytes are actually gone from disk.
    expect(await new LocalMediaStore(root).getStream("a")).toBeNull();
    expect(await new LocalMediaStore(root).getStream("b")).toBeNull();
    expect(prisma.mediaAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] } },
    });
  });

  it("is a no-op on an empty store", async () => {
    const store = new LocalMediaStore(root);
    const prisma = fakePrisma();
    prisma.mediaAsset.findMany.mockResolvedValue([]);

    const result = await deleteAllMedia({ store, prisma: prisma as never });
    expect(result).toEqual({ removed: 0, bytes: 0 });
    expect(prisma.mediaAsset.deleteMany).not.toHaveBeenCalled();
  });
});
