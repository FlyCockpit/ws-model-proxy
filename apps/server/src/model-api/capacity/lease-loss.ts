import type { ModelApiFailure } from "../openai-errors.js";

/** Why a lease owner stopped holding its slot without anyone asking it to. */
export type CapacityLeaseLossKind =
  /** A heartbeat answered false: the row was reclaimed or its fencing token changed. */
  | "ownership_lost"
  /** The last acknowledged database TTL ran out before a renewal was acknowledged. */
  | "heartbeat_timeout"
  /** Heartbeats kept throwing until no retry fit inside the acknowledged TTL. */
  | "heartbeat_failed"
  /** The backstop lifetime cap fired (a route kept its owner past any relay deadline). */
  | "max_lifetime"
  /** The request scope that created the owner closed while the owner was still alive. */
  | "request_scope_closed";

/**
 * Abort reason for a dispatch whose capacity lease was lost. It is a server-side
 * failure, never a client cancellation: dispatches classify on `signal.reason`
 * (see `isCapacityLeaseLost`) and fail over or report a 5xx instead of 499.
 */
export class CapacityLeaseLostError extends Error {
  readonly kind: CapacityLeaseLossKind;

  constructor(kind: CapacityLeaseLossKind, options?: { cause?: unknown }) {
    super(`Capacity lease was lost (${kind}).`, options);
    this.name = "CapacityLeaseLostError";
    this.kind = kind;
  }
}

export function isCapacityLeaseLost(reason: unknown): reason is CapacityLeaseLostError {
  return reason instanceof CapacityLeaseLostError;
}

/** True when `signal` aborted because its capacity lease was lost. */
export function capacityLeaseLostSignal(signal: AbortSignal | undefined | null): boolean {
  return signal?.aborted === true && isCapacityLeaseLost(signal.reason);
}

/**
 * The ONE classifier for a precommit throw on a capacity-held path (F2-CAP-3):
 * true when the capacity lease was lost, whether the thrown error is the typed
 * loss or a transport/body error caused by the loss. A client abort is never a
 * lease loss. Callers evaluate it BEFORE their own cleanup releases the owner
 * (a release also aborts the lease signal, with a non-loss reason).
 */
export function precommitLeaseLost(
  error: unknown,
  leaseSignal: AbortSignal | undefined | null,
  clientSignal: AbortSignal,
): boolean {
  if (clientSignal.aborted) return false;
  return isCapacityLeaseLost(error) || capacityLeaseLostSignal(leaseSignal);
}

/**
 * The attempt terminal a local precommit catch records/serves. A lost lease
 * outranks an attempt that had already completed (or failed without a cause)
 * upstream: the client was served the lease-loss 503, not that result. A
 * failure with its own concrete class keeps it.
 */
export function servedLocalTerminal<T extends { ok: boolean; failure: ModelApiFailure | null }>(
  terminal: T,
  leaseLost: boolean,
): T {
  if (!leaseLost) return terminal;
  if (terminal.ok || terminal.failure === null || terminal.failure === "unknown")
    return { ...terminal, ok: false, failure: "capacity_lease_lost" };
  return terminal;
}
