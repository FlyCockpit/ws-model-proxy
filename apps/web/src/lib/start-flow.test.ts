import { describe, expect, it } from "vitest";

import {
  pickProblemOf,
  START_FLOW_INITIAL,
  type StartFlow,
  type StartFlowEvent,
  sameStartTarget,
  shownPreview,
  startFlowReducer,
  startTarget,
} from "./start-flow";

type Preview = { fingerprint: string };

const run = (events: StartFlowEvent<Preview>[], from: StartFlow<Preview> = START_FLOW_INITIAL) =>
  events.reduce(startFlowReducer<Preview>, from);

const onA = { nodeIds: ["a"] };
const onB = { nodeIds: ["b"] };

describe("startFlowReducer", () => {
  it("previews then confirms the previewed target", () => {
    const previewed = run([
      { type: "previewRequested", target: onA },
      { type: "previewResolved", target: onA, preview: { fingerprint: "fp-a" } },
    ]);
    expect(previewed).toEqual({ kind: "previewed", target: onA, preview: { fingerprint: "fp-a" } });
    const confirming = run([{ type: "confirmRequested" }], previewed);
    expect(confirming).toEqual({
      kind: "confirming",
      target: onA,
      preview: { fingerprint: "fp-a" },
    });
    expect(run([{ type: "confirmSucceeded" }], confirming)).toEqual({ kind: "done" });
  });

  it("drops a preview that resolves after the person picked other nodes", () => {
    const state = run([
      { type: "previewRequested", target: onA },
      { type: "picked" },
      { type: "previewResolved", target: onA, preview: { fingerprint: "fp-a" } },
    ]);
    expect(state).toEqual({ kind: "picking" });
    expect(shownPreview(state)).toBeNull();
  });

  it("drops an older preview reply once a newer preview is in flight", () => {
    const state = run([
      { type: "previewRequested", target: onA },
      { type: "picked" },
      { type: "previewRequested", target: onB },
      { type: "previewResolved", target: onA, preview: { fingerprint: "fp-a" } },
      { type: "previewFailed", target: onA },
    ]);
    expect(state).toEqual({ kind: "previewing", target: onB });
    expect(
      run([{ type: "previewResolved", target: onB, preview: { fingerprint: "fp-b" } }], state),
    ).toEqual({ kind: "previewed", target: onB, preview: { fingerprint: "fp-b" } });
  });

  it("forgets a preview when the target changes, and cannot confirm without one", () => {
    const previewed = run([
      { type: "previewRequested", target: onA },
      { type: "previewResolved", target: onA, preview: { fingerprint: "fp-a" } },
    ]);
    const picking = run([{ type: "picked" }], previewed);
    expect(picking).toEqual({ kind: "picking" });
    expect(run([{ type: "confirmRequested" }], picking)).toEqual({ kind: "picking" });
  });

  it("returns to picking when the preview or the confirm is refused", () => {
    expect(
      run([
        { type: "previewRequested", target: onA },
        { type: "previewFailed", target: onA },
      ]),
    ).toEqual({ kind: "picking" });
    expect(
      run([
        { type: "previewRequested", target: onA },
        { type: "previewResolved", target: onA, preview: { fingerprint: "fp-a" } },
        { type: "confirmRequested" },
        { type: "confirmFailed" },
      ]),
    ).toEqual({ kind: "picking" });
  });

  it("keeps a confirm in flight (and the done state) through picks and stray events", () => {
    const confirming = run([
      { type: "previewRequested", target: onA },
      { type: "previewResolved", target: onA, preview: { fingerprint: "fp-a" } },
      { type: "confirmRequested" },
    ]);
    expect(
      run(
        [
          { type: "picked" },
          { type: "previewRequested", target: onB },
          { type: "confirmRequested" },
        ],
        confirming,
      ),
    ).toBe(confirming);
    const done = run([{ type: "confirmSucceeded" }], confirming);
    expect(run([{ type: "picked" }, { type: "confirmFailed" }], done)).toBe(done);
  });
});

describe("start targets", () => {
  it("restarts an instance, places on every picked rank, or lets the planner pick", () => {
    expect(startTarget("i-1", ["a"], 1)).toEqual({ instanceId: "i-1" });
    expect(startTarget(undefined, ["a", "b"], 2)).toEqual({ nodeIds: ["a", "b"] });
    expect(startTarget(undefined, ["a"], 2)).toEqual({});
    expect(startTarget(undefined, [], 1)).toEqual({});
  });

  it("compares targets by value and rank order", () => {
    expect(sameStartTarget({ nodeIds: ["a", "b"] }, { nodeIds: ["a", "b"] })).toBe(true);
    expect(sameStartTarget({ nodeIds: ["a", "b"] }, { nodeIds: ["b", "a"] })).toBe(false);
    expect(sameStartTarget({}, { nodeIds: ["a"] })).toBe(false);
    expect(sameStartTarget({}, {})).toBe(true);
    expect(sameStartTarget({ instanceId: "i-1" }, { instanceId: "i-2" })).toBe(false);
  });

  it("asks for every rank, each on its own node", () => {
    expect(pickProblemOf([], 2)).toBeNull();
    expect(pickProblemOf(["a"], 2)).toBe("pickEveryRank");
    expect(pickProblemOf(["a", "a"], 2)).toBe("pickDistinct");
    expect(pickProblemOf(["a", "b"], 2)).toBeNull();
  });
});
