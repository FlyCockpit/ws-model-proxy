import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const { createRuntimeStepServices } = await import("./operator-steps.js");
const { OperatorStepError } = await import("./lifecycle.js");
const { TerminalTicketStore } = await import("../relay/terminal-tickets.js");

const db = prisma as unknown as {
  instanceStep: { findFirst: MockInstance };
  node: { findFirst: MockInstance };
};

const terminalId = Buffer.alloc(16, 3).toString("base64url");
const interactiveIntent = { interactive: true };
const row = (overrides: Record<string, unknown> = {}) => ({
  state: "AWAITING_OPERATOR",
  intent: {
    operationId: null,
    runtimeId: "rt",
    launchVersionId: "v",
    launchHash: "b".repeat(64),
    rank: 0,
    nnodes: 1,
    handle: "i-abcdefabcdef",
    unitName: "wsmp-i-abcdefabcdef-r0",
    port: 30_000,
    distPort: null,
    fabricId: null,
    placeholders: {},
    timeoutMs: 60_000,
    ...interactiveIntent,
  },
  nodeId: "node-1",
  operatorTerminalId: terminalId,
  Instance: { startedBy: "USER" },
  ...overrides,
});

describe("runtime step services", () => {
  const engine = { reopenStep: vi.fn(), cancelStep: vi.fn() };
  const relay = { operatorStepTerminal: vi.fn() };
  let tickets: InstanceType<typeof TerminalTicketStore>;
  let services: ReturnType<typeof createRuntimeStepServices>;
  const input = { userId: "user-1", sessionId: "sess-1", stepId: "step-1" };

  beforeEach(() => {
    vi.clearAllMocks();
    tickets = new TerminalTicketStore();
    services = createRuntimeStepServices({ engine, relay, tickets });
    relay.operatorStepTerminal.mockReturnValue({ nodeId: "node-1", terminalId, state: "awaiting" });
  });

  it("mints a ticket bound to the step's live terminal, for this session only", async () => {
    db.instanceStep.findFirst.mockResolvedValue(row());
    const answer = await services.attach(input);
    expect(db.instanceStep.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "step-1", Instance: { userId: "user-1" } } }),
    );
    expect(answer).toMatchObject({ ok: true, terminalId });
    if (!answer.ok) return;
    expect(
      tickets.redeem({ ticket: answer.ticket, userId: "user-1", sessionId: "sess-1" }),
    ).toEqual({ kind: "attach", nodeId: "node-1", terminalId, stepId: "step-1" });
  });

  it("refuses what has no live terminal of this dispatch", async () => {
    db.instanceStep.findFirst.mockResolvedValueOnce(null);
    expect(await services.attach(input)).toEqual({ ok: false, code: "not_found" });
    db.instanceStep.findFirst.mockResolvedValueOnce(row({ intent: { interactive: false } }));
    expect(await services.attach(input)).toEqual({ ok: false, code: "not_interactive" });
    db.instanceStep.findFirst.mockResolvedValueOnce(row({ operatorTerminalId: null }));
    expect(await services.attach(input)).toEqual({ ok: false, code: "terminal_closed" });
    db.instanceStep.findFirst.mockResolvedValueOnce(row({ state: "SUCCEEDED" }));
    expect(await services.attach(input)).toEqual({ ok: false, code: "not_waiting" });
    // The relay holds another (older) terminal of the step, or none.
    db.instanceStep.findFirst.mockResolvedValueOnce(row());
    relay.operatorStepTerminal.mockReturnValueOnce({
      nodeId: "node-1",
      terminalId: Buffer.alloc(16, 9).toString("base64url"),
      state: "awaiting",
    });
    expect(await services.attach(input)).toEqual({ ok: false, code: "terminal_unavailable" });
    db.instanceStep.findFirst.mockResolvedValueOnce(row());
    relay.operatorStepTerminal.mockReturnValueOnce(null);
    expect(await services.attach(input)).toEqual({ ok: false, code: "terminal_unavailable" });
    expect(tickets.size).toBe(0);
  });

  it("never lets a person answer an agent's step on a node lowered to Relay only", async () => {
    db.instanceStep.findFirst.mockResolvedValue(row({ Instance: { startedBy: "AGENT" } }));
    db.node.findFirst.mockResolvedValueOnce({ trust: "RELAY", trustLowerRequestedAt: null });
    expect(await services.attach(input)).toEqual({ ok: false, code: "trust_relay" });
    db.node.findFirst.mockResolvedValueOnce({ trust: "FULL", trustLowerRequestedAt: new Date() });
    expect(await services.attach(input)).toEqual({ ok: false, code: "trust_relay" });
    expect(db.node.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "node-1", userId: "user-1" } }),
    );
    db.node.findFirst.mockResolvedValueOnce({ trust: "FULL", trustLowerRequestedAt: null });
    expect(await services.attach(input)).toMatchObject({ ok: true });
  });

  it("maps the engine's refusals for reopen and cancel", async () => {
    engine.reopenStep.mockRejectedValueOnce(new OperatorStepError("not_waiting"));
    expect(await services.reopen({ userId: "user-1", stepId: "step-1" })).toEqual({
      ok: false,
      code: "not_waiting",
    });
    engine.cancelStep.mockResolvedValueOnce(undefined);
    expect(await services.cancel({ userId: "user-1", stepId: "step-1" })).toEqual({ ok: true });
    engine.cancelStep.mockRejectedValueOnce(new Error("database"));
    await expect(services.cancel({ userId: "user-1", stepId: "step-1" })).rejects.toThrow(
      "database",
    );
  });
});
