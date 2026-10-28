import { describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({
  default: mockDeep<PrismaClient>(),
  Prisma: { DbNull: "DbNull" },
}));

import type { RuntimeSpec } from "./runtime-spec";
import { syncRuntimeModels, type Tx } from "./runtime-store";

describe("syncRuntimeModels", () => {
  it("stores a listed model without capabilities as its type, as the node serves it", async () => {
    const tx = mockDeep<Tx>();
    const spec = {
      api: "openai",
      engine: "llama_cpp",
      modelType: "embeddings",
      models: [{ id: "bge" }, { id: "both", capabilities: ["embedding", "text_generation"] }],
      address: { baseUrl: "http://127.0.0.1:8080" },
    } as RuntimeSpec;
    await syncRuntimeModels(tx, { userId: "u", runtimeId: "r", spec });
    const stored = tx.runtimeModel.upsert.mock.calls.map(([args]) => [
      args.create.upstreamModelId,
      args.create.detectedCapabilities,
      args.update.detectedCapabilities,
    ]);
    expect(stored).toEqual([
      ["bge", ["EMBEDDING"], ["EMBEDDING"]],
      ["both", ["EMBEDDING", "TEXT_GENERATION"], ["EMBEDDING", "TEXT_GENERATION"]],
    ]);
  });
});
