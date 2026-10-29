// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

vi.mock("@/utils/orpc", () => {
  // Every procedure path answers `.key()` with its own path, enough to tell the keys apart.
  const at = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => (prop === "key" ? () => [path] : at([...path, String(prop)])),
    });
  return { orpc: at([]) };
});

const { useNodeLive } = await import("@/stores/node-live");
const { nodeLiveQueryKeys } = await import("@/lib/node-live-updates");
const { useNodeLiveUpdates } = await import("./use-node-live-updates");

const KEYS = nodeLiveQueryKeys().length;
const encoder = new TextEncoder();

type Stream = {
  push: (text: string) => void;
  end: () => void;
  signal: AbortSignal;
};

let streams: Stream[];
let responses: Array<number | "stream" | "hang">;

function fakeFetch(_url: string, init?: RequestInit): Promise<Response> {
  const kind = responses.shift() ?? "stream";
  const signal = init?.signal ?? new AbortController().signal;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort);
    if (kind === "hang") return;
    if (typeof kind === "number") {
      resolve(new Response(JSON.stringify({ error: "x" }), { status: kind }));
      return;
    }
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    signal.addEventListener("abort", () => {
      try {
        controller?.error(new DOMException("aborted", "AbortError"));
      } catch {
        // already closed
      }
    });
    streams.push({
      push: (text) => controller?.enqueue(encoder.encode(text)),
      end: () => controller?.close(),
      signal,
    });
    resolve(new Response(body, { status: 200 }));
  });
}

const fetchMock = vi.fn(fakeFetch);
let queryClient: QueryClient;
let invalidate: MockInstance<QueryClient["invalidateQueries"]>;

function Harness({ sessionKey }: { sessionKey: string | null }) {
  useNodeLiveUpdates(sessionKey);
  return null;
}

function mount(sessionKey: string | null = "sess-1") {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<Harness sessionKey={sessionKey} />, { wrapper });
}

/** Lets fetch promises and stream reads settle, then moves the clock. */
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const flushes = () => invalidate.mock.calls.length / KEYS;
const status = () => useNodeLive.getState().status;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  streams = [];
  responses = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  queryClient = new QueryClient();
  invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
  useNodeLive.getState().set({ status: "off" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useNodeLiveUpdates", () => {
  it("opens no stream while signed out", async () => {
    mount(null);
    await advance(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status()).toBe("off");
  });

  it("opens one same-origin stream, goes live and refreshes once after opening", async () => {
    mount();
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/dashboard/events");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
    expect(status()).toBe("live");
    expect(flushes()).toBe(0);
    await advance(250);
    expect(flushes()).toBe(1);
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual(
      nodeLiveQueryKeys().map((queryKey) => ({ queryKey })),
    );
  });

  it("coalesces a burst of node events into one refresh, and ignores other events", async () => {
    mount();
    await advance(250);
    invalidate.mockClear();
    const stream = streams[0];
    for (let index = 0; index < 20; index += 1)
      stream?.push(`event: node\ndata: {"type":"node.connection","nodeId":"n${index}"}\n\n`);
    stream?.push(": ping\n\nevent: other\ndata: {}\n\nevent: node\ndata: nope\n\n");
    await advance(250);
    expect(flushes()).toBe(1);
    invalidate.mockClear();
    stream?.push(": ping\n\n");
    await advance(1_000);
    expect(flushes()).toBe(0);
  });

  it("stops for good on 401 or 403, and on an unauthorized event", async () => {
    for (const refusal of [401, 403]) {
      responses = [refusal];
      const view = mount();
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(status()).toBe("unauthorized");
      view.unmount();
      fetchMock.mockClear();
    }
    mount();
    await advance();
    streams[0]?.push('event: unauthorized\ndata: {"reason":"session_ended"}\n\n');
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status()).toBe("unauthorized");
  });

  it("opens a fresh stream when the session changes after an unauthorized stop", async () => {
    responses = [401];
    const view = mount("sess-1");
    await advance();
    expect(status()).toBe("unauthorized");
    view.rerender(<Harness sessionKey="sess-2" />);
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(status()).toBe("live");
  });

  it("reconnects with backoff after an ended stream or a refused one, and refreshes again", async () => {
    responses = ["stream", 503, 429, "stream"];
    mount();
    await advance(250);
    streams[0]?.end();
    await advance();
    expect(status()).toBe("down");
    // Attempt 0: 0.5 s (+ jitter up to 250 ms), then 1 s, then 2 s.
    await advance(750);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1_250);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    invalidate.mockClear();
    await advance(2_250 + 250);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(status()).toBe("live");
    // The reconnect refreshes, since events may have been missed while down.
    expect(flushes()).toBe(1);
  });

  it("resets the backoff after a stream that stayed up", async () => {
    responses = [503, 503, 503, "stream", "stream"];
    mount();
    await advance(500 + 1_000 + 2_000 + 750);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(status()).toBe("live");
    await advance(30_000);
    streams[0]?.end();
    await advance(750);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("ends a stream that hears nothing, even a response that never arrives", async () => {
    responses = ["hang", "stream", "stream"];
    mount();
    await advance(64_000);
    expect(status()).toBe("connecting");
    await advance(1_000 + 750);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(status()).toBe("live");
    // Pings keep it open; silence ends it.
    for (let index = 0; index < 4; index += 1) {
      await advance(25_000);
      streams[0]?.push(": ping\n\n");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(65_000);
    expect(streams[0]?.signal.aborted).toBe(true);
    await advance(2_250);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reconnects at once when the browser comes back online or the tab becomes visible", async () => {
    responses = [503, 503, "stream", "stream"];
    mount();
    await advance();
    expect(status()).toBe("down");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(status()).toBe("live");
    // Already open: nothing more.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("says so only after 10 s down, and clears it once live again", async () => {
    responses = ["stream", 503, 503, 503, 503, 503, "stream"];
    mount();
    await advance();
    streams[0]?.end();
    await advance(9_000);
    expect(useNodeLive.getState()).toMatchObject({ status: "down", notice: false });
    await advance(1_000);
    expect(useNodeLive.getState()).toMatchObject({ status: "down", notice: true });
    await advance(30_000);
    expect(useNodeLive.getState()).toMatchObject({ status: "live", notice: false });
  });

  it("closes the stream and stops on unmount (sign-out)", async () => {
    const view = mount();
    await advance();
    view.unmount();
    expect(streams[0]?.signal.aborted).toBe(true);
    expect(status()).toBe("off");
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
