import { beforeEach, describe, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => {
  const calls: string[] = [];
  const failures = { left: 0 };
  const tx = {
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, held: string[]) => {
      calls.push(`lock ${JSON.stringify(held)}`);
      return [{ acquired: true }];
    }),
    verification: {
      deleteMany: vi.fn(async (args: unknown) => {
        calls.push(`delete ${JSON.stringify(args)}`);
        return { count: 1 };
      }),
    },
  };
  const client = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => {
      if (failures.left > 0) {
        failures.left -= 1;
        throw new TypeError("database unavailable");
      }
      calls.push("begin");
      const result = await operation(tx);
      calls.push("commit");
      return result;
    }),
  };
  return { calls, failures, client };
});
vi.mock("@ws-model-proxy/db", () => ({ default: stub.client }));

const { afterUserUpdate, deleteResetLinksOnActivation, noteVerificationWrite } = await import(
  "./account-activation"
);

const CLEANUP = [
  "begin",
  'lock ["00:owner:u1"]',
  `delete ${JSON.stringify({ where: { value: "u1", identifier: { startsWith: "reset-password:" } } })}`,
  "commit",
];
const noSleep = async () => {};

beforeEach(() => {
  stub.calls.length = 0;
  stub.failures.left = 0;
  stub.client.$transaction.mockClear();
});

describe("account activation", () => {
  it("deletes the reset links under the owner fence after a write that verified the address", async () => {
    const context = { path: "/verify-email" };
    noteVerificationWrite({ emailVerified: true }, context);
    await afterUserUpdate({ id: "u1", emailVerified: true }, context);
    expect(stub.calls).toEqual(CLEANUP);
  });

  it("does nothing for an update that did not verify, or that unverified", async () => {
    const context = { path: "/update-user" };
    noteVerificationWrite({ name: "New" }, context);
    await afterUserUpdate({ id: "u1", emailVerified: true }, context);
    const unverify = { path: "/verify-email" };
    noteVerificationWrite({ emailVerified: false }, unverify);
    await afterUserUpdate({ id: "u1", emailVerified: false }, unverify);
    expect(stub.client.$transaction).not.toHaveBeenCalled();
  });

  it("cleans up for a verified row when there is no endpoint context (fail safe)", async () => {
    await afterUserUpdate({ id: "u1", emailVerified: true }, null);
    expect(stub.calls).toEqual(CLEANUP);
  });

  it("retries, then logs by user id and error class and resolves", async () => {
    stub.failures.left = 3;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(deleteResetLinksOnActivation("u1", { sleep: noSleep })).resolves.toBeUndefined();
    expect(stub.client.$transaction).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("failed after 3 attempts"),
      "user=u1",
      "TypeError",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("database unavailable");
    error.mockRestore();
  });

  it("succeeds on a retry", async () => {
    stub.failures.left = 2;
    await deleteResetLinksOnActivation("u1", { sleep: noSleep });
    expect(stub.client.$transaction).toHaveBeenCalledTimes(3);
    expect(stub.calls).toEqual(CLEANUP);
  });
});
