// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KEYBOARD_INSET_VAR, useMobileKeyboard } from "./use-mobile-keyboard";

/** A visual viewport whose geometry the test moves, firing the events a browser would. */
class FakeVisualViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
}

const inset = () => document.documentElement.style.getPropertyValue(KEYBOARD_INSET_VAR);

describe("useMobileKeyboard inset", () => {
  let viewport: FakeVisualViewport;
  let input: HTMLTextAreaElement;

  beforeEach(() => {
    viewport = new FakeVisualViewport();
    vi.stubGlobal("visualViewport", viewport);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
  });

  afterEach(() => {
    cleanup();
    input.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("follows the visual viewport when it only scrolls", () => {
    const { result } = renderHook(() => useMobileKeyboard());
    expect(inset()).toBe("0px");
    act(() => {
      viewport.height = 480;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(true);
    expect(inset()).toBe("320px");
    // Scrolling the visual viewport down changes offsetTop without a resize.
    act(() => {
      viewport.offsetTop = 100;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(inset()).toBe("220px");
    act(() => {
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(inset()).toBe("320px");
  });

  it("clears the inset on unmount", () => {
    const { unmount } = renderHook(() => useMobileKeyboard());
    unmount();
    expect(inset()).toBe("");
  });
});
