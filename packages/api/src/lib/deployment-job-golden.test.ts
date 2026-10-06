import { readFileSync, writeFileSync } from "node:fs";
import { deploymentJobWireIssue } from "@ws-model-proxy/config/deployment-job-wire";
import type {
  DeploymentCommandAuthor,
  DeploymentJob,
} from "@ws-model-proxy/config/deployment-protocol";
import { validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import { describe, expect, it, vi } from "vitest";

import type { DeploymentNode } from "./deployment-planner";
import { deploymentDispatchShape, renderDeploymentGroup } from "./deployment-service";
import { deploymentVariantSchema, originalDeploymentStopIntent } from "./deployment-spec";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

/**
 * The cross-language deployment job golden is generated here from the server's own admission
 * renderer, so a change on either side shows up as a diff instead of hiding behind a
 * hand-written fixture. Regenerate with `UPDATE_DEPLOYMENT_JOB_GOLDEN=1`; the Rust tests
 * (`apps/cli/src/deployments/tests.rs`) and `apps/server/src/deployments/inventory-wire.test.ts`
 * read the same file. Run biome on the file after regenerating it.
 */
const GOLDEN = new URL(
  "../../../../apps/cli/tests/fixtures/relay-current/deployment-jobs.json",
  import.meta.url,
);
const TERMINAL_ID = "AAECAwQFBgcICQoLDA0ODw";
/** Terminal ids are never reused, so the stop has its own. */
const STOP_TERMINAL_ID = "EBESExQVFhcYGRobHB0eHw";
const OWNER_EPOCH = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f:7";

const node: DeploymentNode = {
  id: "node",
  online: true,
  protocolVersion: "2.4",
  allowDeployments: true,
  reportedDeployments: true,
  mode: "UNSUPERVISED",
  localMode: "UNSUPERVISED",
  execution: "systemd+linger",
  labels: [],
  info: { nodeKind: "unified", memoryTotalMiB: 128 * 1024, interfaces: [] },
  budgets: {
    usableMemoryGb: 120,
    usableRamGb: null,
    usableVramGb: {},
    usableMemoryGbDefault: false,
    usableRamGbDefault: false,
    usableVramGbDefaults: {},
  },
  portStart: 30000,
  portEnd: 30999,
};

function variant(commands: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return deploymentVariantSchema.parse({
    key: "default",
    engine: "vllm",
    groupSize: 1,
    resources: [{ kind: "unified", memoryGb: 64 }],
    commands: [commands],
    readiness: { path: "/health", timeoutMs: 600_000 },
    models: ["fixture/model"],
    attachment: { type: "llm", poolId: "pool" },
    hardConcurrencyLimit: 4,
    contextWindow: 32768,
    ...extra,
  });
}

/** The start intent of a single-node group, exactly as admission persists it. */
function renderedStart(v: ReturnType<typeof variant>) {
  const [rank] = renderDeploymentGroup(
    v,
    {
      id: "cm9instancefixture000000a",
      revisionId: "cm9revisionfixture000000a",
      endpointSlug: "inst-fixture-a1b2c3d4e5f6",
    },
    [
      {
        nodeId: "node",
        rank: 0,
        group: 0,
        resources: { kind: "unified", memoryGb: 64, ramGb: 0, gpus: [] },
        port: 30001,
        distPort: null,
      },
    ],
    [node],
  );
  const start = rank?.steps.find((step) => step.phase === "start");
  if (!start) throw new Error("no start step");
  return start.intent;
}

function dispatched(
  intent: Parameters<typeof deploymentDispatchShape>[0],
  stepId: string,
  commandAuthor: DeploymentCommandAuthor = "user",
  terminalId = TERMINAL_ID,
) {
  return deploymentDispatchShape(intent, {
    stepId,
    ownerEpoch: OWNER_EPOCH,
    actor: "USER",
    humanApproved: true,
    operator: { terminalId, commandAuthor },
  });
}

function generate() {
  const plainIntent = renderedStart(
    variant({
      management: "ownedProcess",
      start: "vllm serve fixture/model --port {{port}}",
      stop: "true",
    }),
  );
  const interactiveIntent = renderedStart(
    variant({
      management: "externalService",
      start: "sudo systemctl start fixture-vllm.service",
      stop: "sudo systemctl stop fixture-vllm.service",
      status: "systemctl is-active --quiet fixture-vllm.service",
      interactive: { start: true, stop: true },
    }),
  );
  const stopInteractiveIntent = renderedStart(
    variant({
      management: "ownedProcess",
      start: "vllm serve fixture/model --port {{port}}",
      stop: "sudo /usr/local/bin/fixture-stop",
      status: "pgrep -f fixture/model",
      interactive: { stop: true },
    }),
  );
  const jobs = {
    plainStart: dispatched(plainIntent, "tz4a98xxat96iws9zmbrgj3a"),
    interactiveStart: dispatched(interactiveIntent, "tz4a98xxat96iws9zmbrgj3b"),
    interactiveStop: dispatched(
      originalDeploymentStopIntent(interactiveIntent),
      "tz4a98xxat96iws9zmbrgj3c",
      "agent",
      STOP_TERMINAL_ID,
    ),
    stopInteractiveStart: dispatched(stopInteractiveIntent, "tz4a98xxat96iws9zmbrgj3d"),
  };
  const result = (job: DeploymentJob, extra: Record<string, unknown>) => ({
    type: "deployment.job.result",
    stepId: job.stepId,
    instanceId: job.instanceId,
    rank: job.rank,
    intentHash: job.intentHash,
    ownerEpoch: job.ownerEpoch,
    stopped: false,
    ...extra,
  });
  const j = jobs.interactiveStart;
  const results = {
    // Every result of an interactive job names its dispatch's terminal, finals included.
    interactiveRefused: result(j, {
      status: "failed",
      error: "interactive_unsupported",
      terminalId: TERMINAL_ID,
    }),
    operatorSucceeded: result(j, { status: "succeeded", terminalId: TERMINAL_ID }),
    stopInteractiveRefused: result(jobs.stopInteractiveStart, {
      status: "failed",
      error: "interactive_unsupported",
    }),
    awaitingOperator: result(j, { status: "awaiting_operator", terminalId: TERMINAL_ID }),
    operatorRunning: result(j, { status: "operator_running", terminalId: TERMINAL_ID }),
    operatorClosed: result(j, {
      status: "operator_closed",
      terminalId: TERMINAL_ID,
      exitCode: 1,
    }),
    operatorDeclined: result(j, { status: "operator_closed", terminalId: TERMINAL_ID }),
    // A terminal that could not open: retryable, the step still waits for its person.
    operatorTerminalFailed: result(j, {
      status: "operator_closed",
      terminalId: TERMINAL_ID,
      error: "operator_terminal_failed",
    }),
  };
  // Edge cases both validators must agree on: the TS mirror here, `Job::validate` in Rust.
  const plain = jobs.plainStart;
  const embeddings = (text: string): DeploymentJob => ({
    ...plain,
    attachment: "embeddings",
    embeddingContract: {
      model: text,
      revision: "r1",
      dimensions: 256,
      normalization: "l2",
      vectorSpace: "space",
    },
  });
  // Rust `char::is_whitespace`: U+0085 is whitespace, U+FEFF is not (JavaScript differs on both).
  const external = (status: string, stop = "true"): DeploymentJob => ({
    ...plain,
    management: "externalService",
    stopCommand: stop,
    statusCommand: status,
  });
  // A speech-to-text recipe that opts in to live transcription, rendered by admission.
  const realtimeStt = dispatched(
    renderedStart(
      variant(
        {
          management: "ownedProcess",
          start: "vllm serve fixture/model --port {{port}}",
          stop: "true",
        },
        {
          attachment: {
            type: "transcription",
            poolId: "pool",
            transcription: {
              languages: ["en"],
              realtime: { adapter: "vllm", maxItemSeconds: 300, maxSessions: 2 },
            },
          },
        },
      ),
    ),
    "tz4a98xxat96iws9zmbrgj3e",
  );
  const realtime = (value: unknown): DeploymentJob => ({
    ...realtimeStt,
    transcriptionProfile: { realtime: value as { adapter: "vllm" } },
  });
  const { contextWindow: _contextWindow, ...withoutContextWindow } = plain;
  // A dispatch never omits it, but `Option<u64>` in Rust decodes an absent field as None.
  const wireCases = {
    accepted: {
      operatorUnknownAuthorship: {
        ...jobs.interactiveStart,
        operator: { terminalId: TERMINAL_ID, commandAuthor: "unknown" },
      },
      statusFeffIsNotBlank: external("\ufeff"),
      stopFeffIsNotBlank: external("status", "\ufeff"),
      embeddingTextFeffIsNotBlank: embeddings("\ufeff"),
      contextWindowAbsent: withoutContextWindow,
      contextWindowAbove2To53: { ...plain, contextWindow: 2 ** 60 },
      endpointSlugSingleHyphens: { ...plain, endpointSlug: "inst-qwen-3-a1b2c3d4e5f6" },
      readinessPath2048Bytes: {
        ...plain,
        readiness: { ...plain.readiness, path: `/${"é".repeat(1023)}a` },
      },
      readinessQueryString: { ...plain, readiness: { ...plain.readiness, path: "/health?x=1" } },
      model256Bytes: { ...plain, models: ["é".repeat(128)] },
      embeddingText256Bytes: embeddings("é".repeat(128)),
      transcriptionRealtime: realtimeStt,
      realtimeSegmentedBounds: realtime({
        adapter: "segmented",
        maxItemSeconds: 120,
        maxSessions: 8,
      }),
      realtimeVllmMaxItem: realtime({ adapter: "vllm", maxItemSeconds: 600 }),
    },
    rejected: {
      endpointSlugTrailingHyphen: { ...plain, endpointSlug: "inst-qwen--a1b2c3d4e5f6" },
      endpointSlugDoubleHyphen: { ...plain, endpointSlug: "inst-qw--en-a1b2c3d4e5f6" },
      // Every `inst-` slug is outside the reserved list, so reserved words are exercised by
      // `slugCases` instead.
      endpointSlugWithoutPrefix: { ...plain, endpointSlug: "qwen-a1b2c3d4e5f6" },
      endpointSlugTooLong: { ...plain, endpointSlug: `inst-${"a".repeat(59)}` },
      statusU0085IsBlank: external("\u0085"),
      stopU0085IsBlank: external("status", "\u0085 "),
      statusIdeographicSpaceIsBlank: external("\u3000\u2028"),
      embeddingTextU0085IsBlank: embeddings("\u0085"),
      contextWindowNegative: { ...plain, contextWindow: -1 },
      contextWindowFraction: { ...plain, contextWindow: 1.5 },
      readinessFragment: { ...plain, readiness: { ...plain.readiness, path: "/health#x" } },
      readinessDoubleSlash: { ...plain, readiness: { ...plain.readiness, path: "//health" } },
      readinessPath2049Bytes: {
        ...plain,
        readiness: { ...plain.readiness, path: `/${"é".repeat(1024)}` },
      },
      readinessTimeoutTooLong: {
        ...plain,
        readiness: { ...plain.readiness, timeoutMs: 900_001 },
      },
      model257Bytes: { ...plain, models: ["é".repeat(128) + "a"] },
      embeddingText257Bytes: embeddings(`${"é".repeat(128)}a`),
      ownerEpochSlash: { ...plain, ownerEpoch: "epoch/7" },
      operatorNonCanonical: {
        ...jobs.interactiveStart,
        operator: { terminalId: "AAECAwQFBgcICQoLDA0ODx", commandAuthor: "user" },
      },
      operatorWithoutInteractive: {
        ...plain,
        operator: { terminalId: TERMINAL_ID, commandAuthor: "user" },
      },
      operatorNull: { ...jobs.interactiveStart, operator: null },
      operatorWithoutAuthor: {
        ...jobs.interactiveStart,
        operator: { terminalId: TERMINAL_ID },
      },
      operatorUnknownAuthor: {
        ...jobs.interactiveStart,
        operator: { terminalId: TERMINAL_ID, commandAuthor: "person" },
      },
      operatorExtraField: {
        ...jobs.interactiveStart,
        operator: { terminalId: TERMINAL_ID, commandAuthor: "user", viewerId: "x" },
      },
      realtimeUnknownAdapter: realtime({ adapter: "openai" }),
      realtimeWithoutAdapter: realtime({ maxSessions: 1 }),
      realtimeSegmentedItemTooLong: realtime({ adapter: "segmented", maxItemSeconds: 121 }),
      realtimeItemTooShort: realtime({ adapter: "vllm", maxItemSeconds: 4 }),
      realtimeTooManySessions: realtime({ adapter: "vllm", maxSessions: 9 }),
      realtimeUnknownKey: realtime({ adapter: "vllm", supported: true }),
      realtimeOnLlmAttachment: {
        ...plain,
        transcriptionProfile: { realtime: { adapter: "vllm" } },
      },
    },
  };
  // The forwarder slug rules (`validateForwarderSlug`, Rust `slug::validate_slug`) on their own,
  // including the reserved list.
  const slugCases = {
    accepted: ["abc", "inst-qwen-a1b2c3d4e5f6", "a".repeat(63), "healthy", "v12"],
    rejected: ["health", "api", "tokens", "ab", "-abc", "abc-", "a--b", "Abc", "a".repeat(64)],
  };
  return { protocolVersion: "2.4", jobs, results, wireCases, slugCases };
}

describe("deployment job golden generated from admission rendering", () => {
  const golden = generate();

  it("matches the committed golden", () => {
    const text = `${JSON.stringify(golden, null, 2)}\n`;
    if (process.env.UPDATE_DEPLOYMENT_JOB_GOLDEN === "1") writeFileSync(GOLDEN, text);
    expect(JSON.parse(readFileSync(GOLDEN, "utf8"))).toEqual(JSON.parse(text));
  });

  it("holds only deliverable rendered jobs", () => {
    for (const [name, job] of Object.entries(golden.jobs))
      expect(deploymentJobWireIssue(job), name).toBeNull();
  });

  it("agrees with the CLI on every edge case", () => {
    for (const [name, job] of Object.entries(golden.wireCases.accepted))
      expect(deploymentJobWireIssue(job as DeploymentJob), name).toBeNull();
    for (const [name, job] of Object.entries(golden.wireCases.rejected))
      expect(deploymentJobWireIssue(job as DeploymentJob), name).not.toBeNull();
    for (const slug of golden.slugCases.accepted)
      expect(validateForwarderSlug(slug).ok, slug).toBe(true);
    for (const slug of golden.slugCases.rejected)
      expect(validateForwarderSlug(slug).ok, slug).toBe(false);
    expect(validateForwarderSlug("health")).toEqual({ ok: false, reason: "reserved" });
  });
});
