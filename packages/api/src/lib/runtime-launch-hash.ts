import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import type { NodeMetricCommand, RuntimeSpec } from "./runtime-spec";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * THE node-side identity of a runtime version (B2): sha256 of the canonical JSON of `spec`.
 * Sent in `runtime.define` envelopes, held/frozen records and every `runtime.job`. Equal
 * launch hashes mean running instances adopt a new version live and nothing is re-pushed.
 */
export function runtimeLaunchHash(spec: RuntimeSpec): string {
  return sha256Hex(canonicalJson(spec));
}

/**
 * Server-only identity of a version: spec plus the admission columns and `advanced`. Used for
 * deduplication and audit; never sent to a node.
 */
export function runtimeContentHash(input: {
  spec: RuntimeSpec;
  limits: {
    concurrencyLimit: number | null;
    contextLimit: number | null;
    kvBudgetTokens: number | null;
    kvFullThreshold: number | null;
    engineLoadGate: "AUTO" | "ENFORCE" | "OBSERVE";
  };
  advanced: Record<string, unknown>;
}): string {
  return sha256Hex(canonicalJson(input));
}

/** `Node.metricCommandsHash` and `runtime.define.node.metricCommands.hash`. */
export function nodeMetricCommandsHash(commands: readonly NodeMetricCommand[]): string {
  return sha256Hex(canonicalJson(commands));
}
