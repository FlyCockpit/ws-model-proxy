/**
 * The explicit lifecycles of the relay session manager (`session-manager.ts`): one node
 * socket's handshake phase, and the manager's own running / draining / disposed state.
 *
 * Node session phases, in the only order they can occur:
 *
 *   awaiting_hello --hello--> registering --registerNodeHello--> registered --hello.ok--> ready
 *         \                        \                                 \                      \
 *          `------------------------`---------------------------------`----------------------`--> closed
 *
 * - `awaiting_hello`: authenticated, `hello.challenge` sent; holds the one-shot nonce and the
 *   registration deadline.
 * - `registering`: the nonce was consumed by a hello whose registration is in flight; nothing
 *   but that hello's outcome moves it on (a second hello is refused).
 * - `registered`: the node's registration committed and the session is installed for it; the
 *   handshake (trust sync, definition sync) runs, `hello.ok` not sent yet.
 * - `ready`: `hello.ok` was sent; lane frames may follow.
 * - `closed`: detached, replaced or refused. A session closed after registering keeps its node
 *   identity, so work still in flight on it can name the node it was for.
 */
import type { NodeFeatures } from "@ws-model-proxy/api/lib/runtime-spec";
import type { NodeToServerControlFrame } from "./frames.js";
import type { RoutingEvaluationState } from "./metric-routing-evaluator.js";

type HelloFrame = Extract<NodeToServerControlFrame, { type: "hello" }>;
export type TerminalIdentity = NonNullable<HelloFrame["node"]["terminalIdentity"]>;
type Timer = ReturnType<typeof setTimeout>;

/** What a verified, committed hello established about the node on this socket. */
export type RegisteredNode = {
  readonly nodeId: string;
  readonly slug: string;
  /**
   * The node's connection generation this session was accepted under. A disconnect write
   * presents it and is refused once the node has accepted a later connection. Raised only to
   * adopt a newer generation a detached hello committed (`settleDetachedRegistration`).
   */
  connectionGeneration: number;
  readonly protocolVersion: string;
  readonly nodeVersion: string | null;
  /** As the node last reported them (hello, then `node.state`). */
  features: NodeFeatures;
  readonly terminalPublicKey: string;
  readonly terminalIdentity: TerminalIdentity | null;
  /** This session's metric routing verdicts; cancelled when the session closes. */
  readonly routingEvaluation: RoutingEvaluationState;
};

export type SessionPhase =
  | { readonly kind: "awaiting_hello"; readonly nonce: string; readonly deadline: Timer }
  | { readonly kind: "registering"; readonly deadline: Timer }
  | { readonly kind: "registered"; readonly node: RegisteredNode }
  | { readonly kind: "ready"; readonly node: RegisteredNode }
  | { readonly kind: "closed"; readonly node: RegisteredNode | null };

/** Anything that holds a session phase (the manager's `SessionState`). */
export type PhaseHolder = { phase: SessionPhase };

export function awaitingHello(nonce: string, deadline: Timer): SessionPhase {
  return { kind: "awaiting_hello", nonce, deadline };
}

/**
 * A hello arrived: consume the challenge nonce (`awaiting_hello` -> `registering`). Null, with
 * nothing changed, when the session is past its challenge (a second hello).
 */
export function beginRegistration(holder: PhaseHolder): string | null {
  const phase = holder.phase;
  if (phase.kind !== "awaiting_hello") return null;
  holder.phase = { kind: "registering", deadline: phase.deadline };
  return phase.nonce;
}

/** The registration committed and the session is installed (`registering` -> `registered`). */
export function installRegistered(holder: PhaseHolder, node: RegisteredNode): boolean {
  const phase = holder.phase;
  if (phase.kind !== "registering") return false;
  clearTimeout(phase.deadline);
  holder.phase = { kind: "registered", node };
  return true;
}

/** `hello.ok` was sent (`registered` -> `ready`). */
export function acknowledgeHello(holder: PhaseHolder): boolean {
  const phase = holder.phase;
  if (phase.kind !== "registered") return false;
  holder.phase = { kind: "ready", node: phase.node };
  return true;
}

/**
 * The one way out: any phase -> `closed` (the registration deadline is cleared). Returns the
 * node the session had installed when this call closed it, null when it never registered or
 * was closed already (so per-node cleanup runs once).
 */
export function closePhase(holder: PhaseHolder): { closed: boolean; node: RegisteredNode | null } {
  const phase = holder.phase;
  if (phase.kind === "closed") return { closed: false, node: null };
  if (phase.kind === "awaiting_hello" || phase.kind === "registering") {
    clearTimeout(phase.deadline);
    holder.phase = { kind: "closed", node: null };
    return { closed: true, node: null };
  }
  holder.phase = { kind: "closed", node: phase.node };
  return { closed: true, node: phase.node };
}

/** Before any registration committed: only hello (or its refusal) may happen. */
export function preRegistration(phase: SessionPhase): boolean {
  return phase.kind === "awaiting_hello" || phase.kind === "registering";
}

/**
 * The node this session registered for, also after it closed: what in-flight work names. Null
 * before registration and for a session closed before it registered.
 */
export function registeredNode(phase: SessionPhase): RegisteredNode | null {
  return phase.kind === "awaiting_hello" || phase.kind === "registering" ? null : phase.node;
}

/** Installed and serving its node (`registered` or `ready`): node frames are accepted. */
export function liveNode(phase: SessionPhase): RegisteredNode | null {
  return phase.kind === "registered" || phase.kind === "ready" ? phase.node : null;
}

/** `hello.ok` was sent and the session is not closed: lane frames may be sent. */
export function readyNode(phase: SessionPhase): RegisteredNode | null {
  return phase.kind === "ready" ? phase.node : null;
}

/**
 * The manager's own lifecycle, one-way: `running` -> `draining` (shutdown began: new sockets
 * and new work are refused, idle node sockets close) -> `disposed` (background recovery and
 * retries stopped too). `dispose` implies the drain.
 */
export type ManagerLifecycle = "running" | "draining" | "disposed";

const LIFECYCLE_ORDER: Record<ManagerLifecycle, number> = { running: 0, draining: 1, disposed: 2 };

/** The later of the two states: a lifecycle never moves back. */
export function advanceLifecycle(
  current: ManagerLifecycle,
  next: ManagerLifecycle,
): ManagerLifecycle {
  return LIFECYCLE_ORDER[next] > LIFECYCLE_ORDER[current] ? next : current;
}
