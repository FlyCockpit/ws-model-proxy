/**
 * The runtime instance lifecycle as one explicit state machine (spec §3.4), over the existing
 * `RuntimeInstance` columns. Every writer that changes an instance's phase builds its column
 * bundle here ({@link instancePhaseData}) and checks the move first ({@link
 * assertInstanceTransition}), so the phase-scoped columns always agree with the phase:
 *
 * | column              | set only while                                                  |
 * | ------------------- | --------------------------------------------------------------- |
 * | `unavailableSince`  | UNAVAILABLE                                                     |
 * | `unhealthySince`    | UNHEALTHY                                                       |
 * | `nextRestartAt`     | STOPPED with desired RUNNING (an automatic restart's backoff)   |
 * | `fabricId`          | not STOPPED and not FAILED                                      |
 * | `needsOperator`     | STEP while serving or starting; STEP or MARK_STOPPED while      |
 * |                     | STOPPING; RESTART while STOPPED; never FAILED                   |
 * | `desiredState`      | RUNNING or STOPPED for a managed instance (null: always-on only) |
 *
 * A STEP need is owned by the step rules (`./operator-need.ts` `syncNeedsOperator`): moves
 * between the serving phases keep it, and the engine recomputes it after the moves that clear it.
 * `healthDetail` is shown only while UNHEALTHY and kept until the instance is READY again (or a
 * new run starts).
 */

export const INSTANCE_PHASES = [
  "STARTING",
  "READY",
  "UNHEALTHY",
  "UNAVAILABLE",
  "STOPPING",
  "STOPPED",
  "FAILED",
] as const;
export type InstancePhase = (typeof INSTANCE_PHASES)[number];
export type OperatorNeed = "STEP" | "RESTART" | "MARK_STOPPED";
export type DesiredState = "RUNNING" | "STOPPED";

/** The phases an always-on instance (desired state null) moves between, from its node's status. */
export const ALWAYS_ON_PHASES = ["READY", "UNHEALTHY", "UNAVAILABLE"] as const;
export type AlwaysOnPhase = (typeof ALWAYS_ON_PHASES)[number];

/** A managed instance's phase change: the target phase and what the move needs to know. */
export type InstancePhaseChange =
  /** A new run (a person's or agent's start or restart, or the engine's automatic restart). */
  | {
      to: "STARTING";
      run: "new";
      reason: string;
      fabricId: string | null;
      /** A person's or agent's start resets the window budget; an automatic restart spends one. */
      restartBudget: "reset" | "spend";
    }
  /** Its node is back and this run never reached readiness: the same run, still starting. */
  | { to: "STARTING"; run: "resume" }
  /**
   * `readiness`: the run's start steps all succeeded. `recovered`: its node is back after a run
   * that had reached readiness. `health`: health probes recovered it.
   */
  | { to: "READY"; via: "readiness" | "recovered" | "health" }
  | { to: "UNHEALTHY"; detail: string | null }
  | { to: "UNAVAILABLE"; reason: string; since: Date | null }
  /**
   * The run ends: its claims are released by stops. `desiredState` STOPPED: a person's or an
   * agent's stop (or a preemption); RUNNING: a failure, the restart rule follows once stopped.
   */
  | { to: "STOPPING"; reason: string; desiredState: DesiredState }
  /** Every claim is released (or marked stopped). The reason is the stop's, kept. */
  | {
      to: "STOPPED";
      reason: string | null;
      after:
        | { kind: "stay" }
        | { kind: "restart_by_person" }
        | {
            kind: "restart_at";
            at: Date;
            restartsInWindow: number;
            restartWindowStartedAt: Date;
          };
    }
  | { to: "FAILED"; reason: string | null };

/** The column bundle of a phase change (assignable to the instance's update inputs). */
export type InstancePhaseColumns = {
  phase: InstancePhase;
  phaseChangedAt: Date;
  phaseReason?: string | null;
  desiredState?: DesiredState;
  needsOperator?: OperatorNeed | null;
  needsOperatorSince?: Date | null;
  nextRestartAt?: Date | null;
  unavailableSince?: Date | null;
  unhealthySince?: Date | null;
  healthDetail?: string | null;
  healthFailures?: number;
  healthSuccesses?: number;
  lastHealthAt?: Date;
  fabricId?: string | null;
  restartsInWindow?: number | { increment: number };
  restartWindowStartedAt?: Date | null;
};

const ALL: readonly InstancePhase[] = INSTANCE_PHASES;
const SERVING: readonly InstancePhase[] = ["STARTING", "READY", "UNHEALTHY", "UNAVAILABLE"];

/** The phases a managed instance may enter `change` from. */
export function instanceTransitionFrom(change: InstancePhaseChange): readonly InstancePhase[] {
  switch (change.to) {
    case "STARTING":
      // A new run replaces whatever the instance does (a definition change restarts it live);
      // a resumed one only comes back from UNAVAILABLE.
      return change.run === "new" ? ALL : ["UNAVAILABLE"];
    case "READY":
      return change.via === "readiness"
        ? ["STARTING"]
        : change.via === "recovered"
          ? ["UNAVAILABLE"]
          : ["UNHEALTHY"];
    case "UNHEALTHY":
      return ["READY"];
    case "UNAVAILABLE":
      return SERVING;
    case "STOPPING":
      // A stop request supersedes anything (a stopping instance takes the new reason; a STOPPED
      // or FAILED one with desired RUNNING settles STOPPED at once). A failure only stops a run.
      return change.desiredState === "STOPPED" ? ALL : [...SERVING, "STOPPING"];
    case "STOPPED":
      return ["STOPPING"];
    case "FAILED":
      // Settled from a stop, or a backed-off restart that has nothing to restart on.
      return ["STOPPING", "STOPPED"];
  }
}

export class InstanceTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`An instance cannot move from ${from} to ${to}.`);
    this.name = "InstanceTransitionError";
  }
}

export function instanceTransitionAllowed(
  from: { phase: string; desiredState: string | null },
  change: InstancePhaseChange,
): boolean {
  // A managed instance always has a desired state; the always-on one has its own moves.
  if (from.desiredState === null) return false;
  return (instanceTransitionFrom(change) as readonly string[]).includes(from.phase);
}

/** Throws {@link InstanceTransitionError} when `change` is not a move `from` may make. */
export function assertInstanceTransition(
  from: { phase: string; desiredState: string | null },
  change: InstancePhaseChange,
): void {
  if (!instanceTransitionAllowed(from, change))
    throw new InstanceTransitionError(
      from.desiredState === null ? `${from.phase} (always-on)` : from.phase,
      change.to,
    );
}

/**
 * Every column a phase change writes: the phase and its stamp, and each phase-scoped column the
 * target phase defines (see the table above). Pure; the caller writes it under its fences.
 */
export function instancePhaseData(change: InstancePhaseChange, now: Date): InstancePhaseColumns {
  const base = { phase: change.to, phaseChangedAt: now } as const;
  const noNeed = { needsOperator: null, needsOperatorSince: null } as const;
  switch (change.to) {
    case "STARTING":
      if (change.run === "resume")
        // The run goes on: its health counters, need (STEP) and fabric are its own.
        return { ...base, phaseReason: null, unavailableSince: null, unhealthySince: null };
      return {
        ...base,
        phaseReason: change.reason,
        desiredState: "RUNNING",
        // A new run's steps raise their own need.
        ...noNeed,
        nextRestartAt: null,
        unavailableSince: null,
        unhealthySince: null,
        healthDetail: null,
        healthFailures: 0,
        healthSuccesses: 0,
        fabricId: change.fabricId,
        ...(change.restartBudget === "reset"
          ? { restartsInWindow: 0, restartWindowStartedAt: null }
          : { restartsInWindow: { increment: 1 } }),
      };
    case "READY":
      return {
        ...base,
        phaseReason: null,
        nextRestartAt: null,
        unavailableSince: null,
        unhealthySince: null,
        healthDetail: null,
        ...(change.via === "readiness"
          ? { lastHealthAt: now, healthFailures: 0, healthSuccesses: 0 }
          : {}),
      };
    case "UNHEALTHY":
      return {
        ...base,
        phaseReason: "health_failed",
        unhealthySince: now,
        healthDetail: change.detail,
        unavailableSince: null,
      };
    case "UNAVAILABLE":
      return {
        ...base,
        phaseReason: change.reason,
        unavailableSince: change.since ?? now,
        unhealthySince: null,
      };
    case "STOPPING":
      return {
        ...base,
        phaseReason: change.reason,
        desiredState: change.desiredState,
        // The stop rules decide the need from here (`settleStopping`).
        ...noNeed,
        nextRestartAt: null,
        unavailableSince: null,
        unhealthySince: null,
      };
    case "STOPPED": {
      const stopped = {
        ...base,
        phaseReason: change.reason,
        fabricId: null,
        unavailableSince: null,
        unhealthySince: null,
      };
      if (change.after.kind === "restart_by_person")
        return {
          ...stopped,
          needsOperator: "RESTART",
          needsOperatorSince: now,
          nextRestartAt: null,
        };
      if (change.after.kind === "restart_at")
        return {
          ...stopped,
          ...noNeed,
          nextRestartAt: change.after.at,
          restartsInWindow: change.after.restartsInWindow,
          restartWindowStartedAt: change.after.restartWindowStartedAt,
        };
      return { ...stopped, ...noNeed, nextRestartAt: null };
    }
    case "FAILED":
      return {
        ...base,
        phaseReason: change.reason,
        ...noNeed,
        fabricId: null,
        nextRestartAt: null,
        unavailableSince: null,
        unhealthySince: null,
      };
  }
}

/** The phase an always-on instance's node status means is written with these columns. */
export function alwaysOnPhaseData(
  phase: AlwaysOnPhase,
  reason: string | null,
  now: Date,
): InstancePhaseColumns {
  // An always-on instance is never started, stopped or restarted by the engine: only its phase
  // and why change (none of the managed lifecycle's columns apply).
  return { phase, phaseChangedAt: now, phaseReason: reason };
}
