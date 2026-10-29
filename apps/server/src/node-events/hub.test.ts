import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeEventHub, type NodeEventSubscriber } from "./hub.js";

const decoder = new TextDecoder();

type Reader = ReadableStreamDefaultReader<Uint8Array>;
const pendingReads = new WeakMap<Reader, ReturnType<Reader["read"]>>();

/** Reads what the stream has queued so far (never waits for more, never drops a chunk). */
async function drain(reader: Reader): Promise<string> {
  let text = "";
  for (;;) {
    const read = pendingReads.get(reader) ?? reader.read();
    pendingReads.set(reader, read);
    const next = await Promise.race([
      read,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
    ]);
    if (next === null) return text;
    pendingReads.delete(reader);
    if (next.done) return `${text}<closed>`;
    text += decoder.decode(next.value);
  }
}

function open(hub: NodeEventHub, userId = "user-1", sessionId = "sess-1") {
  const reserved = hub.reserve({ userId, sessionId });
  if (!reserved.ok) throw new Error(reserved.reason);
  const stream = hub.activate(reserved.subscriber);
  if (!stream) throw new Error("not activated");
  return { subscriber: reserved.subscriber, reader: stream.getReader() };
}

function events(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: node"))
    .map((block) => JSON.parse(block.split("data: ")[1] ?? "null"));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("NodeEventHub", () => {
  it("opens with retry and hello, then delivers only the owner's events", async () => {
    const hub = new NodeEventHub();
    const mine = open(hub, "user-1");
    const theirs = open(hub, "user-2", "sess-2");
    expect(await drain(mine.reader)).toBe('retry: 3000\n\nevent: hello\ndata: {"v":1}\n\n');
    await drain(theirs.reader);

    hub.publish({
      type: "node.connection",
      userId: "user-1",
      nodeId: "node-a",
      connection: "ONLINE",
      generation: 4,
    });
    hub.publish({ type: "node.removed", userId: "user-1", nodeId: "node-b" });

    expect(events(await drain(mine.reader))).toEqual([
      {
        v: 1,
        type: "node.connection",
        nodeId: "node-a",
        connection: "ONLINE",
        generation: 4,
        at: expect.any(String),
      },
      { v: 1, type: "node.removed", nodeId: "node-b", at: expect.any(String) },
    ]);
    expect(await drain(theirs.reader)).toBe("");
  });

  it("caps streams per user and per server", () => {
    const hub = new NodeEventHub({ perUser: 2, perServer: 3 });
    expect(hub.reserve({ userId: "a", sessionId: "s" }).ok).toBe(true);
    expect(hub.reserve({ userId: "a", sessionId: "s" }).ok).toBe(true);
    expect(hub.reserve({ userId: "a", sessionId: "s" })).toEqual({
      ok: false,
      reason: "user_limit",
    });
    expect(hub.reserve({ userId: "b", sessionId: "t" }).ok).toBe(true);
    expect(hub.reserve({ userId: "c", sessionId: "u" })).toEqual({
      ok: false,
      reason: "server_limit",
    });
    expect(hub.size).toBe(3);
  });

  it("gives a released reservation back", () => {
    const hub = new NodeEventHub({ perUser: 1, perServer: 10 });
    const first = hub.reserve({ userId: "a", sessionId: "s" });
    if (!first.ok) throw new Error("refused");
    hub.release(first.subscriber);
    expect(hub.size).toBe(0);
    expect(hub.reserve({ userId: "a", sessionId: "s" }).ok).toBe(true);
  });

  it("never opens a reservation whose session ended while it was checked", () => {
    const hub = new NodeEventHub();
    const reserved = hub.reserve({ userId: "a", sessionId: "s" });
    if (!reserved.ok) throw new Error("refused");
    hub.endSession("s");
    expect(hub.activate(reserved.subscriber)).toBeNull();
    expect(hub.size).toBe(0);
  });

  it("ends one session's streams with unauthorized and keeps the user's others", async () => {
    const hub = new NodeEventHub();
    const signedOut = open(hub, "user-1", "sess-1");
    const other = open(hub, "user-1", "sess-2");
    await drain(signedOut.reader);
    await drain(other.reader);

    hub.endSession("sess-1");

    expect(await drain(signedOut.reader)).toBe(
      'event: unauthorized\ndata: {"reason":"session_ended"}\n\n<closed>',
    );
    expect(await drain(other.reader)).toBe("");
    expect(hub.size).toBe(1);
  });

  it("closes a user's streams, and an impersonating admin's", async () => {
    const hub = new NodeEventHub();
    const own = open(hub, "user-1", "sess-1");
    const reserved = hub.reserve({ userId: "user-2", sessionId: "imp", impersonatedBy: "user-1" });
    if (!reserved.ok) throw new Error("refused");
    const stream = hub.activate(reserved.subscriber);
    if (!stream) throw new Error("not activated");
    const impersonating = stream.getReader();
    await drain(own.reader);
    await drain(impersonating);

    hub.closeUser("user-1", "access_blocked");

    expect(await drain(own.reader)).toContain('"reason":"access_blocked"');
    expect(await drain(impersonating)).toContain("<closed>");
    expect(hub.size).toBe(0);
  });

  it("closes a stream whose reader stopped reading", async () => {
    const hub = new NodeEventHub();
    const slow = open(hub);
    for (let index = 0; index < 2000; index += 1)
      hub.publish({ type: "node.trust", userId: "user-1", nodeId: `node-${index}` });
    expect(slow.subscriber.state).toBe("closed");
    expect(hub.size).toBe(0);
    // What was queued before the close still reads; then the stream ends.
    expect(await drain(slow.reader)).toMatch(/<closed>$/);
  });

  it("forgets a stream the browser cancelled", async () => {
    const hub = new NodeEventHub();
    const gone = open(hub);
    await gone.reader.cancel();
    expect(gone.subscriber.state).toBe("closed");
    expect(hub.size).toBe(0);
  });

  it("pings open streams", async () => {
    vi.useFakeTimers();
    const hub = new NodeEventHub(undefined, 1000);
    const live = open(hub);
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    expect(await drain(live.reader)).toContain(": ping\n\n");
  });

  it("rechecks each session once and ends those that lost access", async () => {
    const hub = new NodeEventHub();
    const ended = open(hub, "user-1", "sess-1");
    const ok = open(hub, "user-2", "sess-2");
    const blocked = open(hub, "user-3", "sess-3");
    const failing = open(hub, "user-4", "sess-4");
    open(hub, "user-1", "sess-1");
    const check = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === "sess-4") throw new Error("db down");
      return sessionId === "sess-1" ? "ended" : sessionId === "sess-3" ? "blocked" : "ok";
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await hub.recheckSessions(check);

    expect(check).toHaveBeenCalledTimes(4);
    expect(await drain(ended.reader)).toContain('"reason":"session_ended"');
    expect(await drain(blocked.reader)).toContain('"reason":"access_blocked"');
    expect(await drain(ok.reader)).not.toContain("<closed>");
    expect(await drain(failing.reader)).not.toContain("<closed>");
    expect(hub.size).toBe(2);
    error.mockRestore();
  });

  it("closes everything at shutdown without unauthorized, and refuses new streams", async () => {
    const hub = new NodeEventHub();
    const live = open(hub);
    const pending = hub.reserve({ userId: "user-1", sessionId: "sess-9" });
    await drain(live.reader);

    hub.closeAll();

    expect(await drain(live.reader)).toBe("<closed>");
    expect(hub.activate((pending as { subscriber: NodeEventSubscriber }).subscriber)).toBeNull();
    expect(hub.reserve({ userId: "user-1", sessionId: "sess-1" })).toEqual({
      ok: false,
      reason: "closing",
    });
    expect(hub.size).toBe(0);
  });
});
