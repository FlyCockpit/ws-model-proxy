import { describe, expect, it } from "vitest";

import { MOBILE_BREAKPOINT_PX } from "./use-media-query";
import {
  getMobileKeyboardDecision,
  isEditableFocusSnapshot,
  isEditableFocusTarget,
  isKeyboardSummoningInputType,
  MOBILE_KEYBOARD_DISMISS_GROWTH_PX,
  MOBILE_KEYBOARD_HEIGHT_RATIO,
  visualViewportGrewPastDismissThreshold,
} from "./use-mobile-keyboard";

const mobileFocused = {
  viewportWidth: 390,
  visualViewportHeight: 700,
  visualViewportScale: 1,
  baselineHeight: 700,
  editableFocused: true,
  virtualKeyboardOpened: null,
  geometryChanged: false,
} as const;

describe("getMobileKeyboardDecision", () => {
  it("never treats desktop widths as a software keyboard", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        viewportWidth: MOBILE_BREAKPOINT_PX,
        visualViewportHeight: 400,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: 400 });
  });

  it("never treats widths above the mobile breakpoint as a software keyboard", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        viewportWidth: 1280,
        visualViewportHeight: 500,
        baselineHeight: 900,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: 500 });
  });

  it("recaptures the baseline on mobile when no editable is focused", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        editableFocused: false,
        visualViewportHeight: 640,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: 640 });
  });

  it("does not hide chrome when an editable is focused without a height drop", () => {
    expect(getMobileKeyboardDecision(mobileFocused)).toEqual({
      isKeyboardOpen: false,
      nextBaselineHeight: 700,
    });
  });

  it("treats a focused mobile field plus a height drop as a software keyboard", () => {
    const droppedHeight = mobileFocused.baselineHeight * MOBILE_KEYBOARD_HEIGHT_RATIO - 1;
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        visualViewportHeight: droppedHeight,
      }),
    ).toEqual({ isKeyboardOpen: true, nextBaselineHeight: 700 });
  });

  it("does not treat a height drop as a keyboard when nothing is focused", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        editableFocused: false,
        visualViewportHeight: 400,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: 400 });
  });

  it("does not hide chrome while pinch-zoomed even if height dropped", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        visualViewportScale: 1.25,
        visualViewportHeight: 400,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: 400 });
  });

  it("treats an explicit VirtualKeyboard signal as open on a focused mobile field", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        virtualKeyboardOpened: true,
      }),
    ).toEqual({ isKeyboardOpen: true, nextBaselineHeight: 700 });
  });

  it("ignores VirtualKeyboard when the viewport is desktop or pinch-zoomed", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        viewportWidth: MOBILE_BREAKPOINT_PX,
        virtualKeyboardOpened: true,
        visualViewportHeight: 400,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: 400 });
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        visualViewportScale: 2,
        virtualKeyboardOpened: true,
        visualViewportHeight: 400,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: 400 });
  });

  it("recaptures the baseline when width, scale, or orientation geometry changes", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        geometryChanged: true,
        visualViewportHeight: 620,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: 620 });
  });

  it("keeps the previous baseline when VirtualKeyboard is already open during a geometry change", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        geometryChanged: true,
        visualViewportHeight: 620,
        virtualKeyboardOpened: true,
      }),
    ).toEqual({ isKeyboardOpen: true, nextBaselineHeight: 700 });
  });

  it("recaptures on rotate while focused when the keyboard was not already open", () => {
    const droppedHeight = mobileFocused.baselineHeight * MOBILE_KEYBOARD_HEIGHT_RATIO - 1;
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        geometryChanged: true,
        previouslyKeyboardOpen: false,
        visualViewportHeight: droppedHeight,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: droppedHeight });
  });

  it("keeps the previous baseline when rotating with the keyboard already open", () => {
    const droppedHeight = mobileFocused.baselineHeight * MOBILE_KEYBOARD_HEIGHT_RATIO - 1;
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        geometryChanged: true,
        previouslyKeyboardOpen: true,
        visualViewportHeight: droppedHeight,
      }),
    ).toEqual({ isKeyboardOpen: true, nextBaselineHeight: 700 });
  });

  it("seeds a missing baseline from the current visual viewport height", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: 0,
        visualViewportHeight: 680,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: 680 });
  });

  it("keeps the unfocused baseline while focused so a later drop can be detected", () => {
    const decision = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: 844,
      visualViewportHeight: 844,
    });

    expect(decision).toEqual({ isKeyboardOpen: false, nextBaselineHeight: 844 });
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: decision.nextBaselineHeight,
        visualViewportHeight: 500,
      }),
    ).toEqual({ isKeyboardOpen: true, nextBaselineHeight: 844 });
  });

  it("recaptures and closes when height grows after rotate while still below the old baseline", () => {
    const portraitBaseline = 844;
    const landscapeKeyboardHeight = 220;
    const landscapeFullHeight = 390;
    expect(landscapeFullHeight).toBeLessThan(portraitBaseline * MOBILE_KEYBOARD_HEIGHT_RATIO);
    expect(landscapeFullHeight - landscapeKeyboardHeight).toBeGreaterThanOrEqual(
      MOBILE_KEYBOARD_DISMISS_GROWTH_PX,
    );

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: portraitBaseline,
        previousVisualViewportHeight: landscapeKeyboardHeight,
        visualViewportHeight: landscapeFullHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: landscapeFullHeight });
  });

  it("stays open and keeps the old baseline when height stays shrunken or shrinks further", () => {
    const portraitBaseline = 844;
    const landscapeKeyboardHeight = 250;
    const stillShrunkenHeight = 220;

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: portraitBaseline,
        previousVisualViewportHeight: landscapeKeyboardHeight,
        visualViewportHeight: landscapeKeyboardHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
      }),
    ).toEqual({ isKeyboardOpen: true, nextBaselineHeight: portraitBaseline });
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: portraitBaseline,
        previousVisualViewportHeight: landscapeKeyboardHeight,
        visualViewportHeight: stillShrunkenHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
      }),
    ).toEqual({ isKeyboardOpen: true, nextBaselineHeight: portraitBaseline });
  });

  it("stays open and keeps the old baseline when rotating with the keyboard already open", () => {
    const portraitBaseline = 844;
    const portraitKeyboardHeight = 500;
    const landscapeKeyboardHeight = 220;

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: portraitBaseline,
        previousVisualViewportHeight: portraitKeyboardHeight,
        visualViewportHeight: landscapeKeyboardHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: true,
      }),
    ).toEqual({ isKeyboardOpen: true, nextBaselineHeight: portraitBaseline });
  });

  it("does not treat sub-threshold growth as a dismiss", () => {
    const portraitBaseline = 844;
    const previousHeight = 220;
    const jitterHeight = previousHeight + MOBILE_KEYBOARD_DISMISS_GROWTH_PX - 1;

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: portraitBaseline,
        previousVisualViewportHeight: previousHeight,
        visualViewportHeight: jitterHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
      }),
    ).toEqual({ isKeyboardOpen: true, nextBaselineHeight: portraitBaseline });
  });

  it("does not recapture on URL-bar chrome growth while the keyboard is still open", () => {
    const portraitBaseline = 844;
    const keyboardHeight = 500;
    const chromeGrownHeight = keyboardHeight + 80;

    expect(80).toBeLessThan(MOBILE_KEYBOARD_DISMISS_GROWTH_PX);
    expect(chromeGrownHeight).toBeLessThan(portraitBaseline * MOBILE_KEYBOARD_HEIGHT_RATIO);
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: portraitBaseline,
        previousVisualViewportHeight: keyboardHeight,
        visualViewportHeight: chromeGrownHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
      }),
    ).toEqual({ isKeyboardOpen: true, nextBaselineHeight: portraitBaseline });
  });

  it("lets VirtualKeyboard true win as open even when height grew after rotate", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: 844,
        previousVisualViewportHeight: 220,
        visualViewportHeight: 390,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
        virtualKeyboardOpened: true,
      }),
    ).toEqual({ isKeyboardOpen: true, nextBaselineHeight: 844 });
  });

  it("recaptures and closes on VirtualKeyboard false plus height growth", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: 844,
        previousVisualViewportHeight: 220,
        visualViewportHeight: 390,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
        virtualKeyboardOpened: false,
      }),
    ).toEqual({ isKeyboardOpen: false, nextBaselineHeight: 390 });
  });
});

describe("visualViewportGrewPastDismissThreshold", () => {
  it("requires growth of at least MOBILE_KEYBOARD_DISMISS_GROWTH_PX", () => {
    expect(MOBILE_KEYBOARD_DISMISS_GROWTH_PX).toBe(160);
    expect(
      visualViewportGrewPastDismissThreshold(220, 220 + MOBILE_KEYBOARD_DISMISS_GROWTH_PX),
    ).toBe(true);
    expect(
      visualViewportGrewPastDismissThreshold(220, 220 + MOBILE_KEYBOARD_DISMISS_GROWTH_PX - 1),
    ).toBe(false);
    expect(visualViewportGrewPastDismissThreshold(0, 400)).toBe(false);
  });

  it("does not treat URL-bar chrome growth as a dismiss", () => {
    expect(visualViewportGrewPastDismissThreshold(500, 580)).toBe(false);
  });

  it("treats software-keyboard sized growth as a dismiss", () => {
    expect(visualViewportGrewPastDismissThreshold(500, 700)).toBe(true);
  });
});

describe("isKeyboardSummoningInputType", () => {
  it("treats empty and text-like types as keyboard-summoning", () => {
    expect(isKeyboardSummoningInputType("")).toBe(true);
    expect(isKeyboardSummoningInputType("text")).toBe(true);
    expect(isKeyboardSummoningInputType("TEXT")).toBe(true);
    expect(isKeyboardSummoningInputType("search")).toBe(true);
    expect(isKeyboardSummoningInputType("email")).toBe(true);
    expect(isKeyboardSummoningInputType("tel")).toBe(true);
    expect(isKeyboardSummoningInputType("url")).toBe(true);
    expect(isKeyboardSummoningInputType("password")).toBe(true);
    expect(isKeyboardSummoningInputType("number")).toBe(true);
  });

  it("excludes non-text input types that do not open a software keyboard", () => {
    for (const type of [
      "button",
      "submit",
      "reset",
      "checkbox",
      "radio",
      "file",
      "hidden",
      "image",
      "range",
      "color",
      "date",
      "time",
      "datetime-local",
      "month",
      "week",
    ]) {
      expect(isKeyboardSummoningInputType(type)).toBe(false);
    }
  });
});

describe("isEditableFocusSnapshot", () => {
  it("treats textarea, contenteditable, and role=textbox as editable", () => {
    expect(isEditableFocusSnapshot({ tagName: "textarea" })).toBe(true);
    expect(isEditableFocusSnapshot({ tagName: "div", isContentEditable: true })).toBe(true);
    expect(isEditableFocusSnapshot({ tagName: "div", role: "textbox" })).toBe(true);
  });

  it("treats text-like inputs as editable and ignores non-text inputs", () => {
    expect(isEditableFocusSnapshot({ tagName: "input" })).toBe(true);
    expect(isEditableFocusSnapshot({ tagName: "input", inputType: "email" })).toBe(true);
    expect(isEditableFocusSnapshot({ tagName: "input", inputType: "checkbox" })).toBe(false);
    expect(isEditableFocusSnapshot({ tagName: "input", inputType: "file" })).toBe(false);
    expect(isEditableFocusSnapshot({ tagName: "button" })).toBe(false);
  });

  it("does not treat disabled controls as editable", () => {
    expect(isEditableFocusSnapshot({ tagName: "input", inputType: "text", disabled: true })).toBe(
      false,
    );
    expect(isEditableFocusSnapshot({ tagName: "textarea", disabled: true })).toBe(false);
    expect(isEditableFocusSnapshot({ tagName: "div", role: "textbox", disabled: true })).toBe(
      false,
    );
  });
});

describe("isEditableFocusTarget", () => {
  it("rejects null and non-element targets", () => {
    expect(isEditableFocusTarget(null)).toBe(false);
  });
});
