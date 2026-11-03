import { afterEach, describe, expect, it, vi } from "vitest";
import { type CloseSendOutcome, TerminalCloseIntents } from "./terminal-close-intents";

afterEach(() => {
  vi.useRealTimers();
});

function setup(outcomes: CloseSendOutcome[] = []) {
  const sent: { terminalId: string; requestId: string }[] = [];
  let next = 0;
  const intents = new TerminalCloseIntents({
    send: (terminalId, requestId) => {
      sent.push({ terminalId, requestId });
      return outcomes.shift() ?? "taken";
    },
    newRequestId: () => {
      next += 1;
      return `close_${next}`;
    },
    retryMs: 1_000,
  });
  return { intents, sent };
}

describe("TerminalCloseIntents", () => {
  it("sends a close and finds it by its request id", () => {
    const { intents, sent } = setup();
    intents.request("t1", "tab1", 0);
    expect(sent).toEqual([{ terminalId: "t1", requestId: "close_1" }]);
    expect(intents.get("t1")?.send).toEqual({ state: "sent", requestId: "close_1" });
    expect(intents.byRequestId("close_1")).toBe("t1");
    expect(intents.pendingFor("tab1")).toBe(true);
    // Pressed again while it is out: nothing more is sent.
    intents.request("t1", "tab1", 0);
    expect(sent).toHaveLength(1);
  });

  it("keeps an intent unsent on a closed socket and sends it when a list names it", () => {
    const { intents, sent } = setup(["closed"]);
    intents.request("t1", null, 0);
    expect(intents.get("t1")?.send).toEqual({ state: "unsent" });
    intents.resendIfUnsent("t1");
    expect(sent.map((item) => item.requestId)).toEqual(["close_1", "close_2"]);
    expect(intents.get("t1")?.send).toEqual({ state: "sent", requestId: "close_2" });
    intents.resendIfUnsent("t1");
    expect(sent).toHaveLength(2);
  });

  it("backs off after a full queue, then sends again", () => {
    vi.useFakeTimers();
    const { intents, sent } = setup(["full"]);
    intents.request("t1", "tab1", 0);
    expect(intents.get("t1")?.send.state).toBe("backoff");
    // A list in the meantime does not send it early.
    intents.resendIfUnsent("t1");
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(sent).toHaveLength(2);
    expect(intents.get("t1")?.send).toEqual({ state: "sent", requestId: "close_2" });
  });

  it("backs off after a rate-limited answer, and a settled intent never retries", () => {
    vi.useFakeTimers();
    const { intents, sent } = setup();
    intents.request("t1", "tab1", 0);
    intents.backoff("t1");
    expect(intents.byRequestId("close_1")).toBeUndefined();
    expect(intents.settle("t1")?.localId).toBe("tab1");
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(1);
    expect(intents.has("t1")).toBe(false);
    expect(intents.pendingFor("tab1")).toBe(false);
  });

  it("forgets everything out on a closed socket", () => {
    vi.useFakeTimers();
    const { intents, sent } = setup(["taken", "full"]);
    intents.request("t1", null, 0);
    intents.request("t2", null, 0);
    intents.socketClosed();
    expect(intents.get("t1")?.send).toEqual({ state: "unsent" });
    expect(intents.get("t2")?.send).toEqual({ state: "unsent" });
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(2);
  });

  it("lets a tab go without ending the intent", () => {
    const { intents } = setup();
    intents.request("t1", "tab1", 0);
    intents.forgetTab("tab1");
    expect(intents.pendingFor("tab1")).toBe(false);
    expect(intents.has("t1")).toBe(true);
    // A later End session takes it again.
    intents.request("t1", "tab2", 0);
    expect(intents.pendingFor("tab2")).toBe(true);
  });

  it("is proven gone only by a list requested after the terminal was known", () => {
    const { intents } = setup();
    intents.request("old", null, 1);
    intents.request("new", null, 3);
    intents.request("listed", null, 1);
    expect(intents.provenGone(new Set(["listed"]), 2)).toEqual(["old"]);
  });
});
