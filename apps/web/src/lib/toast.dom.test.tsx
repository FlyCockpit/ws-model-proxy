// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Toaster } from "@ws-model-proxy/ui/components/sileo";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  act(() => {
    toast.clear();
  });
});

afterEach(() => {
  act(() => {
    toast.clear();
  });
  cleanup();
  vi.unstubAllGlobals();
});

describe("Toaster + toast single-control action", () => {
  it("renders the action as a non-interactive span inside the toast button without nested interactive controls", () => {
    const onClick = vi.fn();
    const { container } = render(<Toaster />);

    act(() => {
      toast.error("Sync failed", { action: { label: "Retry", onClick } });
    });

    const toastButton = container.querySelector("[data-sileo-toast]");
    expect(toastButton).toBeTruthy();
    expect(toastButton?.tagName).toBe("BUTTON");
    expect(toastButton?.getAttribute("aria-label")).toBe("Sync failed — Retry");
    expect(toastButton?.querySelectorAll("a, button, [role='button']")).toHaveLength(0);

    const actionPill = toastButton?.querySelector("[data-sileo-button][data-toast-action-id]");
    expect(actionPill?.tagName).toBe("SPAN");
    expect(actionPill?.textContent).toBe("Retry");

    fireEvent.click(actionPill as Element);
    expect(onClick).toHaveBeenCalledTimes(1);

    toastButton?.setAttribute("data-exiting", "true");
    fireEvent.click(actionPill as Element);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks after toast.clear() clears the action registry", () => {
    const onClick = vi.fn();
    const { container } = render(<Toaster />);

    act(() => {
      toast.warning("Connection lost", { action: { label: "Reconnect", onClick } });
    });

    const actionPill = container.querySelector("[data-toast-action-id]");
    expect(actionPill).toBeTruthy();

    act(() => {
      toast.clear();
    });

    fireEvent.click(actionPill as Element);
    expect(onClick).not.toHaveBeenCalled();
  });
});
