import { describe, expect, it } from "vitest";

import {
  batchRows,
  forceOffered,
  nodeUpdateMode,
  overviewRefetchInterval,
  progressSteps,
  shortCommit,
} from "./agent-update";

const view = {
  outdated: true,
  canUpdate: true,
  selfUpdate: { strategies: ["self-replace"] },
  build: { installMethod: "script" },
  latest: null,
};

describe("overviewRefetchInterval", () => {
  it("polls fast while an update or a batch is in flight, and slowly otherwise", () => {
    expect(overviewRefetchInterval(undefined)).toBe(30_000);
    expect(
      overviewRefetchInterval({ nodes: [{ latest: { phase: "confirmed" } }], batch: null }),
    ).toBe(30_000);
    expect(
      overviewRefetchInterval({ nodes: [{ latest: { phase: "downloading" } }], batch: null }),
    ).toBe(3_000);
    expect(overviewRefetchInterval({ nodes: [], batch: { state: "running" } })).toBe(3_000);
    expect(overviewRefetchInterval({ nodes: [], batch: { state: "stopped" } })).toBe(30_000);
  });
});

describe("nodeUpdateMode", () => {
  it("offers Update only to an outdated node the server can update", () => {
    expect(nodeUpdateMode(view)).toBe("ready");
    expect(nodeUpdateMode({ ...view, canUpdate: false })).toBe("blocked");
    expect(nodeUpdateMode({ ...view, outdated: false })).toBe("current");
  });

  it("shows the install command for agents too old to update themselves", () => {
    expect(nodeUpdateMode({ ...view, selfUpdate: null })).toBe("too_old");
  });

  it("sends source builds and strategy-less installs to the node (D8)", () => {
    expect(nodeUpdateMode({ ...view, build: { installMethod: "source" } })).toBe("manual");
    expect(nodeUpdateMode({ ...view, selfUpdate: { strategies: [] } })).toBe("manual");
  });

  it("shows only progress while an update runs", () => {
    expect(nodeUpdateMode({ ...view, latest: { phase: "waiting_idle" } })).toBe("in_flight");
    expect(nodeUpdateMode({ ...view, latest: { phase: "rolled_back" } })).toBe("ready");
  });
});

describe("forceOffered", () => {
  it("needs instances that would stop and something running", () => {
    const running = [{ id: "i-1" }];
    expect(
      forceOffered({ selfUpdate: { instancesSurvive: false }, runningInstances: running }),
    ).toBe(true);
    expect(
      forceOffered({ selfUpdate: { instancesSurvive: true }, runningInstances: running }),
    ).toBe(false);
    expect(forceOffered({ selfUpdate: { instancesSurvive: false }, runningInstances: [] })).toBe(
      false,
    );
    expect(forceOffered({ selfUpdate: null, runningInstances: running })).toBe(false);
  });
});

describe("progressSteps", () => {
  it("marks the steps before the phase done and reads swapped as restarting", () => {
    expect(progressSteps("verifying", false)).toEqual([
      { phase: "requested", state: "done" },
      { phase: "downloading", state: "done" },
      { phase: "verifying", state: "current" },
      { phase: "armed", state: "upcoming" },
      { phase: "restarting", state: "upcoming" },
    ]);
    expect(progressSteps("swapped", false).at(-1)).toEqual({
      phase: "restarting",
      state: "current",
    });
  });

  it("shows the idle wait only while waiting, and Homebrew skips verify and arm", () => {
    expect(progressSteps("waiting_idle", false).map((step) => step.phase)).toContain(
      "waiting_idle",
    );
    expect(progressSteps("downloading", true).map((step) => step.phase)).toEqual([
      "requested",
      "downloading",
      "restarting",
    ]);
  });
});

describe("shortCommit", () => {
  it("shortens hex commits and drops anything else", () => {
    expect(shortCommit("ABCDEF0123456789abcdef0123456789abcdef01")).toBe("abcdef0");
    expect(shortCommit(null)).toBeNull();
    expect(shortCommit("<script>")).toBeNull();
  });
});

describe("batchRows", () => {
  const latest: Record<string, { phase: string }> = {
    a: { phase: "confirmed" },
    b: { phase: "rolled_back" },
  };
  it("shows done, the stop and the untouched nodes in order", () => {
    expect(
      batchRows(
        {
          state: "stopped",
          nodeIds: ["a", "b", "c"],
          currentNodeId: null,
          untouchedNodeIds: ["c"],
        },
        (nodeId) => latest[nodeId],
      ),
    ).toEqual([
      { nodeId: "a", status: "updated" },
      { nodeId: "b", status: "rolled_back" },
      { nodeId: "c", status: "untouched" },
    ]);
  });

  it("does not count an older update of a node that has not had its turn", () => {
    expect(
      batchRows(
        {
          state: "running",
          nodeIds: ["a", "b", "c"],
          currentNodeId: "b",
          untouchedNodeIds: [],
        },
        (nodeId) => latest[nodeId] ?? { phase: "confirmed" },
      ),
    ).toEqual([
      { nodeId: "a", status: "updated" },
      { nodeId: "b", status: "rolled_back" },
      { nodeId: "c", status: "waiting" },
    ]);
  });

  it("shows the current node as updating and the rest as waiting while running", () => {
    expect(
      batchRows(
        { state: "running", nodeIds: ["a", "c"], currentNodeId: "a", untouchedNodeIds: [] },
        () => ({ phase: "restarting" }),
      ),
    ).toEqual([
      { nodeId: "a", status: "updating" },
      { nodeId: "c", status: "waiting" },
    ]);
  });
});
