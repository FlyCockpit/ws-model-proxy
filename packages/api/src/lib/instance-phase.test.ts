import { describe, expect, it } from "vitest";
import {
  ALWAYS_ON_PHASES,
  alwaysOnPhaseData,
  assertInstanceTransition,
  INSTANCE_PHASES,
  type InstancePhase,
  type InstancePhaseChange,
  type InstancePhaseColumns,
  InstanceTransitionError,
  instancePhaseData,
  instanceTransitionAllowed,
} from "./instance-phase";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const LATER = new Date("2026-11-03T12:05:00.000Z");
const EARLIER = new Date("2026-11-03T11:00:00.000Z");

/** One of every change a writer makes (every variant of every target). */
const CHANGES: readonly InstancePhaseChange[] = [
  {
    to: "STARTING",
    run: "new",
    reason: "restart_requested",
    fabricId: "f1",
    restartBudget: "reset",
  },
  { to: "STARTING", run: "new", reason: "restarting", fabricId: null, restartBudget: "spend" },
  { to: "STARTING", run: "resume" },
  { to: "READY", via: "readiness" },
  { to: "READY", via: "recovered" },
  { to: "READY", via: "health" },
  { to: "UNHEALTHY", detail: "http_503" },
  { to: "UNAVAILABLE", reason: "node_offline", since: null },
  { to: "UNAVAILABLE", reason: "node_offline", since: EARLIER },
  { to: "STOPPING", reason: "stop_requested", desiredState: "STOPPED" },
  { to: "STOPPING", reason: "health_failed", desiredState: "RUNNING" },
  { to: "STOPPED", reason: "stop_requested", after: { kind: "stay" } },
  { to: "STOPPED", reason: "startup_failed", after: { kind: "restart_by_person" } },
  {
    to: "STOPPED",
    reason: "startup_failed",
    after: { kind: "restart_at", at: LATER, restartsInWindow: 2, restartWindowStartedAt: EARLIER },
  },
  { to: "FAILED", reason: "restart_budget_exhausted" },
  { to: "FAILED", reason: "trust_relay" },
];

function label(change: InstancePhaseChange): string {
  const variant =
    "run" in change
      ? change.run
      : "via" in change
        ? change.via
        : "after" in change
          ? change.after.kind
          : "desiredState" in change
            ? change.desiredState
            : "";
  return `${change.to}${variant ? ` (${variant})` : ""}`;
}

/**
 * The stored row after the write: every column the bundle writes replaces the old value, every
 * other column keeps it. Starts from a "dirty" row, every phase-scoped column set.
 */
function applied(columns: InstancePhaseColumns, needsOperator: string | null = "STEP") {
  const before = {
    phase: "STOPPING" as string,
    phaseReason: "old" as string | null,
    desiredState: "RUNNING" as string,
    needsOperator,
    needsOperatorSince: needsOperator ? EARLIER : (null as Date | null),
    nextRestartAt: EARLIER as Date | null,
    unavailableSince: EARLIER as Date | null,
    unhealthySince: EARLIER as Date | null,
    healthDetail: "timeout" as string | null,
    fabricId: "old-fabric" as string | null,
  };
  return { ...before, ...columns };
}

describe("instancePhaseData: the invariants every target phase keeps", () => {
  for (const change of CHANGES) {
    const columns = instancePhaseData(change, NOW);
    it(`${label(change)} writes its phase and stamp`, () => {
      expect(columns.phase).toBe(change.to);
      expect(columns.phaseChangedAt).toBe(NOW);
    });

    const resumed = change.to === "STARTING" && change.run === "resume";
    // What the row looks like after the write when every column was set before it. A resumed
    // run and the serving moves keep an existing STEP need (the step rules own it).
    const row = applied(columns);

    it(`${label(change)}: unavailableSince only while UNAVAILABLE`, () => {
      if (change.to === "UNAVAILABLE") expect(row.unavailableSince).toEqual(change.since ?? NOW);
      else expect(row.unavailableSince).toBeNull();
    });

    it(`${label(change)}: unhealthySince only while UNHEALTHY`, () => {
      if (change.to === "UNHEALTHY") expect(row.unhealthySince).toBe(NOW);
      else expect(row.unhealthySince).toBeNull();
    });

    it(`${label(change)}: nextRestartAt only on a STOPPED backoff`, () => {
      if (change.to === "STOPPED" && change.after.kind === "restart_at")
        expect(row.nextRestartAt).toBe(LATER);
      else if (!resumed && change.to !== "UNHEALTHY" && change.to !== "UNAVAILABLE")
        expect(row.nextRestartAt).toBeNull();
    });

    it(`${label(change)}: no fabric once STOPPED or FAILED`, () => {
      if (change.to === "STOPPED" || change.to === "FAILED") expect(row.fabricId).toBeNull();
      if (change.to === "STARTING" && change.run === "new")
        expect(row.fabricId).toBe(change.fabricId);
    });

    it(`${label(change)}: the need the target phase allows`, () => {
      switch (change.to) {
        case "FAILED":
          expect(row.needsOperator).toBeNull();
          expect(row.needsOperatorSince).toBeNull();
          break;
        case "STOPPED":
          expect(row.needsOperator).toBe(
            change.after.kind === "restart_by_person" ? "RESTART" : null,
          );
          expect(row.needsOperatorSince).toBe(
            change.after.kind === "restart_by_person" ? NOW : null,
          );
          break;
        case "STOPPING":
          // The stop rules decide it from scratch (a stale RESTART or STEP never survives).
          expect(row.needsOperator).toBeNull();
          break;
        case "STARTING":
          if (change.run === "new") expect(row.needsOperator).toBeNull();
          // A resumed run keeps the STEP need its steps raised.
          else expect(columns).not.toHaveProperty("needsOperator");
          break;
        default:
          // Serving moves never touch the need: it can only be a STEP the step rules keep.
          expect(columns).not.toHaveProperty("needsOperator");
          expect(columns).not.toHaveProperty("needsOperatorSince");
      }
    });

    it(`${label(change)}: a managed desired state (never null)`, () => {
      if (change.to === "STOPPING") expect(columns.desiredState).toBe(change.desiredState);
      else if (change.to === "STARTING" && change.run === "new")
        expect(columns.desiredState).toBe("RUNNING");
      else expect(columns).not.toHaveProperty("desiredState");
      expect(columns.desiredState).not.toBeNull();
    });

    it(`${label(change)}: healthDetail is cleared by READY and a new run, else kept`, () => {
      if (change.to === "READY" || (change.to === "STARTING" && change.run === "new"))
        expect(row.healthDetail).toBeNull();
      else if (change.to === "UNHEALTHY") expect(row.healthDetail).toBe(change.detail);
      else expect(columns).not.toHaveProperty("healthDetail");
    });
  }

  it("a new run resets or spends the restart budget, and resets the health counters", () => {
    const reset = instancePhaseData(CHANGES[0] as InstancePhaseChange, NOW);
    expect(reset).toMatchObject({
      restartsInWindow: 0,
      restartWindowStartedAt: null,
      healthFailures: 0,
      healthSuccesses: 0,
      phaseReason: "restart_requested",
    });
    const spend = instancePhaseData(CHANGES[1] as InstancePhaseChange, NOW);
    expect(spend.restartsInWindow).toEqual({ increment: 1 });
    expect(spend).not.toHaveProperty("restartWindowStartedAt");
  });

  it("readiness resets the health counters and stamps the last health check", () => {
    expect(instancePhaseData({ to: "READY", via: "readiness" }, NOW)).toMatchObject({
      lastHealthAt: NOW,
      healthFailures: 0,
      healthSuccesses: 0,
      phaseReason: null,
    });
    // Health recovery and a node coming back leave the counters to the health rule.
    expect(instancePhaseData({ to: "READY", via: "health" }, NOW)).not.toHaveProperty(
      "healthFailures",
    );
    expect(instancePhaseData({ to: "READY", via: "recovered" }, NOW)).not.toHaveProperty(
      "lastHealthAt",
    );
  });

  it("a STOPPED backoff records the window it counts in", () => {
    expect(instancePhaseData(CHANGES[13] as InstancePhaseChange, NOW)).toMatchObject({
      nextRestartAt: LATER,
      restartsInWindow: 2,
      restartWindowStartedAt: EARLIER,
      phaseReason: "startup_failed",
    });
  });

  it("UNAVAILABLE keeps the first since (a reason change does not restart the clock)", () => {
    expect(
      instancePhaseData({ to: "UNAVAILABLE", reason: "node_offline", since: EARLIER }, NOW)
        .unavailableSince,
    ).toBe(EARLIER);
  });
});

describe("instance transitions", () => {
  const managed = (phase: InstancePhase, desiredState: "RUNNING" | "STOPPED" = "RUNNING") => ({
    phase,
    desiredState,
  });
  /** The allowed moves, spelled out (from → targets), as the lifecycle makes them. */
  const ALLOWED: Record<string, readonly InstancePhase[]> = {
    "STARTING (new)": INSTANCE_PHASES,
    "STARTING (resume)": ["UNAVAILABLE"],
    "READY (readiness)": ["STARTING"],
    "READY (recovered)": ["UNAVAILABLE"],
    "READY (health)": ["UNHEALTHY"],
    UNHEALTHY: ["READY"],
    UNAVAILABLE: ["STARTING", "READY", "UNHEALTHY", "UNAVAILABLE"],
    "STOPPING (STOPPED)": INSTANCE_PHASES,
    "STOPPING (RUNNING)": ["STARTING", "READY", "UNHEALTHY", "UNAVAILABLE", "STOPPING"],
    "STOPPED (stay)": ["STOPPING"],
    "STOPPED (restart_by_person)": ["STOPPING"],
    "STOPPED (restart_at)": ["STOPPING"],
    FAILED: ["STOPPING", "STOPPED"],
  };

  for (const change of CHANGES) {
    const key = label(change);
    const allowed = ALLOWED[key];
    it(`${key} is allowed exactly from ${allowed?.join(", ")}`, () => {
      expect(allowed).toBeDefined();
      for (const from of INSTANCE_PHASES) {
        const ok = (allowed ?? []).includes(from);
        expect(instanceTransitionAllowed(managed(from), change), `${from} → ${key}`).toBe(ok);
        if (ok) expect(() => assertInstanceTransition(managed(from), change)).not.toThrow();
        else
          expect(() => assertInstanceTransition(managed(from), change)).toThrow(
            InstanceTransitionError,
          );
      }
    });
  }

  it("an always-on instance (desired null) never takes a managed move", () => {
    for (const change of CHANGES)
      for (const from of ALWAYS_ON_PHASES)
        expect(instanceTransitionAllowed({ phase: from, desiredState: null }, change)).toBe(false);
    expect(() =>
      assertInstanceTransition(
        { phase: "READY", desiredState: null },
        { to: "STOPPING", reason: "health_failed", desiredState: "RUNNING" },
      ),
    ).toThrow("READY (always-on)");
  });

  it("no move goes from STOPPED to READY or from FAILED back to serving without a new run", () => {
    for (const from of ["STOPPED", "FAILED"] as const) {
      for (const change of CHANGES) {
        if (change.to === "STARTING" && change.run === "new") continue;
        if (change.to === "STOPPING" && change.desiredState === "STOPPED") continue;
        if (change.to === "FAILED" && from === "STOPPED") continue;
        expect(instanceTransitionAllowed(managed(from), change), `${from} → ${label(change)}`).toBe(
          false,
        );
      }
    }
  });
});

describe("alwaysOnPhaseData", () => {
  it("writes only the phase, its stamp and why", () => {
    for (const phase of ALWAYS_ON_PHASES)
      expect(alwaysOnPhaseData(phase, phase === "READY" ? null : "node_offline", NOW)).toEqual({
        phase,
        phaseChangedAt: NOW,
        phaseReason: phase === "READY" ? null : "node_offline",
      });
  });
});
