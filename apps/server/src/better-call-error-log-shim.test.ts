import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * L19 (bucket B of the TERMINAL log-sanitizer policy, pass 6):
 * - B1: ANY console.error/warn/log call whose FIRST argument is an Error,
 *   at ANY arity, is re-emitted as `<method> (sanitized): <ctor name>`
 *   only — never the message, stack, or other args.
 * - B2: the better-call router fallback markers (`# SERVER_ERROR: ` with
 *   the probe-verified trailing space, plus the no-space variant) are
 *   intercepted and re-emitted as `# SERVER_ERROR (sanitized): <name>`.
 * - B3: everything else — including ALL string-first calls — passes
 *   through verbatim (zero repo call-site impact).
 * - Double install is safe.
 *
 * Each test resets the module so the idempotence flag starts fresh
 * (mockRestore would otherwise discard the shim while leaving `installed`
 * true for later tests in this file).
 */

type Spies = Record<"error" | "warn" | "log", ReturnType<typeof vi.spyOn>>;

let installBetterCallErrorLogShim: () => void;
let spies: Spies;

beforeEach(async () => {
  vi.resetModules();
  // Spy FIRST so the shim's captured "originals" are the spies: every
  // re-emitted sanitized line and every verbatim passthrough is observable.
  spies = {
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
  };
  ({ installBetterCallErrorLogShim } = await import("./better-call-error-log-shim"));
  installBetterCallErrorLogShim();
});

afterEach(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
});

describe("installBetterCallErrorLogShim — B1 Error-first interception", () => {
  it("bucket 5 — console.error(new Error(...)) at ARITY 1: ctor-only line, no message/stack", () => {
    const error = new Error("SECRET-Internal-detail");
    error.stack = "Error: SECRET-Internal-detail\n    at somewhere (factory.mjs:191:5)";
    console.error(error);
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(spies.error.mock.calls[0]).toEqual(["error (sanitized): Error"]);
    for (const arg of spies.error.mock.calls[0] ?? []) {
      expect(String(arg)).not.toContain("SECRET");
      expect(String(arg)).not.toContain("at ");
    }
  });

  it("bucket 5 — console.error(new Error(...), extra, args...) at ARITY >= 2: same ctor-only line, extras dropped", () => {
    const error = new TypeError("SECRET-SQL SELECT token='*********************'");
    console.error(error, "second arg with SECRET", { secret: "leak" }, 42);
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(spies.error.mock.calls[0]).toEqual(["error (sanitized): TypeError"]);
    expect(String(spies.error.mock.calls[0])).not.toContain("SECRET");
  });

  it("B1 also covers console.warn and console.log with Error-first args", () => {
    console.warn(new RangeError("SECRET-warn"));
    console.log(new SyntaxError("SECRET-log"), "dropped");
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.warn.mock.calls[0]).toEqual(["warn (sanitized): RangeError"]);
    expect(spies.log).toHaveBeenCalledTimes(1);
    expect(spies.log.mock.calls[0]).toEqual(["log (sanitized): SyntaxError"]);
  });

  it("Error subclass names are preserved (PrismaClientKnownRequestError etc.)", () => {
    class PrismaClientKnownRequestError extends Error {}
    console.error(new PrismaClientKnownRequestError("SECRET"));
    expect(spies.error.mock.calls[0]).toEqual(["error (sanitized): PrismaClientKnownRequestError"]);
  });
});

describe("installBetterCallErrorLogShim — B2 marker rule", () => {
  it("sanitizes the ACTUAL upstream marker call (trailing space): constructor name only, never the message", () => {
    console.error("# SERVER_ERROR: ", new Error("SECRET-Internal-detail"));
    expect(spies.error).toHaveBeenCalledTimes(1);
    const firstCall: unknown[] = spies.error.mock.calls[0] ?? [];
    const line = firstCall.find((arg: unknown): arg is string => typeof arg === "string");
    expect(line).toBe("# SERVER_ERROR (sanitized): Error");
    for (const arg of firstCall) {
      expect(String(arg)).not.toContain("SECRET-Internal-detail");
    }
  });

  it("also sanitizes the no-space marker variant (defensive both-forms match)", () => {
    console.error("# SERVER_ERROR:", new Error("SECRET-Internal-detail"));
    expect(spies.error).toHaveBeenCalledTimes(1);
    const line = (spies.error.mock.calls[0] ?? []).find(
      (arg: unknown): arg is string => typeof arg === "string",
    );
    expect(line).toBe("# SERVER_ERROR (sanitized): Error");
  });

  it("non-error second arguments degrade to typeof, never String(value)", () => {
    console.error("# SERVER_ERROR: ", "raw string with SECRET");
    const line = (spies.error.mock.calls[0] ?? []).find(
      (arg: unknown): arg is string => typeof arg === "string",
    );
    expect(line).toBe("# SERVER_ERROR (sanitized): string");
  });

  it("near-miss first arguments are NOT intercepted (verbatim passthrough)", () => {
    const e1 = new Error("SECRET-1");
    const e2 = new Error("SECRET-2");
    const e3 = new Error("SECRET-3");
    const arr = ["# SERVER_ERROR: ", new Error("SECRET-4")];
    console.error("# SERVER_ERROR", e1); // no colon at all
    console.error("SERVER_ERROR: ", e2); // no leading '#'
    console.error("# SERVER_ERRORS: ", e3); // pluralized
    console.error(arr); // marker not the first arg
    expect(spies.error).toHaveBeenCalledTimes(4);
    // Passthrough is verbatim: same args, same identity, no re-shaping.
    expect(spies.error.mock.calls[0]).toEqual(["# SERVER_ERROR", e1]);
    expect(spies.error.mock.calls[1]).toEqual(["SERVER_ERROR: ", e2]);
    expect(spies.error.mock.calls[2]).toEqual(["# SERVER_ERRORS: ", e3]);
    expect(spies.error.mock.calls[3]).toEqual([arr]);
    // And none of them produced a sanitized line.
    for (const call of spies.error.mock.calls) {
      for (const arg of call) {
        if (typeof arg === "string") {
          expect(arg).not.toContain("# SERVER_ERROR (sanitized)");
        }
      }
    }
  });
});

describe("installBetterCallErrorLogShim — B3 verbatim passthrough", () => {
  it("bucket 7 — string-first console.error passes through VERBATIM (blast-radius pin: zero repo call-site impact)", () => {
    const obj = { secret: "leak-me-not" };
    console.error("x", obj);
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(spies.error.mock.calls[0]?.[0]).toBe("x");
    expect(spies.error.mock.calls[0]?.[1]).toBe(obj);
  });

  it("string-first warn/log and non-Error-first calls pass through verbatim on every shimmed method", () => {
    const payload = ["msg", { a: 1 }];
    console.warn(...payload);
    console.log("plain", 42, null);
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.warn.mock.calls[0]).toEqual(payload);
    expect(spies.log).toHaveBeenCalledTimes(1);
    expect(spies.log.mock.calls[0]).toEqual(["plain", 42, null]);
  });
});

describe("installBetterCallErrorLogShim — idempotency", () => {
  it("double install is safe (no double-wrap, behavior unchanged)", () => {
    installBetterCallErrorLogShim();
    installBetterCallErrorLogShim();
    console.error(new Error("SECRET"));
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(spies.error.mock.calls[0]).toEqual(["error (sanitized): Error"]);
    expect(
      (spies.error.mock.calls[0] ?? []).find(
        (arg: unknown): arg is string => typeof arg === "string",
      ),
    ).not.toContain("SECRET");
  });
});
