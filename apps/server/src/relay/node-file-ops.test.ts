import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackedFileOp } from "./session-manager.js";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const relay = vi.hoisted(() => ({
  getLiveNodeState: vi.fn(),
  dispatchFileOp: vi.fn(),
  dispatchFileCancel: vi.fn(),
  forgetFileOp: vi.fn(),
}));
vi.mock("./session-manager.js", () => ({ relaySessionManager: relay }));

const audit = vi.hoisted(() => ({ recordNodeAuditEvent: vi.fn() }));
vi.mock("./node-audit.js", () => audit);

const { default: prisma } = await import("@ws-model-proxy/db");
const ops = await import("./node-file-ops.js");
const { resetNodeAgentAccessForTests } = await import("./node-access.js");

const db = prisma as unknown as {
  node: { findUnique: MockInstance };
  agentToken: { findFirst: MockInstance };
  mcpGrant: { findFirst: MockInstance };
  user: { findUnique: MockInstance };
};

const ROOT = "/home/me/deploy";
const ETAG = `h:${"A".repeat(22)}`;
const SECRET_TEXT = "super-secret-file-content";

function liveState(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: "node-1",
    userId: "user-1",
    trust: "full",
    features: { files: { roots: [ROOT], asRoot: false } },
    ...overrides,
  };
}

const base = {
  userId: "user-1",
  tokenId: "tok-1",
  expiresAt: null,
  nodeId: "node-1",
} as const;

/** The op the relay was handed last, and the frame and body it carried. */
function sent(): { op: TrackedFileOp; frame: Record<string, unknown>; body?: Uint8Array } {
  const call = relay.dispatchFileOp.mock.calls.at(-1);
  if (!call) throw new Error("nothing was dispatched");
  const [op, frame, body] = call as [TrackedFileOp, Record<string, unknown>, Uint8Array?];
  return { op, frame, ...(body ? { body } : {}) };
}

/** Let the admission reads resolve and the op be dispatched. */
async function dispatched(): Promise<ReturnType<typeof sent>> {
  await vi.waitFor(() => expect(relay.dispatchFileOp).toHaveBeenCalled());
  return sent();
}

function lastAudit(): Record<string, unknown> {
  const call = audit.recordNodeAuditEvent.mock.calls.at(-1);
  if (!call) throw new Error("nothing was audited");
  return call[0] as Record<string, unknown>;
}

describe("node file ops (server side)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ops.resetFileOpsForTests();
    resetNodeAgentAccessForTests();
    db.node.findUnique.mockResolvedValue({
      id: "node-1",
      userId: "user-1",
      slug: "box",
      trust: "FULL",
      trustLowerRequestedAt: null,
      rejectedProtocolVersion: null,
    });
    db.agentToken.findFirst.mockResolvedValue({ name: "agent", expiresAt: null });
    db.mcpGrant.findFirst.mockResolvedValue({ clientId: "client" });
    db.user.findUnique.mockResolvedValue({
      banned: false,
      banExpires: null,
      deletionRequestedAt: null,
    });
    relay.getLiveNodeState.mockReturnValue(liveState());
    relay.dispatchFileOp.mockReturnValue(true);
  });

  afterEach(() => {
    ops.resetFileOpsForTests();
  });

  it("reads a file and audits path, size and outcome, never content", async () => {
    const pending = ops.runFileOp({
      ...base,
      op: "read",
      args: { path: `${ROOT}/app.env` },
    });
    const { op, frame } = await dispatched();
    expect(op.userId).toBe("user-1");
    expect(frame).toMatchObject({ type: "file.op", op: "read", args: { path: `${ROOT}/app.env` } });
    op.markResult({
      type: "file.result",
      opId: op.opId,
      op: "read",
      result: {
        etag: ETAG,
        size: 42,
        mtime: "2026-01-01T00:00:00Z",
        mode: "644",
        totalLines: 1,
        startLine: 1,
        endLine: 1,
        eol: "lf",
        text: SECRET_TEXT,
        redactions: 0,
        more: null,
        secretFile: false,
      },
    });
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: true, op: "read", result: { text: SECRET_TEXT } });
    expect(audit.recordNodeAuditEvent).toHaveBeenCalledTimes(1);
    expect(lastAudit()).toMatchObject({
      userId: "user-1",
      nodeId: "node-1",
      actor: "AGENT",
      agentTokenId: "tok-1",
      mcpGrantId: null,
      kind: "file_read",
      subject: `${ROOT}/app.env`,
      etagAfter: ETAG,
      bytes: 42,
      outcome: "completed",
    });
    expect(JSON.stringify(lastAudit())).not.toContain(SECRET_TEXT);
  });

  it("sends a write's content as the body and audits its byte count only", async () => {
    const body = new TextEncoder().encode(SECRET_TEXT);
    const pending = ops.runFileOp({
      ...base,
      op: "write",
      args: { path: `${ROOT}/new.txt`, ifExists: "fail" },
      body,
    });
    const sentOp = await dispatched();
    expect(sentOp.frame).toMatchObject({ op: "write", bodyBytes: body.byteLength });
    expect(sentOp.frame.args).not.toHaveProperty("content");
    expect(sentOp.body).toBe(body);
    sentOp.op.markResult({
      type: "file.result",
      opId: sentOp.op.opId,
      op: "write",
      result: { etag: ETAG, size: body.byteLength, created: true },
    });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(lastAudit()).toMatchObject({
      kind: "file_write",
      bytes: body.byteLength,
      outcome: "completed",
    });
    expect(JSON.stringify(lastAudit())).not.toContain(SECRET_TEXT);
  });

  it.each([
    ["traversal", { op: "read", args: { path: `${ROOT}/../../../etc/shadow` } }],
    ["a sibling sharing the root's prefix", { op: "read", args: { path: `${ROOT}x/a` } }],
    ["a home-relative path", { op: "read", args: { path: "~/deploy/a" } }],
    ["a parent of the root", { op: "list", args: { path: "/home/me" } }],
    ["a dot component", { op: "read", args: { path: `${ROOT}/./a` } }],
    ["a rename target outside", { op: "rename", args: { from: `${ROOT}/a`, to: "/etc/a" } }],
    ["one stat path outside", { op: "stat", args: { paths: [`${ROOT}/a`, "/etc/passwd"] } }],
    ["a search root outside", { op: "search", args: { root: "/", pattern: "x" } }],
  ] as const)("refuses %s before anything is sent", async (_label, request) => {
    const outcome = await ops.runFileOp({ ...base, ...request });
    expect(outcome).toEqual({ ok: false, code: "path_denied", roots: [ROOT] });
    expect(relay.dispatchFileOp).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({ outcome: "refused", reason: "path_denied" });
  });

  it("admits the root itself and paths beneath it", async () => {
    const pending = ops.runFileOp({ ...base, op: "list", args: { path: `${ROOT}/` } });
    const { op } = await dispatched();
    op.markRejected("not_found");
    await expect(pending).resolves.toEqual({ ok: false, code: "not_found" });
  });

  it("passes the node's own refusal through (its deny list), audited as refused", async () => {
    const pending = ops.runFileOp({
      ...base,
      op: "write",
      args: { path: `${ROOT}/config.json`, ifExists: "fail" },
      body: new Uint8Array([1]),
    });
    const { op } = await dispatched();
    op.markRejected("path_denied");
    await expect(pending).resolves.toEqual({ ok: false, code: "path_denied" });
    expect(lastAudit()).toMatchObject({ kind: "file_write", outcome: "failed" });
  });

  it("refuses a body over 1 MiB and a body on a non-write op", async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    await expect(
      ops.runFileOp({ ...base, op: "write", args: { path: `${ROOT}/a` }, body: big }),
    ).resolves.toEqual({ ok: false, code: "invalid_input" });
    await expect(
      ops.runFileOp({ ...base, op: "read", args: { path: `${ROOT}/a` }, body: new Uint8Array(1) }),
    ).resolves.toEqual({ ok: false, code: "invalid_input" });
    expect(relay.dispatchFileOp).not.toHaveBeenCalled();
  });

  it("refuses an inactive credential, a foreign node, Relay only and another owner's session", async () => {
    db.agentToken.findFirst.mockResolvedValueOnce(null);
    await expect(
      ops.runFileOp({ ...base, op: "read", args: { path: `${ROOT}/a` } }),
    ).resolves.toEqual({ ok: false, code: "token_inactive" });
    db.node.findUnique.mockResolvedValueOnce({ id: "node-1", userId: "user-2" });
    await expect(
      ops.runFileOp({ ...base, op: "read", args: { path: `${ROOT}/a` } }),
    ).resolves.toEqual({ ok: false, code: "unknown_node" });
    expect(lastAudit()).toMatchObject({ nodeId: ops.NODE_AUDIT_UNKNOWN_NODE });
    relay.getLiveNodeState.mockReturnValueOnce(liveState({ trust: "relay" }));
    await expect(
      ops.runFileOp({ ...base, op: "read", args: { path: `${ROOT}/a` } }),
    ).resolves.toEqual({ ok: false, code: "trust_relay" });
    relay.getLiveNodeState.mockReturnValueOnce(liveState({ userId: "user-2" }));
    await expect(
      ops.runFileOp({ ...base, op: "read", args: { path: `${ROOT}/a` } }),
    ).resolves.toEqual({ ok: false, code: "node_offline" });
    relay.getLiveNodeState.mockReturnValueOnce(liveState({ features: { files: { roots: null } } }));
    await expect(
      ops.runFileOp({ ...base, op: "read", args: { path: `${ROOT}/a` } }),
    ).resolves.toEqual({ ok: false, code: "no_roots" });
    expect(relay.dispatchFileOp).not.toHaveBeenCalled();
  });

  it("admits an OAuth grant by its grant row and audits the grant", async () => {
    const pending = ops.runFileOp({
      ...base,
      tokenId: "grant-1",
      credentialKind: "oauth_grant",
      op: "mkdir",
      args: { path: `${ROOT}/d` },
    });
    const { op } = await dispatched();
    expect(db.mcpGrant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "grant-1", userId: "user-1", level: "FULL", revokedAt: null },
      }),
    );
    expect(db.agentToken.findFirst).not.toHaveBeenCalled();
    op.markResult({ type: "file.result", opId: op.opId, op: "mkdir", result: { created: true } });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(lastAudit()).toMatchObject({ agentTokenId: null, mcpGrantId: "grant-1" });
  });

  it("ends a revoked credential's in-flight op (unknown outcome for a mutation)", async () => {
    const pending = ops.runFileOp({
      ...base,
      op: "delete",
      args: { path: `${ROOT}/a` },
    });
    const { op } = await dispatched();
    ops.cancelFileOpsForToken("tok-1");
    await expect(pending).resolves.toEqual({
      ok: false,
      code: "token_inactive",
      outcome: "unknown",
    });
    expect(relay.dispatchFileCancel).toHaveBeenCalledWith("node-1", op.opId);
    expect(lastAudit()).toMatchObject({ kind: "file_delete", outcome: "unknown" });
    // A late answer changes nothing.
    op.markResult({
      type: "file.result",
      opId: op.opId,
      op: "delete",
      result: { deleted: true, type: "file" },
    });
    expect(audit.recordNodeAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("refuses an op whose credential is revoked while its admission reads", async () => {
    let release: (value: unknown) => void = () => undefined;
    db.user.findUnique.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = ops.runFileOp({ ...base, op: "read", args: { path: `${ROOT}/a` } });
    await vi.waitFor(() => expect(db.user.findUnique).toHaveBeenCalled());
    ops.cancelFileOpsForToken("tok-1");
    release({ banned: false, banExpires: null, deletionRequestedAt: null });
    await expect(pending).resolves.toEqual({ ok: false, code: "token_inactive" });
    expect(relay.dispatchFileOp).not.toHaveBeenCalled();
  });

  it("ends a banned user's in-flight ops", async () => {
    const pending = ops.runFileOp({ ...base, op: "read", args: { path: `${ROOT}/a` } });
    await dispatched();
    ops.cancelFileOpsForUser("user-1");
    await expect(pending).resolves.toEqual({ ok: false, code: "token_inactive" });
  });

  it("maps outcomes for the procedures (nodeFileServices)", async () => {
    const pending = ops.nodeFileServices.run({
      userId: "user-1",
      credential: { kind: "agent_token", id: "tok-1" },
      nodeId: "node-1",
      op: "edit",
      args: {
        path: `${ROOT}/a`,
        expectedEtag: ETAG,
        edits: [{ oldText: "a", newText: "b" }],
      },
    });
    const { op } = await dispatched();
    op.markRejected("conflict", { currentEtag: ETAG });
    await expect(pending).resolves.toEqual({
      ok: false,
      code: "conflict",
      detail: { currentEtag: ETAG },
    });
    await expect(
      ops.nodeFileServices.run({
        userId: "user-1",
        credential: { kind: "agent_token", id: "tok-1" },
        nodeId: "node-1",
        op: "read",
        args: { path: "/etc/passwd" },
      }),
    ).resolves.toEqual({ ok: false, code: "path_denied", roots: [ROOT] });
  });

  it("audits a refused input without trusting the node id", () => {
    ops.nodeFileServices.auditRefused({
      userId: "user-1",
      credential: { kind: "oauth_grant", id: "grant-1" },
      nodeId: "node-1",
      op: "write",
      args: { path: `${ROOT}/a` },
    });
    expect(lastAudit()).toMatchObject({
      nodeId: ops.NODE_AUDIT_UNKNOWN_NODE,
      mcpGrantId: "grant-1",
      kind: "file_write",
      subject: `${ROOT}/a`,
      outcome: "refused",
      reason: "invalid_input",
    });
  });
});
