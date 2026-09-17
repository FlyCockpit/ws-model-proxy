import {
  armDbShutdownFence,
  DbShutdownFenceError,
  disarmDbShutdownFence,
  isDbShutdownFenceArmed,
  withDbShutdownFence,
} from "@ws-model-proxy/db/shutdown-fence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armAuthDbShutdownFence,
  disarmAuthDbShutdownFence,
  isAuthDbShutdownFenceArmed,
} from "./auth-db-shutdown-fence";

/**
 * Part G pass 2 (G1): the DB-seam fence implementation MOVED to
 * @ws-model-proxy/db/shutdown-fence, where the ONE shared client is wrapped
 * at construction (covering better-auth's adapter AND the direct procedure
 * calls the MCP tool dispatch makes). This suite pins the compatibility
 * delegation: the Part F arm/disarm surface on this module drives the SAME
 * fence state as the db seam (one arming seam, no double-wrapping). The
 * wrapper's own unit contract lives in
 * apps/server/src/mcp/db-shutdown-fence.test.ts (migrated from the Part F
 * pass-5 suite that used to live here).
 */

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  disarmDbShutdownFence();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  disarmDbShutdownFence();
});

describe("auth fence API — delegation to the ONE db-seam fence", () => {
  it("armAuthDbShutdownFence arms the shared db-seam fence state", () => {
    expect(isAuthDbShutdownFenceArmed()).toBe(false);
    expect(isDbShutdownFenceArmed()).toBe(false);
    armAuthDbShutdownFence();
    expect(isAuthDbShutdownFenceArmed()).toBe(true);
    expect(isDbShutdownFenceArmed()).toBe(true);
  });

  it("disarmAuthDbShutdownFence disarms the shared state", () => {
    armDbShutdownFence();
    disarmAuthDbShutdownFence();
    expect(isAuthDbShutdownFenceArmed()).toBe(false);
    expect(isDbShutdownFenceArmed()).toBe(false);
  });

  it("a client wrapped by the db seam rejects once the auth API arms the fence", () => {
    const row = { findFirst: vi.fn(async (_args: unknown) => null) };
    const wrapped = withDbShutdownFence({ row });
    armAuthDbShutdownFence();
    expect(() => wrapped.row.findFirst({})).toThrow(DbShutdownFenceError);
    expect(row.findFirst).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toBe(
      "[db] fence rejected database operation (DbShutdownFenceError)",
    );
  });
});
