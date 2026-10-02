import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { vi } from "vitest";
import type { Context } from "../context";

const testEnv = vi.hoisted(() => ({
  WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
}));

// The parent-delete fence prelude runs against real PostgreSQL
// (capacity-lock-order.postgres.integration.test.ts); here it is observed.
const { fenceParentDelete } = vi.hoisted(() => ({
  fenceParentDelete: vi.fn(async (_tx: unknown, _scope: unknown): Promise<string[]> => []),
}));
vi.mock("@ws-model-proxy/db/capacity-lock-order", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ws-model-proxy/db/capacity-lock-order")>()),
  fenceParentDelete,
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  class TestDecimal {
    readonly value: string;

    constructor(value: string | number) {
      this.value = String(value);
    }

    greaterThan(other: string | number) {
      return Number(this.value) > Number(other);
    }

    toFixed() {
      return this.value;
    }

    equals(other: { value?: string } | string | number) {
      const right =
        typeof other === "object" && other && "value" in other
          ? String(other.value)
          : String(other);
      return this.value === right;
    }
  }
  return {
    default: mockDeep(),
    Prisma: {
      DbNull: { kind: "DbNull" },
      Decimal: TestDecimal,
      join: (values: readonly unknown[]) => values,
      TransactionIsolationLevel: { Serializable: "Serializable" },
    },
  };
});

vi.mock("@ws-model-proxy/env/server", () => ({
  env: testEnv,
  ADMIN_EMAIL: undefined,
}));

export { fenceParentDelete, testEnv };

export const { default: prisma } = await import("@ws-model-proxy/db");
export const { assertPoolSlugAvailable, forwarderManagementRouter } = await import(
  "./forwarder-management"
);

export const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  user: {
    findUnique: MockInstance;
    findFirst: MockInstance;
    update: MockInstance;
  };
  discoveredModel: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  appSetting: {
    findUnique: MockInstance;
  };
  modelPool: {
    findMany: MockInstance;
    findUnique: MockInstance;
    findFirst: MockInstance;
    create: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  cliDevice: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
    delete: MockInstance;
  };
  cliDeviceCredential: { findMany: MockInstance };
  cliToken: { findMany: MockInstance; updateMany: MockInstance };
  endpoint: {
    findUnique: MockInstance;
    delete: MockInstance;
  };
  poolMember: {
    create: MockInstance;
    count: MockInstance;
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  executionTarget: { findMany: MockInstance; findUnique: MockInstance; upsert: MockInstance };
  inferenceCapacity: { findMany: MockInstance; updateMany: MockInstance; upsert: MockInstance };
  providerModel: { findFirst: MockInstance; findMany: MockInstance };
  providerBudgetPolicy: {
    create: MockInstance;
    findFirst: MockInstance;
    findMany: MockInstance;
    update: MockInstance;
  };
  providerAuditEvent: { create: MockInstance; findFirst: MockInstance };
  poolGrant: {
    upsert: MockInstance;
    deleteMany: MockInstance;
    findMany: MockInstance;
    findFirst: MockInstance;
    updateMany: MockInstance;
    findUniqueOrThrow: MockInstance;
  };
  capacityAuditEvent: { create: MockInstance };
  cacheAffinityNode: { count: MockInstance; deleteMany: MockInstance };
  cacheAffinityRecord: {
    count: MockInstance;
    groupBy: MockInstance;
    deleteMany: MockInstance;
  };
};

export const sqlOf = (call: unknown[]) => (call[0] as readonly string[]).join("?");
export const isFenceCall = (call: unknown[]) => sqlOf(call).includes("wsmp_acquire_fences");

/** The fence arrays passed to `wsmp_acquire_fences`, one per call, in call order. */
export function fenceCalls(): unknown[] {
  return (db.$queryRaw.mock.calls as unknown[][]).filter(isFenceCall).map((call) => call[1]);
}

/** Call order of the last fence call (NaN when none was taken). */
export function lastFenceOrder(): number {
  const calls = db.$queryRaw.mock.calls as unknown[][];
  return db.$queryRaw.mock.invocationCallOrder[calls.findLastIndex(isFenceCall)] ?? Number.NaN;
}

/** Call order of the first `$queryRaw` that is not a fence (a row lock). */
export function firstRowLockOrder(): number {
  const calls = db.$queryRaw.mock.calls as unknown[][];
  return (
    db.$queryRaw.mock.invocationCallOrder[calls.findIndex((call) => !isFenceCall(call))] ??
    Number.NaN
  );
}

export function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null };
  return {
    session: {
      user: {
        id: "user-id",
        email: "owner@example.com",
        name: "Owner",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.user,
      },
      session: {
        id: "session-id",
        userId: sessionOverride?.user?.id ?? "user-id",
        token: "session-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

export function client() {
  return createRouterClient(forwarderManagementRouter, { context: buildContext() });
}

export function httpClient(captures?: Array<{ status: number; body: string }>) {
  const handler = new RPCHandler(forwarderManagementRouter);
  const link = new RPCLink({
    url: "https://example.test/rpc",
    fetch: async (request, init) => {
      const result = await handler.handle(new Request(request, init), {
        prefix: "/rpc",
        context: buildContext(),
      });
      if (!result.matched) return new Response(null, { status: 404 });
      if (captures)
        captures.push({
          status: result.response.status,
          body: await result.response.clone().text(),
        });
      return result.response;
    },
  });
  return createORPCClient(link) as ReturnType<
    typeof createRouterClient<typeof forwarderManagementRouter>
  >;
}

export function poolRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pool-id",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    slug: "general",
    name: "General",
    description: null,
    maxAttachmentBytes: null,
    optimisticBasicTranscription: false,
    protocolAdaptationEnabled: false,
    allowLossyDeveloperRoleCollapse: false,
    recommendedSurfaceOverride: null,
    cacheHolderWaitMs: null,
    protectionEnabled: true,
    evictionFeedbackEnabled: true,
    protectionWindowSeconds: 300,
    protectMinTokens: 8192,
    protectionShare: "EQUAL_SHARE",
    protectionFixedPercent: null,
    ownerProtectionPercent: null,
    transformerDiscoveredModelId: null,
    transformerSystemPrompt: null,
    transformerImages: true,
    transformerAudio: false,
    transformerVideo: false,
    transformerCacheMode: "OFF",
    TransformerDiscoveredModel: null,
    affinityResidencyWeight: 100,
    // Schema defaults of the fallback columns (forwarder.prisma).
    fallbackEnabled: false,
    fallbackForGrantees: false,
    externalAfterWaitMs: 2000,
    User: { slug: "owner" },
    PoolMembers: [],
    PoolGrants: [],
    ...overrides,
  };
}

export function guardedLocalModel(
  overrides: Record<string, unknown> = {},
  native: "chat" | "responses" = "responses",
) {
  return {
    id: "local-id",
    upstreamModelId: "local-model",
    capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
    capabilityOverrides: [],
    capabilityOverrideMetadata: null,
    Endpoint: {
      capabilityMetadata: {
        version: 1,
        protocol: "openai-compatible",
        chatCompletions: { supported: native === "chat", streaming: true },
        responses: { supported: native === "responses", streaming: true },
      },
      defaultCapabilities: [],
    },
    ...overrides,
  };
}
