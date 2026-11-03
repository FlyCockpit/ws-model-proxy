// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { fitAttachments, useAttachmentQueue } from "./use-attachment-queue";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("fitAttachments", () => {
  it("appends within the limit and says when some did not fit", () => {
    expect(fitAttachments([1], [2, 3], 4)).toEqual({ items: [1, 2, 3], overflow: false });
    expect(fitAttachments([1, 2], [3, 4, 5], 3)).toEqual({ items: [1, 2, 3], overflow: true });
    expect(fitAttachments([1, 2, 3], [4], 2)).toEqual({ items: [1, 2, 3], overflow: true });
  });
});

describe("useAttachmentQueue", () => {
  afterEach(cleanup);

  it("runs overlapping adds one at a time, each with the room left, never past the limit", async () => {
    const { result } = renderHook(() => useAttachmentQueue<string>(3));
    const first = deferred<{ accepted: string[]; result: null }>();
    const rooms: number[] = [];
    let firstOutcome: Promise<unknown> = Promise.resolve();
    let secondOutcome: Promise<unknown> = Promise.resolve();
    await act(async () => {
      firstOutcome = result.current.add((room) => {
        rooms.push(room);
        return first.promise;
      });
      secondOutcome = result.current.add(async (room) => {
        rooms.push(room);
        return { accepted: ["c", "d", "e"].slice(0, room), result: null };
      });
    });
    expect(result.current.processing).toBe(true);
    // The second job waits for the first.
    expect(rooms).toEqual([3]);

    await act(async () => {
      first.resolve({ accepted: ["a", "b"], result: null });
      await firstOutcome;
    });
    await act(async () => {
      await secondOutcome;
    });
    expect(rooms).toEqual([3, 1]);
    expect(result.current.items).toEqual(["a", "b", "c"]);
    expect(result.current.processing).toBe(false);
  });

  it("keeps processing on until the last job ends, even when an earlier one ends first", async () => {
    const { result } = renderHook(() => useAttachmentQueue<string>(5));
    const first = deferred<{ accepted: string[]; result: null }>();
    const second = deferred<{ accepted: string[]; result: null }>();
    let firstOutcome: Promise<unknown> = Promise.resolve();
    let secondOutcome: Promise<unknown> = Promise.resolve();
    act(() => {
      firstOutcome = result.current.add(() => first.promise);
      secondOutcome = result.current.add(() => second.promise);
    });
    await act(async () => {
      first.resolve({ accepted: ["a"], result: null });
      await firstOutcome;
    });
    expect(result.current.processing).toBe(true);
    await act(async () => {
      second.resolve({ accepted: ["b"], result: null });
      await secondOutcome;
    });
    expect(result.current.processing).toBe(false);
    expect(result.current.items).toEqual(["a", "b"]);
  });

  it("does not run a job when the list is full, and reports overflow", async () => {
    const { result } = renderHook(() => useAttachmentQueue<string>(1));
    await act(async () => {
      const outcome = await result.current.add(async () => ({ accepted: ["a", "b"], result: 1 }));
      expect(outcome).toEqual({ kind: "added", result: 1, overflow: true });
    });
    let ran = false;
    await act(async () => {
      const outcome = await result.current.add(async () => {
        ran = true;
        return { accepted: ["c"], result: 2 };
      });
      expect(outcome).toEqual({ kind: "full" });
    });
    expect(ran).toBe(false);
    expect(result.current.items).toEqual(["a"]);
  });

  it("a failing job ends its processing and does not block the next one", async () => {
    const { result } = renderHook(() => useAttachmentQueue<string>(3));
    await act(async () => {
      await expect(
        result.current.add(async () => {
          throw new Error("unreadable");
        }),
      ).rejects.toThrow("unreadable");
    });
    expect(result.current.processing).toBe(false);
    await act(async () => {
      await result.current.add(async () => ({ accepted: ["a"], result: null }));
    });
    expect(result.current.items).toEqual(["a"]);
  });

  it("removes and clears", async () => {
    const { result } = renderHook(() => useAttachmentQueue<string>(3));
    await act(async () => {
      await result.current.add(async () => ({ accepted: ["a", "b"], result: null }));
    });
    act(() => result.current.remove((item) => item === "a"));
    expect(result.current.items).toEqual(["b"]);
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
  });
});
