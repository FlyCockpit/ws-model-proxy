// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRealtimeTranscription } from "./use-realtime-transcription";

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  closed = false;
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

class FakeNode {
  static last: FakeNode | null = null;
  port = new FakePort();
  disconnected = false;
  constructor() {
    FakeNode.last = this;
  }
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
}

class FakeContext {
  static last: FakeContext | null = null;
  closed = false;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  constructor() {
    FakeContext.last = this;
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
  async close() {
    this.closed = true;
  }
}

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: FakeSocket | null = null;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly protocols: unknown;
  constructor(
    readonly url: string,
    ...rest: unknown[]
  ) {
    this.protocols = rest[0];
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  serverEvent(event: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

const track = { stop: vi.fn() };
const getUserMedia = vi.fn();

beforeEach(() => {
  track.stop.mockClear();
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [track] });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeNode);
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function started() {
  const hook = renderHook(() => useRealtimeTranscription());
  await act(async () => {
    await hook.result.current.start({ model: "owner/asr" });
  });
  const socket = FakeSocket.last;
  if (!socket) throw new Error("no socket");
  return { hook, socket };
}

describe("useRealtimeTranscription", () => {
  it("opens the mic, then the dashboard-signed Chat Test socket with no token or subprotocol", async () => {
    const { hook, socket } = await started();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    expect(FakeContext.last?.audioWorklet.addModule).toHaveBeenCalledWith(
      "/realtime-pcm-worklet.js",
    );
    expect(socket.url).toBe(
      "ws://localhost:3000/api/internal/chat-test/realtime?intent=transcription&model=owner%2Fasr",
    );
    expect(socket.protocols).toBeUndefined();
    expect(hook.result.current.state.phase).toBe("starting");
    act(() => socket.serverEvent({ type: "session.created" }));
    expect(hook.result.current.state.phase).toBe("live");
  });

  it("streams worklet PCM as appends and commits after the flush", async () => {
    const { hook, socket } = await started();
    const node = FakeNode.last;
    act(() => node?.port.emit(new Int16Array([1, 2]).buffer));
    act(() => hook.result.current.commit());
    expect(node?.port.posted).toEqual(["flush"]);
    act(() => node?.port.emit({ type: "flushed" }));
    expect(socket.sent.map((data) => JSON.parse(data))).toEqual([
      {
        type: "input_audio_buffer.append",
        audio: Buffer.from(new Int16Array([1, 2]).buffer).toString("base64"),
      },
      { type: "input_audio_buffer.commit" },
    ]);
  });

  it("reports a denied microphone without opening a socket", async () => {
    FakeSocket.last = null;
    getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    const hook = renderHook(() => useRealtimeTranscription());
    await act(async () => {
      await hook.result.current.start({ model: "owner/asr" });
    });
    expect(hook.result.current.state).toMatchObject({
      phase: "failed",
      problem: { kind: "mic", reason: "denied" },
    });
    expect(FakeSocket.last).toBeNull();
  });

  it("reports an unsupported browser", async () => {
    vi.stubGlobal("AudioWorkletNode", undefined);
    const hook = renderHook(() => useRealtimeTranscription());
    await act(async () => {
      await hook.result.current.start({ model: "owner/asr" });
    });
    expect(hook.result.current.state.problem).toEqual({ kind: "mic", reason: "unsupported" });
  });

  it("keeps the server error through its close and releases the microphone", async () => {
    const { hook, socket } = await started();
    act(() => socket.serverEvent({ type: "session.created" }));
    act(() => socket.serverEvent({ type: "error", error: { code: "upstream_disconnected" } }));
    act(() => socket.serverClose(1011));
    expect(hook.result.current.state).toMatchObject({
      phase: "failed",
      problem: { kind: "server", code: "upstream_disconnected" },
    });
    expect(track.stop).toHaveBeenCalled();
    expect(FakeContext.last?.closed).toBe(true);
  });

  it("stops cleanly, and tears everything down on unmount", async () => {
    const { hook, socket } = await started();
    act(() => hook.result.current.stop());
    expect(socket.closedWith).toBe(1000);
    expect(hook.result.current.state.phase).toBe("stopped");
    expect(track.stop).toHaveBeenCalled();

    const second = await started();
    second.hook.unmount();
    expect(second.socket.closedWith).toBe(1000);
    expect(FakeNode.last?.disconnected).toBe(true);
  });
});
