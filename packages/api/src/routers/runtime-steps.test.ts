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
import type { Context, RuntimeStepServices } from "../context";
import type { CallerAuth } from "../contracts/auth-context";
import { CSRF_REQUIRED_PROCEDURES } from "../contracts/index";
import { runtimeSteps } from "./runtime-steps";

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

function services() {
  return {
    attach: vi.fn<RuntimeStepServices["attach"]>(async () => ({
      ok: true as const,
      ticket: "t".repeat(43),
      terminalId: "AAAAAAAAAAAAAAAAAAAAAA",
      expiresAt: new Date("2026-10-06T13:00:00Z"),
    })),
    reopen: vi.fn<RuntimeStepServices["reopen"]>(async () => ({ ok: true as const })),
    cancel: vi.fn<RuntimeStepServices["cancel"]>(async () => ({ ok: true as const })),
  };
}

function client(auth: CallerAuth, steps?: RuntimeStepServices) {
  return createRouterClient(
    { steps: runtimeSteps },
    {
      context: {
        session,
        auth,
        ...(steps ? { services: { runtimeSteps: steps } } : {}),
      } satisfies Context,
    },
  );
}

const stepRow = {
  id: "step1",
  createdAt: new Date("2026-10-06T12:00:00Z"),
  updatedAt: new Date("2026-10-06T12:00:00Z"),
  instanceId: "inst1",
  nodeId: "node1",
  rank: 0,
  phase: "START" as const,
  sequence: 120,
  generation: 1,
  state: "AWAITING_OPERATOR" as const,
  intent: {
    operationId: "op1",
    runtimeId: "rt1",
    launchVersionId: "ver1",
    launchHash: "b".repeat(64),
    rank: 0,
    nnodes: 1,
    handle: "i-abcdefabcdef",
    unitName: "wsmp-rt-i-abcdefabcdef-0.service",
    port: 30001,
    distPort: null,
    fabricId: null,
    placeholders: { port: 30001 },
    timeoutMs: 60_000,
    interactive: true,
  },
  intentHash: "a".repeat(64),
  attempts: 1,
  ownerEpoch: "e:1",
  leaseExpiresAt: null,
  deadline: null,
  notBefore: null,
  errorCode: null,
  operatorTerminalId: "AAAAAAAAAAAAAAAAAAAAAA",
  operatorSince: new Date("2026-10-06T12:00:00Z"),
  operatorAcceptedAt: null,
  operatorLastExit: null,
  operatorHold: null,
  Instance: {
    launchVersionId: "ver1",
    Fabric: null,
    Ranks: [{ rank: 0, nodeId: "node1" }],
    LaunchVersion: {
      editor: "AGENT" as const,
      launchHash: "b".repeat(64),
      spec: {
        api: "openai",
        engine: "vllm",
        modelType: "llm",
        models: [{ id: "m" }],
        launch: {
          management: "service",
          groupSize: 1,
          resources: [{ kind: "none" }],
          labels: [],
          commands: [
            {
              start: "sudo systemctl start llm@{{port}}",
              stop: "sudo systemctl stop llm",
              status: "systemctl is-active llm",
              interactive: { start: true },
            },
          ],
          readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
          health: { intervalMs: 15_000, failureThreshold: 2, successThreshold: 1 },
        },
      },
    },
  },
};

describe("runtimes.steps", () => {
  beforeEach(() => {
    mockReset(db);
    db.instanceStep.findFirst.mockResolvedValue(stepRow as never);
  });

  it("are human procedures that need the CSRF header", () => {
    for (const name of ["attach", "reopen", "cancel"])
      expect(CSRF_REQUIRED_PROCEDURES.has(`runtimes.steps.${name}`)).toBe(true);
  });

  it("refuse agents, even with a Full token", async () => {
    const steps = services();
    const agent = client(FULL_AGENT, steps);
    await expect(agent.steps.attach({ stepId: "step1", cols: 80, rows: 24 })).rejects.toMatchObject(
      {
        code: "FORBIDDEN",
      },
    );
    await expect(agent.steps.reopen({ stepId: "step1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(agent.steps.cancel({ stepId: "step1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(steps.attach).not.toHaveBeenCalled();
    expect(steps.reopen).not.toHaveBeenCalled();
    expect(steps.cancel).not.toHaveBeenCalled();
  });

  it("attach returns a ticket bound to the person's session and the step view", async () => {
    const steps = services();
    const answer = await client(PERSON, steps).steps.attach({
      stepId: "step1",
      cols: 80,
      rows: 24,
    });
    expect(steps.attach).toHaveBeenCalledWith({
      userId: "owner",
      sessionId: "sess",
      impersonatedBy: null,
      stepId: "step1",
    });
    expect(answer.ticket).toBe("t".repeat(43));
    expect(answer.terminalId).toBe("AAAAAAAAAAAAAAAAAAAAAA");
    expect(answer.step).toMatchObject({
      id: "step1",
      state: "AWAITING_OPERATOR",
      interactive: true,
      command: "sudo systemctl start llm@{{port}}",
      commandAuthor: "agent",
      rendered: { state: "ready", text: "sudo systemctl start llm@30001", nodeFills: [] },
      headAddr: null,
      terminalOpen: true,
    });
    // The view never carries the terminal id.
    expect(JSON.stringify(answer.step)).not.toContain("AAAAAAAAAAAAAAAAAAAAAA");
    // The view is the caller's own step.
    expect(db.instanceStep.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "step1", Instance: { userId: "owner" } } }),
    );
  });

  it("maps refusals to errors without changing anything", async () => {
    const steps = services();
    steps.attach.mockResolvedValueOnce({ ok: false, code: "terminal_closed" });
    steps.reopen.mockResolvedValueOnce({ ok: false, code: "not_found" });
    steps.cancel.mockResolvedValueOnce({ ok: false, code: "running" });
    const person = client(PERSON, steps);
    await expect(
      person.steps.attach({ stepId: "step1", cols: 80, rows: 24 }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { code: "terminal_closed" },
    });
    await expect(person.steps.reopen({ stepId: "step1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(person.steps.cancel({ stepId: "step1" })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { code: "running" },
    });
  });

  it("reopen and cancel answer with the step as it is now", async () => {
    const steps = services();
    const person = client(PERSON, steps);
    db.instanceStep.findFirst.mockResolvedValueOnce({
      ...stepRow,
      state: "PENDING",
      operatorTerminalId: null,
      operatorSince: null,
    } as never);
    expect(await person.steps.reopen({ stepId: "step1" })).toMatchObject({
      state: "PENDING",
      terminalOpen: false,
    });
    expect(steps.reopen).toHaveBeenCalledWith({ userId: "owner", stepId: "step1" });
    db.instanceStep.findFirst.mockResolvedValueOnce({
      ...stepRow,
      state: "FAILED",
      errorCode: "operator_cancelled",
      operatorTerminalId: null,
    } as never);
    expect(await person.steps.cancel({ stepId: "step1" })).toMatchObject({
      state: "FAILED",
      errorCode: "operator_cancelled",
    });
    expect(steps.cancel).toHaveBeenCalledWith({ userId: "owner", stepId: "step1" });
  });

  it("answers SERVICE_UNAVAILABLE without the server's services", async () => {
    await expect(client(PERSON).steps.cancel({ stepId: "step1" })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});
