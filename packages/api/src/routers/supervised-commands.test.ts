import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import type {
  PendingSupervisedRequest,
  SupervisedCommandServices,
} from "../lib/supervised-command-types";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret" },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { supervisedCommandsRouter } = await import("./supervised-commands");

const COMMAND_ID = Buffer.alloc(16, 7).toString("base64url");

function session(userId: string): Session {
  return {
    user: {
      id: userId,
      email: "owner@example.com",
      name: "Owner",
      emailVerified: true,
      role: "user",
      twoFactorEnabled: true,
      image: null,
      banned: false,
      banReason: null,
      banExpires: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    session: {
      id: "session-1",
      userId,
      token: "session-token",
      expiresAt: new Date(Date.now() + 60_000),
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  } as Session;
}

function services(): SupervisedCommandServices & {
  listPending: ReturnType<typeof vi.fn>;
  submitOutput: ReturnType<typeof vi.fn>;
} {
  return { listPending: vi.fn(() => []), submitOutput: vi.fn() };
}

function client(context: Context) {
  return createRouterClient(supervisedCommandsRouter, { context });
}

const pending: PendingSupervisedRequest = {
  commandId: COMMAND_ID,
  terminalId: "term",
  cliDeviceId: "cli",
  status: "awaiting_user",
  requester: "Agent",
  reason: null,
  command: "make",
  cwd: null,
  shareOutput: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:15:00.000Z",
};

describe("supervisedCommandsRouter", () => {
  it("requires a session for both procedures", async () => {
    const svc = services();
    const anonymous = client({ session: null, services: { supervisedCommands: svc } });
    await expect(anonymous.pending()).rejects.toSatisfy(
      (error: ORPCError) => error.code === "UNAUTHORIZED",
    );
    await expect(
      anonymous.submitOutput({ commandId: COMMAND_ID, output: null, edited: false }),
    ).rejects.toSatisfy((error: ORPCError) => error.code === "UNAUTHORIZED");
    expect(svc.listPending).not.toHaveBeenCalled();
    expect(svc.submitOutput).not.toHaveBeenCalled();
  });

  it("lists pending requests for the session user only", async () => {
    const svc = services();
    svc.listPending.mockReturnValue([pending]);
    await expect(
      client({ session: session("owner"), services: { supervisedCommands: svc } }).pending(),
    ).resolves.toEqual({ requests: [pending] });
    expect(svc.listPending).toHaveBeenCalledWith("owner");
    await expect(
      client({ session: session("owner"), services: undefined }).pending(),
    ).resolves.toEqual({ requests: [] });
  });

  it("submits for the session user and maps outcomes", async () => {
    const svc = services();
    const owner = client({ session: session("owner"), services: { supervisedCommands: svc } });
    svc.submitOutput.mockReturnValueOnce({ ok: true, outputMode: "reviewed" });
    await expect(
      owner.submitOutput({ commandId: COMMAND_ID, output: "text", edited: true }),
    ).resolves.toEqual({ status: "exited", outputMode: "reviewed" });
    expect(svc.submitOutput).toHaveBeenLastCalledWith({
      userId: "owner",
      commandId: COMMAND_ID,
      output: "text",
      edited: true,
    });

    // A redaction is never reported as edited.
    svc.submitOutput.mockReturnValueOnce({ ok: true, outputMode: "redacted" });
    await owner.submitOutput({ commandId: COMMAND_ID, output: null, edited: true });
    expect(svc.submitOutput).toHaveBeenLastCalledWith(
      expect.objectContaining({ output: null, edited: false }),
    );

    svc.submitOutput.mockReturnValueOnce({ ok: false, error: "conflict" });
    await expect(
      owner.submitOutput({ commandId: COMMAND_ID, output: null, edited: false }),
    ).rejects.toSatisfy((error: ORPCError) => error.code === "CONFLICT");
    svc.submitOutput.mockReturnValueOnce({ ok: false, error: "not_found" });
    await expect(
      owner.submitOutput({ commandId: COMMAND_ID, output: null, edited: false }),
    ).rejects.toSatisfy((error: ORPCError) => error.code === "NOT_FOUND");
  });

  it("validates the command id and bounds the output", async () => {
    const svc = services();
    const owner = client({ session: session("owner"), services: { supervisedCommands: svc } });
    await expect(
      owner.submitOutput({ commandId: "not-an-id", output: null, edited: false }),
    ).rejects.toSatisfy((error: ORPCError) => error.code === "BAD_REQUEST");
    await expect(
      owner.submitOutput({ commandId: COMMAND_ID, output: "x".repeat(200_001), edited: true }),
    ).rejects.toSatisfy((error: ORPCError) => error.code === "BAD_REQUEST");
    expect(svc.submitOutput).not.toHaveBeenCalled();
  });

  it("is NOT_FOUND when the server has no supervised-command service", async () => {
    await expect(
      client({ session: session("owner"), services: undefined }).submitOutput({
        commandId: COMMAND_ID,
        output: null,
        edited: false,
      }),
    ).rejects.toSatisfy((error: ORPCError) => error.code === "NOT_FOUND");
  });
});
