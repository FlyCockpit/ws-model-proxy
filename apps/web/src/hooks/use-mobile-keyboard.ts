import { useEffect, useRef, useState } from "react";

import { MOBILE_BREAKPOINT_PX } from "./use-media-query";

/** Keyboard is open only when visual viewport height falls below this share of the baseline. */
export const MOBILE_KEYBOARD_HEIGHT_RATIO = 0.8;

/**
 * Visual viewport must grow by at least this many px vs the last evaluated
 * height to count as a keyboard dismiss. Mobile browser chrome (URL bar
 * hide/show) commonly changes visualViewport by ~50–80px while the keyboard
 * is still open; real software-keyboard dismiss jumps are typically 200px+.
 * Stay above chrome-sized growth and below keyboard-sized growth.
 */
export const MOBILE_KEYBOARD_DISMISS_GROWTH_PX = 160;

const PINCH_ZOOM_SCALE_EPSILON = 0.01;

/** Input types that typically summon a software keyboard on mobile. */
const KEYBOARD_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "tel",
  "url",
  "password",
  "number",
]);

export type EditableFocusSnapshot = {
  tagName: string;
  inputType?: string | null;
  disabled?: boolean;
  isContentEditable?: boolean;
  role?: string | null;
};

type VirtualKeyboardLike = {
  boundingRect: { readonly height: number };
  addEventListener(type: "geometrychange", listener: () => void): void;
  removeEventListener(type: "geometrychange", listener: () => void): void;
};

export type MobileKeyboardSnapshot = {
  viewportWidth: number;
  visualViewportHeight: number;
  visualViewportScale: number;
  baselineHeight: number;
  editableFocused: boolean;
  /** True when the VirtualKeyboard API reports a visible keyboard. `null` if unavailable. */
  virtualKeyboardOpened?: boolean | null;
  /** Width, scale, or orientation changed since the previous evaluation. */
  geometryChanged?: boolean;
  /** Previous decision: keyboard was already known to be open. */
  previouslyKeyboardOpen?: boolean;
  /** Last evaluated visual viewport height (before this snapshot). */
  previousVisualViewportHeight?: number;
};

export type MobileKeyboardDecision = {
  isKeyboardOpen: boolean;
  nextBaselineHeight: number;
};

function isPinchZoomed(scale: number): boolean {
  return Math.abs(scale - 1) > PINCH_ZOOM_SCALE_EPSILON;
}

function isMobileViewport(viewportWidth: number): boolean {
  return viewportWidth < MOBILE_BREAKPOINT_PX;
}

function heightDroppedVersus(baselineHeight: number, visualViewportHeight: number): boolean {
  return baselineHeight > 0 && visualViewportHeight < baselineHeight * MOBILE_KEYBOARD_HEIGHT_RATIO;
}

/** True when height grew vs the last visual viewport by a dismiss, not jitter. */
export function visualViewportGrewPastDismissThreshold(
  previousVisualViewportHeight: number,
  visualViewportHeight: number,
): boolean {
  return (
    previousVisualViewportHeight > 0 &&
    visualViewportHeight - previousVisualViewportHeight >= MOBILE_KEYBOARD_DISMISS_GROWTH_PX
  );
}

/**
 * Conservative software-keyboard decision for chrome visibility.
 * Recapture the height baseline when the keyboard cannot be open. Geometry
 * changes recapture unless the keyboard was already known to be open or
 * VirtualKeyboard currently reports open. A height drop vs the old baseline
 * is not proof the keyboard is open during a geometry change (landscape
 * height is often a >20% drop from portrait). After that, if the keyboard
 * was already open, geometry is stable, VirtualKeyboard is not reporting
 * open, and visual viewport grew by MOBILE_KEYBOARD_DISMISS_GROWTH_PX,
 * recapture and close (dismiss without blur after rotate).
 */
export function getMobileKeyboardDecision(input: MobileKeyboardSnapshot): MobileKeyboardDecision {
  const mobile = isMobileViewport(input.viewportWidth);
  const pinchZoomed = isPinchZoomed(input.visualViewportScale);
  const dismissedAfterRotate =
    input.previouslyKeyboardOpen === true &&
    input.geometryChanged !== true &&
    input.virtualKeyboardOpened !== true &&
    visualViewportGrewPastDismissThreshold(
      input.previousVisualViewportHeight ?? 0,
      input.visualViewportHeight,
    );
  const shouldRecaptureBaseline =
    input.baselineHeight <= 0 ||
    !mobile ||
    pinchZoomed ||
    !input.editableFocused ||
    (input.geometryChanged === true &&
      input.previouslyKeyboardOpen !== true &&
      input.virtualKeyboardOpened !== true) ||
    dismissedAfterRotate;
  const nextBaselineHeight = shouldRecaptureBaseline
    ? input.visualViewportHeight
    : input.baselineHeight;
  const heightDropped = heightDroppedVersus(nextBaselineHeight, input.visualViewportHeight);
  const isKeyboardOpen =
    mobile &&
    !pinchZoomed &&
    input.editableFocused &&
    (input.virtualKeyboardOpened === true || heightDropped);

  return { isKeyboardOpen, nextBaselineHeight };
}

export function isKeyboardSummoningInputType(type: string): boolean {
  return KEYBOARD_INPUT_TYPES.has(type.trim().toLowerCase());
}

export function isEditableFocusSnapshot(input: EditableFocusSnapshot): boolean {
  if (input.disabled) return false;
  const tag = input.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return isKeyboardSummoningInputType(input.inputType ?? "");
  if (input.isContentEditable) return true;
  return input.role === "textbox";
}

export function isEditableFocusTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  const formControl =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
  return isEditableFocusSnapshot({
    tagName: target.tagName,
    inputType: target instanceof HTMLInputElement ? target.type : null,
    disabled: Boolean(formControl?.disabled) || target.getAttribute("aria-disabled") === "true",
    isContentEditable: target.isContentEditable,
    role: target.getAttribute("role"),
  });
}

function getVirtualKeyboard(): VirtualKeyboardLike | null {
  if (typeof navigator === "undefined") return null;
  const candidate = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike })
    .virtualKeyboard;
  return candidate ?? null;
}

function readOrientationKey(): string {
  const screenOrientation = window.screen.orientation?.type;
  if (screenOrientation) return screenOrientation;
  return String(window.orientation ?? window.innerWidth > window.innerHeight);
}

export function useMobileKeyboard(): boolean {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const baselineHeightRef = useRef(0);
  const keyboardOpenRef = useRef(false);
  const previousVisualViewportHeightRef = useRef(0);
  const geometryRef = useRef({ width: 0, scale: 1, orientation: "" });

  useEffect(() => {
    const readGeometry = () => {
      const visualViewport = window.visualViewport;
      return {
        width: window.innerWidth,
        height: visualViewport?.height ?? window.innerHeight,
        scale: visualViewport?.scale ?? 1,
        orientation: readOrientationKey(),
      };
    };

    const evaluate = () => {
      const geometry = readGeometry();
      const previous = geometryRef.current;
      const geometryChanged =
        previous.width !== 0 &&
        (previous.width !== geometry.width ||
          previous.scale !== geometry.scale ||
          previous.orientation !== geometry.orientation);
      const virtualKeyboard = getVirtualKeyboard();
      const decision = getMobileKeyboardDecision({
        viewportWidth: geometry.width,
        visualViewportHeight: geometry.height,
        visualViewportScale: geometry.scale,
        baselineHeight: baselineHeightRef.current,
        editableFocused: isEditableFocusTarget(document.activeElement),
        virtualKeyboardOpened: virtualKeyboard ? virtualKeyboard.boundingRect.height > 0 : null,
        geometryChanged,
        previouslyKeyboardOpen: keyboardOpenRef.current,
        previousVisualViewportHeight: previousVisualViewportHeightRef.current,
      });

      baselineHeightRef.current = decision.nextBaselineHeight;
      keyboardOpenRef.current = decision.isKeyboardOpen;
      previousVisualViewportHeightRef.current = geometry.height;
      geometryRef.current = {
        width: geometry.width,
        scale: geometry.scale,
        orientation: geometry.orientation,
      };
      setKeyboardOpen(decision.isKeyboardOpen);
    };

    const onFocusOut = (event: FocusEvent) => {
      if (isEditableFocusTarget(event.relatedTarget)) {
        evaluate();
        return;
      }
      // Blur runs before the next focus lands. Wait a frame so tabbing
      // between fields does not recapture a keyboard-shrunk baseline.
      requestAnimationFrame(evaluate);
    };

    evaluate();

    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", evaluate);
    window.addEventListener("resize", evaluate);
    window.addEventListener("orientationchange", evaluate);
    document.addEventListener("focusin", evaluate);
    document.addEventListener("focusout", onFocusOut);
    const virtualKeyboard = getVirtualKeyboard();
    virtualKeyboard?.addEventListener("geometrychange", evaluate);

    return () => {
      visualViewport?.removeEventListener("resize", evaluate);
      window.removeEventListener("resize", evaluate);
      window.removeEventListener("orientationchange", evaluate);
      document.removeEventListener("focusin", evaluate);
      document.removeEventListener("focusout", onFocusOut);
      virtualKeyboard?.removeEventListener("geometrychange", evaluate);
    };
  }, []);

  return keyboardOpen;
}
