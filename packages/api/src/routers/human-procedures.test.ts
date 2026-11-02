import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
// The refusal happens before any procedure reads configuration; the real env module would
// demand DATABASE_URL and the auth secrets.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    WMP_MCP_ENABLED: true,
    WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY: true,
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
    BETTER_AUTH_URL: "https://proxy.example.com",
  },
}));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
  invalidateForceTwoFactorPolicyCache: vi.fn(),
}));
vi.mock("@ws-model-proxy/mailer", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import type { Context } from "../context";
import type { AnonymousAuth, CallerAuth } from "../contracts/auth-context";
import { apiContract, flattenContract } from "../contracts/index";
import { appRouter } from "./index";

const session = {
  user: {
    id: "owner",
    email: "o@example.test",
    name: "O",
    role: "admin",
    emailVerified: true,
    twoFactorEnabled: true,
  },
  session: { id: "s", userId: "owner", expiresAt: new Date(Date.now() + 60_000) },
} as unknown as Session;

/** Every caller that is NOT a verified person (§6.3, review #8). */
const NOT_A_PERSON: ReadonlyArray<[string, CallerAuth | AnonymousAuth]> = [
  ["Full agent token", { kind: "agent_token", userId: "owner", agentTokenId: "t", level: "FULL" }],
  [
    "OAuth access token",
    { kind: "oauth_access_token", userId: "owner", grantId: "g", level: "FULL" },
  ],
  ["API key", { kind: "api_key", userId: "owner", apiKeyId: "k" }],
  [
    "cookie without the CSRF header",
    { kind: "cookie_session", userId: "owner", sessionId: "s", csrfVerified: false },
  ],
];

type Callable = (input: unknown) => Promise<unknown>;

function procedureAt(client: unknown, path: string): Callable {
  let node: unknown = client;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  if (typeof node !== "function") throw new Error(`no procedure at ${path}`);
  return node as Callable;
}

const humanPaths = flattenContract(apiContract)
  .filter(([, procedure]) => procedure.access === "human" || procedure.access === "human_admin")
  .map(([path]) => path);

describe("router ↔ contract", () => {
  it("binds every contract procedure, and nothing else", () => {
    const client = createRouterClient(appRouter, {
      context: { session: null, auth: { kind: "anonymous" } } satisfies Context,
    });
    const contractPaths = flattenContract(apiContract).map(([path]) => path);
    for (const path of contractPaths) expect(() => procedureAt(client, path), path).not.toThrow();
    const routerPaths: string[] = [];
    const walk = (node: unknown, prefix: string) => {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === "object" && "~orpc" in value) routerPaths.push(path);
        else if (value && typeof value === "object") walk(value, path);
      }
    };
    walk(appRouter, "");
    expect(routerPaths.sort()).toEqual([...contractPaths].sort());
  });
});

describe("human-only procedures (positive check)", () => {
  it("covers a real set of procedures", () => {
    expect(humanPaths.length).toBeGreaterThan(40);
  });

  for (const [label, auth] of NOT_A_PERSON)
    it(`refuses every human procedure for a ${label}, before any handler runs`, async () => {
      const client = createRouterClient(appRouter, {
        context: { session, auth } satisfies Context,
      });
      for (const path of humanPaths) {
        await expect(procedureAt(client, path)({}), `${label} → ${path}`).rejects.toMatchObject({
          code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND|UNAUTHORIZED)$/),
        });
      }
      expect(vi.mocked(prisma).$transaction).not.toHaveBeenCalled();
      expect(vi.mocked(prisma).user.update).not.toHaveBeenCalled();
    });

  it("lets a CSRF-checked cookie session through the access check", async () => {
    const client = createRouterClient(appRouter, {
      context: {
        session,
        auth: { kind: "cookie_session", userId: "owner", sessionId: "s", csrfVerified: true },
      } satisfies Context,
    });
    // A human procedure gets past the access check and reaches its handler (which finds no
    // such node).
    vi.mocked(prisma).node.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      procedureAt(client, "nodes.rename")({ nodeId: "n", name: null }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("session, admin and agent procedures", () => {
  it("hides admin procedures (NOT_FOUND) from a non-admin person", async () => {
    const client = createRouterClient(appRouter, {
      context: {
        session: { ...session, user: { ...session.user, role: "user" } } as Session,
        auth: { kind: "cookie_session", userId: "owner", sessionId: "s", csrfVerified: true },
      } satisfies Context,
    });
    await expect(procedureAt(client, "users.list")({})).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses tokens on session procedures (only /rpc cookies reach them)", async () => {
    const client = createRouterClient(appRouter, {
      context: {
        session,
        auth: { kind: "agent_token", userId: "owner", agentTokenId: "t", level: "FULL" },
      } satisfies Context,
    });
    await expect(procedureAt(client, "nodes.enrollmentCodes.list")({})).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lets an agent token reach agent procedures", async () => {
    const client = createRouterClient(appRouter, {
      context: {
        session,
        auth: { kind: "agent_token", userId: "owner", agentTokenId: "t", level: "FULL" },
      } satisfies Context,
    });
    vi.mocked(prisma).node.findMany.mockResolvedValueOnce([]);
    await expect(procedureAt(client, "nodes.list")({})).resolves.toEqual({ nodes: [] });
  });

  it("refuses anonymous callers everywhere but public procedures", async () => {
    const client = createRouterClient(appRouter, {
      context: { session: null, auth: { kind: "anonymous" } } satisfies Context,
    });
    await expect(procedureAt(client, "nodes.list")({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("an admin's impersonation session is read-only", () => {
  const impersonated = {
    user: { ...session.user, id: "person", role: "user" },
    session: { ...session.session, userId: "person", impersonatedBy: "owner" },
  } as unknown as Session;
  const cookie: CallerAuth = {
    kind: "cookie_session",
    userId: "person",
    sessionId: "s",
    csrfVerified: true,
  };
  const procedures = flattenContract(apiContract).filter(
    ([, procedure]) => procedure.access !== "public",
  );
  // Admin procedures answer NOT_FOUND to a non-admin before the read-only rule.
  const mutations = procedures
    .filter(([, p]) => p.kind === "mutation" && p.access !== "admin" && p.access !== "human_admin")
    .map(([path]) => path);
  const queries = procedures
    .filter(([, p]) => p.kind === "query" && p.access !== "admin" && p.access !== "human_admin")
    .map(([path]) => path);

  it("covers a real set of procedures", () => {
    expect(mutations.length).toBeGreaterThan(40);
    expect(queries.length).toBeGreaterThan(10);
  });

  it("refuses every mutation before any handler or input check runs", async () => {
    const client = createRouterClient(appRouter, {
      context: { session: impersonated, auth: cookie } satisfies Context,
    });
    for (const path of mutations) {
      await expect(procedureAt(client, path)({}), path).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "impersonating" },
      });
    }
    expect(vi.mocked(prisma).$transaction).not.toHaveBeenCalled();
    expect(vi.mocked(prisma).agentToken.create).not.toHaveBeenCalled();
  });

  it("does not refuse a query for the impersonation", async () => {
    const client = createRouterClient(appRouter, {
      context: { session: impersonated, auth: cookie } satisfies Context,
    });
    for (const path of queries) {
      const error = await procedureAt(client, path)({}).catch((caught: unknown) => caught);
      expect((error as { data?: { reason?: string } } | undefined)?.data?.reason, path).not.toBe(
        "impersonating",
      );
    }
  });
});
