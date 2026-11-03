/**
 * One interactive runtime step a node session sent with an operator terminal (spec §4.7), from
 * the send until its final result, `operator_closed`, a replacement or the session's end. It
 * outlives the step's terminal record: the node ends the terminal (`term.exit`) before its
 * final result. The terminal record references this step; it holds no copy of its stage.
 *
 *   spawning --awaiting_operator--> awaiting --operator_running--> running
 *       \                              \                             \
 *        `------------------------------`-----------------------------`--server close--> cancelling
 *
 * - `spawning`: the job was sent; nobody can attach before the node shows its confirm screen.
 * - `awaiting`: the confirm screen is up; a person may attach and press Enter.
 * - `running`: the person accepted (`operator_running` seen). Owns the retry chain of a failed
 *   `operator_running` delivery (`retryOperatorAcceptance`): leaving `running` ends it.
 * - `cancelling`: the server closed the terminal; only the node's answer to that close still
 *   routes. Terminal: the step leaves the session from here (`forgetOperatorStep`).
 */
import type { RuntimeJobFrame } from "./frames.js";

/**
 * A pending redelivery of one step's failed `operator_running`. `timer` is null while a
 * redelivery is in flight; the chain lives as long as its `running` stage holds it.
 */
export type OperatorAcceptanceRetry = {
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export type OperatorStage =
  | { readonly kind: "spawning" }
  | { readonly kind: "awaiting" }
  | { readonly kind: "running"; acceptanceRetry: OperatorAcceptanceRetry | null }
  | { readonly kind: "cancelling" };

export type OperatorStageKind = OperatorStage["kind"];

export type OperatorStep = {
  readonly stepId: string;
  readonly instanceId: string;
  readonly rank: number;
  readonly phase: RuntimeJobFrame["phase"];
  readonly intentHash: string;
  readonly ownerEpoch: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly nodeId: string;
  stage: OperatorStage;
};

const NEXT: Record<OperatorStageKind, readonly OperatorStageKind[]> = {
  spawning: ["awaiting", "cancelling"],
  awaiting: ["running", "cancelling"],
  running: ["cancelling"],
  cancelling: [],
};

export function newOperatorStep(fields: Omit<OperatorStep, "stage">): OperatorStep {
  return { ...fields, stage: { kind: "spawning" } };
}

/**
 * Moves the step to `next` along the diagram; false (nothing changed) for any other move,
 * including staying put. Leaving `running` ends its acceptance retry chain.
 */
export function advanceOperatorStep(
  step: OperatorStep,
  next: Exclude<OperatorStageKind, "spawning">,
): boolean {
  if (!NEXT[step.stage.kind].includes(next)) return false;
  endAcceptanceRetry(step);
  step.stage =
    next === "running"
      ? { kind: "running", acceptanceRetry: null }
      : next === "awaiting"
        ? { kind: "awaiting" }
        : { kind: "cancelling" };
  return true;
}

/** The server has not closed the step's terminal. */
export function operatorStepLive(step: OperatorStep): boolean {
  return step.stage.kind !== "cancelling";
}

/** The step's acceptance retry chain, while it runs and has one. */
export function acceptanceRetryOf(step: OperatorStep): OperatorAcceptanceRetry | null {
  return step.stage.kind === "running" ? step.stage.acceptanceRetry : null;
}

/** Starts the step's retry chain; null when the step does not run or already has one. */
export function startAcceptanceRetry(step: OperatorStep): OperatorAcceptanceRetry | null {
  if (step.stage.kind !== "running" || step.stage.acceptanceRetry !== null) return null;
  const chain: OperatorAcceptanceRetry = { attempt: 0, timer: null };
  step.stage.acceptanceRetry = chain;
  return chain;
}

/** Ends the step's retry chain, clearing its timer (a redelivery in flight finds it gone). */
export function endAcceptanceRetry(step: OperatorStep): void {
  if (step.stage.kind !== "running") return;
  const chain = step.stage.acceptanceRetry;
  if (chain === null) return;
  if (chain.timer !== null) clearTimeout(chain.timer);
  chain.timer = null;
  step.stage.acceptanceRetry = null;
}
