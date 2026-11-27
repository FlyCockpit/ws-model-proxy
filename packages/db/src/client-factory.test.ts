import type { PoolConfig } from "pg";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ configs: [] as PoolConfig[], transactions: 0 }));
vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(config: PoolConfig) {
      state.configs.push(config);
    }
  },
}));
vi.mock("../prisma/generated/client", () => ({
  PrismaClient: class {
    async $transaction(work: (tx: object) => Promise<unknown>) {
      state.transactions++;
      return work(this);
    }
  },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://localhost/disposable-unit", DATABASE_POOL_MAX: 3 },
}));

import { createPrismaClient } from "./client-factory";
import prisma from "./index";
import { releaseSlots, tryAcquireSlots, withLockSlot } from "./lock-slots";
import { armDbShutdownFence, DbShutdownFenceError, disarmDbShutdownFence } from "./shutdown-fence";

describe("shared request pool and lock accounting", () => {
  it("constructs the actual PrismaPg request pool with the validated ceiling and release guard", () => {
    expect(state.configs[0]?.max).toBe(3);
    expect(state.configs[0]?.onConnect).toBeTypeOf("function");
    const Connection = state.configs[0]?.Client;
    expect(Object.getPrototypeOf(Connection?.prototype).constructor.name).toBe(
      "ReleaseGuardedClient",
    );
    createPrismaClient("postgresql://localhost/disposable-unit", { maxConnections: 7 });
    expect(state.configs.at(-1)?.max).toBe(7);
  });
  it("accounts raw transactions before checkout, consumes high-level tickets once, and reserves nested work", async () => {
    await withLockSlot(
      async () => {
        await prisma.$transaction(async () => {
          expect(tryAcquireSlots()).toBe(false);
          await withLockSlot(() =>
            prisma.$transaction(async () => {
              expect(tryAcquireSlots()).toBe(false);
            }),
          );
        });
      },
      { nested: 1 },
    );
    await prisma.$transaction(async () => {
      expect(tryAcquireSlots()).toBe(true);
      expect(tryAcquireSlots()).toBe(false);
      releaseSlots();
    });
    expect(state.transactions).toBe(3);
  });
  it("rechecks shutdown after a queued raw transaction obtains its slot", async () => {
    expect(tryAcquireSlots(2)).toBe(true);
    const before = state.transactions;
    const waiting = prisma.$transaction(async () => {});
    const refused = expect(waiting).rejects.toBeInstanceOf(DbShutdownFenceError);
    armDbShutdownFence();
    releaseSlots(2);
    try {
      await refused;
      expect(state.transactions).toBe(before);
    } finally {
      disarmDbShutdownFence();
    }
  });
});
