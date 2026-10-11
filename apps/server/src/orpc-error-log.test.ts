import { ORPCError } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logOrpcError, sensitiveProcedureErrors } from "./orpc-error-log";

/**
 * Pass-11 regression (R37 finding 2): the oRPC onError interceptor is a
 * HANDLED-error sink that never reaches app.onError — a sentinel-carrying
 * Prisma-shaped rejection flowing through it must NOT leak its message or
 * stack into the console, while an ORPCError's app-authored safe message
 * must still be visible.
 */

const SENTINEL = "SECRET-TOKEN-VALUE";

function prismaShapedRejection(): Error {
  const err = new Error(
    `Invalid \`prisma.user.findUnique()\` invocation: client_secret=${SENTINEL} SELECT "User"`,
  );
  err.stack = `Error: ${SENTINEL}\n    at findUnique (index.ts:265:5)`;
  return err;
}

const calls: { method: "error" | "warn"; line: string }[] = [];
vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
  calls.push({ method: "error", line: args.map(String).join(" ") });
});
vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
  calls.push({ method: "warn", line: args.map(String).join(" ") });
});

afterEach(() => {
  calls.length = 0;
});

describe("logOrpcError — sentinel Prisma-shaped rejection (unknown Error)", () => {
  it("logs the constructor name ONLY — no message, no stack, single argument", () => {
    logOrpcError(prismaShapedRejection());

    expect(calls).toEqual([{ method: "error", line: "[orpc] unhandled error (Error)" }]);
    expect(calls[0]?.line).not.toContain(SENTINEL);
    expect(calls[0]?.line).not.toContain("client_secret");
    expect(calls[0]?.line).not.toContain("SELECT");
    expect(calls[0]?.line).not.toContain("findUnique");
  });

  it("ORPCError with an app-authored safe message keeps its message + code (NO stack)", () => {
    const safe = new ORPCError("INTERNAL_SERVER_ERROR", {
      message:
        "Couldn't delete that account. Try again, or contact an admin if it keeps happening.",
    });
    safe.stack = `Error: ${SENTINEL}\n    at remove (users.ts:282:9)`;
    logOrpcError(safe);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("error");
    expect(calls[0]?.line).toContain("[orpc] ORPCError INTERNAL_SERVER_ERROR:");
    expect(calls[0]?.line).toContain("Couldn't delete that account");
    expect(calls[0]?.line).not.toContain(SENTINEL);
    expect(calls[0]?.line).not.toContain("users.ts");
    expect(calls[0]?.line).not.toContain("at remove");
  });

  it("expected 4xx ORPCErrors are skipped entirely", () => {
    logOrpcError(new ORPCError("NOT_FOUND", { message: `user ${SENTINEL} missing` }));
    expect(calls).toEqual([]);
  });

  it("transient >500 codes log at warn with the safe message", () => {
    logOrpcError(new ORPCError("SERVICE_UNAVAILABLE", { message: "Upstream blip" }));
    expect(calls).toEqual([
      { method: "warn", line: "[orpc] ORPCError SERVICE_UNAVAILABLE: Upstream blip" },
    ]);
  });

  it("non-Error rejections log a typeof label only — never the value", () => {
    logOrpcError({ client_secret: SENTINEL });
    expect(calls).toEqual([{ method: "error", line: "[orpc] non-Error rejection (object)" }]);
  });
});

describe("sensitiveProcedureErrors", () => {
  const intercept = sensitiveProcedureErrors(new Set(["nodes.secrets.set"]));

  it("strips the cause of a sensitive procedure's error and logs its code only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const thrown = await intercept({
      path: ["nodes", "secrets", "set"],
      next: async () => {
        throw new ORPCError("BAD_GATEWAY", {
          message: "The node did not answer.",
          cause: new Error(SENTINEL),
        });
      },
    }).catch((caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(ORPCError);
    if (!(thrown instanceof ORPCError)) return;
    expect(thrown.code).toBe("BAD_GATEWAY");
    expect(JSON.stringify(thrown.cause)).not.toContain(SENTINEL);
    logOrpcError(thrown);
    expect(error).toHaveBeenCalledWith("[orpc] sensitive procedure failed: BAD_GATEWAY");
    // An unknown error leaves as a plain internal error.
    const unknown = await intercept({
      path: ["nodes", "secrets", "set"],
      next: async () => {
        throw new Error(SENTINEL);
      },
    }).catch((caught: unknown) => caught);
    expect(unknown).toBeInstanceOf(ORPCError);
    expect(JSON.stringify(unknown)).not.toContain(SENTINEL);
    error.mockRestore();
  });

  it("leaves other procedures alone", async () => {
    const original = new Error("x");
    const thrown = await intercept({
      path: ["nodes", "list"],
      next: async () => {
        throw original;
      },
    }).catch((caught: unknown) => caught);
    expect(thrown).toBe(original);
  });
});
