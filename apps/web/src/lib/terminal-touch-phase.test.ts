import { describe, expect, it } from "vitest";

import {
  moveTouchPhase,
  releaseTouchPhase,
  startTouchPhase,
  type TouchPhase,
  touchLive,
  touchTaken,
  voidTouchPhase,
} from "./terminal-touch-phase";

const lastLift = { fingersLeft: 0, cancelled: false, moved: false, liftedWithinSlop: true };

describe("startTouchPhase", () => {
  it("is the pane's only while touch is enabled", () => {
    expect(startTouchPhase({ enabled: true, coasting: false, fingers: 1 })).toEqual({
      kind: "owned",
    });
    expect(startTouchPhase({ enabled: false, coasting: false, fingers: 1 })).toEqual({
      kind: "native",
    });
  });

  it("takes a touch that stops a coasting scroll, only while enabled", () => {
    expect(startTouchPhase({ enabled: true, coasting: true, fingers: 1 })).toEqual({
      kind: "claimed",
    });
    expect(startTouchPhase({ enabled: false, coasting: true, fingers: 1 })).toEqual({
      kind: "native",
    });
  });

  it("is void with two fingers down, remembering whether the pane took it", () => {
    expect(startTouchPhase({ enabled: true, coasting: true, fingers: 2 })).toEqual({
      kind: "void",
      claimed: true,
    });
    expect(startTouchPhase({ enabled: true, coasting: false, fingers: 2 })).toEqual({
      kind: "void",
      claimed: false,
    });
  });
});

describe("moveTouchPhase", () => {
  it("takes an owned touch once it moves past the slop", () => {
    expect(moveTouchPhase({ kind: "owned" }, { enabled: true, pastSlop: false })).toEqual({
      kind: "owned",
    });
    expect(moveTouchPhase({ kind: "owned" }, { enabled: true, pastSlop: true })).toEqual({
      kind: "claimed",
    });
  });

  it("gives an owned touch to the browser when touch stops being the pane's", () => {
    expect(moveTouchPhase({ kind: "owned" }, { enabled: false, pastSlop: true })).toEqual({
      kind: "native",
    });
  });

  it("keeps a taken touch out of the page, but scrolling no more, once disabled", () => {
    const disowned = moveTouchPhase({ kind: "claimed" }, { enabled: false, pastSlop: true });
    expect(disowned).toEqual({ kind: "disowned" });
    expect(touchTaken(disowned)).toBe(true);
    // Enabled again, it does not scroll again.
    expect(moveTouchPhase(disowned, { enabled: true, pastSlop: true })).toEqual(disowned);
  });

  it("never makes a native touch the pane's", () => {
    expect(moveTouchPhase({ kind: "native" }, { enabled: true, pastSlop: true })).toEqual({
      kind: "native",
    });
  });
});

describe("voidTouchPhase", () => {
  it("keeps whether the pane had taken the touch", () => {
    expect(voidTouchPhase({ kind: "owned" })).toEqual({ kind: "void", claimed: false });
    expect(voidTouchPhase({ kind: "native" })).toEqual({ kind: "void", claimed: false });
    expect(voidTouchPhase({ kind: "claimed" })).toEqual({ kind: "void", claimed: true });
    expect(voidTouchPhase({ kind: "disowned" })).toEqual({ kind: "void", claimed: true });
  });

  it("leaves a void or ended touch as it is", () => {
    const voided: TouchPhase = { kind: "void", claimed: true };
    expect(voidTouchPhase(voided)).toBe(voided);
    expect(voidTouchPhase({ kind: "ended" })).toEqual({ kind: "ended" });
  });
});

describe("releaseTouchPhase", () => {
  it("is a tap for an untaken one-finger touch lifted within the slop", () => {
    for (const kind of ["owned", "native"] as const) {
      expect(releaseTouchPhase({ kind }, lastLift)).toEqual({
        phase: { kind: "ended" },
        release: "tap",
        coasts: false,
      });
    }
  });

  it("cancels a lift past the slop, or one that does not carry the touch's finger", () => {
    expect(releaseTouchPhase({ kind: "owned" }, { ...lastLift, liftedWithinSlop: false })).toEqual({
      phase: { kind: "ended" },
      release: "cancel",
      coasts: false,
    });
  });

  it("leaves a drag the browser had alone", () => {
    expect(releaseTouchPhase({ kind: "native" }, { ...lastLift, moved: true }).release).toBe(
      "native",
    );
  });

  it("cancels a taken touch's release; only the pane's scroll coasts", () => {
    expect(releaseTouchPhase({ kind: "claimed" }, { ...lastLift, moved: true })).toEqual({
      phase: { kind: "ended" },
      release: "cancel",
      coasts: true,
    });
    expect(releaseTouchPhase({ kind: "disowned" }, { ...lastLift, moved: true })).toEqual({
      phase: { kind: "ended" },
      release: "cancel",
      coasts: false,
    });
  });

  it("voids the touch while a finger is still down, and does not end it", () => {
    expect(releaseTouchPhase({ kind: "claimed" }, { ...lastLift, fingersLeft: 1 })).toEqual({
      phase: { kind: "void", claimed: true },
      release: "cancel",
      coasts: false,
    });
    const { phase } = releaseTouchPhase({ kind: "owned" }, { ...lastLift, fingersLeft: 1 });
    expect(touchLive(phase)).toBe(true);
  });

  it("voids a touch the browser took: no tap, no coasting", () => {
    expect(releaseTouchPhase({ kind: "claimed" }, { ...lastLift, cancelled: true })).toEqual({
      phase: { kind: "ended" },
      release: "cancel",
      coasts: false,
    });
    expect(releaseTouchPhase({ kind: "owned" }, { ...lastLift, cancelled: true }).release).toBe(
      "cancel",
    );
  });

  it("cancels every lift of a void or ended touch", () => {
    expect(releaseTouchPhase({ kind: "void", claimed: false }, lastLift)).toEqual({
      phase: { kind: "ended" },
      release: "cancel",
      coasts: false,
    });
    expect(releaseTouchPhase({ kind: "ended" }, lastLift)).toEqual({
      phase: { kind: "ended" },
      release: "cancel",
      coasts: false,
    });
  });
});
