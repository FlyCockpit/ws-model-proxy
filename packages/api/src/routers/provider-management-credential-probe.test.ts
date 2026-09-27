import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

// Real egress (no provider-egress mock) against a loopback-only fixture: the
// reviewer's counterexample for compatible gateways whose root is public.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: true,
    WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS: "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return {
    default: mockDeep(),
    Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
  };
});

const { providerManagementRouter } = await import("./provider-management");
const { default: prisma } = await import("@ws-model-proxy/db");
const { encryptProviderCredential, parseProviderCredentialKeyring } = await import(
  "../lib/provider-credential-crypto"
);
const { providerHttpsRequest } = await import("../lib/provider-egress");
const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  providerAccount: { findFirst: MockInstance };
  providerCredential: { findFirst: MockInstance; updateMany: MockInstance };
  providerAuditEvent: { create: MockInstance };
};

const context: Context = {
  session: {
    user: {
      id: "owner",
      email: "owner@example.com",
      name: "Owner",
      emailVerified: true,
      role: "user",
      twoFactorEnabled: false,
      image: null,
      banned: false,
      banReason: null,
      banExpires: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    session: {
      id: "session",
      userId: "owner",
      token: "token",
      expiresAt: new Date(Date.now() + 60_000),
      ipAddress: null,
      userAgent: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as Session,
};
const client = () => createRouterClient(providerManagementRouter, { context });

const secret = "fixture-bogus-key";
// The root never looks at the key; /v1/models answers with `modelsStatus`.
let modelsStatus = 401;
const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
const server = createServer((request, response) => {
  seen.push({ path: request.url ?? "", headers: request.headers });
  response.statusCode =
    request.url === "/" ? 200 : request.url === "/v1/models" ? modelsStatus : 404;
  response.end("{}");
});
let baseUrl = "";

// Endpoint-scoped gateway (reviewer's r2 counterexample): unknown keys get 401
// everywhere; the inference key may call chat/messages but gets 403 on
// `GET /v1/models`; the model-reader key may also list models.
const inferenceKey = "fixture-inference-key";
const modelReaderKey = "fixture-model-reader-key";
const scopedServer = createServer((request, response) => {
  const key =
    request.headers["x-api-key"] ?? request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
  const known = key === inferenceKey || key === modelReaderKey;
  if (request.url === "/") response.statusCode = 200;
  else if (!known) response.statusCode = 401;
  else if (request.url === "/v1/models") response.statusCode = key === modelReaderKey ? 200 : 403;
  else if (
    request.method === "POST" &&
    (request.url === "/v1/chat/completions" || request.url === "/v1/messages")
  )
    response.statusCode = 200;
  else response.statusCode = 404;
  request.resume();
  response.end("{}");
});
let scopedBaseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => scopedServer.listen(0, "127.0.0.1", resolve));
  scopedBaseUrl = `http://127.0.0.1:${(scopedServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => scopedServer.close(() => resolve()));
});

function arrange(
  providerType: string,
  credentialType: "BEARER" | "API_KEY",
  key: string = secret,
  accountBaseUrl: string = baseUrl,
) {
  const encrypted = encryptProviderCredential(
    key,
    {
      userId: "owner",
      providerAccountId: "acct",
      credentialId: "credential",
      credentialType,
      aadVersion: 1,
    },
    parseProviderCredentialKeyring("v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
  );
  db.providerAccount.findFirst.mockResolvedValue({
    id: "acct",
    userId: "owner",
    deletedAt: null,
    currentCredentialId: "credential",
    providerType,
    baseUrl: accountBaseUrl,
  });
  db.providerCredential.findFirst.mockResolvedValue({
    id: "credential",
    providerAccountId: "acct",
    credentialType,
    aadVersion: 1,
    status: "ACTIVE",
    ...encrypted,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seen.length = 0;
  db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) => callback(db));
  db.providerCredential.updateMany.mockResolvedValue({ count: 1 });
  db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
});

describe("compatible-provider credential test against a public-root gateway", () => {
  it.each([
    ["openai-compatible", "BEARER", "authorization"],
    ["anthropic-compatible", "API_KEY", "x-api-key"],
  ] as const)(
    "%s: root 200 + /v1/models 401 is a refused key, not a pass",
    async (providerType, credentialType, authHeader) => {
      modelsStatus = 401;
      arrange(providerType, credentialType);
      await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toEqual({
        ok: false,
        outcome: "FAILURE",
        reason: "INVALID_CREDENTIAL",
        statusCode: 401,
      });
      expect(seen.map((request) => request.path)).toEqual(["/v1/models"]);
      expect(seen[0]?.headers[authHeader]).toContain(secret);
      const audit = db.providerAuditEvent.create.mock.calls.at(-1)?.[0];
      expect(audit.data.metadata).toEqual({
        outcome: "FAILURE",
        statusCode: 401,
        reason: "INVALID_CREDENTIAL",
      });
      expect(JSON.stringify(audit)).not.toContain(secret);
    },
  );

  it.each(["openai-compatible", "anthropic-compatible"] as const)(
    "%s: root 200 + /v1/models 200 is unverified, never a pass",
    async (providerType) => {
      modelsStatus = 200;
      arrange(providerType, "BEARER");
      await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toEqual({
        ok: false,
        outcome: "INCONCLUSIVE",
        reason: "UNVERIFIED",
        statusCode: 200,
      });
      expect(db.providerAuditEvent.create.mock.calls.at(-1)?.[0].data.metadata).toEqual({
        outcome: "INCONCLUSIVE",
        statusCode: 200,
        reason: "UNVERIFIED",
      });
    },
  );

  it("a gateway without /v1/models is inconclusive, not a refused key", async () => {
    modelsStatus = 404;
    arrange("openai-compatible", "BEARER");
    await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toEqual({
      ok: false,
      outcome: "INCONCLUSIVE",
      reason: "UNEXPECTED_STATUS",
      statusCode: 404,
    });
  });

  it("the same fixture passes a native type only on its authenticated endpoint", async () => {
    modelsStatus = 200;
    arrange("openai", "BEARER");
    await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toMatchObject({
      ok: true,
      outcome: "SUCCESS",
    });
    expect(seen.map((request) => request.path)).toEqual(["/v1/models"]);
  });
});

describe("credential test against an endpoint-scoped gateway", () => {
  const cases = [
    ["openai-compatible", "openai", "BEARER", "/v1/chat/completions"],
    ["anthropic-compatible", "anthropic", "API_KEY", "/v1/messages"],
    ["openai", "openai", "BEARER", "/v1/chat/completions"],
    ["anthropic", "anthropic", "API_KEY", "/v1/messages"],
  ] as const;

  async function inferenceStatus(
    protocol: "openai" | "anthropic",
    credentialType: "BEARER" | "API_KEY",
    path: string,
    key: string,
  ) {
    const response = await providerHttpsRequest(
      `${scopedBaseUrl}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode("{}"),
      },
      { allowPrivateNetworks: true, egressEnabled: true },
      protocol,
      credentialType === "BEARER"
        ? { type: "BEARER", token: key }
        : { type: "API_KEY", apiKey: key },
    );
    response.resume();
    return response.statusCode;
  }

  it.each(cases)(
    "%s: an inference-only key (403 on /v1/models) is inconclusive, not rejected",
    async (providerType, protocol, credentialType, inferencePath) => {
      // The fixture really accepts this key for inference and refuses a bogus one.
      expect(await inferenceStatus(protocol, credentialType, inferencePath, inferenceKey)).toBe(
        200,
      );
      expect(await inferenceStatus(protocol, credentialType, inferencePath, secret)).toBe(401);

      arrange(providerType, credentialType, inferenceKey, scopedBaseUrl);
      await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toEqual({
        ok: false,
        outcome: "INCONCLUSIVE",
        reason: "INSUFFICIENT_PERMISSION",
        statusCode: 403,
      });
      const audit = db.providerAuditEvent.create.mock.calls.at(-1)?.[0];
      expect(audit.data.metadata).toEqual({
        outcome: "INCONCLUSIVE",
        statusCode: 403,
        reason: "INSUFFICIENT_PERMISSION",
      });
      expect(JSON.stringify(audit)).not.toContain(inferenceKey);
    },
  );

  it.each(cases)(
    "%s: an unknown key (401) is not accepted",
    async (providerType, _p, credentialType) => {
      arrange(providerType, credentialType, secret, scopedBaseUrl);
      await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toEqual({
        ok: false,
        outcome: "FAILURE",
        reason: "INVALID_CREDENTIAL",
        statusCode: 401,
      });
    },
  );

  it.each([
    ["openai", "BEARER", { ok: true, outcome: "SUCCESS", reason: null }],
    ["anthropic", "API_KEY", { ok: true, outcome: "SUCCESS", reason: null }],
    ["openai-compatible", "BEARER", { ok: false, outcome: "INCONCLUSIVE", reason: "UNVERIFIED" }],
  ] as const)(
    "%s: a key allowed to list models",
    async (providerType, credentialType, expected) => {
      arrange(providerType, credentialType, modelReaderKey, scopedBaseUrl);
      await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toEqual({
        ...expected,
        statusCode: 200,
      });
    },
  );
});
