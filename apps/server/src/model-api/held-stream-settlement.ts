import type { ProtocolSurface } from "./protocols/index.js";

/**
 * Where a held provider response body is in its life. The body forwards chunks while
 * `streaming`; once a protocol terminal record is seen it holds the chunk that carried it and
 * keeps reading (bounded) toward EOF while `draining`; it settles the attempt durably while
 * `reconciling`, and only then exposes the held terminal chunk (`delivered`, after which the
 * next pull ends the body). A client cancel can interrupt any phase and owns the outcome.
 */
export type HeldStreamPhase =
  | { kind: "streaming" }
  | {
      kind: "draining";
      /** The chunk carrying the first protocol terminal record, withheld until settlement. */
      terminalChunk: Uint8Array;
      /** Wall-clock bound on reading past the terminal toward EOF. */
      deadline: number;
      /** Bytes read after the terminal record, bounded by the post-terminal drain cap. */
      postTerminalBytes: number;
    }
  | { kind: "reconciling"; terminalChunk: Uint8Array | undefined }
  | { kind: "delivered" }
  | { kind: "client_cancelled" };

/** What the body observed, as the settlement derivation needs it. */
export type HeldStreamObservation = {
  stream: boolean;
  /** HTTP status in [200, 400). */
  httpOk: boolean;
  /** The caller of reconciliation saw the body to its end (EOF or a bounded drain). */
  streamComplete: boolean;
  /** The provider transport reported a complete response. */
  responseComplete: boolean;
  /** A streaming protocol terminal record (success or failure) was observed. */
  protocolTerminal: boolean;
  /** A failure terminal record, a response depth violation, or a rejecting adapter. */
  protocolFailed: boolean;
  /** Usage accounting could not observe every record through EOF. */
  accountingIncomplete: boolean;
  /** The non-streaming body exceeded its retention bound. */
  nonstreamOverflow: boolean;
  /** The parsed non-streaming JSON object body, when there is one. */
  nonstreamEnvelope: Record<string, unknown> | undefined;
  surface: ProtocolSurface;
  /** The client cancelled the body before settlement began. */
  clientCancelled: boolean;
  /** The request signal had aborted when settlement began. */
  requestAborted: boolean;
  /** That abort was a lost capacity lease (a server failure, never a client cancel). */
  capacityLeaseLost: boolean;
};

export type HeldStreamSettlement = {
  ok: boolean;
  transportComplete: boolean;
  /** Usage may settle spend only from a complete observation. */
  observationComplete: boolean;
  /** Settled as a client cancellation (never when the capacity lease was lost). */
  cancelled: boolean;
  budgetReason: "COMPLETED" | "FAILED" | "CANCELLED";
  terminalState: "COMPLETED" | "FAILED" | "CANCELLED";
  eventReason: "COMPLETED" | "FAILED" | "CANCELLED" | "CAPACITY_LEASE_LOST";
};

/** Durable facts for an attempt whose request signal aborted. */
export function abortedAttemptFactsFor(capacityLeaseLost: boolean) {
  return capacityLeaseLost
    ? ({ reason: "CAPACITY_LEASE_LOST", terminalState: "FAILED", budgetReason: "FAILED" } as const)
    : ({ reason: "CANCELLED", terminalState: "CANCELLED", budgetReason: "CANCELLED" } as const);
}

function nonstreamEnvelopeFailed(
  envelope: Record<string, unknown> | undefined,
  surface: ProtocolSurface,
): boolean {
  if (!envelope) return false;
  if (envelope.error != null) return true;
  if (surface === "anthropic-messages" && envelope.type === "error") return true;
  return (
    surface === "openai-responses" &&
    ["failed", "cancelled", "incomplete"].includes(
      typeof envelope.status === "string" ? envelope.status : "",
    )
  );
}

/** The one derivation of a held provider attempt's durable outcome from what its body saw. */
export function deriveHeldStreamSettlement(input: HeldStreamObservation): HeldStreamSettlement {
  const transportComplete =
    input.streamComplete && (input.responseComplete || input.protocolTerminal);
  const hasEnvelope = input.nonstreamEnvelope !== undefined;
  const providerFailed =
    input.protocolFailed ||
    (!input.stream && nonstreamEnvelopeFailed(input.nonstreamEnvelope, input.surface));
  // A stream needs its protocol terminal; a non-stream needs a parsed envelope.
  const bodyTerminal = input.stream ? input.protocolTerminal : hasEnvelope;
  const ok =
    transportComplete && input.httpOk && bodyTerminal && !providerFailed && !input.clientCancelled;
  const observationComplete =
    transportComplete &&
    !input.accountingIncomplete &&
    (input.stream
      ? input.protocolTerminal && !input.protocolFailed
      : hasEnvelope && !input.nonstreamOverflow);
  const cancelled = input.clientCancelled && !input.capacityLeaseLost;
  const aborted = input.requestAborted ? abortedAttemptFactsFor(input.capacityLeaseLost) : null;
  const plain = ok ? "COMPLETED" : "FAILED";
  return {
    ok,
    transportComplete,
    observationComplete,
    cancelled,
    budgetReason: cancelled ? "CANCELLED" : (aborted?.budgetReason ?? plain),
    terminalState: cancelled ? "CANCELLED" : (aborted?.terminalState ?? plain),
    eventReason: cancelled ? "CANCELLED" : (aborted?.reason ?? plain),
  };
}
