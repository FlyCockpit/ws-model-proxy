import type { RelayFailure } from "../../relay/relay-failure.js";

/** How the half-open trial an attempt holds (if any) is settled. */
export type TrialSettlement =
  | { kind: "release"; outcome: "unused" | "inconclusive" }
  /** A health verdict against the member; reported even when no trial was held. */
  | { kind: "member_failed"; failure: RelayFailure };

/**
 * One routing attempt on one candidate, from admission to its end.
 * - `lease_held`: admitted; this attempt owns the candidate's admission lease.
 * - `trial_claimed`: also holds the target's half-open recovery trial.
 * - `opening`: the relay open is in flight (the routing deadline cutting it is a member failure).
 * - `opened`: the session runs on this candidate; the trial went to `memberOpened`, and the
 *   lease is held until the session ends.
 * - `ended`: the lease was released and any trial settled, exactly once.
 */
export type CandidateAttemptStage =
  | { stage: "lease_held" }
  | { stage: "trial_claimed"; trialStartedAt: Date }
  | { stage: "opening"; trialStartedAt: Date | null }
  | { stage: "opened" }
  | { stage: "ended" };

export type CandidateAttemptPorts<C, L> = {
  releaseLease(lease: L): void;
  releaseTrial(candidate: C, startedAt: Date, outcome: "unused" | "inconclusive"): void;
  memberFailed(candidate: C, failure: RelayFailure, trialStartedAt: Date | null): void;
};

export type CandidateAttempt<C, L> = {
  readonly candidate: C;
  readonly lease: L;
  readonly stage: CandidateAttemptStage["stage"];
  /**
   * Records a claimed trial. An attempt that already ended (the session closed while the
   * claim was in flight) releases it unused at once, so no claim is ever stranded.
   */
  trialClaimed(startedAt: Date): void;
  /** The relay open is about to be sent. */
  opening(): void;
  /** Settles the trial (or reports the member failure) without ending the attempt. */
  settleTrial(how: TrialSettlement): void;
  /** The open succeeded: returns the trial start for `memberOpened`, which consumes it. */
  opened(): Date | null;
  /**
   * The one release path: settles anything still held (the trial per `how`, `unused` by
   * default) and releases the lease. A no-op once ended.
   */
  end(how?: TrialSettlement): void;
};

export function candidateAttempt<C, L>(
  candidate: C,
  lease: L,
  ports: CandidateAttemptPorts<C, L>,
): CandidateAttempt<C, L> {
  let state: CandidateAttemptStage = { stage: "lease_held" };
  const heldTrial = (): Date | null =>
    state.stage === "trial_claimed" || state.stage === "opening" ? state.trialStartedAt : null;

  function settleTrial(how: TrialSettlement) {
    if (state.stage === "ended" || state.stage === "opened") return;
    const startedAt = heldTrial();
    if (state.stage === "trial_claimed") state = { stage: "lease_held" };
    else if (state.stage === "opening") state = { stage: "opening", trialStartedAt: null };
    if (how.kind === "member_failed") ports.memberFailed(candidate, how.failure, startedAt);
    else if (startedAt) ports.releaseTrial(candidate, startedAt, how.outcome);
  }

  return {
    candidate,
    lease,
    get stage() {
      return state.stage;
    },
    trialClaimed(startedAt) {
      if (state.stage === "lease_held")
        state = { stage: "trial_claimed", trialStartedAt: startedAt };
      else ports.releaseTrial(candidate, startedAt, "unused");
    },
    opening() {
      if (state.stage === "lease_held" || state.stage === "trial_claimed")
        state = { stage: "opening", trialStartedAt: heldTrial() };
    },
    settleTrial,
    opened() {
      if (state.stage !== "opening") return null;
      const startedAt = state.trialStartedAt;
      state = { stage: "opened" };
      return startedAt;
    },
    end(how = { kind: "release", outcome: "unused" }) {
      if (state.stage === "ended") return;
      settleTrial(how);
      state = { stage: "ended" };
      ports.releaseLease(lease);
    },
  };
}
