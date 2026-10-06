import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    nodeCommand: { updateMany: vi.fn(async () => ({ count: 1 })) },
    nodeAuditEvent: { create: vi.fn(async () => ({})) },
  };
  return {
    tx,
    client: {
      $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
      nodeCommand: {
        findFirst: vi.fn(async (): Promise<unknown> => null),
        findUnique: vi.fn(async (): Promise<unknown> => null),
        findMany: vi.fn(async (): Promise<unknown[]> => []),
      },
      agentToken: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
      mcpGrant: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
      user: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    },
  };
});
vi.mock("@ws-model-proxy/db", () => ({ default: db.client }));

const { createNodeOperatorServices, NodeCommandStartError } = await import(
  "./node-operator-services.js"
);
const { NodeCommandTracker, NODE_COMMAND_SWEEP_PAGE } = await import("./node-command-tracker.js");
const { TerminalTicketStore } = await import("./terminal-tickets.js");

import type { ServerToNodeControlFrame } from "./frames.js";
import type { NodeSessionRef, SendGuard } from "./session-manager.js";

const COMMAND = Buffer.alloc(16, 7).toString("base64url");

const ref = (overrides: Partial<NodeSessionRef> = {}): NodeSessionRef => ({
  nodeId: "node-1",
  userId: "user-1",
  slug: "desk",
  connectionGeneration: 3,
  trust: "full",
  ...overrides,
});

function relay() {
  const sent: Array<{ nodeId: string; frame: ServerToNodeControlFrame; guard?: SendGuard }> = [];
  const session: { online: boolean; connectionGeneration: number; trust: "full" | "relay" } = {
    online: true,
    connectionGeneration: 3,
    trust: "full",
  };
  const port = {
    sendToNode: vi.fn((nodeId: string, frame: ServerToNodeControlFrame, guard?: SendGuard) => {
      if (!session.online) return false;
      if (guard?.requireFullTrust && session.trust !== "full") return false;
      if (
        guard?.connectionGeneration !== undefined &&
        guard.connectionGeneration !== session.connectionGeneration
      )
        return false;
      sent.push({ nodeId, frame, ...(guard ? { guard } : {}) });
      return true;
    }),
    nodeSession: vi.fn(() =>
      session.online
        ? { connectionGeneration: session.connectionGeneration, trust: session.trust }
        : null,
    ),
  };
  return { sent, session, port, types: () => sent.map((entry) => entry.frame.type) };
}

function setup(options: { startTimeoutMs?: number; pollAnswerTimeoutMs?: number } = {}) {
  const r = relay();
  const tracker = new NodeCommandTracker(r.port);
  const tickets = new TerminalTicketStore();
  const operator = createNodeOperatorServices(r.port, { tickets, tracker, ...options });
  return { ...r, tracker, tickets, ...operator };
}

const startArgs = {
  userId: "user-1",
  nodeId: "node-1",
  commandId: COMMAND,
  command: "nvidia-smi",
  timeoutMs: 60_000,
};

function status(state: "running" | "succeeded" | "cancelled", tail?: string) {
  return {
    type: "exec.status" as const,
    commandId: COMMAND,
    state,
    ...(state === "succeeded" ? { exitCode: 0 } : {}),
    ...(state === "running" ? {} : { finishedAt: "2026-01-01T00:00:05.000Z" }),
    ...(tail !== undefined ? { tail } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("node operator services: commands", () => {
  it("starts on the live session at Full control and resolves on its exec.started", async () => {
    const s = setup();
    const started = s.services.startCommand(startArgs);
    expect(s.sent[0]).toMatchObject({
      frame: { type: "exec.start", commandId: COMMAND, command: "nvidia-smi", timeoutMs: 60_000 },
      guard: { connectionGeneration: 3, requireFullTrust: true },
    });
    expect(s.tracker.commandsOnNode("node-1").map((entry) => entry.commandId)).toEqual([COMMAND]);
    const frame = {
      type: "exec.started" as const,
      commandId: COMMAND,
      startedAt: "2026-01-01T00:00:00.000Z",
      endsBy: "2026-01-01T00:01:00.000Z",
    };
    // Another node, an older session or another user's session cannot answer it.
    await s.handlers["exec.started"]?.(ref({ nodeId: "node-2" }), frame);
    await s.handlers["exec.started"]?.(ref({ connectionGeneration: 2 }), frame);
    await s.handlers["exec.started"]?.(ref({ userId: "user-2" }), frame);
    await s.handlers["exec.started"]?.(ref(), frame);
    await expect(started).resolves.toEqual({
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      endsBy: new Date("2026-01-01T00:01:00.000Z"),
    });
    expect(s.tracker.get(COMMAND)?.endsBy).toBe(Date.parse("2026-01-01T00:01:00.000Z"));
  });

  it("throws a fixed message on exec.rejected and when the node is offline or at Relay", async () => {
    const s = setup();
    const started = s.services.startCommand(startArgs);
    await s.handlers["exec.rejected"]?.(ref(), {
      type: "exec.rejected",
      commandId: COMMAND,
      reason: "bad_cwd",
    });
    await expect(started).rejects.toThrow("The node did not start the command (rejected).");
    expect(s.tracker.size).toBe(0);

    s.session.trust = "relay";
    await expect(s.services.startCommand(startArgs)).rejects.toBeInstanceOf(NodeCommandStartError);
    s.session.online = false;
    await expect(s.services.startCommand(startArgs)).rejects.toMatchObject({
      code: "not_delivered",
    });
    expect(s.types()).toEqual(["exec.start"]);
  });

  it("times out without an answer and cancels a start that may land late", async () => {
    vi.useFakeTimers();
    const s = setup({ startTimeoutMs: 15_000 });
    const started = s.services.startCommand(startArgs);
    const failed = expect(started).rejects.toMatchObject({ code: "no_answer" });
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(s.types()).toEqual(["exec.start", "exec.cancel"]);
    // A late answer resolves nothing, and the cancel goes out again: the node only now
    // knows the command (its first cancel was ignored there).
    await s.handlers["exec.started"]?.(ref(), {
      type: "exec.started",
      commandId: COMMAND,
      startedAt: "2026-01-01T00:00:00.000Z",
      endsBy: "2026-01-01T00:01:00.000Z",
    });
    expect(s.types()).toEqual(["exec.start", "exec.cancel", "exec.cancel"]);
  });

  it("fails a start on its own session's disconnect only", async () => {
    const s = setup();
    const started = s.services.startCommand(startArgs);
    let settled = false;
    started.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // A late notice about an earlier session.
    s.handlers.nodeDisconnected?.(ref({ connectionGeneration: 2 }));
    await Promise.resolve();
    expect(settled).toBe(false);
    s.handlers.nodeDisconnected?.(ref());
    await expect(started).rejects.toMatchObject({ code: "disconnected" });
    // The node may have started it: the cancel goes out when it is back.
    expect(s.tracker.get(COMMAND)?.cancelRequested).toBe(true);
    s.sent.length = 0;
    await s.handlers.nodeReady?.(ref({ connectionGeneration: 4 }));
    expect(s.types()).toEqual(["exec.cancel"]);
  });

  it("answers null for an offline node without sending anything", async () => {
    const s = setup();
    s.session.online = false;
    await expect(
      s.services.pollCommand({ ...startArgs, waitMs: 0, cancel: false }),
    ).resolves.toBeNull();
    expect(s.sent).toHaveLength(0);
  });

  it("polls once and maps the node's status (output is the tail, '' when absent)", async () => {
    const s = setup();
    const polled = s.services.pollCommand({ ...startArgs, waitMs: 0, cancel: false });
    expect(s.sent[0]).toMatchObject({
      frame: { type: "exec.poll", commandId: COMMAND, tailBytes: 64 * 1024 },
      guard: { connectionGeneration: 3 },
    });
    expect(s.sent[0]?.guard?.requireFullTrust).toBeUndefined();
    // An older session's answer is not this poll's.
    await s.handlers["exec.status"]?.(ref({ connectionGeneration: 2 }), status("running", "old"));
    await s.handlers["exec.status"]?.(ref(), status("running"));
    await expect(polled).resolves.toEqual({ state: "RUNNING", output: "" });
  });

  it("waits for the end, answering at once when it arrives before waitMs", async () => {
    vi.useFakeTimers();
    const s = setup();
    const polled = s.services.pollCommand({ ...startArgs, waitMs: 30_000, cancel: false });
    await s.handlers["exec.status"]?.(ref(), status("running", "1"));
    await vi.advanceTimersByTimeAsync(10_000);
    await s.handlers["exec.status"]?.(ref(), status("succeeded", "done\n"));
    await expect(polled).resolves.toEqual({
      state: "SUCCEEDED",
      exitCode: 0,
      output: "done\n",
      finishedAt: new Date("2026-01-01T00:00:05.000Z"),
    });
    // A poll answered the end: the procedure records it, not the handler.
    expect(db.client.nodeCommand.findFirst).not.toHaveBeenCalled();
  });

  it("polls again at waitMs for a command still running and answers its latest output", async () => {
    vi.useFakeTimers();
    const s = setup();
    const polled = s.services.pollCommand({ ...startArgs, waitMs: 2_000, cancel: false });
    await s.handlers["exec.status"]?.(ref(), status("running", "a"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.types()).toEqual(["exec.poll", "exec.poll"]);
    await s.handlers["exec.status"]?.(ref(), status("running", "ab"));
    await expect(polled).resolves.toMatchObject({ state: "RUNNING", output: "ab" });
  });

  it("answers the latest status (or null) when the node does not answer a poll", async () => {
    vi.useFakeTimers();
    const s = setup({ pollAnswerTimeoutMs: 5_000 });
    const silent = s.services.pollCommand({ ...startArgs, waitMs: 0, cancel: false });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(silent).resolves.toBeNull();
  });

  it("cancels: exec.cancel then exec.poll, answered by the command's end", async () => {
    const s = setup();
    const cancelled = s.services.pollCommand({ ...startArgs, waitMs: 0, cancel: true });
    expect(s.types()).toEqual(["exec.cancel", "exec.poll"]);
    await s.handlers["exec.status"]?.(ref(), status("cancelled", "partial"));
    await expect(cancelled).resolves.toMatchObject({ state: "CANCELLED", output: "partial" });
  });

  it("keeps a cancel asked while the node is offline and sends it when the node is back", async () => {
    const s = setup();
    s.session.online = false;
    await expect(
      s.services.pollCommand({
        ...startArgs,
        waitMs: 0,
        cancel: true,
        endsBy: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBeNull();
    expect(s.tracker.get(COMMAND)).toMatchObject({ nodeId: "node-1", cancelRequested: true });
    s.session.online = true;
    s.session.connectionGeneration = 4;
    await s.handlers.nodeReady?.(ref({ connectionGeneration: 4 }));
    expect(s.sent.map((entry) => entry.frame)).toEqual([
      { type: "exec.cancel", commandId: COMMAND },
    ]);
  });

  it("sends a cancel again once the node starts a command it reached before exec.start", async () => {
    const s = setup();
    // A revocation found the row and cancelled before the start went out (the node ignored it).
    s.tracker.cancel({ commandId: COMMAND, nodeId: "node-1", userId: "user-1", endsBy: 0 });
    const started = s.services.startCommand(startArgs);
    expect(s.types()).toEqual(["exec.cancel", "exec.start"]);
    await s.handlers["exec.started"]?.(ref(), {
      type: "exec.started",
      commandId: COMMAND,
      startedAt: "2026-01-01T00:00:00.000Z",
      endsBy: "2026-01-01T00:01:00.000Z",
    });
    await started;
    expect(s.sent.at(-1)).toEqual({
      nodeId: "node-1",
      frame: { type: "exec.cancel", commandId: COMMAND },
      guard: { connectionGeneration: 3 },
    });
  });

  it("does not cancel a started command nobody asked to cancel", async () => {
    const s = setup();
    const started = s.services.startCommand(startArgs);
    await s.handlers["exec.started"]?.(ref(), {
      type: "exec.started",
      commandId: COMMAND,
      startedAt: "2026-01-01T00:00:00.000Z",
      endsBy: "2026-01-01T00:01:00.000Z",
    });
    await started;
    expect(s.types()).toEqual(["exec.start"]);
  });

  it("ends a poll on its own session's disconnect with what it had", async () => {
    const s = setup();
    const polled = s.services.pollCommand({ ...startArgs, waitMs: 30_000, cancel: false });
    await s.handlers["exec.status"]?.(ref(), status("running", "so far"));
    s.handlers.nodeDisconnected?.(ref({ connectionGeneration: 2 }));
    s.handlers.nodeDisconnected?.(ref());
    await expect(polled).resolves.toMatchObject({ state: "RUNNING", output: "so far" });
  });

  it("records an end nobody polled for, on the reporting node's own row", async () => {
    const s = setup();
    s.tracker.track({ commandId: COMMAND, nodeId: "node-1", userId: "user-1", endsBy: 0 });
    db.client.nodeCommand.findFirst.mockResolvedValueOnce({
      id: COMMAND,
      nodeId: "node-1",
      userId: "user-1",
      actor: "AGENT",
      agentTokenId: "token-1",
      mcpGrantId: null,
      subject: "hmac-sha256:00 nvidia-smi",
      state: "RUNNING",
      exitCode: null,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      endsBy: new Date("2026-01-01T00:01:00.000Z"),
      finishedAt: null,
    });
    await s.handlers["exec.status"]?.(ref(), status("cancelled", "secret output"));
    expect(db.client.nodeCommand.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: COMMAND, nodeId: "node-1", userId: "user-1", state: "RUNNING" },
      }),
    );
    expect(db.tx.nodeCommand.updateMany).toHaveBeenCalledWith({
      where: { id: COMMAND, state: "RUNNING" },
      data: expect.objectContaining({ state: "CANCELLED" }),
    });
    expect(JSON.stringify(db.tx.nodeAuditEvent.create.mock.calls)).not.toContain("secret output");
    expect(s.tracker.size).toBe(0);
  });
});

describe("node operator services: command tracking", () => {
  it("ends a banned user's commands at once and resends to an offline node when it is back", async () => {
    const s = setup();
    void s.services.startCommand(startArgs).catch(() => undefined);
    s.sent.length = 0;
    s.session.online = false;
    expect(s.tracker.cancelForUser("user-1")).toBe(1);
    expect(s.tracker.cancelForUser("user-2")).toBe(0);
    s.session.online = true;
    s.tracker.nodeReady("node-1");
    expect(s.types()).toEqual(["exec.cancel"]);
    expect(db.client.nodeCommand.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", state: "RUNNING" } }),
    );
  });

  it("ends the commands of revoked credentials from their rows", async () => {
    const s = setup();
    db.client.nodeCommand.findMany.mockResolvedValueOnce([
      { id: COMMAND, nodeId: "node-1", userId: "user-1", endsBy: new Date(Date.now() + 60_000) },
    ]);
    await expect(
      s.tracker.cancelForCredentials({ userId: "user-1", credentialIds: ["token-1", "grant-1"] }),
    ).resolves.toBe(1);
    expect(db.client.nodeCommand.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          state: "RUNNING",
          OR: [
            { agentTokenId: { in: ["token-1", "grant-1"] } },
            { mcpGrantId: { in: ["token-1", "grant-1"] } },
          ],
        },
      }),
    );
    expect(s.sent.map((entry) => entry.frame)).toEqual([
      { type: "exec.cancel", commandId: COMMAND },
    ]);
  });

  it("sweeps commands whose token expired or whose owner is banned, and keeps live ones", async () => {
    const s = setup();
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const row = (id: string, extra: Record<string, unknown>) => ({
      id,
      nodeId: "node-1",
      userId: "user-1",
      endsBy: new Date(now + 60_000),
      agentTokenId: null,
      mcpGrantId: null,
      ...extra,
    });
    db.client.nodeCommand.findMany.mockResolvedValueOnce([
      row("live", { agentTokenId: "token-live" }),
      row("expired", { agentTokenId: "token-gone" }),
      row("grant", { mcpGrantId: "grant-gone" }),
      row("person", {}),
      row("banned", { userId: "user-banned" }),
    ]);
    db.client.agentToken.findMany.mockResolvedValueOnce([{ id: "token-live" }]);
    db.client.mcpGrant.findMany.mockResolvedValueOnce([]);
    db.client.user.findMany.mockResolvedValueOnce([
      { id: "user-1", banned: false, banExpires: null, deletionRequestedAt: null },
      { id: "user-banned", banned: true, banExpires: null, deletionRequestedAt: null },
    ]);
    await expect(s.tracker.sweep(now)).resolves.toBe(3);
    expect(s.sent.map((entry) => entry.frame)).toEqual([
      { type: "exec.cancel", commandId: "expired" },
      { type: "exec.cancel", commandId: "grant" },
      { type: "exec.cancel", commandId: "banned" },
    ]);
  });

  it("reads the sweep's rows in pages by id", async () => {
    const s = setup();
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `cmd-${String(from + index).padStart(4, "0")}`,
        nodeId: "node-1",
        userId: "user-1",
        endsBy: new Date(now + 60_000),
        agentTokenId: "token-gone",
        mcpGrantId: null,
      }));
    db.client.nodeCommand.findMany
      .mockResolvedValueOnce(page(0, NODE_COMMAND_SWEEP_PAGE))
      .mockResolvedValueOnce(page(NODE_COMMAND_SWEEP_PAGE, 3));
    const owner = { id: "user-1", banned: false, banExpires: null, deletionRequestedAt: null };
    db.client.user.findMany.mockResolvedValueOnce([owner]).mockResolvedValueOnce([owner]);
    await expect(s.tracker.sweep(now)).resolves.toBe(NODE_COMMAND_SWEEP_PAGE + 3);
    const calls = db.client.nodeCommand.findMany.mock.calls as unknown as Array<
      [{ take: number; orderBy: unknown; cursor?: unknown; skip?: number }]
    >;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toMatchObject({ take: NODE_COMMAND_SWEEP_PAGE, orderBy: { id: "asc" } });
    expect(calls[0]?.[0].cursor).toBeUndefined();
    expect(calls[1]?.[0]).toMatchObject({
      cursor: { id: `cmd-${String(NODE_COMMAND_SWEEP_PAGE - 1).padStart(4, "0")}` },
      skip: 1,
    });
  });
});

describe("node operator services: terminal tickets", () => {
  it("mints a ticket for a live node at Full control and refuses otherwise", async () => {
    const s = setup();
    const ticket = await s.services.openTerminalTicket({
      userId: "user-1",
      sessionId: "session-1",
      nodeId: "node-1",
      cols: 80,
      rows: 24,
      typedCommand: "nvidia-smi",
    });
    expect(
      s.tickets.redeem({ userId: "user-1", sessionId: "session-1", ticket: ticket.ticket }),
    ).toEqual({ kind: "open", nodeId: "node-1", terminalId: ticket.terminalId });
    s.session.trust = "relay";
    await expect(
      s.services.openTerminalTicket({
        userId: "user-1",
        sessionId: "session-1",
        nodeId: "node-1",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ data: { reason: "trust_relay" } });
    s.session.online = false;
    await expect(
      s.services.openTerminalTicket({
        userId: "user-1",
        sessionId: "session-1",
        nodeId: "node-1",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ data: { reason: "node_offline" } });
    // Nothing about a terminal ticket goes to the node.
    expect(s.sent).toHaveLength(0);
  });
});
