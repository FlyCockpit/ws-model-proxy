import {
  DEPLOYMENT_JOB_FRAME_MAX_BYTES,
  deploymentJobFrameBytes,
} from "@ws-model-proxy/config/deployment-protocol";
import { describe, expect, it } from "vitest";
import {
  deploymentDerivedIntents,
  deploymentHealthIntent,
  deploymentJobIntentSchema,
  originalDeploymentStopIntent,
} from "./deployment-job-intent";
import { deploymentFingerprint } from "./deployment-planner";
import { deploymentVariantSchema } from "./deployment-spec";

const original = {
  type: "deployment.job",
  instanceId: "original",
  revisionId: "original-revision",
  rank: 1,
  attachment: "embeddings",
  engine: "vllm",
  management: "externalService",
  action: "start",
  embeddingContract: {
    model: "embedding",
    revision: "r1",
    dimensions: 256,
    normalization: "l2",
    vectorSpace: "space1",
  },
  command: "original-start",
  stopCommand: "original-stop",
  statusCommand: "original-status",
  healthCommand: "original-health",
  timeoutMs: 60_000,
  unitName: "wsmp-i-original-r1",
  port: 30001,
  endpointSlug: "inst-original",
  models: ["embedding"],
  contextWindow: 8192,
  readiness: { path: "/original-readiness", expectedStatus: 202, timeoutMs: 60000 },
  health: { intervalMs: 30_000, failureThreshold: 3, successThreshold: 1 },
};
describe("strict durable deployment identity", () => {
  it("preserves the entire original external/owned immutable identity when constructing STOP", () => {
    for (const management of ["externalService", "ownedProcess"]) {
      const base = { ...original, management };
      const stop = originalDeploymentStopIntent(base);
      expect(stop).toEqual({
        ...base,
        action: "stop",
        command: "original-stop",
        timeoutMs: 300_000,
      });
      expect(stop.management).toBe(management);
      expect(deploymentFingerprint(stop)).not.toBe(deploymentFingerprint(base));
    }
  });
  it("rejects absent/invalid management and unknown fields instead of stripping execution identity", () => {
    const { management: _management, ...missing } = original;
    expect(deploymentJobIntentSchema.safeParse(missing).success).toBe(false);
    expect(
      deploymentJobIntentSchema.safeParse({ ...original, management: "guessed" }).success,
    ).toBe(false);
    expect(
      deploymentJobIntentSchema.safeParse({ ...original, unrecognizedIdentity: "danger" }).success,
    ).toBe(false);
    expect(deploymentJobIntentSchema.parse(original).management).toBe("externalService");
  });
  it("external status/stop must be explicit and nonblank; owned status is optional", () => {
    expect(deploymentJobIntentSchema.safeParse({ ...original, statusCommand: " " }).success).toBe(
      false,
    );
    expect(deploymentJobIntentSchema.safeParse({ ...original, stopCommand: " " }).success).toBe(
      false,
    );
    expect(
      deploymentJobIntentSchema.safeParse({
        ...original,
        management: "ownedProcess",
        statusCommand: null,
      }).success,
    ).toBe(true);
    const variant = {
      key: "one",
      groupSize: 1,
      resources: [{ kind: "cpu", ramGb: 1 }],
      commands: [{ management: "externalService", start: "start", stop: " ", status: "status" }],
      readiness: {},
      models: ["one"],
      attachment: { type: "llm", poolId: "pool" },
      hardConcurrencyLimit: 1,
    };
    expect(deploymentVariantSchema.safeParse(variant).success).toBe(false);
  });
  it("hashes the actual identity independently of PostgreSQL JSON key order, preserving array order", () => {
    expect(deploymentFingerprint(original)).toBe(
      deploymentFingerprint(Object.fromEntries(Object.entries(original).reverse())),
    );
    expect(deploymentFingerprint({ ...original, management: "ownedProcess" })).not.toBe(
      deploymentFingerprint(original),
    );
    expect(deploymentFingerprint({ ranks: [0, 1] })).not.toBe(
      deploymentFingerprint({ ranks: [1, 0] }),
    );
  });
});

describe("deliverable deployment job frames", () => {
  const start = deploymentJobIntentSchema.parse(original);
  const bytes = (intent: unknown) =>
    deploymentJobFrameBytes(deploymentJobIntentSchema.parse(intent));
  // Pads the start command so the worst-case frame is exactly `target` bytes.
  const sized = (target: number, unit = "a") => {
    const base = bytes({ ...original, command: "" }) ?? 0;
    const unitBytes = (bytes({ ...original, command: unit }) ?? 0) - base;
    return { ...original, command: unit.repeat((target - base) / unitBytes) };
  };
  it("derives stop and health from a start, and nothing from other phases", () => {
    expect(deploymentDerivedIntents(original).map((i) => i.action)).toEqual([
      "start",
      "stop",
      "health",
    ]);
    expect(deploymentHealthIntent(original)).toEqual({
      ...start,
      action: "health",
      command: "original-health",
      timeoutMs: 30_000,
    });
    expect(deploymentDerivedIntents({ ...original, action: "readiness" })).toHaveLength(1);
  });
  it("accepts a frame of exactly the limit and rejects one byte more", () => {
    const exact = sized(DEPLOYMENT_JOB_FRAME_MAX_BYTES);
    expect(bytes(exact)).toBe(DEPLOYMENT_JOB_FRAME_MAX_BYTES);
    expect(bytes({ ...exact, command: `${exact.command}a` })).toBe(
      DEPLOYMENT_JOB_FRAME_MAX_BYTES + 1,
    );
  });
  it("counts UTF-8 bytes and JSON escapes, not characters", () => {
    const base = bytes({ ...original, command: "" }) ?? 0;
    expect(bytes({ ...original, command: "é" })).toBe(base + 2);
    expect(bytes({ ...original, command: "😀" })).toBe(base + 4);
    expect(bytes({ ...original, command: '"' })).toBe(base + 2);
    expect(bytes({ ...original, command: "\n" })).toBe(base + 2);
    expect(bytes({ ...original, command: "\u0001" })).toBe(base + 6);
  });
  it("refuses text the relay can never frame", () => {
    expect(bytes({ ...original, command: "\ud800" })).toBeNull();
    expect(bytes({ ...original, healthCommand: "x\udc00" })).toBeNull();
    expect(bytes({ ...original, command: "😀" })).not.toBeNull();
  });
  it("a small start whose immutable stop is too large is caught through its derived jobs", () => {
    // The STOP job carries the stop command twice (as its command and as stopCommand).
    const intent = { ...original, command: "true", stopCommand: "s".repeat(32_768) };
    const [startBytes, stopBytes] = deploymentDerivedIntents(intent).map((job) =>
      deploymentJobFrameBytes(job),
    );
    expect(startBytes).toBeLessThanOrEqual(DEPLOYMENT_JOB_FRAME_MAX_BYTES);
    expect(stopBytes).toBeGreaterThan(DEPLOYMENT_JOB_FRAME_MAX_BYTES);
  });
});
