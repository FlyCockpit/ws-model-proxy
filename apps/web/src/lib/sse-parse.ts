/**
 * An incremental `text/event-stream` parser (the WHATWG server-sent events format), for a
 * `fetch` stream read chunk by chunk. `fetch` instead of `EventSource`, because `EventSource`
 * cannot read a refused response's status (a 401 looks like a network error) and gives up for
 * good on any non-200 (see `use-node-live-updates.ts`).
 *
 * Handles lines split across chunks, `\n`, `\r\n` and `\r` line ends, comment lines (`:`),
 * several `data:` lines per event, and a single leading space after the colon. `id` and `retry`
 * are read and ignored: the caller resyncs by refetching, not by replay, and keeps its own
 * backoff.
 */

export type SseEvent = { event: string; data: string };

export type SseParser = {
  /** Feeds the next decoded chunk; calls `onEvent` for every event it completes. */
  push(chunk: string): void;
};

export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = "";
  // A `\r` that ended the last chunk: a `\n` starting the next one belongs to it.
  let pendingCr = false;
  let eventName = "";
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) onEvent({ event: eventName || "message", data: data.join("\n") });
    eventName = "";
    data = [];
  };

  const line = (text: string) => {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") data.push(value);
  };

  return {
    push(chunk) {
      let text = chunk;
      if (pendingCr && text.startsWith("\n")) text = text.slice(1);
      pendingCr = false;
      buffer += text;
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const char = buffer[index];
        if (char !== "\n" && char !== "\r") continue;
        line(buffer.slice(start, index));
        if (char === "\r") {
          if (index + 1 === buffer.length) pendingCr = true;
          else if (buffer[index + 1] === "\n") index += 1;
        }
        start = index + 1;
      }
      buffer = buffer.slice(start);
    },
  };
}
