import { env } from "@ws-model-proxy/env/web";
import { useCallback, useEffect, useReducer, useRef } from "react";

import {
  initialRealtimeState,
  micProblem,
  pcm16Base64,
  REALTIME_WORKLET_NAME,
  REALTIME_WORKLET_URL,
  type RealtimeState,
  realtimeReducer,
  realtimeSocketUrl,
} from "@/lib/realtime-transcription";

/** Client-side cap on bytes queued toward the server before audio is dropped. */
const SOCKET_BUFFER_LIMIT = 1024 * 1024;

type Resources = {
  socket: WebSocket | null;
  stream: MediaStream | null;
  context: AudioContext | null;
  node: AudioWorkletNode | null;
  /** The person asked to stop: the close that follows is not a failure. */
  stopping: boolean;
};

export type RealtimeTranscription = {
  state: RealtimeState;
  /** Opens the microphone, then the session (signed in by the dashboard cookie). */
  start(input: { model: string }): Promise<void>;
  /** Ends the current turn: the audio captured so far is sent, then committed. */
  commit(): void;
  stop(): void;
  reset(): void;
};

/** The Test page realtime socket, reporting parsed events and its close. */
function openSessionSocket(
  model: string,
  handlers: { onEvent(event: unknown): void; onClose(code: number): void },
): WebSocket {
  const socket = new WebSocket(
    realtimeSocketUrl(model, new URL(env.VITE_SERVER_URL, window.location.href)),
  );
  socket.onmessage = (message) => {
    if (typeof message.data !== "string") return;
    try {
      handlers.onEvent(JSON.parse(message.data));
    } catch {
      // Not JSON: nothing this panel can show.
    }
  };
  socket.onclose = (event) => handlers.onClose(event.code);
  return socket;
}

/** Worklet PCM becomes appends; its "flushed" mark (after End turn) becomes the commit. */
function pipeWorkletToSocket(node: AudioWorkletNode, socket: WebSocket) {
  node.port.onmessage = (message: MessageEvent<ArrayBuffer | { type?: string }>) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const data = message.data;
    if (data instanceof ArrayBuffer) {
      // A client that falls far behind drops audio rather than piling it up.
      if (socket.bufferedAmount > SOCKET_BUFFER_LIMIT) return;
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm16Base64(data) }));
      return;
    }
    if (data?.type === "flushed")
      socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  };
}

/**
 * The Test page live transcription session: microphone capture through an
 * AudioWorklet (24 kHz PCM16 mono), the Test page realtime socket (the
 * `/v1/realtime` protocol, signed in by the dashboard session cookie), and
 * teardown on stop, failure and unmount.
 */
export function useRealtimeTranscription(): RealtimeTranscription {
  const [state, dispatch] = useReducer(realtimeReducer, initialRealtimeState);
  const current = useRef<Resources | null>(null);
  const generation = useRef(0);

  const release = useCallback((resources: Resources) => {
    resources.node?.port.close();
    resources.node?.disconnect();
    for (const track of resources.stream?.getTracks() ?? []) track.stop();
    void resources.context?.close().catch(() => {});
    resources.node = null;
    resources.stream = null;
    resources.context = null;
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    const resources = current.current;
    current.current = null;
    if (!resources) return;
    resources.stopping = true;
    release(resources);
    const socket = resources.socket;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, "client_stop");
    // Settled here: the socket's own close event belongs to an old generation.
    dispatch({ type: "closed", code: 1000, requested: true });
  }, [release]);

  const start = useCallback(
    async ({ model }: { model: string }) => {
      stop();
      const attempt = ++generation.current;
      dispatch({ type: "starting" });
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof AudioWorkletNode === "undefined"
      ) {
        dispatch({ type: "failed", problem: { kind: "mic", reason: "unsupported" } });
        return;
      }
      const resources: Resources = {
        socket: null,
        stream: null,
        context: null,
        node: null,
        stopping: false,
      };
      current.current = resources;
      try {
        resources.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        if (generation.current !== attempt) return release(resources);
        resources.context = new AudioContext();
        await resources.context.audioWorklet.addModule(REALTIME_WORKLET_URL);
        if (generation.current !== attempt) return release(resources);
        const source = resources.context.createMediaStreamSource(resources.stream);
        resources.node = new AudioWorkletNode(resources.context, REALTIME_WORKLET_NAME);
        // A silent sink keeps the graph rendering without playing the microphone back.
        const sink = resources.context.createGain();
        sink.gain.value = 0;
        source.connect(resources.node);
        resources.node.connect(sink);
        sink.connect(resources.context.destination);
      } catch (error) {
        release(resources);
        if (generation.current !== attempt) return;
        current.current = null;
        dispatch({ type: "failed", problem: micProblem(error) });
        return;
      }

      // Owned by `resources`: `stop` (and the unmount cleanup) closes it.
      const socket = openSessionSocket(model, {
        onEvent: (event) => {
          if (generation.current === attempt) dispatch({ type: "event", event });
        },
        onClose: (code) => {
          if (resources.socket !== socket || generation.current !== attempt) return;
          release(resources);
          if (current.current === resources) current.current = null;
          dispatch({ type: "closed", code, requested: resources.stopping });
        },
      });
      resources.socket = socket;
      pipeWorkletToSocket(resources.node, socket);
    },
    [release, stop],
  );

  const commit = useCallback(() => {
    const node = current.current?.node;
    // The worklet posts its partial chunk, then "flushed"; the commit follows it.
    node?.port.postMessage("flush");
  }, []);

  const reset = useCallback(() => {
    stop();
    dispatch({ type: "reset" });
  }, [stop]);

  // Unmount: the microphone and the socket never outlive the panel.
  useEffect(() => stop, [stop]);

  return { state, start, commit, stop, reset };
}
