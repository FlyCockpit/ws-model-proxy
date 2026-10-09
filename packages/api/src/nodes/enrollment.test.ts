import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({
  default: mockDeep<PrismaClient>(),
  Prisma: { DbNull: "DbNull" },
}));
vi.mock("@ws-model-proxy/db/node-security", () => ({
  credentialDigest: vi.fn((purpose: string, secret: string) => `hmac:${purpose}:${secret}`),
}));
// The queued-command notice pulls in the mailer; without SMTP it sends nothing.
vi.mock("@ws-model-proxy/env/shared", () => ({ env: {} }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.com/" },
}));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import { nodesRouter } from "../routers/nodes";
import { base32, generateEnrollmentCode } from "./enrollment-code";
import { contextFor, PERSON } from "./lane-b-test-helpers";

const db = vi.mocked(prisma, true);

function codeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "code-1",
    codePrefix: "ABCDEFGH",
    createdAt: new Date("2026-10-06T10:00:00Z"),
    expiresAt: new Date("2026-10-06T11:00:00Z"),
    suggestedSlug: null,
    replaceNodeId: null,
    maxUses: 5,
    usedCount: 1,
    lastUsedAt: new Date("2026-10-06T10:05:00Z"),
    labels: ["lab"],
    removeAfterOfflineMs: 3_600_000n,
    revokedAt: null,
    Uses: [{ nodeId: "node-1", usedAt: new Date("2026-10-06T10:05:00Z"), Node: { slug: "box" } }],
    ...overrides,
  };
}

const client = () => createRouterClient(nodesRouter, { context: contextFor(PERSON) });

beforeEach(() => {
  mockReset(db);
  db.$transaction.mockImplementation(((fn: (tx: typeof db) => unknown) => fn(db)) as never);
});

describe("enrollment code text", () => {
  it("base32-encodes RFC 4648 vectors", () => {
    expect(base32(new TextEncoder().encode("foobar"), 10)).toBe("MZXW6YTBOI");
  });
  it("mints 130-bit codes in the contract shape, all different", () => {
    const codes = new Set(Array.from({ length: 50 }, generateEnrollmentCode));
    expect(codes.size).toBe(50);
    for (const code of codes) expect(code).toMatch(/^wsmp_enr_[A-Z2-7]{26}$/);
  });
});

describe("nodes.enrollmentCodes.create", () => {
  it("stores only the digest and returns the secret once with the one-liner", async () => {
    db.nodeEnrollmentCode.findMany.mockResolvedValueOnce([]);
    db.nodeEnrollmentCode.create.mockResolvedValueOnce(codeRow() as never);
    const out = await client().enrollmentCodes.create({
      maxUses: 5,
      ttlHours: 24,
      labels: ["lab"],
      removeAfterOfflineMs: 3_600_000,
    });
    const data = db.nodeEnrollmentCode.create.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      userId: "owner-1",
      maxUses: 5,
      labels: ["lab"],
      removeAfterOfflineMs: 3_600_000n,
      codeDigest: `hmac:enrollmentCode:${out.secret}`,
      codePrefix: out.secret.slice(9, 17),
    });
    expect(Object.values(data ?? {})).not.toContain(out.secret);
    const expiresAt = data?.expiresAt as Date;
    const ttl = expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(23.9 * 3_600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3_600_000);
    expect(out.installCommand).toBe(
      `curl -fsSL https://proxy.example.com/install.sh | sh && ~/.cargo/bin/wsmp login https://proxy.example.com --code ${out.secret}`,
    );
    expect(out.code.enrolled).toEqual([
      { nodeId: "node-1", slug: "box", usedAt: "2026-10-06T10:05:00.000Z" },
    ]);
  });

  it("makes `temporary: true` alone an hour offline", async () => {
    db.nodeEnrollmentCode.findMany.mockResolvedValueOnce([]);
    db.nodeEnrollmentCode.create.mockResolvedValueOnce(codeRow() as never);
    await client().enrollmentCodes.create({ temporary: true });
    expect(db.nodeEnrollmentCode.create.mock.calls[0]?.[0]?.data).toMatchObject({
      removeAfterOfflineMs: 3_600_000n,
    });
  });

  it("refuses temporary: false with removeAfterOfflineMs (contract refinement)", async () => {
    await expect(
      client().enrollmentCodes.create({ temporary: false, removeAfterOfflineMs: 120_000 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a multi-use code with a suggested slug (contract refinement)", async () => {
    await expect(
      client().enrollmentCodes.create({ maxUses: 3, suggestedSlug: "box" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("supersedes the node's previous live Replace code", async () => {
    db.node.findFirst.mockResolvedValueOnce({ id: "node-1" } as never);
    db.nodeEnrollmentCode.findMany.mockResolvedValueOnce([]);
    db.nodeEnrollmentCode.create.mockResolvedValueOnce(
      codeRow({ replaceNodeId: "node-1", maxUses: 1, labels: [], Uses: [] }) as never,
    );
    await client().enrollmentCodes.create({ replaceNodeId: "node-1" });
    expect(db.nodeEnrollmentCode.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "owner-1", replaceNodeId: "node-1", revokedAt: null, usedCount: 0 },
    });
  });

  it("refuses a Replace code for someone else's node", async () => {
    db.node.findFirst.mockResolvedValueOnce(null);
    await expect(
      client().enrollmentCodes.create({ replaceNodeId: "node-x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.nodeEnrollmentCode.create).not.toHaveBeenCalled();
  });

  it("caps live codes per person", async () => {
    db.nodeEnrollmentCode.findMany.mockResolvedValueOnce(
      Array.from({ length: 20 }, () => ({ usedCount: 0, maxUses: 1 })) as never,
    );
    await expect(client().enrollmentCodes.create({})).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      data: { reason: "rate_limited" },
    });
  });
});

describe("nodes.enrollmentCodes.revoke / credentials.revoke", () => {
  it("revokes the caller's own code", async () => {
    db.nodeEnrollmentCode.findFirst.mockResolvedValueOnce({
      id: "code-1",
      revokedAt: null,
    } as never);
    await client().enrollmentCodes.revoke({ codeId: "code-1" });
    expect(db.nodeEnrollmentCode.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "code-1",
      userId: "owner-1",
    });
    expect(db.nodeEnrollmentCode.updateMany).toHaveBeenCalled();
  });

  it("revokes a credential and disconnects the node", async () => {
    const disconnect = vi.fn(async () => undefined);
    db.nodeCredential.findFirst.mockResolvedValueOnce({
      id: "cr-1",
      nodeId: "node-1",
      revokedAt: null,
    } as never);
    await createRouterClient(nodesRouter, {
      context: contextFor(PERSON, { disconnect }),
    }).credentials.revoke({ credentialId: "cr-1" });
    expect(disconnect).toHaveBeenCalledWith("node-1", "credential_revoked");
  });
});
