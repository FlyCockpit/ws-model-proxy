import { readFileSync } from "node:fs";
import { deploymentFingerprint } from "@ws-model-proxy/api/lib/deployment-planner";
import {
  deploymentJobIntentSchema,
  originalDeploymentStopIntent,
} from "@ws-model-proxy/api/lib/deployment-spec";
import { coarseCapabilitiesFromOpenAi } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  DEPLOYMENT_PROTOCOL_VERSION,
  type DeploymentJob,
  deploymentJobFrameBytes,
  deploymentJobNeedsOperator,
} from "@ws-model-proxy/config/deployment-protocol";
import { describe, expect, it } from "vitest";
import {
  encodeRelayServerControlMessage,
  type OpenAiCompatibleCapabilities,
  parseRelayClientControlFrame,
  RELAY_PROTOCOL_VERSIONS,
} from "../relay/protocol.js";

const golden: { protocolVersion: string; empty: unknown[]; nonempty: unknown[] } = JSON.parse(
  readFileSync(
    new URL("../../../cli/tests/fixtures/relay-current/deployment-inventory.json", import.meta.url),
    "utf8",
  ),
);

describe("current Rust deployment encoder / Node decoder golden", () => {
  it("accepts the exact production Rust encoder's empty and nonempty snapshots", () => {
    expect(RELAY_PROTOCOL_VERSIONS).toEqual([golden.protocolVersion]);
    expect(DEPLOYMENT_PROTOCOL_VERSION).toBe(golden.protocolVersion);
    for (const input of [...golden.empty, ...golden.nonempty]) {
      expect(parseRelayClientControlFrame(JSON.stringify(input))).toEqual(input);
    }
  });
  it("rejects malformed snapshot identities, unknown fields, and invalid records", () => {
    const input = golden.nonempty[0] as Record<string, unknown>;
    for (const change of [
      { snapshotId: "old" },
      { unknown: true },
      { chunkIndex: -1 },
      { instances: [{ instanceId: "fixture" }] },
    ])
      expect(() => parseRelayClientControlFrame(JSON.stringify({ ...input, ...change }))).toThrow();
  });
  it("encodes only bounded durable acknowledgement identities", () => {
    expect(
      JSON.parse(
        encodeRelayServerControlMessage({
          type: "deployment.instances.ok",
          snapshotId: "A".repeat(32),
        }),
      ),
    ).toEqual({ type: "deployment.instances.ok", snapshotId: "A".repeat(32) });
    expect(() =>
      encodeRelayServerControlMessage({ type: "deployment.instances.ok", snapshotId: "old" }),
    ).toThrow();
  });
});

describe("current Rust transcription endpoint / Node inventory golden", () => {
  const endpoint: { defaultCapabilities: OpenAiCompatibleCapabilities } = JSON.parse(
    readFileSync(
      new URL(
        "../../../cli/tests/fixtures/relay-current/transcription-endpoint.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  it("accepts the exact speech-to-text endpoint a transcription recipe advertises", () => {
    const frame = { type: "inventory.update", id: "stt", endpoints: [endpoint] };
    // A rejected inventory would close the whole CLI connection as malformed.
    expect(() => parseRelayClientControlFrame(JSON.stringify(frame))).not.toThrow();
    expect(coarseCapabilitiesFromOpenAi(endpoint.defaultCapabilities)).toEqual(["AUDIO_INPUT"]);
  });
});

type GoldenJobName = "plainStart" | "interactiveStart" | "interactiveStop" | "stopInteractiveStart";
const jobGolden: {
  protocolVersion: string;
  jobs: Record<GoldenJobName, DeploymentJob>;
  results: Record<string, Record<string, unknown>>;
} = JSON.parse(
  readFileSync(
    new URL("../../../cli/tests/fixtures/relay-current/deployment-jobs.json", import.meta.url),
    "utf8",
  ),
);
/** The durable intent a job was dispatched from: everything but the per-dispatch fields. */
function intentOf(job: DeploymentJob) {
  const {
    stepId: _stepId,
    intentHash: _intentHash,
    ownerEpoch: _ownerEpoch,
    actor: _actor,
    humanApproved: _humanApproved,
    operator: _operator,
    ...intent
  } = job;
  return intent;
}

describe("current deployment job / result golden shared with the Rust decoder", () => {
  it("is the current protocol and pins a non-interactive job's intent hash", () => {
    expect(jobGolden.protocolVersion).toBe(DEPLOYMENT_PROTOCOL_VERSION);
    // A job without interactive commands hashes exactly as it did before 2.11.
    expect(jobGolden.jobs.plainStart.intentHash).toBe(
      "c207d85160e877498399c678104792dd0e1eea8529090aad0fed3b29d31e6e67",
    );
    expect(deploymentJobNeedsOperator(jobGolden.jobs.plainStart)).toBe(false);
  });

  it("holds only jobs the server can persist, hash and frame", () => {
    for (const [name, job] of Object.entries(jobGolden.jobs)) {
      const intent = intentOf(job);
      // Strict: the fixture is exactly the durable intent shape, and `operator` never is.
      expect(deploymentJobIntentSchema.parse(intent), name).toEqual(intent);
      expect(deploymentFingerprint(intent), name).toBe(job.intentHash);
      expect(
        deploymentJobIntentSchema.safeParse({ ...intent, operator: job.operator }).success,
      ).toBe(false);
      // The reconciler's owner epoch: `<uuid>:<connection generation>`.
      expect(job.ownerEpoch).toMatch(/^[0-9a-f-]{36}:\d+$/);
      const encoded = encodeRelayServerControlMessage(job);
      expect(JSON.parse(encoded), name).toEqual(job);
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(
        deploymentJobFrameBytes(intent) ?? 0,
      );
      expect(deploymentJobNeedsOperator(job), name).toBe(name !== "plainStart");
    }
    const { interactiveStart, interactiveStop } = jobGolden.jobs;
    // Terminal ids are per dispatch and never reused.
    expect(interactiveStart.operator?.terminalId).not.toEqual(interactiveStop.operator?.terminalId);
    expect(interactiveStart.operator?.commandAuthor).toBe("user");
    expect(interactiveStop.operator?.commandAuthor).toBe("agent");
    // The interactive stop is the start's derived stop intent.
    expect(intentOf(interactiveStop)).toEqual(
      originalDeploymentStopIntent(intentOf(interactiveStart)),
    );
  });

  it("frames an operator terminal with exactly the interactive jobs", () => {
    const { plainStart, interactiveStart } = jobGolden.jobs;
    const { operator, ...withoutOperator } = interactiveStart;
    const jobs: DeploymentJob[] = [
      withoutOperator,
      { ...plainStart, operator },
      { ...interactiveStart, operator: { terminalId: "too-short", commandAuthor: "user" } },
      { ...interactiveStart, operator: { terminalId: "A".repeat(23), commandAuthor: "user" } },
      // Decodes to 16 bytes in Node, but the CLI's strict base64 refuses the trailing bits.
      {
        ...interactiveStart,
        operator: { terminalId: "AAECAwQFBgcICQoLDA0ODx", commandAuthor: "user" },
      },
      { ...interactiveStart, operator: { ...operator, viewerId: "x" } as typeof operator },
      {
        ...interactiveStart,
        operator: { terminalId: operator?.terminalId } as unknown as typeof operator,
      },
      {
        ...interactiveStart,
        operator: { ...operator, commandAuthor: "person" } as unknown as typeof operator,
      },
    ];
    for (const job of jobs) expect(() => encodeRelayServerControlMessage(job)).toThrow(/operator/);
  });

  it("accepts every result the Rust encoder produces", () => {
    for (const [name, result] of Object.entries(jobGolden.results))
      expect(parseRelayClientControlFrame(JSON.stringify(result)), name).toEqual(result);
  });

  it("binds terminal ids and exit codes to the operator statuses", () => {
    const { awaitingOperator, operatorClosed, interactiveRefused } = jobGolden.results;
    for (const result of [
      { ...awaitingOperator, terminalId: undefined },
      { ...interactiveRefused, terminalId: awaitingOperator?.terminalId },
      { ...awaitingOperator, exitCode: 0 },
      { ...operatorClosed, exitCode: 256 },
      { ...operatorClosed, exitCode: -1 },
      { ...awaitingOperator, stopped: true },
      { ...awaitingOperator, terminalId: "bad" },
      { ...awaitingOperator, terminalId: "AAECAwQFBgcICQoLDA0ODx" },
      { ...awaitingOperator, status: "operator_paused" },
    ])
      expect(() => parseRelayClientControlFrame(JSON.stringify(result))).toThrow();
  });
});
