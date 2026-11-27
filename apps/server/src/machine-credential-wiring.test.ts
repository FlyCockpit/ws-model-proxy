import { notifyUserBanned } from "@ws-model-proxy/auth/user-ban-listeners";
import { afterEach, describe, expect, it, vi } from "vitest";

const wiring = vi.hoisted(() => ({ reconciler: undefined as unknown }));
vi.mock("./relay/node-commands.js", () => ({
  nodeCommandTracker: {
    setCommandReconciler: vi.fn((reconciler: unknown) => {
      wiring.reconciler = reconciler;
    }),
  },
  cancelNodeCommandsForCredentials: vi.fn(async () => 0),
  cancelNodeCommandsForUser: vi.fn(),
  sweepExpiredNodeCommands: vi.fn(async () => 0),
}));
vi.mock("./relay/node-file-ops.js", () => ({
  nodeFileServices: {},
  runFileOp: vi.fn(),
  cancelFileOpsForToken: vi.fn(),
  cancelFileOpsForUser: vi.fn(),
  sweepExpiredFileOps: vi.fn(),
  auditRefusedFileInput: vi.fn(),
}));

// Same process-dependency mocks as app-order.test.ts: importing app.ts must
// not touch Postgres, SMTP or the real Better Auth instance.
const envMock = vi.hoisted(() => ({
  NODE_ENV: "test",
  WMP_MCP_ENABLED: true,
  BETTER_AUTH_URL: "https://proxy.example.com",
  BETTER_AUTH_SECRET: "contract-test-secret-at-least-thirty-two-characters",
  CORS_ORIGIN: "https://app.example.com",
  WMP_RATE_LIMIT_SCALE: 1,
  TRUST_PROXY_HOPS: 0,
  MEDIA_MAX_UPLOAD_BYTES: 5 * 1024 * 1024,
  MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES: 1024 * 1024,
  WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: false,
  SSR_CACHE_TTL_SECONDS: 0,
}));
vi.mock("@ws-model-proxy/env/server", () => ({ env: envMock }));

// Mock @ws-model-proxy/db so importing the full appRouter graph never
// touches Postgres (same pattern as packages/api/src/routers/index.test.ts).
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// @ws-model-proxy/auth builds the Better-Auth instance at import time — stub
// it; these tests never call createApp.
vi.mock("@ws-model-proxy/auth", () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

// @ws-model-proxy/mailer would open SMTP — stub the surface the graph uses.
// Mocked by SOURCE PATH: the specifier is not a direct dependency of
// apps/server (pnpm strict node_modules), so a specifier-keyed mock never
// matches the id that packages/api resolves.
vi.mock("../../../packages/mailer/src/index", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const mockGetConnInfo = vi.hoisted(() => vi.fn(() => ({ remote: { address: "10.0.0.1" } })));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: mockGetConnInfo }));

import { notifyMachineCredentialsRevoked } from "@ws-model-proxy/auth/machine-credential-listeners";
import { passwordWriteLockHeld } from "../../../packages/auth/src/password-write-lock";
import { createApp } from "./app";
import { relaySessionManager } from "./relay/session-manager";

const { default: prisma } = await import("@ws-model-proxy/db");
const db = vi.mocked(prisma, true);

describe("machine recovery and password mount wiring", () => {
  afterEach(() => vi.restoreAllMocks());
  it("actual recovery registration closes the user's relay sockets and awaits completion; ban keeps them", async () => {
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.spyOn(relaySessionManager, "closeSessionsForUser").mockReturnValueOnce(done);
    let completed = false;
    const notifying = notifyMachineCredentialsRevoked("recovering").then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith("recovering"));
    expect(completed).toBe(false);
    release();
    await notifying;
    expect(completed).toBe(true);
    close.mockClear();
    await notifyUserBanned("banned");
    expect(close).not.toHaveBeenCalled();
  });
  it("the actual auth mount runs exactly once inside the password lock", async () => {
    db.verification.findFirst.mockResolvedValue({ value: "target" } as never);
    db.$queryRaw.mockResolvedValue([{ locked: true }]);
    db.$transaction.mockImplementation((async (work: (tx: typeof db) => unknown) =>
      work(db)) as never);
    const handler = vi.fn(async () => {
      expect(passwordWriteLockHeld()).toBe(true);
      return Response.json({ status: true });
    });
    const { app } = await createApp({ auth: { handler } });
    const response = await app.request("https://proxy.example.com/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://proxy.example.com" },
      body: JSON.stringify({ token: "unit-reset", newPassword: "new-unit-password" }),
    });
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
