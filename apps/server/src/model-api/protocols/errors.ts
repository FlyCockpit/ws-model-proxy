import { REQUEST_JSON_DEPTH_ERROR, requestJsonDepthExceeded } from "../request-json-depth.js";
import type { ProtocolSurface } from "./canonical.js";

export class AdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly parameter?: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

/** Every JSON-string expansion has its own depth-0 acceptance boundary. */
export function parseEmbeddedJson(value: string, parameter: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid(parameter, "must be a complete JSON object");
  }
  if (requestJsonDepthExceeded(parsed))
    throw new AdapterError("request_json_depth_exceeded", REQUEST_JSON_DEPTH_ERROR, parameter);
  return parsed;
}

export function isRequestDepthError(error: unknown): error is AdapterError {
  return error instanceof AdapterError && error.code === "request_json_depth_exceeded";
}

export function unsupported(parameter: string, reason = "is not safely adaptable"): never {
  throw new AdapterError("unsupported_feature", `${parameter} ${reason}.`, parameter);
}

export function invalid(parameter: string, reason: string): never {
  throw new AdapterError("invalid_request", `${parameter} ${reason}.`, parameter);
}

const MAX_LOGGED_PARAMETER_CHARS = 128;

/** Server-issued ids that locate an adapted reply. Ids only, never content. */
export type AdapterLogContext = {
  relayRequestId?: string;
  poolMemberId?: string;
  executionTargetId?: string;
};

/**
 * Operator log for an upstream reply the adapter rejected. Logs `code`,
 * `parameter` and the request/target ids only: some messages embed upstream
 * values, and a parameter can name an upstream key, so it is truncated.
 * Cancellation is not a rejection.
 */
export function logAdapterRejection(
  error: unknown,
  direction: { source: ProtocolSurface; target: ProtocolSurface },
  context: AdapterLogContext = {},
) {
  if (!(error instanceof AdapterError) || error.code === "cancelled") return;
  console.warn("[model-api] adapter rejected upstream reply", {
    source: direction.source,
    target: direction.target,
    code: error.code,
    parameter: error.parameter?.slice(0, MAX_LOGGED_PARAMETER_CHARS) ?? null,
    ...(context.relayRequestId ? { relayRequestId: context.relayRequestId } : {}),
    ...(context.poolMemberId ? { poolMemberId: context.poolMemberId } : {}),
    ...(context.executionTargetId ? { executionTargetId: context.executionTargetId } : {}),
  });
}
