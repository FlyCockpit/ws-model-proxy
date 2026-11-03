// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCopyFeedback } from "./use-copy-feedback";

const writeText = vi.fn<(text: string) => Promise<void>>();

describe("useCopyFeedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows copied, then idle after the reset time", async () => {
    const { result } = renderHook(() => useCopyFeedback(1_000));
    let copied = false;
    await act(async () => {
      copied = await result.current.copy("hello");
    });
    expect(copied).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(result.current.feedback).toBe("copied");
    act(() => vi.advanceTimersByTime(999));
    expect(result.current.feedback).toBe("copied");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.feedback).toBe("idle");
  });

  it("restarts the timer on a rapid second copy instead of resetting early", async () => {
    const { result } = renderHook(() => useCopyFeedback(1_000));
    await act(async () => {
      await result.current.copy("a");
    });
    act(() => vi.advanceTimersByTime(800));
    await act(async () => {
      await result.current.copy("b");
    });
    // The first copy's timer would have fired here.
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.feedback).toBe("copied");
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.feedback).toBe("idle");
  });

  it("shows failed when the clipboard refuses, and resolves false", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const { result } = renderHook(() => useCopyFeedback(1_000));
    let copied = true;
    await act(async () => {
      copied = await result.current.copy("x");
    });
    expect(copied).toBe(false);
    expect(result.current.feedback).toBe("failed");
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.feedback).toBe("idle");
  });

  it("leaves no timer behind on unmount, even for a copy that settles after it", async () => {
    const { result, unmount } = renderHook(() => useCopyFeedback(1_000));
    await act(async () => {
      await result.current.copy("first");
    });
    expect(vi.getTimerCount()).toBe(1);
    let release: () => void = () => {};
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = result.current.copy("late");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    release();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
