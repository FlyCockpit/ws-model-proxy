import { createHash } from "node:crypto";
import type { CliAgentActionEventInput } from "@ws-model-proxy/config/cli-agent-audit";
import { armDbShutdownFence, disarmDbShutdownFence } from "@ws-model-proxy/db/shutdown-fence";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A credential-free sentinel: the writer must never log the database error text.
const DB_ERROR_SENTINEL = "db-error-sentinel-7f3a";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const {
  CLI_AGENT_AUDIT_BATCH,
  CLI_AGENT_AUDIT_FLUSH_DELAY_MS,
  CLI_AGENT_AUDIT_QUEUE_CAP,
  cliAgentAuditDroppedCount,
  flushCliAgentAudit,
  recordCliAgentAction,
  resetCliAgentAuditForTests,
  stopCliAgentAuditWriter,
} = await import("./cli-agent-audit.js");

const createMany = (prisma as unknown as { cliAgentActionEvent: { createMany: MockInstance } })
  .cliAgentActionEvent.createMany;

const findUsers = (prisma as unknown as { user: { findMany: MockInstance } }).user.findMany;

const startedAt = new Date("2026-01-01T00:00:00.000Z");

function event(overrides: Partial<CliAgentActionEventInput> = {}): CliAgentActionEventInput {
  return {
    userId: "user-1",
    cliDeviceId: "device-1",
    mcpTokenId: "token-1",
    kind: "file_write",
    path: "/etc/hosts",
    outcome: "completed",
    startedAt,
    ...overrides,
  };
}

function written(): Array<Record<string, unknown>> {
  return createMany.mock.calls.flatMap(
    ([args]) => (args as { data: Array<Record<string, unknown>> }).data,
  );
}

describe("recordCliAgentAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCliAgentAuditForTests();
    createMany.mockReset();
    createMany.mockResolvedValue({ count: 0 });
    findUsers.mockReset();
    // Every owner exists unless a test says otherwise.
    findUsers.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id })),
    );
    disarmDbShutdownFence();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    disarmDbShutdownFence();
  });

  it("returns at once and writes the batch after the flush delay", async () => {
    recordCliAgentAction(event());
    recordCliAgentAction(event({ kind: "file_read", path: "/etc/passwd" }));
    expect(createMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CLI_AGENT_AUDIT_FLUSH_DELAY_MS);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(written().map((row) => row.path)).toEqual(["/etc/hosts", "/etc/passwd"]);
  });

  it("does not write events of a user that no longer exists", async () => {
    findUsers.mockImplementation(async () => [{ id: "user-live" }]);
    recordCliAgentAction(event({ userId: "user-gone", path: "gone" }));
    recordCliAgentAction(event({ userId: "user-live", path: "live" }));
    await vi.advanceTimersByTimeAsync(CLI_AGENT_AUDIT_FLUSH_DELAY_MS);
    expect(written().map((row) => row.path)).toEqual(["live"]);
    expect(cliAgentAuditDroppedCount()).toBe(1);
  });

  it("drops the batch, without throwing, when the owner lookup fails", async () => {
    findUsers.mockRejectedValue(new Error(DB_ERROR_SENTINEL));
    recordCliAgentAction(event());
    await vi.advanceTimersByTimeAsync(CLI_AGENT_AUDIT_FLUSH_DELAY_MS);
    expect(createMany).not.toHaveBeenCalled();
    expect(cliAgentAuditDroppedCount()).toBe(1);
  });

  it("stores only the allow-listed metadata, never content passed alongside", async () => {
    const sentinel = "CONTENT-SENTINEL-7f3a";
    recordCliAgentAction({
      ...event({ bytes: 12, etagBefore: "e1", etagAfter: "e2", reason: "ok" }),
      content: sentinel,
      diff: sentinel,
      output: sentinel,
    } as CliAgentActionEventInput);
    await flushCliAgentAudit();
    const [row] = written();
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        "bytes",
        "cliDeviceId",
        "etagAfter",
        "etagBefore",
        "finishedAt",
        "kind",
        "mcpTokenId",
        "outcome",
        "path",
        "reason",
        "startedAt",
        "userId",
      ].sort(),
    );
    expect(JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(
      sentinel,
    );
    expect(row).toMatchObject({ bytes: 12n, etagBefore: "e1", etagAfter: "e2", reason: "ok" });
  });

  it("never writes raw command text: the row carries only the hash and the program", async () => {
    const { commandAuditPath } = await import("@ws-model-proxy/config/cli-agent-audit");
    const command = "FOO=secret curl --api-key sk-secret-9 https://x";
    // The keyed digest is injected: this module never sees the key.
    const digest = (text: string) => createHash("sha256").update(`key:${text}`).digest("hex");
    recordCliAgentAction(event({ kind: "command", path: commandAuditPath(command, digest) }));
    await flushCliAgentAudit();
    const serialized = JSON.stringify(written(), (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    for (const leak of ["secret", "sk-secret-9", "https://x", "--api-key", "FOO=", command])
      expect(serialized, `write leaks ${leak}`).not.toContain(leak);
    expect(written()[0]?.path).toMatch(/^hmac-sha256:[0-9a-f]{64} curl$/);
  });

  it("makes every string safe for Postgres and bounds it", async () => {
    recordCliAgentAction(
      event({
        path: `a\0b\ud800${"z".repeat(5000)}`,
        reason: "bad reason: \u0007 ünï",
        bytes: -1,
        etagBefore: "e".repeat(500),
      }),
    );
    await flushCliAgentAudit();
    const [row] = written() as Array<{
      path: string;
      reason: string;
      bytes: bigint | null;
      etagBefore: string;
      finishedAt: Date;
    }>;
    expect(row?.path.includes("\0")).toBe(false);
    expect(row?.path.isWellFormed()).toBe(true);
    expect(row?.path.length).toBeLessThanOrEqual(4096);
    expect(row?.reason).toMatch(/^[A-Za-z0-9_:.-]+$/);
    expect(row?.bytes).toBeNull();
    expect(row?.etagBefore.length).toBe(128);
    expect(row?.finishedAt).toEqual(startedAt);
  });

  it("drops an event with an unknown kind or outcome, or without owner ids, and counts it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recordCliAgentAction(event({ kind: "nope" as never }));
    recordCliAgentAction(event({ outcome: "nope" as never }));
    recordCliAgentAction(event({ userId: "" }));
    recordCliAgentAction(event({ cliDeviceId: "" }));
    recordCliAgentAction(event({ startedAt: new Date("nope") }));
    await flushCliAgentAudit();
    expect(createMany).not.toHaveBeenCalled();
    expect(cliAgentAuditDroppedCount()).toBe(5);
  });

  it("never throws and never blocks when the database rejects; later events still write", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    createMany.mockRejectedValueOnce(new Error(DB_ERROR_SENTINEL));
    expect(() => recordCliAgentAction(event())).not.toThrow();
    await vi.advanceTimersByTimeAsync(CLI_AGENT_AUDIT_FLUSH_DELAY_MS);
    expect(cliAgentAuditDroppedCount()).toBe(1);
    expect(JSON.stringify([...errors.mock.calls, ...warns.mock.calls])).not.toContain(
      DB_ERROR_SENTINEL,
    );
    recordCliAgentAction(event({ path: "/later" }));
    await vi.advanceTimersByTimeAsync(CLI_AGENT_AUDIT_FLUSH_DELAY_MS);
    expect(written().map((row) => row.path)).toContain("/later");
  });

  it("does not wait for a slow database", () => {
    createMany.mockReturnValue(new Promise(() => undefined));
    const before = performance.now();
    for (let i = 0; i < 50; i += 1) recordCliAgentAction(event());
    expect(performance.now() - before).toBeLessThan(200);
  });

  it("drops the oldest events past the queue cap and counts them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const total = CLI_AGENT_AUDIT_QUEUE_CAP + 7;
    for (let i = 0; i < total; i += 1) recordCliAgentAction(event({ path: `/p/${i}` }));
    expect(cliAgentAuditDroppedCount()).toBe(7);
    await flushCliAgentAudit();
    const paths = written().map((row) => row.path);
    expect(paths).toHaveLength(CLI_AGENT_AUDIT_QUEUE_CAP);
    expect(paths[0]).toBe("/p/7");
    expect(paths.at(-1)).toBe(`/p/${total - 1}`);
    // Written in bounded batches.
    for (const [args] of createMany.mock.calls)
      expect((args as { data: unknown[] }).data.length).toBeLessThanOrEqual(CLI_AGENT_AUDIT_BATCH);
  });

  it("drops instead of writing once the database shutdown fence is armed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recordCliAgentAction(event());
    armDbShutdownFence();
    await flushCliAgentAudit();
    expect(createMany).not.toHaveBeenCalled();
    expect(cliAgentAuditDroppedCount()).toBe(1);
  });

  it("stop flushes now, and events recorded after it flush without the batching delay", async () => {
    recordCliAgentAction(event({ path: "/before" }));
    await stopCliAgentAuditWriter();
    expect(written().map((row) => row.path)).toEqual(["/before"]);
    recordCliAgentAction(event({ path: "/after" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(written().map((row) => row.path)).toEqual(["/before", "/after"]);
  });
});
