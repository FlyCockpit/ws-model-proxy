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

export function unsupported(parameter: string, reason = "is not safely adaptable"): never {
  throw new AdapterError("unsupported_feature", `${parameter} ${reason}.`, parameter);
}

export function invalid(parameter: string, reason: string): never {
  throw new AdapterError("invalid_request", `${parameter} ${reason}.`, parameter);
}

const MAX_LOGGED_PARAMETER_CHARS = 128;

/**
 * Operator log for an upstream reply the adapter rejected. Logs `code` and
 * `parameter` only: some messages embed upstream values, and a parameter can
 * name an upstream key, so it is truncated. Cancellation is not a rejection.
 */
export function logAdapterRejection(
  error: unknown,
  direction: { source: ProtocolSurface; target: ProtocolSurface },
) {
  if (!(error instanceof AdapterError) || error.code === "cancelled") return;
  console.warn("[model-api] adapter rejected upstream reply", {
    source: direction.source,
    target: direction.target,
    code: error.code,
    parameter: error.parameter?.slice(0, MAX_LOGGED_PARAMETER_CHARS) ?? null,
  });
}
