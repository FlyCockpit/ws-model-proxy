import { describe, expect, it, vi } from "vitest";

import {
  claimReloadSlot,
  recoverFromStaleChunk,
  STALE_BUILD_RELOAD_COOLDOWN_MS,
  STALE_BUILD_RELOAD_KEY,
  type StaleBuildRecoveryEnv,
} from "./stale-build-recovery";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

const idle = {
  latestLocation: { href: "/en-US/overview", publicHref: "/en-US/overview" },
  state: { resolvedLocation: { href: "/en-US/overview" } },
};
const navigating = {
  latestLocation: { href: "/en-US/nodes?tab=all", publicHref: "/en-US/nodes?tab=all" },
  state: { resolvedLocation: { href: "/en-US/overview" } },
};

function env(overrides: Partial<StaleBuildRecoveryEnv> = {}) {
  const storage = memoryStorage();
  return {
    storageData: storage.data,
    router: navigating,
    storage,
    now: 1_000_000,
    userActivated: false,
    assign: vi.fn(),
    reload: vi.fn(),
    ...overrides,
  };
}

describe("recoverFromStaleChunk", () => {
  it("navigates fully to the page the router was going to", () => {
    const e = env();
    expect(recoverFromStaleChunk(e)).toBe(true);
    expect(e.assign).toHaveBeenCalledWith("/en-US/nodes?tab=all");
    expect(e.reload).not.toHaveBeenCalled();
    expect(e.storageData.get(STALE_BUILD_RELOAD_KEY)).toBe("1000000");
  });

  it("reloads the current page when a click (not a navigation) hit the stale chunk", () => {
    const e = env({ router: idle, userActivated: true });
    expect(recoverFromStaleChunk(e)).toBe(true);
    expect(e.reload).toHaveBeenCalledOnce();
    expect(e.assign).not.toHaveBeenCalled();
  });

  it("ignores a failed hover/intent preload so hovering a link never reloads", () => {
    const e = env({ router: idle, userActivated: false });
    expect(recoverFromStaleChunk(e)).toBe(false);
    expect(e.reload).not.toHaveBeenCalled();
    expect(e.assign).not.toHaveBeenCalled();
    expect(e.storageData.has(STALE_BUILD_RELOAD_KEY)).toBe(false);
  });

  it("does nothing again within the cooldown, so it cannot loop", () => {
    const storage = memoryStorage({ [STALE_BUILD_RELOAD_KEY]: "1000000" });
    const e = env({ storage, now: 1_000_000 + STALE_BUILD_RELOAD_COOLDOWN_MS - 1 });
    expect(recoverFromStaleChunk(e)).toBe(false);
    expect(e.assign).not.toHaveBeenCalled();
  });

  it("recovers again once the cooldown has passed", () => {
    const storage = memoryStorage({ [STALE_BUILD_RELOAD_KEY]: "1000000" });
    const e = env({ storage, now: 1_000_000 + STALE_BUILD_RELOAD_COOLDOWN_MS });
    expect(recoverFromStaleChunk(e)).toBe(true);
  });
});

describe("claimReloadSlot", () => {
  it("refuses when storage is unavailable or throws", () => {
    expect(claimReloadSlot(undefined, 1)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
    };
    expect(claimReloadSlot(throwing, 1)).toBe(false);
  });

  it("ignores a garbage or future timestamp", () => {
    expect(claimReloadSlot(memoryStorage({ [STALE_BUILD_RELOAD_KEY]: "nope" }), 5)).toBe(true);
    expect(claimReloadSlot(memoryStorage({ [STALE_BUILD_RELOAD_KEY]: "9999" }), 5)).toBe(true);
  });
});
