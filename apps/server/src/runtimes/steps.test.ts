import { runtimeLaunchSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import { describe, expect, it } from "vitest";
import { runtimeJobFrameSchema } from "../relay/frames.js";
import {
  canonicalDecimal,
  generationSteps,
  intentHash,
  jobFrame,
  rankPlaceholders,
  stepIntentSchema,
} from "./steps.js";

const launch = runtimeLaunchSchema.parse({
  management: "process",
  groupSize: 2,
  resources: [{ kind: "discrete", gpuCount: 1, vramGb: 24 }],
  labels: [],
  commands: [
    { prepare: "pull", start: "head --port {{port}}", stop: "true", afterJoin: "join" },
    { start: "worker {{head_addr}}", stop: "true" },
  ],
  readiness: { path: "/health", expectedStatus: 200, timeoutMs: 120_000 },
  health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
});

const instance = {
  id: "inst1",
  handle: "i-abcdefabcdef",
  runtimeId: "rt1",
  launchVersionId: "v1",
  launchHash: "a".repeat(64),
  fabricId: "fab1",
};
const ranks = [
  { rank: 1, port: 30_002, distPort: 31_000, resources: { kind: "discrete", gpus: ["nvidia:1"] } },
  {
    rank: 0,
    port: 30_001,
    distPort: 31_000,
    resources: { kind: "discrete", vramGb: 24, gpus: ["nvidia:0"] },
  },
];

describe("generationSteps", () => {
  it("orders a run: prepare, start, after_join, readiness on the head; a restart stops first", () => {
    const first = generationSteps({ instance, ranks, launch, generation: 1, operationId: "op" });
    expect(first.map((step) => [step.phase, step.rank, step.sequence])).toEqual([
      ["PREPARE", 0, 110],
      ["START", 0, 120],
      ["AFTER_JOIN", 0, 130],
      ["START", 1, 120],
      ["READINESS", 0, 140],
    ]);
    const second = generationSteps({ instance, ranks, launch, generation: 2, operationId: "op" });
    expect(second.filter((step) => step.phase === "STOP").map((s) => [s.rank, s.sequence])).toEqual(
      [
        [0, 200],
        [1, 200],
      ],
    );
    for (const step of first) {
      expect(stepIntentSchema.parse(step.intent)).toEqual(step.intent);
      expect(step.intentHash).toBe(intentHash(step.intent));
    }
    expect(first.find((step) => step.phase === "READINESS")?.intent.timeoutMs).toBe(120_000);
  });

  it("builds jobs the node accepts, with the head address for multi-node", () => {
    const [prepare] = generationSteps({
      instance,
      ranks,
      launch,
      generation: 1,
      operationId: null,
    });
    if (!prepare) throw new Error("no step");
    const job = jobFrame({
      stepId: "step1",
      instanceId: instance.id,
      phase: prepare.phase,
      generation: 1,
      intent: prepare.intent,
      intentHash: prepare.intentHash,
      ownerEpoch: "e1:3",
      headAddr: "10.0.0.5",
    });
    expect(runtimeJobFrameSchema.safeParse(job).success).toBe(true);
    expect(job.placeholders).toEqual({
      port: 30_001,
      dist_port: 31_000,
      head_addr: "10.0.0.5",
      gpu_ids: "0",
      vram_gb: "24",
    });
    expect(job.fabricId).toBe("fab1");
  });
});

describe("placeholders", () => {
  it("passes recorded GPU indexes and canonical decimals", () => {
    expect(
      rankPlaceholders({
        kind: "discrete",
        vramGb: 7.5,
        ramGb: 16,
        gpus: ["nvidia:0", "nvidia:3"],
      }),
    ).toEqual({
      gpu_ids: "0,3",
      vram_gb: "7.5",
      memory_gb: "16",
    });
    // A GPU key that is not vendor:index gives no ids (never a partial list).
    expect(
      rankPlaceholders({ kind: "discrete", vramGb: 8, gpus: ["nvidia:0", "GPU-uuid"] }),
    ).toEqual({
      vram_gb: "8",
    });
    expect(rankPlaceholders({ kind: "unified", memoryGb: 120 })).toEqual({ memory_gb: "120" });
    expect(canonicalDecimal(0.1234567)).toBe("0.123457");
    expect(canonicalDecimal(1e15)).toBeNull();
  });
});
