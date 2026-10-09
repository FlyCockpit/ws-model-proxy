import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-characters" },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const { credentialDigest, credentialLookupPrefix } = await import(
  "@ws-model-proxy/db/node-security"
);
const { authenticateNodeCredential } = await import("./node-credential-auth.js");

const db = prisma as unknown as { nodeCredential: { findUnique: MockInstance } };
const SECRET = `wsmp_node_${"A".repeat(43)}`;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "cred-1",
    userId: "user-1",
    nodeId: "node-1",
    secretDigest: credentialDigest("nodeCredential", SECRET),
    identityPublicKey: "key",
    revokedAt: null,
    User: { banned: false, banExpires: null, deletionRequestedAt: null },
    ...overrides,
  };
}

describe("authenticateNodeCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.nodeCredential.findUnique.mockResolvedValue(row());
  });

  it("finds the credential by lookup prefix and returns its node identity", async () => {
    await expect(authenticateNodeCredential(SECRET)).resolves.toEqual({
      credentialId: "cred-1",
      userId: "user-1",
      nodeId: "node-1",
      identityPublicKey: "key",
    });
    expect(db.nodeCredential.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lookupPrefix: credentialLookupPrefix(SECRET) } }),
    );
  });

  it("refuses other credential types and malformed secrets without a lookup", async () => {
    for (const secret of [`wsmp_agent_${"A".repeat(43)}`, "wsmp_node_short", `${SECRET}x`]) {
      await expect(authenticateNodeCredential(secret)).resolves.toBeNull();
    }
    expect(db.nodeCredential.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret, a revoked credential and a blocked owner", async () => {
    db.nodeCredential.findUnique.mockResolvedValueOnce(
      row({ secretDigest: credentialDigest("nodeCredential", `wsmp_node_${"B".repeat(43)}`) }),
    );
    await expect(authenticateNodeCredential(SECRET)).resolves.toBeNull();
    db.nodeCredential.findUnique.mockResolvedValueOnce(row({ revokedAt: new Date() }));
    await expect(authenticateNodeCredential(SECRET)).resolves.toBeNull();
    db.nodeCredential.findUnique.mockResolvedValueOnce(
      row({ User: { banned: false, banExpires: null, deletionRequestedAt: new Date() } }),
    );
    await expect(authenticateNodeCredential(SECRET)).resolves.toBeNull();
    db.nodeCredential.findUnique.mockResolvedValueOnce(null);
    await expect(authenticateNodeCredential(SECRET)).resolves.toBeNull();
  });
});
