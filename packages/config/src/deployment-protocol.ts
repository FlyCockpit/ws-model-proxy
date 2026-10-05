/**
 * Relay 2.11 deployment jobs. The step ID is an idempotency key across reconnects.
 *
 * 2.11 adds interactive (operator-run) commands to the first deployment protocol: the
 * `interactive`/`stopInteractive` job fields, `DeploymentJob.operator`, the operator progress
 * statuses on `DeploymentJobResult`, and the `deploymentOperator` hello feature.
 */
export const DEPLOYMENT_PROTOCOL_VERSION = "2.11";

/**
 * The node can run interactive jobs: it speaks the deployment protocol, reports deployments,
 * and reports the `deploymentOperator` feature.
 */
export function deploymentOperatorSupported(node: {
  protocolVersion: string | null | undefined;
  deployments?: boolean | null;
  deploymentOperator?: boolean | null;
}): boolean {
  return (
    node.protocolVersion === DEPLOYMENT_PROTOCOL_VERSION &&
    node.deployments === true &&
    node.deploymentOperator === true
  );
}

/** A job that only a `deploymentOperatorSupported` node may receive. */
export function deploymentJobNeedsOperator(
  job: Pick<DeploymentJob, "interactive" | "stopInteractive" | "operator">,
): boolean {
  return job.interactive === true || job.stopInteractive === true || job.operator !== undefined;
}

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
  /** A person runs `command` in an operator terminal; present only when true. */
  interactive?: true;
  /** The rank's stop command is interactive; present only when true. */
  stopInteractive?: true;
  /**
   * 2.11. Present exactly when `interactive`: the operator terminal minted for this dispatch
   * (16 random bytes, base64url). Per dispatch, so it is not part of the hashed intent.
   */
  operator?: { terminalId: string };
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
  /**
   * `running` is progress. 2.11 operator progress for interactive jobs (never final):
   * `awaiting_operator` (terminal spawned, confirm screen drawn), `operator_running` (the
   * operator pressed Enter and the command started) and `operator_closed` (declined, or the
   * terminal ended without success). Each carries the job's `operator.terminalId`.
   */
  status: DeploymentJobResultStatus;
  /** True only after stop command and process ownership teardown succeed. */
  stopped: boolean;
  /** Operational failure codes only: never persist command output/model content. */
  error?: string;
  /** 2.11: present exactly on the operator statuses; equals the job's `operator.terminalId`. */
  terminalId?: string;
  /** 2.11, `operator_closed` only: the last attempt's exit code, absent when nothing ran. */
  exitCode?: number;
};
export const DEPLOYMENT_OPERATOR_RESULT_STATUSES = [
  "awaiting_operator",
  "operator_running",
  "operator_closed",
] as const;
export type DeploymentOperatorResultStatus = (typeof DEPLOYMENT_OPERATOR_RESULT_STATUSES)[number];
export type DeploymentJobResultStatus =
  | "succeeded"
  | "failed"
  | "running"
  | DeploymentOperatorResultStatus;
export function deploymentOperatorResultStatus(
  status: DeploymentJobResultStatus,
): status is DeploymentOperatorResultStatus {
  return (DEPLOYMENT_OPERATOR_RESULT_STATUSES as readonly string[]).includes(status);
}
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
/** Per-dispatch fields admission never sees: the envelope plus the operator terminal. */
type DeploymentDispatchFields = keyof DeploymentDispatchEnvelope | "operator";
/**
 * Upper bounds for the per-dispatch fields: step IDs are 24-character cuid2s, intent hashes
 * are SHA-256 hex, and owner epochs are `<uuid>:<connection generation>`. An interactive
 * intent also carries `operator.terminalId` (22 base64url characters).
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
  intent: Omit<DeploymentJob, DeploymentDispatchFields>,
): number | null {
  let wellFormed = true;
  const dispatch: Pick<DeploymentJob, DeploymentDispatchFields> = intent.interactive
    ? { ...WORST_CASE_DISPATCH, operator: { terminalId: "A".repeat(22) } }
    : WORST_CASE_DISPATCH;
  const frame = JSON.stringify({ ...intent, ...dispatch }, (key, value: unknown) => {
    if (
      UNPAIRED_SURROGATE.test(key) ||
      (typeof value === "string" && UNPAIRED_SURROGATE.test(value))
    )
      wellFormed = false;
    return value;
  });
  return wellFormed ? new TextEncoder().encode(frame).byteLength : null;
}
