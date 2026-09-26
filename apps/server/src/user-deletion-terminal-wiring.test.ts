import {
  notifyUserDeleted,
  notifyUserDeletionMarked,
} from "@ws-model-proxy/auth/user-deletion-listeners";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./relay/cli-commands.js", () => ({
  startCliCommand: vi.fn(),
  waitCliCommand: vi.fn(),
  snapshotCliCommand: vi.fn(),
  cancelCommandsForToken: vi.fn(),
  startSupervisedCommand: vi.fn(),
  snapshotSupervisedCommand: vi.fn(),
  listPendingSupervised: vi.fn(() => []),
  submitSupervisedOutput: vi.fn(),
}));

// Same process-dependency mocks as app-order.test.ts: importing app.ts must
// not touch Postgres, SMTP or the real Better Auth instance.
const envMock = vi.hoisted(() => ({
  NODE_ENV: "test",
  WMP_MCP_ENABLED: true,
  BETTER_AUTH_URL: "https://proxy.example.com",
  BETTER_AUTH_SECRET: "contract-test-secret-at-least-thirty-two-characters",
  CORS_ORIGIN: "https://app.example.com",
  RATE_LIMIT_AUTH_POINTS: 500,
  RATE_LIMIT_AUTH_DURATION: 60,
  RATE_LIMIT_AUTH_BLOCK_DURATION: 0,
  RATE_LIMIT_SIGNIN_FAILURE_POINTS: 10,
  RATE_LIMIT_SIGNIN_FAILURE_DURATION: 900,
  RATE_LIMIT_SIGNIN_FAILURE_BLOCK_DURATION: 600,
  RATE_LIMIT_SIGNUP_POINTS: 3,
  RATE_LIMIT_SIGNUP_DURATION: 3600,
  RATE_LIMIT_SIGNUP_BLOCK_DURATION: 3600,
  RATE_LIMIT_RPC_POINTS: 1000,
  RATE_LIMIT_RPC_DURATION: 60,
  RATE_LIMIT_EMAIL_RECIPIENT_POINTS: 3,
  RATE_LIMIT_EMAIL_RECIPIENT_DURATION: 3600,
  RATE_LIMIT_EMAIL_RECIPIENT_BLOCK_DURATION: 0,
  RATE_LIMIT_SIGNUP_RECIPIENT_POINTS: 6,
  RATE_LIMIT_MCP_POINTS: 2,
  RATE_LIMIT_MCP_DURATION: 60,
  RATE_LIMIT_MCP_CONSENT_POINTS: 2,
  RATE_LIMIT_MCP_CONSENT_DURATION: 60,
  RATE_LIMIT_MCP_REGISTRATION_POINTS: 2,
  RATE_LIMIT_MCP_REGISTRATION_DURATION: 60,
  TRUST_PROXY_HOPS: undefined,
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

/**
 * WIRE-PIN-2 / RELAY-CLOSE-AWAIT: the deletion listeners app.ts registers at
 * import, fired through the same notify functions the deletion paths call
 * (`deleteUserDurably`'s `onMarked`, the post-commit delete notification).
 * Nothing here calls the hub's revoke method directly.
 */
await import("./app");
const { default: prisma } = await import("@ws-model-proxy/db");
const { admitBrowserConnection, terminalBrowserHub } = await import(
  "./relay/terminal-websocket.js"
);
const { relaySessionManager } = await import("./relay/session-manager.js");

const db = prisma as unknown as { session: { findUnique: MockInstance } };

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sends: Array<string | ArrayBuffer> = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  send(data: string | ArrayBuffer | Uint8Array) {
    this.sends.push(typeof data === "string" ? data : "binary");
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closes.push({ code, reason });
  }
}

function admissionRow(userId: string) {
  return {
    userId,
    expiresAt: new Date(Date.now() + 60_000),
    user: { deletionRequestedAt: null, banned: null, banExpires: null },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("app deletion listeners reach browser terminal sockets", () => {
  let closeRelay: MockInstance;

  beforeEach(() => {
    db.session.findUnique.mockReset();
    closeRelay = vi.spyOn(relaySessionManager, "closeSessionsForUser");
  });

  afterEach(() => {
    terminalBrowserHub.closeAll();
    vi.restoreAllMocks();
  });

  it("the mark listener closes admitted and pending sockets and awaits the relay close", async () => {
    const admitted = new FakeSocket();
    db.session.findUnique.mockResolvedValueOnce(admissionRow("user-id"));
    await admitBrowserConnection({ socket: admitted, userId: "user-id", sessionId: "s1" });
    expect(admitted.closes).toEqual([]);

    const pending = new FakeSocket();
    const read = deferred<unknown>();
    db.session.findUnique.mockReturnValueOnce(read.promise);
    const admission = admitBrowserConnection({
      socket: pending,
      userId: "user-id",
      sessionId: "s2",
    });

    const relayClosed = deferred<void>();
    closeRelay.mockReturnValueOnce(relayClosed.promise);
    let notified = false;
    const notifying = notifyUserDeletionMarked("user-id").then(() => {
      notified = true;
    });
    await vi.waitFor(() => expect(closeRelay).toHaveBeenCalledWith("user-id"));
    expect(admitted.closes).toEqual([{ code: 4401, reason: "user_deletion_pending" }]);
    expect(pending.closes).toEqual([{ code: 4401, reason: "user_deletion_pending" }]);
    // The listener returns only after the relay close finished.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notified).toBe(false);
    relayClosed.resolve();
    await notifying;
    expect(notified).toBe(true);

    // The pending socket's stale read (no marker) does not admit it.
    read.resolve(admissionRow("user-id"));
    await admission;
    expect(pending.closes).toHaveLength(1);
    expect(pending.sends).toHaveLength(0);
  });

  it("contains a failing relay close (logged, not an unhandled rejection)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    closeRelay.mockRejectedValueOnce(new TypeError("boom"));
    await expect(notifyUserDeletionMarked("user-id")).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith("[auth] user deletion marked listener failed", "TypeError");
    closeRelay.mockImplementationOnce(() => {
      throw new RangeError("sync");
    });
    await expect(notifyUserDeleted("user-id")).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith("[auth] user deletion listener failed", "RangeError");
  });

  it("the delete listener closes sockets an admin impersonates through (IMP-MARK)", async () => {
    closeRelay.mockResolvedValue(undefined);
    const impersonation = new FakeSocket();
    db.session.findUnique.mockResolvedValueOnce(admissionRow("target-id"));
    await admitBrowserConnection({
      socket: impersonation,
      userId: "target-id",
      sessionId: "imp",
      impersonatedBy: "admin-id",
    });
    const targetOwn = new FakeSocket();
    db.session.findUnique.mockResolvedValueOnce(admissionRow("target-id"));
    await admitBrowserConnection({ socket: targetOwn, userId: "target-id", sessionId: "own" });

    await notifyUserDeleted("admin-id");
    expect(impersonation.closes).toEqual([{ code: 4401, reason: "user_deletion_pending" }]);
    expect(targetOwn.closes).toEqual([]);
  });
});
