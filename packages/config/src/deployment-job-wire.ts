import {
  DEPLOYMENT_COMMAND_MAX_BYTES,
  type DeploymentJob,
  deploymentCommandBytes,
  isDeploymentCommandAuthor,
} from "./deployment-protocol";
import { validateForwarderSlug } from "./forwarder-identifiers";

/**
 * A TypeScript mirror of the CLI's `Job::validate` (`apps/cli/src/deployments/mod.rs`) and
 * of the shapes its strict decoder requires. The CLI refuses a job that fails any of these
 * rules with `bad_job` (or drops it undecoded), which would leave the instance stuck, so the
 * server refuses to admit any rendered job that fails here. The shared golden
 * (`apps/cli/tests/fixtures/relay-current/deployment-jobs.json`) holds accepted and rejected
 * cases that both implementations check.
 *
 * Returns the first rule a job breaks, or null when the CLI accepts it.
 */
export function deploymentJobWireIssue(job: DeploymentJob): string | null {
  const id = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (
    job.type !== "deployment.job" ||
    !id(job.stepId) ||
    !id(job.instanceId) ||
    !id(job.revisionId) ||
    // The reconciler's owner epoch is `<uuid>:<connection generation>`.
    !/^[A-Za-z0-9_:-]{1,128}$/.test(job.ownerEpoch)
  )
    return "identity";
  if (
    !uint(job.rank) ||
    job.rank >= 64 ||
    !/^[A-Za-z0-9]+$/.test(job.instanceId) ||
    job.unitName !== `wsmp-i-${job.instanceId}-r${job.rank}`
  )
    return "unit";
  if (!/^[0-9a-f]{64}$/.test(job.intentHash)) return "intent hash";
  if (
    !uint(job.port) ||
    job.port === 0 ||
    job.port > 65_535 ||
    !job.endpointSlug.startsWith("inst-") ||
    !validateForwarderSlug(job.endpointSlug).ok
  )
    return "endpoint slug";
  if (
    job.models.length === 0 ||
    job.models.length > 64 ||
    !job.models.every((m) => m.length > 0 && utf8(m) <= 256 && !m.includes("\0"))
  )
    return "models";
  if (!["llm", "embeddings", "transcription"].includes(job.attachment)) return "attachment";
  const { health, readiness } = job;
  if (
    !uint(health.intervalMs) ||
    health.intervalMs < 5_000 ||
    health.intervalMs > 300_000 ||
    !uint(health.failureThreshold) ||
    health.failureThreshold < 1 ||
    health.failureThreshold > 20 ||
    !uint(health.successThreshold) ||
    health.successThreshold < 1 ||
    health.successThreshold > 20
  )
    return "health policy";
  const readinessTimeout = (readiness as { timeoutMs?: number }).timeoutMs;
  if (
    !readiness.path.startsWith("/") ||
    readiness.path.startsWith("//") ||
    utf8(readiness.path) > 2048 ||
    /[\r\n#]/.test(readiness.path) ||
    !uint(readiness.expectedStatus) ||
    readiness.expectedStatus < 200 ||
    readiness.expectedStatus > 399 ||
    (readinessTimeout !== undefined &&
      (!uint(readinessTimeout) || readinessTimeout < 1_000 || readinessTimeout > 900_000))
  )
    return "readiness";
  const maximum = ["start", "prepare", "after_join", "readiness"].includes(job.action)
    ? 900_000
    : job.action === "stop"
      ? 300_000
      : 30_000;
  if (!uint(job.timeoutMs) || job.timeoutMs < 1 || job.timeoutMs > maximum) return "timeout";
  // `Option<u64>`: absent, null, or any non-negative integer below 2^64.
  if (
    job.contextWindow != null &&
    !(Number.isInteger(job.contextWindow) && job.contextWindow >= 0 && job.contextWindow < 2 ** 64)
  )
    return "context window";
  for (const command of [job.command, job.stopCommand, job.statusCommand, job.healthCommand]) {
    const text = command ?? "";
    if (deploymentCommandBytes(text) > DEPLOYMENT_COMMAND_MAX_BYTES || text.includes("\0"))
      return "command";
  }
  if (
    job.management === "externalService" &&
    (rustBlank(job.stopCommand) || rustBlank(job.statusCommand))
  )
    return "external service proof";
  const profile = job.transcriptionProfile;
  if (profile) {
    const tokens = (values: string[] | undefined, max: number) =>
      values === undefined ||
      (values.length <= max && values.every((v) => /^[A-Za-z0-9_.+/-]{1,64}$/.test(v)));
    if (
      job.attachment !== "transcription" ||
      !tokens(profile.responseFormats, 8) ||
      !tokens(profile.timestampGranularities, 4) ||
      !tokens(profile.languages, 128) ||
      !tokens(profile.acceptedMimeTypes, 16) ||
      (profile.maxUploadBytes !== undefined &&
        (!uint(profile.maxUploadBytes) ||
          profile.maxUploadBytes < 1 ||
          profile.maxUploadBytes > 2 ** 31 - 1))
    )
      return "transcription profile";
  }
  const contract = job.embeddingContract;
  if (
    contract &&
    (!uint(contract.dimensions) ||
      contract.dimensions < 1 ||
      contract.dimensions > 1_000_000 ||
      !["none", "l2"].includes(contract.normalization) ||
      ![contract.model, contract.revision, contract.vectorSpace].every(
        (v) => !rustBlank(v) && utf8(v) <= 256,
      ))
  )
    return "embedding contract";
  return interactiveIssue(job);
}

function interactiveIssue(job: DeploymentJob): string | null {
  const flags = job as { interactive?: unknown; stopInteractive?: unknown };
  if (
    (flags.interactive !== undefined && flags.interactive !== true) ||
    (flags.stopInteractive !== undefined && flags.stopInteractive !== true)
  )
    return "interactive flag";
  const interactive = job.interactive === true;
  if (interactive !== (job.operator !== undefined)) return "operator";
  if (job.operator !== undefined && !deploymentJobOperatorValid(job.operator)) return "operator";
  if (interactive) {
    if (!["prepare", "start", "after_join", "stop"].includes(job.action))
      return "interactive action";
    if (
      (job.action === "start" || job.action === "after_join") &&
      job.management !== "externalService"
    )
      return "interactive management";
  }
  if ((interactive || job.stopInteractive === true) && rustBlank(job.statusCommand))
    return "interactive status";
  return null;
}

/**
 * The operator object exactly as the CLI's strict decoder takes it: a canonical terminal ID and
 * a known command author, nothing else.
 */
export function deploymentJobOperatorValid(operator: unknown): boolean {
  if (typeof operator !== "object" || operator === null || Array.isArray(operator)) return false;
  const keys = Object.keys(operator).sort();
  const value = operator as { terminalId?: unknown; commandAuthor?: unknown };
  return (
    keys.length === 2 &&
    keys[0] === "commandAuthor" &&
    keys[1] === "terminalId" &&
    typeof value.terminalId === "string" &&
    isCanonicalBase64Url16(value.terminalId) &&
    isDeploymentCommandAuthor(value.commandAuthor)
  );
}

/** 16 bytes as canonical unpadded base64url (22 characters, zero trailing bits). */
export function isCanonicalBase64Url16(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) return false;
  // The 22nd character carries 2 data bits; its 4 low bits must be zero ("A", "Q", "g", "w").
  return "AQgw".includes(value.charAt(21));
}

/**
 * Rust `str::trim().is_empty()`: only Unicode White_Space (`char::is_whitespace`) counts, so
 * U+0085 is blank and U+FEFF is not (JavaScript `trim()` differs on both).
 */
const RUST_WHITESPACE = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;
export function rustBlank(value: string | null | undefined): boolean {
  return !value || RUST_WHITESPACE.test(value);
}

function uint(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}
function utf8(value: string) {
  return deploymentCommandBytes(value);
}
