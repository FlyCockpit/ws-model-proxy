import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

const state = vi.hoisted(() => ({
  sessionLive: true,
  code: {
    id: "code",
    userId: "owner-1",
    revokedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 3_600_000),
    usedCount: 1,
    maxUses: 5,
    labels: [],
    removeAfterOfflineMs: null,
    ReplaceNode: null,
  },
  credentials: [] as { id: string; userId: string; revokedAt: Date | null }[],
  tail: Promise.resolve(),
  reachedFence: 0,
  onRevoke: undefined as (() => Promise<void>) | undefined,
  onMint: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("@ws-model-proxy/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://app.example.test",
    BETTER_AUTH_SECRET: "unit-test-purpose-hmac-secret-at-least-32-characters",
  },
}));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: async () => false,
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<PrismaClient>(), Prisma: { DbNull: "DbNull" } };
});

import prisma from "@ws-model-proxy/db";
import { revokeUserCredentials } from "../../../auth/src/credential-revocation";
import { exchangeEnrollmentCode } from "./enroll-exchange";
import { enrollmentProcedures } from "./enrollment";
import { contextFor, PERSON } from "./lane-b-test-helpers";

// The stand-in returns ordinary promises; Prisma's relation methods and lazy
// PrismaPromise objects are not part of this fixture's interface.
type AsyncModel<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => PromiseLike<infer R>
    ? (...args: A) => Promise<R>
    : T[K];
};
type Models = Pick<
  PrismaClient,
  "session" | "verification" | "node" | "nodeCredential" | "nodeEnrollmentCode"
>;
type FixtureDb = { [K in keyof Models]: AsyncModel<Models[K]> } & Pick<
  PrismaClient,
  "$transaction"
>;
const db = prisma as unknown as DeepMockProxy<FixtureDb>;
function pause() {
  let arrived!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    wait: async () => {
      arrived();
      await released;
    },
  };
}
const exchange = () =>
  exchangeEnrollmentCode({
    code: "ABCDEFGHIJKLMNOP234567ABCD",
    slug: "box",
    identityPublicKey: "unit-key",
    replaceConfirmed: false,
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.sessionLive = true;
  state.code.revokedAt = null;
  state.credentials = [];
  state.tail = Promise.resolve();
  state.reachedFence = 0;
  state.onMint = state.onRevoke = undefined;
  db.verification.findMany.mockResolvedValue([]);
  db.session.findFirst.mockImplementation(async () =>
    state.sessionLive ? ({ id: "s-1" } as never) : null,
  );
  db.session.deleteMany.mockImplementation(async () => {
    state.sessionLive = false;
    return { count: 1 };
  });
  db.nodeEnrollmentCode.findUnique.mockImplementation(
    async () =>
      ({
        ...state.code,
        User: { banned: false, banExpires: null, deletionRequestedAt: null },
      }) as never,
  );
  db.nodeEnrollmentCode.findUniqueOrThrow.mockImplementation(
    async () => ({ ...state.code }) as never,
  );
  db.nodeEnrollmentCode.updateMany.mockImplementation(async () => {
    state.code.revokedAt = new Date();
    return { count: 1 };
  });
  db.nodeCredential.updateMany.mockImplementation(async () => {
    await state.onRevoke?.();
    for (const credential of state.credentials) credential.revokedAt = new Date();
    return { count: state.credentials.length };
  });
  db.node.findUnique.mockResolvedValue(null);
  db.node.create.mockResolvedValue({ id: "node", slug: "box" } as never);
  db.nodeCredential.findMany.mockResolvedValue([]);
  db.nodeCredential.create.mockImplementation(async () => {
    await state.onMint?.();
    const row = { id: "minted", userId: "owner-1", revokedAt: null };
    state.credentials.push(row);
    return row as never;
  });
  db.$transaction.mockImplementation((async (work: (tx: typeof db) => Promise<unknown>) => {
    let unlock: (() => void) | undefined;
    const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("").includes("wsmp_acquire_fences")) {
        expect(values[0]).toEqual(["00:owner:owner-1"]);
        state.reachedFence++;
        const predecessor = state.tail;
        state.tail = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        await predecessor;
        return [{ acquired: true }];
      }
      if (strings.join("").includes("FOR UPDATE")) return [{ id: "code" }];
      throw new Error("unexpected query");
    };
    try {
      return await work(
        new Proxy(db, {
          get: (target, key) => (key === "$queryRaw" ? query : Reflect.get(target, key)),
        }),
      );
    } finally {
      unlock?.();
    }
  }) as never);
});

describe("reset vs node enrollment under the same owner fence", () => {
  it("exchange observed a valid code before reset, waits for the owner fence, and refuses its revoked code", async () => {
    const paused = pause();
    state.onRevoke = paused.wait;
    const reset = revokeUserCredentials("owner-1");
    await paused.reached;
    const redeeming = exchange();
    await vi.waitFor(() => expect(state.reachedFence).toBe(2));
    paused.release();
    await reset;
    expect((await redeeming).response).toEqual({ ok: false, error: "revoked" });
    expect(state.credentials).toEqual([]);
  });
  it("exchange first commits a credential, then reset waiting at the owner fence revokes it", async () => {
    const paused = pause();
    state.onMint = paused.wait;
    const redeeming = exchange();
    await paused.reached;
    const reset = revokeUserCredentials("owner-1");
    await vi.waitFor(() => expect(state.reachedFence).toBe(2));
    expect(state.code.revokedAt).toBeNull();
    paused.release();
    expect((await redeeming).response.ok).toBe(true);
    await reset;
    expect(state.credentials).toHaveLength(1);
    expect(state.credentials[0]?.revokedAt).toBeInstanceOf(Date);
  });
  it("browser issuance with a stale context waits for reset and refuses before creating a code", async () => {
    const paused = pause();
    state.onRevoke = paused.wait;
    const reset = revokeUserCredentials("owner-1");
    await paused.reached;
    const client = createRouterClient(enrollmentProcedures, { context: contextFor(PERSON) });
    const minting = client.create({ ttlHours: 1, maxUses: 5, temporary: false });
    const refused = expect(minting).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await vi.waitFor(() => expect(state.reachedFence).toBe(2));
    paused.release();
    await reset;
    await refused;
    expect(db.nodeEnrollmentCode.create).not.toHaveBeenCalled();
    expect(db.node.delete).not.toHaveBeenCalled();
  });
});
