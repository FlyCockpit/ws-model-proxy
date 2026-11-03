import { describe, expect, it, vi } from "vitest";
import { candidateAttempt } from "./candidate-attempt.js";

function setup() {
  const ports = {
    releaseLease: vi.fn(),
    releaseTrial: vi.fn(),
    memberFailed: vi.fn(),
  };
  const attempt = candidateAttempt("member-a", "lease-a", ports);
  return { ports, attempt };
}

const trialAt = new Date("2026-11-03T00:00:00Z");

describe("candidate attempt", () => {
  it("releases its lease exactly once, whatever ends it", () => {
    const { ports, attempt } = setup();
    expect(attempt.stage).toBe("lease_held");
    attempt.end();
    attempt.end({ kind: "member_failed", failure: "timeout" });
    expect(ports.releaseLease).toHaveBeenCalledTimes(1);
    expect(ports.releaseLease).toHaveBeenCalledWith("lease-a");
    expect(ports.memberFailed).not.toHaveBeenCalled();
    expect(attempt.stage).toBe("ended");
  });

  it("settles a claimed trial with the end outcome", () => {
    const { ports, attempt } = setup();
    attempt.trialClaimed(trialAt);
    expect(attempt.stage).toBe("trial_claimed");
    attempt.opening();
    attempt.end({ kind: "release", outcome: "inconclusive" });
    expect(ports.releaseTrial).toHaveBeenCalledWith("member-a", trialAt, "inconclusive");
    expect(ports.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("hands the trial to a member failure verdict, and reports one without a trial", () => {
    const withTrial = setup();
    withTrial.attempt.trialClaimed(trialAt);
    withTrial.attempt.opening();
    withTrial.attempt.end({ kind: "member_failed", failure: "upstream_5xx" });
    expect(withTrial.ports.memberFailed).toHaveBeenCalledWith("member-a", "upstream_5xx", trialAt);
    expect(withTrial.ports.releaseTrial).not.toHaveBeenCalled();

    const without = setup();
    without.attempt.opening();
    without.attempt.end({ kind: "member_failed", failure: "upstream_5xx" });
    expect(without.ports.memberFailed).toHaveBeenCalledWith("member-a", "upstream_5xx", null);
  });

  it("settles the trial only once when the deadline cuts an open and the close follows", () => {
    const { ports, attempt } = setup();
    attempt.trialClaimed(trialAt);
    attempt.opening();
    attempt.settleTrial({ kind: "member_failed", failure: "timeout" });
    expect(attempt.stage).toBe("opening");
    attempt.settleTrial({ kind: "release", outcome: "unused" });
    attempt.end();
    expect(ports.memberFailed).toHaveBeenCalledTimes(1);
    expect(ports.releaseTrial).not.toHaveBeenCalled();
    expect(ports.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("gives an opened attempt's trial to memberOpened and keeps the lease until the end", () => {
    const { ports, attempt } = setup();
    attempt.trialClaimed(trialAt);
    attempt.opening();
    expect(attempt.opened()).toBe(trialAt);
    expect(attempt.stage).toBe("opened");
    attempt.settleTrial({ kind: "release", outcome: "unused" });
    expect(ports.releaseLease).not.toHaveBeenCalled();
    attempt.end();
    expect(ports.releaseTrial).not.toHaveBeenCalled();
    expect(ports.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("releases a trial claimed after the attempt already ended", () => {
    const { ports, attempt } = setup();
    attempt.end();
    attempt.trialClaimed(trialAt);
    expect(ports.releaseTrial).toHaveBeenCalledWith("member-a", trialAt, "unused");
    expect(attempt.stage).toBe("ended");
  });
});
