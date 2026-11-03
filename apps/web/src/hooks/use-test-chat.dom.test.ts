// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StreamArgs = {
  signal: AbortSignal;
  onDelta: (delta: { content: string; thinking: string }) => void;
};

const streams = vi.hoisted(() => ({
  calls: [] as Array<{ args: StreamArgs; resolve: () => void; reject: (error: Error) => void }>,
}));

vi.mock("@/lib/test-relay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/test-relay")>();
  return {
    ...actual,
    chatRequest: () => ({}),
    streamTestChat: (args: StreamArgs) =>
      new Promise((resolve, reject) => {
        const call = {
          args,
          resolve: () => resolve(undefined),
          reject: (error: Error) => reject(error),
        };
        args.signal.addEventListener("abort", () => reject(new Error("aborted")));
        streams.calls.push(call);
      }),
  };
});

import { type TestChatSettings, useTestChat } from "./use-test-chat";

const settings: TestChatSettings = {
  surface: "OPENAI_CHAT_COMPLETIONS",
  model: "m",
  system: "",
  reasoning: {},
  maxTokens: 16,
  emptyMessage: "empty",
};

const input = (text: string) => ({ text, attachments: [] });

describe("useTestChat request state", () => {
  beforeEach(() => {
    streams.calls = [];
  });
  afterEach(cleanup);

  it("is streaming while a request runs and idle once it settles", async () => {
    const { result } = renderHook(() => useTestChat());
    expect(result.current.request).toBe("idle");
    let sent: Promise<void> = Promise.resolve();
    act(() => {
      sent = result.current.send(input("hi"), settings);
    });
    expect(result.current.request).toBe("streaming");
    expect(result.current.streaming).toBe(true);
    await act(async () => {
      streams.calls[0]?.resolve();
      await sent;
    });
    expect(result.current.request).toBe("idle");
    expect(result.current.messages.at(-1)?.status).toBe("ready");
  });

  it("refuses a second send while one is in flight", async () => {
    const { result } = renderHook(() => useTestChat());
    act(() => {
      void result.current.send(input("one"), settings);
    });
    await act(async () => {
      await result.current.send(input("two"), settings);
    });
    expect(streams.calls).toHaveLength(1);
    expect(result.current.messages).toHaveLength(2);
  });

  it("is idle right after reset, and the reset request settling late does not end a new one", async () => {
    const { result } = renderHook(() => useTestChat());
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.send(input("one"), settings);
    });
    act(() => result.current.reset());
    expect(result.current.request).toBe("idle");
    expect(result.current.streaming).toBe(false);
    expect(result.current.messages).toEqual([]);
    expect(streams.calls[0]?.args.signal.aborted).toBe(true);

    // A new send right away is accepted, even before the aborted one has settled.
    let second: Promise<void> = Promise.resolve();
    act(() => {
      second = result.current.send(input("two"), settings);
    });
    expect(streams.calls).toHaveLength(2);
    await act(async () => {
      await first;
    });
    expect(result.current.request).toBe("streaming");
    expect(result.current.messages.map((message) => message.content)).toEqual(["two", ""]);
    await act(async () => {
      streams.calls[1]?.resolve();
      await second;
    });
    expect(result.current.request).toBe("idle");
  });

  it("marks a stopped answer stopped and goes idle", async () => {
    const { result } = renderHook(() => useTestChat());
    let sent: Promise<void> = Promise.resolve();
    act(() => {
      sent = result.current.send(input("hi"), settings);
    });
    await act(async () => {
      result.current.stop();
      await sent;
    });
    expect(result.current.request).toBe("idle");
    expect(result.current.messages.at(-1)?.status).toBe("stopped");
  });

  it("aborts the request on unmount", () => {
    const { result, unmount } = renderHook(() => useTestChat());
    act(() => {
      void result.current.send(input("hi"), settings);
    });
    unmount();
    expect(streams.calls[0]?.args.signal.aborted).toBe(true);
  });
});
