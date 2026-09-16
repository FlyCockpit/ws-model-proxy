import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthDbShutdownFenceError,
  armAuthDbShutdownFence,
  disarmAuthDbShutdownFence,
  isAuthDbShutdownFenceArmed,
  withAuthDbShutdownFence,
} from "./auth-db-shutdown-fence";

/**
 * Part F pass 5 (F8 reopened): the DB-seam fence unit contract. The fence
 * wraps the Prisma client handed to better-auth's prisma adapter; these
 * tests pin (1) full transparency while INACTIVE (normal operation — zero
 * behavior change), (2) immediate rejection of every adapter DB operation
 * once armed (including $transaction), (3) passthrough of non-adapter
 * client surface, and (4) the sanitized one-line log regime.
 */

interface Delegate {
  create: (args: unknown) => Promise<{ id: string }>;
  findFirst: (args: unknown) => Promise<unknown>;
  findMany: (args: unknown) => Promise<unknown[]>;
  count: (args: unknown) => Promise<number>;
  update: (args: unknown) => Promise<unknown>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
  delete: (args: unknown) => Promise<unknown>;
  deleteMany: (args: unknown) => Promise<{ count: number }>;
}

function buildClient() {
  const delegate = (): Delegate => ({
    create: vi.fn(async () => ({ id: "row" })),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    update: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 0 })),
    delete: vi.fn(async () => null),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  });
  const client = {
    user: delegate(),
    session: delegate(),
    account: delegate(),
    verification: delegate(),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    $disconnect: vi.fn(async () => undefined),
    _runtimeDataModel: { models: {} },
  };
  return { client, wrapped: withAuthDbShutdownFence(client) };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  disarmAuthDbShutdownFence();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  disarmAuthDbShutdownFence();
});

describe("withAuthDbShutdownFence — inactive fence (normal operation)", () => {
  it("is disarmed by default", () => {
    expect(isAuthDbShutdownFenceArmed()).toBe(false);
  });

  it("passes every adapter delegate call through verbatim (args, this-binding, result)", async () => {
    const { client, wrapped } = buildClient();
    const result = await wrapped.verification.create({ data: { id: "v1" } });
    expect(result).toEqual({ id: "row" });
    expect(client.verification.create).toHaveBeenCalledWith({ data: { id: "v1" } });
    await expect(wrapped.user.findFirst({ where: { id: "u" } })).resolves.toBeNull();
    expect(client.user.findFirst).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("supports every delegate method the installed prisma adapter issues", async () => {
    const { client, wrapped } = buildClient();
    await wrapped.user.create({});
    await wrapped.user.findFirst({});
    await wrapped.user.findMany({});
    await wrapped.user.count({});
    await wrapped.user.update({});
    await wrapped.user.updateMany({});
    await wrapped.user.delete({});
    await wrapped.user.deleteMany({});
    for (const method of [
      "create",
      "findFirst",
      "findMany",
      "count",
      "update",
      "updateMany",
      "delete",
      "deleteMany",
    ] as const) {
      expect(client.user[method]).toHaveBeenCalledTimes(1);
    }
  });

  it("passes $transaction through while inactive", async () => {
    const { client, wrapped } = buildClient();
    await wrapped.$transaction(async () => "tx-result");
    expect(client.$transaction).toHaveBeenCalledTimes(1);
  });

  it("leaves $disconnect and _-prefixed internals untouched", async () => {
    const { client, wrapped } = buildClient();
    await wrapped.$disconnect();
    expect(client.$disconnect).toHaveBeenCalledTimes(1);
    expect(wrapped._runtimeDataModel).toBe(client._runtimeDataModel);
  });
});

describe("withAuthDbShutdownFence — armed fence (post gate close)", () => {
  it("rejects every adapter delegate method WITHOUT calling the underlying client", async () => {
    const { client, wrapped } = buildClient();
    armAuthDbShutdownFence();
    for (const method of [
      "create",
      "findFirst",
      "findMany",
      "count",
      "update",
      "updateMany",
      "delete",
      "deleteMany",
    ] as const) {
      expect(() => wrapped.verification[method]({})).toThrow(AuthDbShutdownFenceError);
      // The fence rejects BEFORE the operation executes.
      expect(client.verification[method]).not.toHaveBeenCalled();
    }
  });

  it("rejects $transaction without opening one", () => {
    const { client, wrapped } = buildClient();
    armAuthDbShutdownFence();
    expect(() => wrapped.$transaction(async () => "never")).toThrow(AuthDbShutdownFenceError);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("throws synchronously at call entry — a fenced create never starts", () => {
    const { wrapped } = buildClient();
    armAuthDbShutdownFence();
    // The throw happens in the wrapped method body itself, BEFORE any
    // promise exists — upstream `await` sites observe it as a rejection,
    // and no underlying client operation can have begun.
    expect(() => wrapped.session.create({})).toThrow(AuthDbShutdownFenceError);
  });

  it("does not fence $disconnect (shutdown owns the real teardown)", async () => {
    const { client, wrapped } = buildClient();
    armAuthDbShutdownFence();
    await wrapped.$disconnect();
    expect(client.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("emits exactly ONE sanitized static log line per rejection — no args, no messages", () => {
    const { wrapped } = buildClient();
    armAuthDbShutdownFence();
    expect(() => wrapped.account.deleteMany({ where: { userId: "SECRET-USER" } })).toThrow(
      AuthDbShutdownFenceError,
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]?.[0]);
    expect(line).toBe(
      "[auth] shutdown fence rejected database operation (AuthDbShutdownFenceError)",
    );
    expect(line).not.toContain("SECRET-USER");
  });

  it("disarming restores full passthrough (test hygiene)", async () => {
    const { client, wrapped } = buildClient();
    armAuthDbShutdownFence();
    expect(() => wrapped.user.count({})).toThrow(AuthDbShutdownFenceError);
    disarmAuthDbShutdownFence();
    await expect(wrapped.user.count({})).resolves.toBe(0);
    expect(client.user.count).toHaveBeenCalledTimes(1);
  });

  it("fences CALLABLE delegates too (mockDeep-style function proxies) — method access AND direct invocation", async () => {
    // vitest-mock-extended's mockDeep represents each model as a CALLABLE
    // function proxy, not a plain object — the wrapper must fence both the
    // delegate's methods and any direct call of the delegate itself.
    const underlyingFindFirst = vi.fn(async (_args: unknown) => null);
    const underlyingInvoke = vi.fn(async () => "invoked");
    const delegate = Object.assign(() => underlyingInvoke(), {
      findFirst: underlyingFindFirst,
    });
    const client = { verification: delegate };
    const wrapped = withAuthDbShutdownFence(client);
    // Inactive: full passthrough.
    await expect(wrapped.verification.findFirst({})).resolves.toBeNull();
    await expect((wrapped.verification as unknown as () => Promise<string>)()).resolves.toBe(
      "invoked",
    );
    expect(underlyingFindFirst).toHaveBeenCalledTimes(1);
    expect(underlyingInvoke).toHaveBeenCalledTimes(1);
    // Armed: both surfaces reject BEFORE reaching the delegate.
    armAuthDbShutdownFence();
    expect(() => wrapped.verification.findFirst({})).toThrow(AuthDbShutdownFenceError);
    expect(() => (wrapped.verification as unknown as () => Promise<string>)()).toThrow(
      AuthDbShutdownFenceError,
    );
    expect(underlyingFindFirst).toHaveBeenCalledTimes(1);
    expect(underlyingInvoke).toHaveBeenCalledTimes(1);
  });
});
