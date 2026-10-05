/** Relay 2.10 deployment jobs. The step ID is an idempotency key across reconnects. */
export const DEPLOYMENT_PROTOCOL_VERSION = "2.10";
export type DeploymentJobAction =
  | "prepare"
  | "start"
  | "after_join"
  | "readiness"
  | "health"
  | "stop"
  | "status";
export type DeploymentJob = {
  type: "deployment.job";
  stepId: string;
  instanceId: string;
  revisionId: string;
  rank: number;
  action: DeploymentJobAction;
  /** Hash binds retries to exactly the original execution intent. */
  intentHash: string;
  /** Dispatcher/socket lease fence; echoed by every result. */
  ownerEpoch: string;
  actor: "USER" | "AGENT";
  humanApproved: boolean;
  attachment: "llm" | "embeddings" | "transcription";
  /** Explicit immutable recipe declaration; unknown engines remain other. */
  engine: "vllm" | "sglang" | "llama.cpp" | "other";
  /** Owned processes remain in the unit cgroup; external services require stop/status proof. */
  management: "ownedProcess" | "externalService";
  embeddingContract?: {
    model: string;
    revision: string;
    dimensions: number;
    normalization: "none" | "l2";
    vectorSpace: string;
  };
  /** Options a speech-to-text server accepts; advertised for routing. */
  transcriptionProfile?: {
    streaming?: boolean;
    responseFormats?: string[];
    timestampGranularities?: string[];
    diarization?: boolean;
    languages?: string[];
    languageDetection?: boolean;
    multipleLanguageHints?: boolean;
    maxUploadBytes?: number;
    acceptedMimeTypes?: string[];
  };
  command: string;
  stopCommand?: string;
  statusCommand?: string | null;
  healthCommand?: string | null;
  timeoutMs: number;
  unitName: string;
  port: number;
  endpointSlug: string;
  models: string[];
  contextWindow: number | null;
  readiness: { path: string; expectedStatus: number };
  health: { intervalMs: number; failureThreshold: number; successThreshold: number };
};
export type DeploymentJobResult = {
  type: "deployment.job.result";
  stepId: string;
  instanceId: string;
  rank: number;
  intentHash: string;
  ownerEpoch: string;
  status: "succeeded" | "failed" | "running";
  /** True only after stop command and process ownership teardown succeed. */
  stopped: boolean;
  /** Operational failure codes only: never persist command output/model content. */
  error?: string;
};
export type DeploymentObservedInstance = {
  stepId?: string;
  instanceId: string;
  revisionId: string;
  rank: number;
  intentHash: string;
  phase: "starting" | "ready" | "unhealthy" | "stopping" | "stopped" | "unknown";
  unitName: string;
  port: number;
  endpointSlug: string;
  models: string[];
  contextWindow: number | null;
};
export type DeploymentInstancesFrame = {
  type: "deployment.instances";
  /** A complete, ordered snapshot is required before this socket may dispatch. */
  snapshotId: string;
  chunkIndex: number;
  final: boolean;
  instances: DeploymentObservedInstance[];
};

/** Sent only after the complete current-session snapshot has durably committed. */
export type DeploymentInstancesOk = {
  type: "deployment.instances.ok";
  snapshotId: string;
};

/**
 * Largest UTF-8 byte length of any deployment command, both as saved in a recipe and after
 * placeholder substitution. Must equal `DEPLOYMENT_COMMAND_MAX_BYTES` in
 * `apps/cli/src/deployments/mod.rs`: the CLI refuses any job carrying a longer command, so a
 * longer one accepted here would leave its instance stuck.
 */
export const DEPLOYMENT_COMMAND_MAX_BYTES = 4096;
/** UTF-8 byte length of a command, as the CLI measures it. */
export function deploymentCommandBytes(command: string): number {
  return new TextEncoder().encode(command).byteLength;
}

/** The CLI decodes deployment jobs only from JSON control frames up to this size (`RELAY_JSON_CONTROL_MAX_BYTES`). */
export const DEPLOYMENT_JOB_FRAME_MAX_BYTES = 64 * 1024;
type DeploymentDispatchEnvelope = Pick<
  DeploymentJob,
  "stepId" | "intentHash" | "ownerEpoch" | "actor" | "humanApproved"
>;
/**
 * Upper bounds for the per-dispatch fields: step IDs are 24-character cuid2s, intent hashes
 * are SHA-256 hex, and owner epochs are `<uuid>:<connection generation>`.
 */
const WORST_CASE_DISPATCH: DeploymentDispatchEnvelope = {
  stepId: "s".repeat(64),
  intentHash: "0".repeat(64),
  ownerEpoch: `${"0".repeat(36)}:${"9".repeat(16)}`,
  actor: "AGENT",
  humanApproved: false,
};
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/**
 * UTF-8 size of the largest relay frame any dispatch of this durable intent can produce, or
 * `null` when it can never be framed (the relay refuses unpaired surrogates). Admission uses
 * this before committing claims, so every persisted job stays deliverable.
 */
export function deploymentJobFrameBytes(
  intent: Omit<DeploymentJob, keyof DeploymentDispatchEnvelope>,
): number | null {
  let wellFormed = true;
  const frame = JSON.stringify({ ...intent, ...WORST_CASE_DISPATCH }, (key, value: unknown) => {
    if (
      UNPAIRED_SURROGATE.test(key) ||
      (typeof value === "string" && UNPAIRED_SURROGATE.test(value))
    )
      wellFormed = false;
    return value;
  });
  return wellFormed ? new TextEncoder().encode(frame).byteLength : null;
}
