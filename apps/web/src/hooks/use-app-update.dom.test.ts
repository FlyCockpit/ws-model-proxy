// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type RegisterOptions = { immediate?: boolean; onNeedReload?: () => void };
const registerSWMock = vi.hoisted(() => vi.fn((_options: RegisterOptions) => async () => {}));

vi.mock("virtual:pwa-register", () => ({ registerSW: registerSWMock }));

import { useAppUpdate } from "./use-app-update";

describe("useAppUpdate", () => {
  afterEach(() => {
    cleanup();
    registerSWMock.mockClear();
    vi.useRealTimers();
  });

  it("registers the service worker with a no-op onNeedReload so an activated update never reloads the page", () => {
    vi.useFakeTimers();

    renderHook(() => useAppUpdate());
    vi.runAllTimers();

    expect(registerSWMock).toHaveBeenCalledTimes(1);
    const options = registerSWMock.mock.calls[0]?.[0];
    expect(options?.immediate).toBe(true);
    // Without onNeedReload, vite-plugin-pwa's autoUpdate mode reloads the page.
    expect(options?.onNeedReload).toBeTypeOf("function");
  });
});
