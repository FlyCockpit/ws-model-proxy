/** Pool views for the pool pages' DOM tests (only the fields the pages read are realistic). */
import type { PoolMemberView, PoolView } from "@/lib/pool-ui";

export function memberFixture(overrides: Partial<PoolMemberView> = {}): PoolMemberView {
  return {
    id: "mem-1",
    kind: "LOCAL",
    state: "ACTIVE",
    status: "serving",
    weight: 1,
    runtimeModelId: "rm-1",
    runtimeId: "rt-1",
    runtimeSlug: "qwen",
    upstreamModelId: "Qwen/Qwen3-8B",
    shareId: null,
    contributorEmail: null,
    providerModelId: null,
    cloudOrder: null,
    health: "HEALTHY",
    live: { instances: 1, running: 1, waiting: 0, p95LatencyMs: null },
    ...overrides,
  };
}

export function poolFixture(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: "pool-1",
    slug: "chat",
    name: "Chat",
    description: null,
    modelType: "LLM",
    callableIds: ["ann/chat"],
    owner: { userId: "user-1", slug: "ann", you: true },
    routing: {
      priorityClass: "NORMAL",
      concurrencyLimit: null,
      keptSlots: 0,
      borrowKept: false,
      ownHardwareOnly: false,
    },
    cloud: {
      mode: "OFF",
      embeddingContract: null,
      paidWarmProtection: false,
      ownKeyEquivalentModel: null,
    },
    sidecars: [],
    advanced: {
      maxWaitMs: { effective: 30_000, source: "default" },
    } as unknown as PoolView["advanced"],
    rules: [],
    members: [memberFixture()],
    sharesCount: 0,
    runsOn: [],
    traffic24h: { requests: 0, errors: 0, sparkline: Array.from({ length: 24 }, () => 0) },
    ...overrides,
  };
}
