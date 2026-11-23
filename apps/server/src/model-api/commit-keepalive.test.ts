import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({ env: { MODEL_API_KEEPALIVE_AFTER_MS: 30_000 } }));

import {
  ANTHROPIC_JSON_KEEPALIVE,
  type CommitKeepalive,
  endsWithSseBlankLine,
  type KeepaliveRoute,
  OPENAI_CHAT_KEEPALIVE,
  OPENAI_JSON_KEEPALIVE,
  OPENAI_RESPONSES_KEEPALIVE,
  TRANSCRIPTION_KEEPALIVE,
  withCommitKeepalive,
} from "./commit-keepalive.js";

const FAST = { afterMs: 20, intervalMs: 10 };
const encoder = new TextEncoder();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(headers: Record<string, string> = {}) {
  return new Request("http://test/v1/chat/completions", { method: "POST", headers });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A handler that reports `facts` as prepared, then answers after `delayMs`. */
function slowHandler(
  answer: () => Response | Promise<Response>,
  delayMs: number,
  facts: Parameters<CommitKeepalive["prepared"]>[0] | null = { stream: false },
) {
  return async (keepalive: CommitKeepalive) => {
    if (facts) keepalive.prepared(facts);
    await sleep(delayMs);
    return answer();
  };
}

function run(
  route: KeepaliveRoute,
  handler: (keepalive: CommitKeepalive) => Promise<Response>,
  options: { afterMs?: number; intervalMs?: number } = FAST,
  req = request(),
) {
  return withCommitKeepalive(req, route, handler, options);
}

const OPENAI_ERROR = {
  error: { message: "No capacity.", type: "api_error", param: null, code: "rate_limited" },
};

describe("commit keepalive", () => {
  it("returns an answer ready before the deadline unchanged, status and headers included", async () => {
    const original = jsonResponse(503, OPENAI_ERROR, { "x-wsmp-route": "local" });
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(() => original, 0),
    );
    expect(response).toBe(original);
    expect(response.status).toBe(503);
    expect(response.headers.get("x-wsmp-route")).toBe("local");
  });

  it("does not commit before the handler reports the request prepared (a slow upload)", async () => {
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(() => jsonResponse(413, OPENAI_ERROR), 80, null),
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("x-wsmp-keepalive")).toBeNull();
  });

  it("is off at 0 ms and for a request that opts out", async () => {
    for (const [options, req] of [
      [{ afterMs: 0, intervalMs: 10 }, request()],
      [FAST, request({ "x-wsmp-keepalive": "off" })],
    ] as const) {
      const response = await run(
        OPENAI_CHAT_KEEPALIVE,
        slowHandler(() => jsonResponse(503, OPENAI_ERROR), 80),
        options,
        req,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("x-wsmp-keepalive")).toBeNull();
    }
  });

  it("commits 200 with JSON-safe whitespace, then the real JSON answer", async () => {
    const answer = { id: "chatcmpl-1", choices: [{ message: { content: "hi" } }] };
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(() => jsonResponse(200, answer, { "content-length": "999" }), 80),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-wsmp-keepalive")).toBe("1");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-length")).toBeNull();
    const text = await response.text();
    expect(text).toMatch(/^\n{2,}\{/);
    expect(JSON.parse(text)).toEqual(answer);
  });

  it("writes a failure after the commit as the protocol's error JSON with error.status", async () => {
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(() => jsonResponse(429, OPENAI_ERROR), 60),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({
      error: { ...OPENAI_ERROR.error, status: 429 },
    });

    const anthropic = await run(
      ANTHROPIC_JSON_KEEPALIVE,
      slowHandler(() => new Response("bad gateway", { status: 502 }), 60),
    );
    expect(JSON.parse(await anthropic.text())).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "The request failed with HTTP status 502.",
        status: 502,
      },
    });
  });

  it("answers a handler that throws after the commit with an in-body 500", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await run(OPENAI_JSON_KEEPALIVE, async (keepalive) => {
      keepalive.prepared({ stream: false });
      await sleep(60);
      throw new Error("boom");
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(await response.text());
    expect(body.error).toMatchObject({ code: "internal_error", status: 500 });
    error.mockRestore();
  });

  it("keeps a stream alive with SSE comments, then forwards the real stream", async () => {
    const stream = 'data: {"choices":[]}\n\ndata: [DONE]\n\n';
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
        60,
        { stream: true },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toMatch(/^(: keepalive\n\n)+data: /);
    expect(text.endsWith(stream)).toBe(true);
  });

  it("writes a stream failure after the commit as the protocol's error event", async () => {
    for (const [route, pattern] of [
      [OPENAI_CHAT_KEEPALIVE, /data: \{"error":\{[^\n]*"No capacity\."/],
      [OPENAI_RESPONSES_KEEPALIVE, /event: error\ndata: \{[^\n]*"No capacity\."/],
    ] as const) {
      const response = await run(
        route,
        slowHandler(() => jsonResponse(503, OPENAI_ERROR), 60, { stream: true }),
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.startsWith(": keepalive\n\n")).toBe(true);
      expect(text).toMatch(pattern);
    }
  });

  it("keeps only JSON transcription formats alive", async () => {
    const cases = [
      [{ stream: false, transcriptionProfile: { stream: false } }, true],
      [
        { stream: false, transcriptionProfile: { stream: false, responseFormat: "verbose_json" } },
        true,
      ],
      [{ stream: false, transcriptionProfile: { stream: false, responseFormat: "srt" } }, false],
      [{ stream: false, transcriptionProfile: { stream: true } }, false],
    ] as const;
    for (const [facts, committed] of cases) {
      const response = await run(
        TRANSCRIPTION_KEEPALIVE,
        slowHandler(() => new Response("1\n00:00:00,000 --> 00:00:01,000\nhi\n"), 60, facts),
      );
      expect(response.headers.get("x-wsmp-keepalive")).toBe(committed ? "1" : null);
    }
  });

  it("cancels the late answer's body when the client leaves after the commit", async () => {
    const cancel = vi.fn();
    let answered!: () => void;
    const answeredPromise = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const response = await run(OPENAI_CHAT_KEEPALIVE, async (keepalive) => {
      keepalive.prepared({ stream: false });
      await sleep(80);
      answered();
      return new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/json" },
      });
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(encoder.encode("\n"));
    // The cancel resolves only once the late answer's body is cancelled, so the
    // request's capacity scope closes after the answer's own release.
    await reader.cancel("client left");
    expect(cancel).toHaveBeenCalledWith("client left");
    await answeredPromise;
  });

  it("adds comments to a started stream only in silent gaps between events", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () => new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
        0,
        { stream: true },
      ),
    );
    expect(response.headers.get("x-wsmp-keepalive")).toBeNull();
    const textPromise = response.text();
    controller.enqueue(encoder.encode('data: {"a":'));
    await sleep(50); // mid-event: no comment may be written
    controller.enqueue(encoder.encode("1}\n\n"));
    await sleep(50); // between events: comments
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
    const text = await textPromise;
    expect(text).toMatch(/^data: \{"a":1\}\n\n(: keepalive\n\n)+data: \[DONE\]\n\n$/);
  });

  it("decodes a compressed answer instead of mixing keepalives into its bytes", async () => {
    const answer = { id: "chatcmpl-gz", choices: [] };
    const committed = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () =>
          new Response(gzipSync(JSON.stringify(answer)), {
            headers: { "content-type": "application/json", "content-encoding": "gzip" },
          }),
        60,
      ),
    );
    expect(committed.headers.get("content-encoding")).toBeNull();
    expect(JSON.parse(await committed.text())).toEqual(answer);

    const failure = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () =>
          new Response(gzipSync(JSON.stringify(OPENAI_ERROR)), {
            status: 429,
            headers: { "content-type": "application/json", "content-encoding": "gzip" },
          }),
        60,
      ),
    );
    expect(JSON.parse(await failure.text()).error).toMatchObject({
      code: "rate_limited",
      status: 429,
    });

    const unknown = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () =>
          new Response("x", {
            headers: { "content-type": "application/json", "content-encoding": "compress" },
          }),
        60,
      ),
    );
    expect(JSON.parse(await unknown.text()).error).toMatchObject({
      code: "unsupported_content_encoding",
      status: 502,
    });

    const stream = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    const early = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () =>
          new Response(gzipSync(stream), {
            headers: { "content-type": "text/event-stream", "content-encoding": "gzip" },
          }),
        0,
        { stream: true },
      ),
    );
    expect(early.headers.get("content-encoding")).toBeNull();
    expect(early.headers.get("x-accel-buffering")).toBe("no");
    expect(early.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(await early.text()).toBe(stream);
  });

  it("recognizes event boundaries with any mix of SSE line terminators", () => {
    for (const ended of [
      "data: x\n\n",
      "data: x\r\n\r\n",
      "data: x\r\r",
      "data: x\n\r\n",
      "data: x\r\n\n",
      "\r\n\r",
    ])
      expect(endsWithSseBlankLine(ended), JSON.stringify(ended)).toBe(true);
    for (const open of ["data: x", "data: x\n", "data: x\r\n", "data: x\r", "data: x\n: c"])
      expect(endsWithSseBlankLine(open), JSON.stringify(open)).toBe(false);
  });

  it("cancels the original body of a compressed answer when the client leaves", async () => {
    const cancel = vi.fn();
    const gz = gzipSync('data: {"a":1}\n\n');
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(gz.subarray(0, gz.byteLength - 8));
              },
              cancel,
            }),
            { headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } },
          ),
        0,
        { stream: true },
      ),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {"a":1}\n\n');
    await reader.cancel("client left");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });

  it("renders a truncated compressed error body as the protocol's error", async () => {
    const gz = gzipSync(JSON.stringify(OPENAI_ERROR));
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () =>
          new Response(gz.subarray(0, 12), {
            status: 503,
            headers: { "content-type": "application/json", "content-encoding": "gzip" },
          }),
        60,
      ),
    );
    expect(JSON.parse(await response.text()).error).toMatchObject({ status: 503 });
  });

  it("keeps a JSON answer alive whose headers came early and whose body is slow", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () =>
          new Response(upstream, {
            headers: { "content-type": "application/json", "content-length": "11" },
          }),
        0,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBeNull();
    const textPromise = response.text();
    await sleep(50);
    controller.enqueue(encoder.encode('{"a":'));
    await sleep(50); // started: no whitespace may be written inside the JSON
    controller.enqueue(encoder.encode("1}"));
    controller.close();
    const text = await textPromise;
    expect(text).toMatch(/^\n+\{"a":1\}$/);
  });

  it("drops a leading BOM, even split across chunks, once keepalives precede it", async () => {
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([0xef, 0xbb]));
                controller.enqueue(new Uint8Array([0xbf, ...encoder.encode("data: x\n\n")]));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        60,
        { stream: true },
      ),
    );
    expect(await response.text()).toMatch(/^(: keepalive\n\n)+data: x\n\n$/);
  });

  it("stops reading a stalled error body when the client leaves, awaiting its teardown", async () => {
    let tornDown = false;
    const cancel = vi.fn(async () => {
      await sleep(30);
      tornDown = true;
    });
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('{"error":'));
              },
              cancel,
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
        40,
      ),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await sleep(80); // the handler answered; its error body is being read and stalls
    await reader.cancel("client left");
    expect(cancel).toHaveBeenCalled();
    expect(tornDown).toBe(true);
  });

  it("logs a failure after the commit by error name only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await run(OPENAI_JSON_KEEPALIVE, async (keepalive) => {
      keepalive.prepared({ stream: false });
      await sleep(60);
      throw new TypeError("postgres://user:secret@db/app failed");
    });
    await response.text();
    expect(error).toHaveBeenCalledWith(
      "[model-api] request failed after the keepalive commit: TypeError",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret");
    error.mockRestore();
  });

  it("resolves a cancel of a compressed answer only after the original body tore down", async () => {
    let tornDown = false;
    const gz = gzipSync('data: {"a":1}\n\n');
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(gz.subarray(0, gz.byteLength - 8));
              },
              async cancel() {
                await sleep(30);
                tornDown = true;
              },
            }),
            { headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } },
          ),
        0,
        { stream: true },
      ),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("client left");
    expect(tornDown).toBe(true);
  });

  it("finishes rendering an undecodable error body only after the body tore down", async () => {
    let tornDown = false;
    const response = await run(
      OPENAI_CHAT_KEEPALIVE,
      slowHandler(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode("this is not gzip at all"));
              },
              async cancel() {
                await sleep(30);
                tornDown = true;
              },
            }),
            {
              status: 503,
              headers: { "content-type": "application/json", "content-encoding": "gzip" },
            },
          ),
        60,
      ),
    );
    const body = JSON.parse(await response.text());
    expect(body.error).toMatchObject({ status: 503 });
    expect(tornDown).toBe(true);
  });
});
