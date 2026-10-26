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
  stopStep,
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

describe("stops of a recorded launch", () => {
  it("carry the head address that launch was dispatched with, outside the intent's hash", () => {
    const [start] = generationSteps({
      instance,
      ranks,
      launch,
      generation: 1,
      operationId: null,
    }).filter((step) => step.phase === "START" && step.rank === 1);
    if (!start) throw new Error("no start step");
    const physical = { intent: start.intent, launch, headAddr: "10.0.0.1" };
    const input = {
      instance,
      rank: ranks[0] as (typeof ranks)[number],
      nnodes: 2,
      launch,
      generation: 2,
      attempt: 0,
      operationId: null,
      physical,
    };
    const stop = stopStep(input);
    expect(stop.headAddr).toBe("10.0.0.1");
    expect(stopStep({ ...input, phase: "STATUS" }).headAddr).toBe("10.0.0.1");
    expect(stop.intentHash).toBe(
      stopStep({ ...input, physical: { ...physical, headAddr: null } }).intentHash,
    );
    // Without a recorded address (or without a recorded launch) dispatch resolves it.
    expect(
      stopStep({ ...input, physical: { ...physical, headAddr: null } }).headAddr,
    ).toBeUndefined();
    expect(stopStep({ ...input, physical: undefined }).headAddr).toBeUndefined();
  });
});

describe("reservation nodes in a run's steps", () => {
  const single = runtimeLaunchSchema.parse({
    management: "service",
    groupSize: 1,
    resources: [{ kind: "unified", memoryGb: 8 }],
    reservations: [
      { labels: ["a"], resources: { kind: "unified", memoryGb: 8 } },
      { labels: ["b"], resources: { kind: "unified", memoryGb: 8 } },
    ],
    labels: [],
    commands: [{ start: "serve --port {{port}}", stop: "true", status: "true" }],
    health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
  });
  const solo = { ...instance, fabricId: null };
  const head = { rank: 0, port: 30_001, distPort: null, resources: { kind: "unified" } };
  const w1 = [
    { index: 1, nodeId: "nd-b", node: "worker-b" },
    { index: 0, nodeId: "nd-a", node: "worker-a" },
  ];
  const frameOf = (step: ReturnType<typeof generationSteps>[number], jobReservations: boolean) =>
    jobFrame({
      stepId: "st1",
      instanceId: solo.id,
      phase: step.phase,
      generation: step.generation,
      intent: step.intent,
      intentHash: step.intentHash,
      ownerEpoch: "e:1",
      headAddr: null,
      jobReservations,
    });

  it("every step of a single-node run carries them (index order); the job only to a CLI that reads them", () => {
    const steps = generationSteps({
      instance: solo,
      ranks: [head],
      launch: single,
      generation: 1,
      operationId: null,
      reservations: w1,
    });
    for (const step of steps)
      expect(step.intent.reservations).toEqual([
        { index: 0, nodeId: "nd-a", node: "worker-a" },
        { index: 1, nodeId: "nd-b", node: "worker-b" },
      ]);
    const start = steps.find((step) => step.phase === "START");
    if (!start) throw new Error("no start");
    const frame = frameOf(start, true);
    expect(runtimeJobFrameSchema.parse(frame)).toEqual(frame);
    expect(frame.reservations).toHaveLength(2);
    expect(frameOf(start, false).reservations).toBeUndefined();
    // Without reservations nothing changes: no key, the intent hash as before.
    const plain = generationSteps({
      instance: solo,
      ranks: [head],
      launch: single,
      generation: 1,
      operationId: null,
    }).find((step) => step.phase === "START");
    expect(plain?.intent).not.toHaveProperty("reservations");
    expect(frameOf(plain ?? start, true)).not.toHaveProperty("reservations");
  });

  it("a stop of a recorded launch names that launch's nodes, not the run's", () => {
    const [start] = generationSteps({
      instance: solo,
      ranks: [head],
      launch: single,
      generation: 1,
      operationId: null,
      reservations: w1,
    }).filter((step) => step.phase === "START");
    if (!start) throw new Error("no start");
    const stop = stopStep({
      instance: solo,
      rank: head,
      nnodes: 1,
      launch: single,
      generation: 2,
      attempt: 0,
      operationId: null,
      physical: { intent: start.intent, launch: single, headAddr: null },
      reservations: [{ index: 0, nodeId: "nd-c", node: "worker-c" }],
    });
    expect(stop.intent.reservations?.map((entry) => entry.nodeId)).toEqual(["nd-a", "nd-b"]);
  });

  it("a multi-node run never carries them", () => {
    const steps = generationSteps({
      instance,
      ranks,
      launch,
      generation: 1,
      operationId: null,
      reservations: w1,
    });
    for (const step of steps) expect(step.intent).not.toHaveProperty("reservations");
  });
});
