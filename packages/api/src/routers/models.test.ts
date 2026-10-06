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
import type { Context, ContextServices, ModelTestServiceOutput } from "../context";
import type { CallerAuth } from "../contracts/auth-context";
import { modelsRouter } from "./models";

const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;

const session = {
  user: { id: "me", email: "me@example.test", name: "Me", role: "user", twoFactorEnabled: false },
  session: { id: "sess", userId: "me", expiresAt: new Date(Date.now() + 60_000) },
} as unknown as Session;

const PERSON: CallerAuth = {
  kind: "cookie_session",
  userId: "me",
  sessionId: "sess",
  csrfVerified: true,
};
const NO_CSRF: CallerAuth = { ...PERSON, csrfVerified: false };
const FULL_AGENT: CallerAuth = {
  kind: "agent_token",
  userId: "me",
  agentTokenId: "tok1",
  level: "FULL",
};
const READ_AGENT: CallerAuth = { ...FULL_AGENT, level: "READ" };

const OUTPUT: ModelTestServiceOutput = {
  result: {
    outcome: "ok",
    servedBy: { instanceId: "inst1", nodeId: "node1", versionId: "ver1", providerModelId: null },
    ttftMs: 12,
    latencyMs: 40,
    queueWaitMs: 0,
    promptTokens: 5,
    completionTokens: 1,
    errorClass: null,
    rejection: null,
    excerpt: "pong",
  },
};

function client(auth: CallerAuth, services?: ContextServices) {
  return createRouterClient(modelsRouter, {
    context: { session, auth, ...(services ? { services } : {}) } satisfies Context,
  });
}

function hook() {
  return vi.fn(async () => OUTPUT);
}

const pool = (overrides: Partial<{ userId: string; modelType: string }> = {}) => ({
  id: "pool1",
  userId: overrides.userId ?? "me",
  modelType: overrides.modelType ?? "LLM",
});

beforeEach(() => {
  mockReset(db);
});

describe("models.test", () => {
  it("answers SERVICE_UNAVAILABLE without the server hook, before reading anything", async () => {
    await expect(client(PERSON).test({ target: { pool: "me/chat" } })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(db.pool.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a browser call without the CSRF header and a Read-only token", async () => {
    const modelTest = hook();
    await expect(
      client(NO_CSRF, { modelTest }).test({ target: { pool: "me/chat" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      client(READ_AGENT, { modelTest }).test({ target: { pool: "me/chat" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(modelTest).not.toHaveBeenCalled();
  });

  it("tests a pool the caller can use and hands the hook the resolved target", async () => {
    db.pool.findFirst.mockResolvedValue(pool() as never);
    const modelTest = hook();
    const output = await client(FULL_AGENT, { modelTest }).test({
      target: { pool: "me/chat" },
      prompt: "hi",
    });
    expect(output).toEqual(OUTPUT);
    const where = db.pool.findFirst.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      slug: "chat",
      User: { slug: "me" },
      OR: [{ userId: "me" }, { Shares: { some: { granteeUserId: "me", canUse: true } } }],
    });
    expect(modelTest).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "me",
        auth: FULL_AGENT,
        kind: "chat",
        prompt: "hi",
        target: { kind: "pool", poolId: "pool1", callableId: "me/chat" },
      }),
    );
  });

  it("does not reveal a pool the caller cannot use", async () => {
    db.pool.findFirst.mockResolvedValue(null);
    const modelTest = hook();
    await expect(
      client(PERSON, { modelTest }).test({ target: { pool: "other/chat" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(modelTest).not.toHaveBeenCalled();
  });

  it("refuses any :external target, single test or bench, before reading anything", async () => {
    const modelTest = hook();
    for (const bench of [undefined, { repeat: 3, concurrency: 1 }]) {
      await expect(
        client(PERSON, { modelTest }).test({
          target: { pool: "me/chat:external" },
          ...(bench ? { bench } : {}),
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: ":external cannot be tested; test me/chat instead.",
      });
    }
    expect(db.pool.findFirst).not.toHaveBeenCalled();
    expect(modelTest).not.toHaveBeenCalled();
  });

  it("lets a can-use grantee send a single test but not bench the shared pool", async () => {
    db.pool.findFirst.mockResolvedValue(pool({ userId: "owner" }) as never);
    const modelTest = hook();
    await client(FULL_AGENT, { modelTest }).test({ target: { pool: "owner/chat" } });
    expect(modelTest).toHaveBeenCalledTimes(1);
    await expect(
      client(FULL_AGENT, { modelTest }).test({
        target: { pool: "owner/chat" },
        bench: { repeat: 2, concurrency: 1 },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "own_hardware_only" } });
    expect(modelTest).toHaveBeenCalledTimes(1);
  });

  it("caps a bench at 1,000,000 prompt tokens in all", async () => {
    db.pool.findFirst.mockResolvedValue(pool() as never);
    const modelTest = hook();
    await client(PERSON, { modelTest }).test({
      target: { pool: "me/chat" },
      bench: { repeat: 5, concurrency: 1, promptTokens: 200_000 },
    });
    expect(modelTest).toHaveBeenCalledTimes(1);
    await expect(
      client(PERSON, { modelTest }).test({
        target: { pool: "me/chat" },
        bench: { repeat: 6, concurrency: 1, promptTokens: 200_000 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(modelTest).toHaveBeenCalledTimes(1);
  });

  it("refuses a kind the target's model type does not serve", async () => {
    db.pool.findFirst.mockResolvedValue(pool({ modelType: "EMBEDDINGS" }) as never);
    const modelTest = hook();
    await expect(
      client(PERSON, { modelTest }).test({ target: { pool: "me/chat" }, kind: "chat" }),
    ).rejects.toMatchObject({ data: { reason: "model_type_mismatch" } });
    expect(modelTest).not.toHaveBeenCalled();
  });

  it("tests the caller's runtime on its first served model, pinned to an owned instance", async () => {
    db.runtime.findFirst.mockResolvedValue({ id: "rt1" } as never);
    db.runtimeModel.findFirst.mockResolvedValue({
      id: "rm1",
      upstreamModelId: "whisper",
      type: "TRANSCRIPTION",
    } as never);
    db.runtimeInstance.findFirst.mockResolvedValue({ id: "inst1" } as never);
    const modelTest = hook();
    await client(PERSON, { modelTest }).test({
      target: { runtimeId: "rt1", instanceId: "inst1" },
      bench: { repeat: 2, concurrency: 2 },
    });
    expect(db.runtime.findFirst.mock.calls[0]?.[0]?.where).toEqual({ id: "rt1", userId: "me" });
    expect(db.runtimeInstance.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "inst1",
      runtimeId: "rt1",
      userId: "me",
    });
    expect(modelTest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "transcription",
        bench: { repeat: 2, concurrency: 2 },
        target: {
          kind: "runtime",
          runtimeId: "rt1",
          runtimeModelId: "rm1",
          model: "whisper",
          instanceId: "inst1",
        },
      }),
    );
  });

  it("does not test someone else's runtime or an instance of another runtime", async () => {
    const modelTest = hook();
    db.runtime.findFirst.mockResolvedValue(null);
    await expect(
      client(FULL_AGENT, { modelTest }).test({ target: { runtimeId: "theirs" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    db.runtime.findFirst.mockResolvedValue({ id: "rt1" } as never);
    db.runtimeModel.findFirst.mockResolvedValue({
      id: "rm1",
      upstreamModelId: "llama",
      type: "LLM",
    } as never);
    db.runtimeInstance.findFirst.mockResolvedValue(null);
    await expect(
      client(FULL_AGENT, { modelTest }).test({
        target: { runtimeId: "rt1", instanceId: "elsewhere" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(modelTest).not.toHaveBeenCalled();
  });
});
