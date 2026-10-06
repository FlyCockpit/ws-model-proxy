import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import type { Context, NodeOperatorServices } from "../context";
import type { CallerAuth } from "../contracts/auth-context";
import { nodeOperatorRouters } from "./node-operator";

const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;

const session = {
  user: {
    id: "owner",
    email: "o@example.test",
    name: "O",
    role: "user",
    emailVerified: true,
    twoFactorEnabled: false,
  },
  session: { id: "sess", userId: "owner", expiresAt: new Date(Date.now() + 60_000) },
} as unknown as Session;

const PERSON: CallerAuth = {
  kind: "cookie_session",
  userId: "owner",
  sessionId: "sess",
  csrfVerified: true,
};
const FULL_AGENT: CallerAuth = {
  kind: "agent_token",
  userId: "owner",
  agentTokenId: "tok1",
  level: "FULL",
};
const READ_AGENT: CallerAuth = { ...FULL_AGENT, level: "READ" };

function operator(): NodeOperatorServices & {
  openTerminalTicket: ReturnType<typeof vi.fn>;
  startCommand: ReturnType<typeof vi.fn>;
  pollCommand: ReturnType<typeof vi.fn>;
} {
  return {
    openTerminalTicket: vi.fn(async () => ({
      ticket: "ticket-1",
      terminalId: "term-1",
      expiresAt: new Date("2026-10-06T13:00:00Z"),
    })),
    startCommand: vi.fn(async () => ({ startedAt: new Date(), endsBy: new Date() })),
    pollCommand: vi.fn(async () => ({ state: "RUNNING" as const, output: "so far" })),
  };
}

function client(auth: CallerAuth, nodeOperator?: NodeOperatorServices) {
  return createRouterClient(nodeOperatorRouters, {
    context: {
      session,
      auth,
      ...(nodeOperator ? { services: { nodeOperator } } : {}),
    } satisfies Context,
  });
}

const fullNode = {
  id: "node1",
  slug: "box",
  trust: "FULL" as const,
  trustLowerRequestedAt: null,
  connection: "ONLINE" as const,
  commandMaxMs: 3_600_000,
};

const startedAt = new Date("2026-10-06T12:00:00Z");
const commandRow = {
  id: "AAAAAAAAAAAAAAAAAAAAAA",
  nodeId: "node1",
  userId: "owner",
  actor: "AGENT" as const,
  agentTokenId: "tok1",
  subject: "hmac-sha256:abc ls",
  state: "RUNNING" as const,
  exitCode: null,
  startedAt,
  endsBy: new Date(startedAt.getTime() + 3_600_000),
  finishedAt: null,
};

const queuedRow = {
  id: "q1",
  nodeId: "node1",
  command: "sudo apt install nvtop",
  note: "needs sudo",
  state: "QUEUED" as const,
  agentTokenId: "tok1",
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 3_600_000),
  decidedAt: null,
  outcome: null,
};

beforeEach(() => {
  mockReset(db);
  db.$transaction.mockImplementation((async (work: (tx: typeof db) => unknown) =>
    work(db)) as never);
});

describe("node commands", () => {
  const runInput = { nodeId: "node1", command: "ls -la", confirm: "RUN" as const };

  it("refuses a browser call without the CSRF header (a cross-site form post)", async () => {
    const forged: CallerAuth = { ...PERSON, csrfVerified: false };
    await expect(client(forged, operator()).commands.run(runInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      client(forged, operator()).queued.enqueue({ nodeId: "node1", command: "ls", note: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      client(forged, operator()).commands.get({ commandId: commandRow.id, cancel: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.node.findFirst).not.toHaveBeenCalled();
    expect(db.nodeCommand.findFirst).not.toHaveBeenCalled();
  });

  it("audits a command the node never started as failed to start", async () => {
    const ops = operator();
    ops.startCommand.mockRejectedValue(new Error("socket closed"));
    db.node.findFirst.mockResolvedValue(fullNode as never);
    db.nodeCommand.create.mockResolvedValue(commandRow as never);
    db.nodeCommand.updateMany.mockResolvedValue({ count: 1 });
    await expect(client(FULL_AGENT, ops).commands.run(runInput)).rejects.toMatchObject({
      data: { reason: "node_offline" },
    });
    expect(db.nodeAuditEvent.create.mock.calls[0]?.[0].data).toMatchObject({
      outcome: "failed",
      reason: "start_failed",
    });
  });

  it("refuses a Read-only agent before anything runs", async () => {
    await expect(client(READ_AGENT, operator()).commands.run(runInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(db.nodeCommand.create).not.toHaveBeenCalled();
  });

  it("refuses a Relay-only node (trust_relay), also while a lower is pending", async () => {
    for (const node of [
      { ...fullNode, trust: "RELAY" as const },
      { ...fullNode, trustLowerRequestedAt: new Date() },
    ]) {
      db.node.findFirst.mockResolvedValueOnce(node as never);
      await expect(client(FULL_AGENT, operator()).commands.run(runInput)).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "trust_relay" },
      });
    }
    expect(db.nodeCommand.create).not.toHaveBeenCalled();
  });

  it("refuses an offline node and someone else's node", async () => {
    db.node.findFirst.mockResolvedValueOnce({ ...fullNode, connection: "OFFLINE" } as never);
    await expect(client(FULL_AGENT, operator()).commands.run(runInput)).rejects.toMatchObject({
      data: { reason: "node_offline" },
    });
    db.node.findFirst.mockResolvedValueOnce(null);
    await expect(client(FULL_AGENT, operator()).commands.run(runInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.node.findFirst.mock.calls[1]?.[0]?.where).toEqual({ id: "node1", userId: "owner" });
  });

  it("answers SERVICE_UNAVAILABLE without the relay hooks and records nothing", async () => {
    db.node.findFirst.mockResolvedValue(fullNode as never);
    await expect(client(FULL_AGENT).commands.run(runInput)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(db.nodeCommand.create).not.toHaveBeenCalled();
  });

  it("starts a command, stores no text, caps the timeout by the node", async () => {
    const ops = operator();
    db.node.findFirst.mockResolvedValue({ ...fullNode, commandMaxMs: 60_000 } as never);
    db.nodeCommand.create.mockResolvedValue(commandRow as never);
    const view = await client(FULL_AGENT, ops).commands.run({ ...runInput, timeoutMs: 3_600_000 });
    expect(view).toMatchObject({ commandId: commandRow.id, state: "RUNNING", output: "so far" });
    const data = db.nodeCommand.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ userId: "owner", actor: "AGENT", agentTokenId: "tok1" });
    expect(data?.subject).toMatch(/^hmac-sha256:[0-9a-f]{64} ls$/);
    expect(JSON.stringify(data)).not.toContain("-la");
    expect(data?.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ops.startCommand.mock.calls[0]?.[0]).toMatchObject({
      command: "ls -la",
      timeoutMs: 60_000,
    });
  });

  it("refuses hidden characters in the command", async () => {
    db.node.findFirst.mockResolvedValue(fullNode as never);
    await expect(
      client(FULL_AGENT, operator()).commands.run({ ...runInput, command: "ls‮ -la" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("settles a finished command once and appends its audit event", async () => {
    const ops = operator();
    ops.pollCommand.mockResolvedValue({ state: "SUCCEEDED", exitCode: 0, output: "done" });
    db.nodeCommand.findFirst.mockResolvedValue(commandRow as never);
    db.nodeCommand.updateMany.mockResolvedValue({ count: 1 });
    const view = await client(FULL_AGENT, ops).commands.get({
      commandId: commandRow.id,
      waitMs: 1_000,
    });
    expect(view).toMatchObject({ state: "SUCCEEDED", exitCode: 0, output: "done" });
    expect(db.nodeCommand.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: commandRow.id,
      state: "RUNNING",
    });
    expect(db.nodeAuditEvent.create.mock.calls[0]?.[0].data).toMatchObject({
      kind: "command",
      outcome: "completed",
      subject: commandRow.subject,
      actor: "AGENT",
      agentTokenId: "tok1",
    });
  });

  it("records an interrupted command (trust lowered) as unknown, once", async () => {
    const ops = operator();
    ops.pollCommand.mockResolvedValue({ state: "INTERRUPTED", output: "" });
    db.nodeCommand.findFirst.mockResolvedValue(commandRow as never);
    db.nodeCommand.updateMany.mockResolvedValue({ count: 0 });
    db.nodeCommand.findUnique.mockResolvedValue({
      ...commandRow,
      state: "INTERRUPTED",
      finishedAt: new Date(),
    } as never);
    const view = await client(PERSON, ops).commands.get({ commandId: commandRow.id });
    expect(view.state).toBe("INTERRUPTED");
    expect(db.nodeAuditEvent.create).not.toHaveBeenCalled();
  });

  it("shows no output while the node is offline", async () => {
    const ops = operator();
    ops.pollCommand.mockResolvedValue(null);
    db.nodeCommand.findFirst.mockResolvedValue(commandRow as never);
    await expect(
      client(PERSON, ops).commands.get({ commandId: commandRow.id }),
    ).resolves.toMatchObject({ state: "RUNNING", output: null });
  });

  it("refuses to cancel a finished command and a Read-only agent's cancel", async () => {
    db.nodeCommand.findFirst.mockResolvedValue({
      ...commandRow,
      state: "SUCCEEDED",
      finishedAt: new Date(),
    } as never);
    await expect(
      client(FULL_AGENT, operator()).commands.get({ commandId: commandRow.id, cancel: true }),
    ).rejects.toMatchObject({ data: { reason: "command_not_running" } });
    await expect(
      client(READ_AGENT, operator()).commands.get({ commandId: commandRow.id, cancel: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reads only the caller's commands", async () => {
    db.nodeCommand.findFirst.mockResolvedValue(null);
    await expect(
      client(PERSON, operator()).commands.get({ commandId: commandRow.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.nodeCommand.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: commandRow.id,
      userId: "owner",
    });
  });
});

describe("browser terminals and queued commands", () => {
  it("never opens a terminal or runs a queued command for an agent", async () => {
    for (const call of [
      (c: ReturnType<typeof client>) =>
        c.terminals.openTicket({ nodeId: "node1", cols: 80, rows: 24 }),
      (c: ReturnType<typeof client>) => c.queued.run({ queuedCommandId: "q1", cols: 80, rows: 24 }),
      (c: ReturnType<typeof client>) => c.queued.dismiss({ queuedCommandId: "q1" }),
    ])
      await expect(call(client(FULL_AGENT, operator()))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    expect(db.node.findFirst).not.toHaveBeenCalled();
  });

  it("opens a terminal ticket for a person on a Full-control node", async () => {
    const ops = operator();
    db.node.findFirst.mockResolvedValue(fullNode as never);
    await expect(
      client(PERSON, ops).terminals.openTicket({ nodeId: "node1", cols: 80, rows: 24 }),
    ).resolves.toEqual({
      ticket: "ticket-1",
      terminalId: "term-1",
      expiresAt: "2026-10-06T13:00:00.000Z",
    });
    expect(ops.openTerminalTicket.mock.calls[0]?.[0]).toMatchObject({
      userId: "owner",
      sessionId: "sess",
      nodeId: "node1",
    });
    expect(db.nodeAuditEvent.create.mock.calls[0]?.[0].data).toMatchObject({
      kind: "browser_terminal",
      outcome: "opened",
    });
  });

  it("queues a command from a Full agent (not from a Read-only one)", async () => {
    db.node.findFirst.mockResolvedValue({ ...fullNode, connection: "OFFLINE" } as never);
    db.queuedNodeCommand.count.mockResolvedValue(0);
    db.queuedNodeCommand.create.mockResolvedValue(queuedRow as never);
    const input = { nodeId: "node1", command: "sudo apt install nvtop", note: "needs sudo" };
    await expect(client(READ_AGENT).queued.enqueue(input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(client(FULL_AGENT).queued.enqueue(input)).resolves.toMatchObject({
      id: "q1",
      state: "QUEUED",
    });
    expect(db.queuedNodeCommand.create.mock.calls[0]?.[0].data).toMatchObject({
      userId: "owner",
      agentTokenId: "tok1",
    });
  });

  it("runs a queued command: the terminal opens with the text typed", async () => {
    const ops = operator();
    db.queuedNodeCommand.findFirst.mockResolvedValue(queuedRow as never);
    db.node.findFirst.mockResolvedValue(fullNode as never);
    db.queuedNodeCommand.updateMany.mockResolvedValue({ count: 1 });
    db.queuedNodeCommand.findUnique.mockResolvedValue({
      ...queuedRow,
      state: "RUN",
      decidedAt: new Date(),
      outcome: "term-1",
    } as never);
    const result = await client(PERSON, ops).queued.run({
      queuedCommandId: "q1",
      cols: 80,
      rows: 24,
    });
    expect(result).toMatchObject({ terminalId: "term-1", item: { state: "RUN" } });
    expect(ops.openTerminalTicket.mock.calls[0]?.[0]).toMatchObject({
      typedCommand: "sudo apt install nvtop",
    });
    expect(db.queuedNodeCommand.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "q1", userId: "owner", state: "QUEUED" },
      data: { state: "RUN", decidedBy: "owner", outcome: "term-1" },
    });
  });

  it("refuses a queued command whose node became Relay only, and records why", async () => {
    db.queuedNodeCommand.findFirst.mockResolvedValue(queuedRow as never);
    db.node.findFirst.mockResolvedValue({ ...fullNode, trust: "RELAY" } as never);
    db.queuedNodeCommand.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      client(PERSON, operator()).queued.run({ queuedCommandId: "q1", cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ data: { reason: "trust_relay" } });
    expect(db.queuedNodeCommand.updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      state: "REFUSED",
      outcome: "trust_relay",
    });
  });

  it("expires a queued command past its time instead of running it", async () => {
    db.queuedNodeCommand.findFirst.mockResolvedValue({
      ...queuedRow,
      expiresAt: new Date(Date.now() - 1_000),
    } as never);
    db.queuedNodeCommand.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      client(PERSON, operator()).queued.run({ queuedCommandId: "q1", cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.queuedNodeCommand.updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      state: "EXPIRED",
      decidedBy: null,
    });
  });

  it("dismisses only the caller's queued command", async () => {
    db.queuedNodeCommand.findFirst.mockResolvedValue(null);
    await expect(
      client(PERSON).queued.dismiss({ queuedCommandId: "theirs" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.queuedNodeCommand.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "theirs",
      userId: "owner",
    });
  });

  it("lists queued commands, showing overdue ones as expired", async () => {
    db.queuedNodeCommand.findMany.mockResolvedValue([
      { ...queuedRow, expiresAt: new Date(Date.now() - 1_000) },
    ] as never);
    const listed = await client(PERSON).queued.list({});
    expect(listed.items[0]?.state).toBe("EXPIRED");
  });
});
