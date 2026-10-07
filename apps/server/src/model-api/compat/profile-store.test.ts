import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../../../packages/db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../../packages/db/prisma/generated/client")
  >("../../../../../packages/db/prisma/generated/client");
  return { default: mockDeep<PrismaClient>(), Prisma: actual.Prisma };
});

const db = (await import("@ws-model-proxy/db")).default as unknown as ReturnType<
  typeof mockDeep<PrismaClient>
>;
const store = await import("./profile-store.js");

const key = { userId: "u", runtimeId: "r", launchHash: "h" };
const accepted = { v: 1 as const, endpoints: { "chat.completions": { p: { model: {} } } } };
const learned = {
  v: 1,
  fixes: { "chat.completions": [{ kind: "drop", path: "store" }] },
  stripHeaders: [],
};

beforeEach(() => {
  mockReset(db);
  store.clearRequestProfileCache();
});

describe("request profile store", () => {
  it("reads a launch's profile once and serves it from the cache", async () => {
    db.runtimeRequestProfile.findFirst.mockResolvedValue({
      accepted,
      learned,
      engineFingerprint: "e 1",
    } as never);
    const first = await store.loadRequestProfile(key);
    const second = await store.loadRequestProfile(key);
    expect(first.learned.fixes["chat.completions"]).toEqual([{ kind: "drop", path: "store" }]);
    expect(second).toBe(first);
    expect(db.runtimeRequestProfile.findFirst).toHaveBeenCalledTimes(1);
    expect(db.runtimeRequestProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runtimeId: "r", launchHash: "h", userId: "u" } }),
    );
  });

  it("reads as empty when the database fails", async () => {
    db.runtimeRequestProfile.findFirst.mockRejectedValue(new Error("down"));
    expect((await store.loadRequestProfile(key)).accepted).toBeNull();
  });

  it("adds a learned fix with an optimistic update and retries a lost race", async () => {
    const updatedAt = new Date(1);
    db.runtimeRequestProfile.findFirst.mockResolvedValue({
      id: "p",
      learned: { v: 1, fixes: {}, stripHeaders: [] },
      updatedAt,
      accepted: null,
      engineFingerprint: null,
    } as never);
    db.runtimeRequestProfile.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    await store.recordLearnedFix(key, "chat.completions", { kind: "drop", path: "store" });
    expect(db.runtimeRequestProfile.updateMany).toHaveBeenCalledTimes(2);
    expect(db.runtimeRequestProfile.updateMany).toHaveBeenLastCalledWith({
      where: { id: "p", updatedAt },
      data: { learned },
    });
    expect((await store.loadRequestProfile(key)).learned).toEqual(learned);
  });

  it("keeps what was learned for the same engine and forgets it for another", async () => {
    db.runtimeRequestProfile.findFirst.mockResolvedValue({
      id: "p",
      engineFingerprint: "e 1",
      learned,
    } as never);
    await store.saveDescribedProfile(key, { accepted, engineFingerprint: "e 1" });
    expect(db.runtimeRequestProfile.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ learned, source: "OPENAPI" }) }),
    );
    await store.saveDescribedProfile(key, { accepted, engineFingerprint: "e 2" });
    expect(db.runtimeRequestProfile.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ learned: { v: 1, fixes: {}, stripHeaders: [] } }),
      }),
    );
  });

  it("forgets a described engine that no longer describes itself", async () => {
    db.runtimeRequestProfile.findFirst.mockResolvedValue({
      id: "p",
      engineFingerprint: "e 1",
    } as never);
    await store.markProbedWithoutDescription(key);
    expect(db.runtimeRequestProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ engineFingerprint: null, source: "LEARNED" }),
      }),
    );
    db.runtimeRequestProfile.findFirst.mockResolvedValue({
      id: "p",
      engineFingerprint: null,
    } as never);
    await store.markProbedWithoutDescription(key, new Date(5));
    expect(db.runtimeRequestProfile.update).toHaveBeenLastCalledWith({
      where: { id: "p" },
      data: { probedAt: new Date(5) },
    });
  });
});
