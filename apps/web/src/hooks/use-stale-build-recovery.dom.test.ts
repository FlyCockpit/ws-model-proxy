// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigating = {
  latestLocation: { href: "/en-US/nodes", publicHref: "/en-US/nodes" },
  state: { resolvedLocation: { href: "/en-US/overview" } },
};
const router = vi.hoisted(() => ({
  latestLocation: { href: "", publicHref: "" },
  state: { resolvedLocation: { href: "" } },
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));

import { STALE_BUILD_RELOAD_KEY } from "@/lib/stale-build-recovery";
import { useStaleBuildRecovery } from "./use-stale-build-recovery";

function dispatchPreloadError() {
  const event = new Event("vite:preloadError", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("useStaleBuildRecovery", () => {
  beforeEach(() => {
    Object.assign(router, structuredClone(navigating));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("cancels the preload error and navigates once to the pending route", () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign });
    renderHook(() => useStaleBuildRecovery());

    expect(dispatchPreloadError().defaultPrevented).toBe(true);
    // A second chunk of the same navigation is swallowed without a second navigation.
    expect(dispatchPreloadError().defaultPrevented).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/en-US/nodes");
    expect(sessionStorage.getItem(STALE_BUILD_RELOAD_KEY)).not.toBeNull();
  });

  it("lets the error surface inside the cooldown", () => {
    sessionStorage.setItem(STALE_BUILD_RELOAD_KEY, String(Date.now()));
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign });
    renderHook(() => useStaleBuildRecovery());

    expect(dispatchPreloadError().defaultPrevented).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("stops listening on unmount", () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign });
    const view = renderHook(() => useStaleBuildRecovery());
    view.unmount();

    expect(dispatchPreloadError().defaultPrevented).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("ignores a failed hover preload while idle, but reloads right after a click", () => {
    Object.assign(router, {
      latestLocation: { href: "/en-US/overview", publicHref: "/en-US/overview" },
      state: { resolvedLocation: { href: "/en-US/overview" } },
    });
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload });
    renderHook(() => useStaleBuildRecovery());

    expect(dispatchPreloadError().defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pointerdown"));
    expect(dispatchPreloadError().defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("can recover again after a back/forward-cache restore", () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign });
    renderHook(() => useStaleBuildRecovery());

    expect(dispatchPreloadError().defaultPrevented).toBe(true);
    sessionStorage.clear();
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(dispatchPreloadError().defaultPrevented).toBe(true);
    expect(assign).toHaveBeenCalledTimes(2);
  });
});
