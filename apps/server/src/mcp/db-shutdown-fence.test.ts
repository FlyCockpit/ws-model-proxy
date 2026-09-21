import {
  armDbShutdownFence,
  DbFenceUnsupportedOperationError,
  DbRequestAbortFenceError,
  DbShutdownFenceError,
  disarmDbShutdownFence,
  isDbShutdownFenceArmed,
  runWithDbAbortFence,
  runWithDbShutdownPermit,
  withDbShutdownFence,
} from "@ws-model-proxy/db/shutdown-fence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DB-seam shutdown fence unit contract (Part G pass 2, G1). The fence
 * implementation lives at @ws-model-proxy/db/shutdown-fence, where the ONE
 * shared client packages/db exports is wrapped at construction — covering
 * better-auth's adapter AND the direct procedure/diagnostic calls the MCP
 * tool dispatch makes. These tests (migrated from the Part F pass-5 suite
 * that lived in packages/auth) pin (1) full transparency while INACTIVE,
 * (2) immediate rejection of every data operation once armed (including
 * $transaction), (3) passthrough of the non-data client surface, (4) the
 * sanitized one-line log regime, and (5) the G1 probe shape: a continuation
 * parked on an in-flight operation cannot START the next one after close.
 */

interface Delegate {
  create: (args: unknown) => Promise<{ id: string }>;
  findFirst: (args: unknown) => Promise<unknown>;
  findUnique: (args: unknown) => Promise<unknown>;
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
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    update: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 0 })),
    delete: vi.fn(async () => null),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  });
  const client = {
    modelApiToken: delegate(),
    user: delegate(),
    session: delegate(),
    account: delegate(),
    verification: delegate(),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    $disconnect: vi.fn(async () => undefined),
    _runtimeDataModel: { models: {} },
  };
  return { client, wrapped: withDbShutdownFence(client) };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  disarmDbShutdownFence();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  disarmDbShutdownFence();
});

describe("withDbShutdownFence — inactive fence (normal operation)", () => {
  it("is disarmed by default", () => {
    expect(isDbShutdownFenceArmed()).toBe(false);
  });

  it("passes every data-operation call through verbatim (args, this-binding, result)", async () => {
    const { client, wrapped } = buildClient();
    const result = await wrapped.verification.create({ data: { id: "v1" } });
    expect(result).toEqual({ id: "row" });
    expect(client.verification.create).toHaveBeenCalledWith({ data: { id: "v1" } });
    await expect(wrapped.user.findFirst({ where: { id: "u" } })).resolves.toBeNull();
    expect(client.user.findFirst).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("supports every delegate method the procedures and the adapter issue", async () => {
    const { client, wrapped } = buildClient();
    await wrapped.user.create({});
    await wrapped.user.findFirst({});
    await wrapped.user.findUnique({});
    await wrapped.user.findMany({});
    await wrapped.user.count({});
    await wrapped.user.update({});
    await wrapped.user.updateMany({});
    await wrapped.user.delete({});
    await wrapped.user.deleteMany({});
    for (const method of [
      "create",
      "findFirst",
      "findUnique",
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

  it("passes $-raw data operations through verbatim while inactive", async () => {
    const { client, wrapped } = buildClient();
    (client as { $queryRaw?: unknown }).$queryRaw = vi.fn(async () => [{ ok: true }]);
    const rows = await (
      wrapped as unknown as { $queryRaw: () => Promise<Array<{ ok: boolean }>> }
    ).$queryRaw();
    expect(rows).toEqual([{ ok: true }]);
  });
});

describe("withDbShutdownFence — armed fence (post gate close)", () => {
  it("rejects every data-operation method WITHOUT calling the underlying client", async () => {
    const { client, wrapped } = buildClient();
    armDbShutdownFence();
    for (const method of [
      "create",
      "findFirst",
      "findUnique",
      "findMany",
      "count",
      "update",
      "updateMany",
      "delete",
      "deleteMany",
    ] as const) {
      expect(() => wrapped.verification[method]({})).toThrow(DbShutdownFenceError);
      // The fence rejects BEFORE the operation executes.
      expect(client.verification[method]).not.toHaveBeenCalled();
    }
  });

  it("rejects $transaction without opening one", () => {
    const { client, wrapped } = buildClient();
    armDbShutdownFence();
    expect(() => wrapped.$transaction(async () => "never")).toThrow(DbShutdownFenceError);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("throws synchronously at call entry — a fenced create never starts", () => {
    const { wrapped } = buildClient();
    armDbShutdownFence();
    // The throw happens in the wrapped method body itself, BEFORE any
    // promise exists — upstream `await` sites observe it as a rejection,
    // and no underlying client operation can have begun.
    expect(() => wrapped.session.create({})).toThrow(DbShutdownFenceError);
  });

  it("does not fence $disconnect (shutdown owns the real teardown)", async () => {
    const { client, wrapped } = buildClient();
    armDbShutdownFence();
    await wrapped.$disconnect();
    expect(client.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("rejects $-raw data operations under the armed shutdown fence WITHOUT executing them", async () => {
    const { client, wrapped } = buildClient();
    const rawQuery = vi.fn(async () => []);
    const rawExecute = vi.fn(async () => 0);
    (client as { $queryRaw?: unknown }).$queryRaw = rawQuery;
    (client as { $executeRaw?: unknown }).$executeRaw = rawExecute;
    armDbShutdownFence();
    expect(() => (wrapped as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw()).toThrow(
      DbShutdownFenceError,
    );
    expect(() =>
      (wrapped as unknown as { $executeRaw: () => Promise<unknown> }).$executeRaw(),
    ).toThrow(DbShutdownFenceError);
    expect(rawQuery).not.toHaveBeenCalled();
    expect(rawExecute).not.toHaveBeenCalled();
  });

  it("emits exactly ONE sanitized static log line per rejection — no args, no messages", () => {
    const { wrapped } = buildClient();
    armDbShutdownFence();
    expect(() => wrapped.account.deleteMany({ where: { userId: "SECRET-USER" } })).toThrow(
      DbShutdownFenceError,
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]?.[0]);
    expect(line).toBe("[db] fence rejected database operation (DbShutdownFenceError)");
    expect(line).not.toContain("SECRET-USER");
  });

  it("disarming restores full passthrough (test hygiene)", async () => {
    const { client, wrapped } = buildClient();
    armDbShutdownFence();
    expect(() => wrapped.user.count({})).toThrow(DbShutdownFenceError);
    disarmDbShutdownFence();
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
    const wrapped = withDbShutdownFence(client);
    // Inactive: full passthrough.
    await expect(wrapped.verification.findFirst({})).resolves.toBeNull();
    await expect((wrapped.verification as unknown as () => Promise<string>)()).resolves.toBe(
      "invoked",
    );
    expect(underlyingFindFirst).toHaveBeenCalledTimes(1);
    expect(underlyingInvoke).toHaveBeenCalledTimes(1);
    // Armed: both surfaces reject BEFORE reaching the delegate.
    armDbShutdownFence();
    expect(() => wrapped.verification.findFirst({})).toThrow(DbShutdownFenceError);
    expect(() => (wrapped.verification as unknown as () => Promise<string>)()).toThrow(
      DbShutdownFenceError,
    );
    expect(underlyingFindFirst).toHaveBeenCalledTimes(1);
    expect(underlyingInvoke).toHaveBeenCalledTimes(1);
  });
});

describe("G1 — tool continuation cannot START the next DB operation after close", () => {
  it("a paused lookup that resolves after gate close cannot start its follow-up update (the R63/R64 probe shape)", async () => {
    const { client, wrapped } = buildClient();
    // The probe: revoke()'s ownership findUnique parks; the gate closes
    // (fence armed, HTTP 499, outstanding === 0); the lookup then resolves
    // and the procedure tries modelApiToken.update — the fence must reject
    // it at the CLIENT, before the underlying operation starts.
    let resolveLookup!: (value: unknown) => void;
    const parked = new Promise<unknown>((resolve) => {
      resolveLookup = resolve;
    });
    (client.modelApiToken.findUnique as ReturnType<typeof vi.fn>).mockImplementation(() => parked);
    const continuation = (async () => {
      await wrapped.modelApiToken.findUnique({ where: { id: "token-1" } });
      return wrapped.modelApiToken.update({ where: { id: "token-1" }, data: {} });
    })();
    await vi.waitFor(() => expect(client.modelApiToken.findUnique).toHaveBeenCalled());
    armDbShutdownFence();
    resolveLookup({ id: "token-1", userId: "user-1", revokedAt: null });
    // The continuation SETTLES (fenced rejection), and the update NEVER
    // started on the underlying client.
    await expect(continuation).rejects.toBeInstanceOf(DbShutdownFenceError);
    expect(client.modelApiToken.update).not.toHaveBeenCalled();
    expect(
      errorSpy.mock.calls
        .flat()
        .map(String)
        .some((line: string) => line.includes("fence rejected")),
    ).toBe(true);
  });
});

describe("G1 — transaction callbacks receive a FENCED transaction client", () => {
  it("an interactive transaction opened pre-shutdown cannot START operations after arm", async () => {
    const { client, wrapped } = buildClient();
    const tx = {
      providerAccount: {
        findFirst: vi.fn(async (_args: unknown) => ({ id: "account-1" })),
        updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
      },
      providerAuditEvent: { create: vi.fn(async (_args: unknown) => ({})) },
    };
    (client.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (callback: (txClient: unknown) => Promise<unknown>) => callback(tx),
    );
    const run = wrapped.$transaction(async (txClient) => {
      const fencedTx = txClient as typeof tx;
      await fencedTx.providerAccount.findFirst({ where: { id: "account-1" } });
      // Arm mid-transaction (the paused-lookup probe shape): the resumed
      // callback's NEXT operation must reject at the FENCED tx client.
      armDbShutdownFence();
      await fencedTx.providerAccount.updateMany({ where: { id: "account-1" }, data: {} });
      await fencedTx.providerAuditEvent.create({ data: {} });
    });
    await expect(run).rejects.toBeInstanceOf(DbShutdownFenceError);
    expect(tx.providerAccount.updateMany).not.toHaveBeenCalled();
    expect(tx.providerAuditEvent.create).not.toHaveBeenCalled();
  });

  it("the array transaction form passes through unchanged (element ops were fenced at build)", async () => {
    const { client, wrapped } = buildClient();
    (client.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const arrayForm = [Promise.resolve(1)] as unknown;
    await expect(
      wrapped.$transaction(arrayForm as Parameters<typeof client.$transaction>[0]),
    ).resolves.toEqual([]);
  });
});

describe("G1 — per-request abort fence (AsyncLocalStorage)", () => {
  it("an aborted context signal rejects NEW operations with the distinct abort error", async () => {
    const { client, wrapped } = buildClient();
    const controller = new AbortController();
    const run = runWithDbAbortFence(controller.signal, async () => {
      // Before abort: transparent passthrough.
      await wrapped.user.count({});
      controller.abort();
      expect(() => wrapped.user.count({})).toThrow(DbRequestAbortFenceError);
      expect(client.user.count).toHaveBeenCalledTimes(1);
    });
    await run;
    expect(errorSpy.mock.calls.flat().map(String)).toContain(
      "[db] fence rejected database operation (DbRequestAbortFenceError)",
    );
  });

  it("operations OUTSIDE the abort-fence context are unaffected (normal HTTP traffic)", async () => {
    const { client, wrapped } = buildClient();
    const controller = new AbortController();
    controller.abort();
    await runWithDbAbortFence(controller.signal, async () => {
      expect(() => wrapped.user.count({})).toThrow(DbRequestAbortFenceError);
    });
    // Outside the ALS context the same aborted signal changes nothing.
    await expect(wrapped.user.count({})).resolves.toBe(0);
    expect(client.user.count).toHaveBeenCalledTimes(1);
  });

  it("the abort fence also fences $transaction callbacks inside the context", async () => {
    const { wrapped } = buildClient();
    const tx = { user: { count: vi.fn(async () => 1) } };
    const controller = new AbortController();
    const run = runWithDbAbortFence(controller.signal, async () => {
      controller.abort();
      // The $transaction entry itself is fenced (synchronous throw).
      expect(() => wrapped.$transaction(async () => "never")).toThrow(DbRequestAbortFenceError);
    });
    await run;
    expect(tx.user.count).not.toHaveBeenCalled();
  });
});

describe("G1 pass 4 — raw `$` operations are fenced (the R67/R68 probe shapes)", () => {
  /** The provider-management two-lock pattern: consecutive raw statements. */
  function rawSequenceClient() {
    const calls: number[] = [];
    const client = {
      $queryRaw: vi.fn(async () => {
        calls.push(calls.length);
        return [];
      }),
    };
    return { client, calls };
  }

  it("a raw-op sequence cannot START the second statement after a client abort (ALS fence)", async () => {
    const { client, calls } = rawSequenceClient();
    const wrapped = withDbShutdownFence(client);
    const controller = new AbortController();
    await runWithDbAbortFence(controller.signal, async () => {
      await (wrapped as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw();
      controller.abort();
      expect(() =>
        (wrapped as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw(),
      ).toThrow(DbRequestAbortFenceError);
    });
    expect(calls).toEqual([0]);
  });

  it("the same sequence is rejected under the armed shutdown fence", async () => {
    const { client, calls } = rawSequenceClient();
    const wrapped = withDbShutdownFence(client);
    await (wrapped as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw();
    armDbShutdownFence();
    expect(() => (wrapped as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw()).toThrow(
      DbShutdownFenceError,
    );
    expect(calls).toEqual([0]);
  });

  it("raw statements inside a FENCED interactive transaction callback are rejected after abort", async () => {
    const txRaw = vi.fn(async () => []);
    const client = {
      $transaction: vi.fn(async (callback: (txClient: unknown) => Promise<unknown>) =>
        callback({ $queryRaw: txRaw }),
      ),
    };
    const wrapped = withDbShutdownFence(client);
    const controller = new AbortController();
    await runWithDbAbortFence(controller.signal, async () => {
      await expect(
        (
          wrapped as unknown as {
            $transaction: (
              callback: (txClient: { $queryRaw: () => Promise<unknown> }) => Promise<unknown>,
            ) => Promise<unknown>;
          }
        ).$transaction(async (txClient: { $queryRaw: () => Promise<unknown> }) => {
          // Abort INSIDE the (already-open) transaction callback: the
          // fenced tx client must reject its raw statement.
          controller.abort();
          txClient.$queryRaw();
        }),
      ).rejects.toBeInstanceOf(DbRequestAbortFenceError);
    });
    expect(txRaw).not.toHaveBeenCalled();
  });

  it("$disconnect still passes through when BOTH fences are active", async () => {
    const { client, wrapped } = buildClient();
    const controller = new AbortController();
    controller.abort();
    armDbShutdownFence();
    await runWithDbAbortFence(controller.signal, async () => {
      await wrapped.$disconnect();
    });
    expect(client.$disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("G1 pass 5 — client-valued `$` surface (`$parent`) is fenced", () => {
  /** The installed client's shape: `$parent` = the ORIGINAL unfenced client,
   * whose own `$parent` chains further back. Raw methods on every hop. */
  function parentedClient() {
    const grandparentRaw = vi.fn(async (_sql: string) => []);
    const parentRaw = vi.fn(async (_sql: string) => []);
    const grandparent = { $queryRawUnsafe: grandparentRaw };
    const parent = { $queryRawUnsafe: parentRaw, $parent: grandparent };
    const client = { $queryRawUnsafe: parentRaw, $parent: parent };
    return { client, parentRaw, grandparentRaw };
  }

  it("$parent is wrapped (identity-stable) and transparent while no fence applies", async () => {
    const { client, parentRaw } = parentedClient();
    const wrapped = withDbShutdownFence(client);
    // Identity is stable across accesses AND distinct from the unfenced
    // original — the SAME wrapped object per access path, never the escape.
    expect(wrapped.$parent).not.toBe(client.$parent);
    expect(wrapped.$parent).toBe(wrapped.$parent);
    const rows = await wrapped.$parent.$queryRawUnsafe("SELECT 1");
    expect(rows).toEqual([]);
    expect(parentRaw).toHaveBeenCalledWith("SELECT 1");
  });

  it("the armed shutdown fence rejects $parent raw operations WITHOUT executing them", async () => {
    const { parentRaw, grandparentRaw } = parentedClient();
    const wrapped = withDbShutdownFence({
      $queryRawUnsafe: parentRaw,
      $parent: { $queryRawUnsafe: parentRaw, $parent: { $queryRawUnsafe: grandparentRaw } },
    });
    armDbShutdownFence();
    expect(() => wrapped.$parent.$queryRawUnsafe("SELECT 1")).toThrow(DbShutdownFenceError);
    // The full chain is fenced: $parent-of-$parent cannot escape either.
    expect(() => wrapped.$parent.$parent.$queryRawUnsafe("SELECT 1")).toThrow(DbShutdownFenceError);
    expect(parentRaw).not.toHaveBeenCalled();
    expect(grandparentRaw).not.toHaveBeenCalled();
  });

  it("the per-request abort fence rejects $parent raw operations too", async () => {
    const { client, parentRaw } = parentedClient();
    const wrapped = withDbShutdownFence(client);
    const controller = new AbortController();
    await runWithDbAbortFence(controller.signal, async () => {
      await wrapped.$parent.$queryRawUnsafe("SELECT 1");
      controller.abort();
      expect(() => wrapped.$parent.$queryRawUnsafe("SELECT 1")).toThrow(DbRequestAbortFenceError);
    });
    expect(parentRaw).toHaveBeenCalledTimes(1);
  });

  it("every function-valued `$` method of the installed surface is fenced; only $disconnect passes", async () => {
    // Installed-client $-surface enumeration: $connect, $disconnect,
    // $executeRaw, $executeRawUnsafe, $extends, $on, $queryRaw,
    // $queryRawUnsafe, $runCommandRaw, $transaction — plus $parent (object).
    // ($extends is excluded here: pass 7 PROHIBITS it outright — see the
    // pass-7 describe below.)
    const methods = {
      $connect: vi.fn(async () => undefined),
      $executeRaw: vi.fn(async () => 0),
      $executeRawUnsafe: vi.fn(async () => 0),
      $on: vi.fn(() => undefined),
      $queryRaw: vi.fn(async () => []),
      $queryRawUnsafe: vi.fn(async () => []),
      $runCommandRaw: vi.fn(async () => ({})),
    };
    const client = { ...methods, $disconnect: vi.fn(async () => undefined) };
    const wrapped = withDbShutdownFence(client);
    armDbShutdownFence();
    for (const key of Object.keys(methods) as (keyof typeof methods)[]) {
      expect(() => (wrapped as typeof client)[key]()).toThrow(DbShutdownFenceError);
      expect(methods[key]).not.toHaveBeenCalled();
    }
    await wrapped.$disconnect();
    expect(client.$disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("G1 pass 7 — `$extends` is PROHIBITED on the fenced client (user-decision terminal policy)", () => {
  /**
   * The R73/R74 probe shapes: `$extends` can produce derived surfaces the
   * proxy boundary cannot close (thenable derived clients, callback
   * extensions capturing the raw client, model-extension continuations
   * bound to the raw delegate). The user-decision terminal policy closes
   * the boundary structurally: ANY `$extends` call on ANY fenced surface
   * throws DbFenceUnsupportedOperationError — fence armed or not — and
   * the underlying `$extends` is NEVER invoked (no derived reference can
   * exist to capture).
   */
  function extendsCapableClient() {
    const extendsMock = vi.fn(() => ({}));
    const client = {
      $extends: extendsMock,
      $transaction: vi.fn(async (callback: (txClient: unknown) => Promise<unknown>) =>
        callback({ $extends: extendsMock }),
      ),
      $parent: { $extends: extendsMock },
    };
    return { extendsMock, wrapped: withDbShutdownFence(client) };
  }

  it("throws the unsupported-operation error while the fence is INACTIVE (prohibition, not gating)", () => {
    const { extendsMock, wrapped } = extendsCapableClient();
    expect(() => (wrapped as unknown as { $extends: () => unknown }).$extends()).toThrow(
      DbFenceUnsupportedOperationError,
    );
    // The underlying $extends is NEVER called — no derived client can be
    // created, so no unfenced reference can ever be captured.
    expect(extendsMock).not.toHaveBeenCalled();
  });

  it("throws the same error when the fence is ARMED — the prohibition is not a fence gate", () => {
    const { extendsMock, wrapped } = extendsCapableClient();
    armDbShutdownFence();
    expect(() => (wrapped as unknown as { $extends: () => unknown }).$extends()).toThrow(
      DbFenceUnsupportedOperationError,
    );
    expect(extendsMock).not.toHaveBeenCalled();
  });

  it("$extends inside a transaction-callback client throws too (the callback client is fenced)", async () => {
    const { extendsMock, wrapped } = extendsCapableClient();
    await (
      wrapped as unknown as {
        $transaction: (
          callback: (txClient: { $extends: () => unknown }) => Promise<unknown>,
        ) => Promise<unknown>;
      }
    ).$transaction(async (txClient) => {
      expect(() => txClient.$extends()).toThrow(DbFenceUnsupportedOperationError);
    });
    expect(extendsMock).not.toHaveBeenCalled();
  });

  it("$extends via a $parent-wrapped object throws too (chains cannot reach a raw surface)", () => {
    const { extendsMock, wrapped } = extendsCapableClient();
    const parent = (wrapped as unknown as { $parent: { $extends: () => unknown } }).$parent;
    expect(() => parent.$extends()).toThrow(DbFenceUnsupportedOperationError);
    expect(extendsMock).not.toHaveBeenCalled();
  });

  it("the error message names the remedy (build extensions into @ws-model-proxy/db)", () => {
    const { wrapped } = extendsCapableClient();
    let thrown: unknown;
    try {
      (wrapped as unknown as { $extends: () => unknown }).$extends();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DbFenceUnsupportedOperationError);
    const message = (thrown as Error).message;
    expect(message).toContain("$extends");
    expect(message).toContain("@ws-model-proxy/db");
  });
});

describe("G1 pass 8 — model-delegate `$parent` is fenced (the R75/R76 probe shapes)", () => {
  /**
   * Installed-Prisma-shaped double: EVERY model delegate carries `$parent`
   * pointing at its underlying client, whose raw methods execute through a
   * counter executor. The delegate-property branch must wrap the parent in
   * the SAME weakly-cached fence proxy used for client-level `$parent` —
   * returning it unwrapped hands callers a complete bypass of both fences
   * and the `$extends` prohibition.
   */
  function delegateParentClient() {
    const executor = vi.fn(async (_sql: string) => []);
    const extendsMock = vi.fn(() => ({}));
    const client = {
      $queryRawUnsafe: executor,
      $extends: extendsMock,
      user: {
        count: vi.fn(async (_args: unknown) => 0),
        $parent: undefined,
      } as { count: (args: unknown) => Promise<number>; $parent: unknown },
    };
    client.user.$parent = client;
    return { client, executor, extendsMock, wrapped: withDbShutdownFence(client) };
  }

  /** `Prisma.getExtensionContext` returns its receiver unchanged — the
   * passthrough double reproduces that contract for the bypass probe. */
  function getExtensionContextDouble<T>(receiver: T): T {
    return receiver;
  }

  it("wraps delegate $parent (identity-stable, never the raw client) and passes through verbatim while inactive", async () => {
    const { client, executor, wrapped } = delegateParentClient();
    const parent = (
      wrapped.user as unknown as { $parent: { $queryRawUnsafe: (sql: string) => Promise<unknown> } }
    ).$parent;
    expect(parent).not.toBe(client);
    expect(parent).toBe(
      (
        wrapped.user as unknown as {
          $parent: { $queryRawUnsafe: (sql: string) => Promise<unknown> };
        }
      ).$parent,
    );
    await expect(parent.$queryRawUnsafe("SELECT 1")).resolves.toEqual([]);
    expect(executor).toHaveBeenCalledWith("SELECT 1");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("the armed shutdown fence rejects delegate-$parent raw operations WITHOUT executing them", async () => {
    const { executor, wrapped } = delegateParentClient();
    armDbShutdownFence();
    expect(() =>
      (
        wrapped.user as unknown as {
          $parent: { $queryRawUnsafe: (sql: string) => Promise<unknown> };
        }
      ).$parent.$queryRawUnsafe("SELECT 1"),
    ).toThrow(DbShutdownFenceError);
    expect(executor).not.toHaveBeenCalled();
  });

  it("the per-request abort fence rejects delegate-$parent raw operations too", async () => {
    const { executor, wrapped } = delegateParentClient();
    const controller = new AbortController();
    await runWithDbAbortFence(controller.signal, async () => {
      controller.abort();
      expect(() =>
        (
          wrapped.user as unknown as {
            $parent: { $queryRawUnsafe: (sql: string) => Promise<unknown> };
          }
        ).$parent.$queryRawUnsafe("SELECT 1"),
      ).toThrow(DbRequestAbortFenceError);
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it("delegate-$parent $extends is PROHIBITED through the delegate parent (prohibition holds)", () => {
    const { extendsMock, wrapped } = delegateParentClient();
    expect(() =>
      (
        wrapped.user as unknown as { $parent: { $extends: (ext: unknown) => unknown } }
      ).$parent.$extends({
        name: "escape",
      }),
    ).toThrow(DbFenceUnsupportedOperationError);
    expect(extendsMock).not.toHaveBeenCalled();
  });

  it("getExtensionContext(delegate).$parent is wrapped too (the receiver passthrough bypass is closed)", () => {
    const { client, wrapped } = delegateParentClient();
    const contextParent = (
      getExtensionContextDouble(wrapped.user) as unknown as {
        $parent: { $queryRawUnsafe: () => Promise<unknown> };
      }
    ).$parent;
    expect(contextParent).not.toBe(client);
    armDbShutdownFence();
    expect(() => contextParent.$queryRawUnsafe()).toThrow(DbShutdownFenceError);
  });

  it("interactive tx: tx.user.$parent is wrapped and RETURNING it from the callback transports a FENCED object", async () => {
    const txExecutor = vi.fn(async (_sql: string) => []);
    const txRaw = { $queryRawUnsafe: txExecutor };
    const client = {
      $transaction: vi.fn(async (callback: (txClient: unknown) => Promise<unknown>) =>
        callback({
          user: { count: vi.fn(async (_args: unknown) => 0), $parent: txRaw },
        }),
      ),
    };
    const wrapped = withDbShutdownFence(client);
    const escaped = (await (
      wrapped as unknown as {
        $transaction: (
          callback: (txClient: {
            user: { count: (args: unknown) => Promise<number>; $parent: unknown };
          }) => Promise<unknown>,
        ) => Promise<unknown>;
      }
    ).$transaction(async (txClient) => txClient.user.$parent)) as {
      $queryRawUnsafe: (sql: string) => Promise<unknown>;
    };
    // Inactive: the returned parent is transparent.
    await expect(escaped.$queryRawUnsafe("SELECT 1")).resolves.toEqual([]);
    expect(txExecutor).toHaveBeenCalledTimes(1);
    // Armed: the transported object is fenced — no executor reach.
    armDbShutdownFence();
    expect(() => escaped.$queryRawUnsafe("SELECT 1")).toThrow(DbShutdownFenceError);
    expect(txExecutor).toHaveBeenCalledTimes(1);
  });
});

describe("G1 pass 9 — `$on` chaining result stays fenced (the R80 probe shape)", () => {
  /**
   * Installed Prisma's `$on` registers the listener and returns THE CLIENT
   * ITSELF for chaining. Returning that result verbatim would hand callers
   * the raw unfenced client (bypassing both fences AND the `$extends`
   * prohibition) through the normal typed API. The `$`-method call path
   * wraps it by IDENTITY ONLY: a result that is (===) the underlying
   * client this proxy wraps comes back fence-wrapped; anything else
   * returns verbatim.
   */
  interface OnChainClient {
    $on: (event: string, listener: () => void) => OnChainClient;
    $queryRawUnsafe: (sql: string) => Promise<unknown[]>;
    $extends: () => object;
  }

  function onChainingClient() {
    const listeners: Array<[string, () => void]> = [];
    const executor = vi.fn(async (_sql: string) => []);
    const extendsMock = vi.fn((): object => ({}));
    const client = {
      $on: vi.fn((event: string, listener: () => void): OnChainClient => {
        listeners.push([event, listener]);
        return client;
      }),
      $queryRawUnsafe: executor,
      $extends: extendsMock,
    };
    return {
      client: client as OnChainClient,
      onMock: client.$on,
      executor,
      extendsMock,
      listeners,
    };
  }

  it("armed: the $on chain result is fence-wrapped — raw ops throw without executing, abort fence throws, $extends prohibited", () => {
    const { client, executor, extendsMock } = onChainingClient();
    const wrapped = withDbShutdownFence(client);
    const chained = wrapped.$on("beforeExit", () => {});
    // The result is NOT the raw client (the escape R80 demonstrated) and
    // has stable identity across $on calls via the fence-proxy cache.
    expect(chained).not.toBe(client);
    expect(chained).toBe(wrapped.$on("beforeExit", () => {}));
    armDbShutdownFence();
    expect(() => chained.$queryRawUnsafe("SELECT 1")).toThrow(DbShutdownFenceError);
    expect(executor).not.toHaveBeenCalled();
    expect(() => chained.$extends()).toThrow(DbFenceUnsupportedOperationError);
    expect(extendsMock).not.toHaveBeenCalled();
    disarmDbShutdownFence();
    const controller = new AbortController();
    runWithDbAbortFence(controller.signal, () => {
      controller.abort();
      expect(() => chained.$queryRawUnsafe("SELECT 1")).toThrow(DbRequestAbortFenceError);
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it("fence inactive: $on forwards verbatim (listener registered, same args) and the chain still works", async () => {
    const { client, onMock, executor, listeners } = onChainingClient();
    const wrapped = withDbShutdownFence(client);
    const listener = () => {};
    const chained = wrapped.$on("beforeExit", listener);
    expect(onMock).toHaveBeenCalledTimes(1);
    expect(onMock).toHaveBeenCalledWith("beforeExit", listener);
    expect(listeners).toEqual([["beforeExit", listener]]);
    // Chaining: the wrapped result still forwards operations transparently.
    await expect(chained.$queryRawUnsafe("SELECT 1")).resolves.toEqual([]);
    expect(executor).toHaveBeenCalledWith("SELECT 1");
  });

  it("a `$` method returning some OTHER object returns verbatim (identity-only rule)", async () => {
    const result = { rows: [] };
    const wrapped = withDbShutdownFence({
      $queryRawUnsafe: vi.fn(async (_sql: string) => result),
    });
    const returned = wrapped.$queryRawUnsafe("SELECT 1");
    expect(returned).not.toBe(wrapped);
    await expect(returned).resolves.toBe(result);
  });
});

describe("G2n — durable-cleanup permit", () => {
  it("runWithDbShutdownPermit exempts the wrapped operations from BOTH fences", async () => {
    const { client, wrapped } = buildClient();
    const controller = new AbortController();
    controller.abort();
    armDbShutdownFence();
    // Both fences active: permitted cleanup executes, everything else rejects.
    await runWithDbShutdownPermit(async () => {
      await expect(wrapped.user.count({})).resolves.toBe(0);
    });
    expect(client.user.count).toHaveBeenCalledTimes(1);
    expect(() => wrapped.user.count({})).toThrow(DbShutdownFenceError);
    expect(isDbShutdownFenceArmed()).toBe(true);
    // The permit is scoped: the same aborted signal inside a permit-exempt
    // scope does not leak outside it.
    await runWithDbAbortFence(controller.signal, async () => {
      await runWithDbShutdownPermit(async () => {
        await expect(wrapped.user.count({})).resolves.toBe(0);
      });
    });
  });
});
