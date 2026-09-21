import { describe, expect, it } from "vitest";
import { sanitizedApiErrorLogLine } from "./api-error-logging";

/**
 * L19 (app-logger half): the onAPIError.onError sanitizer must never let an
 * error message, meta, stack, or Prisma query/params reach console.error —
 * only the constructor name (non-APIError / 5xx) or nothing (4xx).
 */

class SentinelPrismaLikeError extends Error {
  constructor() {
    super(
      'PrismaClientKnownRequestError: Invalid `prisma.mcpGrant.findUnique()` invocation: column "relation_does_not_exist" does not exist in the current database SECRET-TOKEN-VALUE',
    );
    this.name = "SentinelPrismaLikeError";
  }
}

describe("sanitizedApiErrorLogLine", () => {
  it("non-APIError exception → ONE line carrying only the constructor name", () => {
    const line = sanitizedApiErrorLogLine(new SentinelPrismaLikeError());
    expect(line).toBe("[auth] unhandled error: SentinelPrismaLikeError");
    expect(line).not.toContain("SECRET-TOKEN-VALUE");
    expect(line).not.toContain("does not exist");
    expect(line).not.toContain("prisma");
  });

  it("non-Error thrown values degrade to the typeof, never String(value)", () => {
    expect(sanitizedApiErrorLogLine("raw string with SECRET")).toBe(
      "[auth] unhandled error: string",
    );
    expect(sanitizedApiErrorLogLine(42)).toBe("[auth] unhandled error: number");
    expect(sanitizedApiErrorLogLine(null)).toBe("[auth] unhandled error: object");
  });

  it("numeric 5xx APIErrors → sanitized line, no message/body echo", async () => {
    const { APIError } = await import("better-auth/api");
    // Numeric-constructor form (typed literal statuses; 599 sits outside
    // better-call's literal union, so it is exercised via the explicit
    // 4th-arg statusCode override the constructor computes for numbers).
    for (const code of [500, 503] as const) {
      const error = new APIError(code, { message: `INTERNAL SECRET detail ${code}` });
      const line = sanitizedApiErrorLogLine(error);
      expect(line).toBe(`[auth] API error (${code}): APIError`);
      expect(line).not.toContain("SECRET");
    }
    const custom5xx = new APIError("INTERNAL_SERVER_ERROR", { message: "SECRET" }, {}, 599);
    expect(sanitizedApiErrorLogLine(custom5xx)).toBe("[auth] API error (599): APIError");
  });

  it("symbolic 5xx APIErrors (full statusCodes table) → sanitized line, no message/body echo", async () => {
    const { APIError } = await import("better-auth/api");
    const symbolic = [
      "INTERNAL_SERVER_ERROR",
      "NOT_IMPLEMENTED",
      "BAD_GATEWAY",
      "SERVICE_UNAVAILABLE",
      "GATEWAY_TIMEOUT",
      "HTTP_VERSION_NOT_SUPPORTED",
      "VARIANT_ALSO_NEGOTIATES",
      "INSUFFICIENT_STORAGE",
      "LOOP_DETECTED",
      "NOT_EXTENDED",
      "NETWORK_AUTHENTICATION_REQUIRED",
    ] as const;
    for (const status of symbolic) {
      const error = new APIError(status, { message: "INTERNAL SECRET detail" });
      const line = sanitizedApiErrorLogLine(error);
      // Every symbolic 5xx resolves to a numeric statusCode >= 500 (probe:
      // 500..511), so the classifier must catch them all — including the
      // ten non-INTERNAL_SERVER_ERROR symbols the old status-field check
      // missed.
      expect(line).toMatch(/^\[auth\] API error \(5\d\d\): APIError$/);
      expect(line).not.toContain("SECRET");
      expect(line).not.toContain("INTERNAL SECRET detail");
    }
  });

  it("4xx APIErrors (numeric AND symbolic) → null (protocol answers are not error-logged)", async () => {
    const { APIError } = await import("better-auth/api");
    expect(sanitizedApiErrorLogLine(new APIError(400, { error: "invalid_scope" }))).toBeNull();
    expect(sanitizedApiErrorLogLine(new APIError("UNAUTHORIZED"))).toBeNull();
    expect(sanitizedApiErrorLogLine(new APIError("BAD_REQUEST", { error: "x" }))).toBeNull();
  });
});
