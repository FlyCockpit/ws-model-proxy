import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AttachEvent,
  type AttachStage,
  attachIdle,
  handshakeUnderWay,
  stageSession,
  TerminalAttachments,
  transitionAttach,
} from "./terminal-attach-state";

type Handshake = { localId: string; terminalId: string | null };
type Session = { terminalId: string; ended: boolean };
type Stage = AttachStage<Handshake, Session>;
type Event = AttachEvent<Handshake, Session>;

const handshake: Handshake = { localId: "local-a", terminalId: "term-a" };
const session: Session = { terminalId: "term-a", ended: false };
/** A timer, typed as the state machine holds it. */
function later(run: () => void, ms: number): ReturnType<typeof setTimeout> {
  return setTimeout(run, ms);
}
const timer = later(() => undefined, 0);
clearTimeout(timer);

const idle: Stage = { stage: "idle" };
const awaiting: Stage = { stage: "awaiting_identity" };
const checking: Stage = { stage: "checking_identity", mode: "attach" };
const sent: Stage = { stage: "handshake_sent", handshake };
const establishing: Stage = { stage: "establishing", handshake };
const backoff: Stage = { stage: "backoff", timer };
const live: Stage = { stage: "live", session };
const retired: Stage = { stage: "retired", session };
const draining: Stage = { stage: "draining", session };
const all = { idle, awaiting, checking, sent, establishing, backoff, live, retired, draining };

function run(stage: Stage, ...events: Event[]): Stage {
  return events.reduce(transitionAttach, stage);
}

/** The stage name each stage moves to for an event. */
function table(event: Event): Record<string, string> {
  return Object.fromEntries(
    Object.entries(all).map(([name, stage]) => [name, transitionAttach(stage, event).stage]),
  );
}

describe("transitionAttach", () => {
  it("runs an attach from the identity check to a live session", () => {
    const checked = run(idle, { type: "check", mode: "attach" });
    expect(checked.stage).toBe("checking_identity");
    const done = run(
      checked,
      { type: "handshakeSent", handshake },
      { type: "establishing" },
      { type: "established", session },
    );
    expect(done).toEqual(live);
  });

  it("gives every attempt a fresh token, and never starts one over a session", () => {
    const first = transitionAttach(idle, { type: "check", mode: "open" });
    const second = transitionAttach(first, { type: "check", mode: "open" });
    expect(second).not.toBe(first);
    for (const stage of [live, retired, draining])
      expect(transitionAttach(stage, { type: "check", mode: "attach" })).toBe(stage);
  });

  it("moves forward only from the stage before", () => {
    expect(transitionAttach(idle, { type: "handshakeSent", handshake })).toBe(idle);
    expect(transitionAttach(checking, { type: "establishing" })).toBe(checking);
    expect(transitionAttach(sent, { type: "established", session })).toBe(sent);
    expect(transitionAttach(awaiting, { type: "identityLoading" })).toBe(awaiting);
    expect(transitionAttach(checking, { type: "identityLoading" })).toEqual(awaiting);
  });

  it("abandons only a handshake under way", () => {
    expect(table({ type: "abandon" })).toEqual({
      idle: "idle",
      awaiting: "awaiting_identity",
      checking: "idle",
      sent: "idle",
      establishing: "idle",
      backoff: "backoff",
      live: "live",
      retired: "retired",
      draining: "draining",
    });
  });

  it("ends only a session", () => {
    expect(table({ type: "endAttach" })).toEqual({
      idle: "idle",
      awaiting: "awaiting_identity",
      checking: "checking_identity",
      sent: "handshake_sent",
      establishing: "establishing",
      backoff: "backoff",
      live: "idle",
      retired: "idle",
      draining: "idle",
    });
  });

  it("keeps deriving keys through an exit, and drains a session", () => {
    expect(table({ type: "exited" })).toEqual({
      idle: "idle",
      awaiting: "awaiting_identity",
      checking: "idle",
      sent: "idle",
      establishing: "establishing",
      backoff: "idle",
      live: "draining",
      retired: "draining",
      draining: "draining",
    });
    expect(transitionAttach(live, { type: "exited" })).toEqual(draining);
  });

  it("ends everything but a draining session when the terminal is gone", () => {
    expect(table({ type: "gone" })).toEqual({
      idle: "idle",
      awaiting: "idle",
      checking: "idle",
      sent: "idle",
      establishing: "idle",
      backoff: "idle",
      live: "draining",
      retired: "draining",
      draining: "draining",
    });
  });

  it("keeps only a wait for the browser identity across a closed socket", () => {
    expect(Object.values(table({ type: "socketClosed" }))).toEqual([
      "idle",
      "awaiting_identity",
      "idle",
      "idle",
      "idle",
      "idle",
      "idle",
      "idle",
      "idle",
    ]);
    expect(table({ type: "socketOpened" })).toMatchObject({
      awaiting: "awaiting_identity",
      checking: "idle",
      sent: "idle",
      establishing: "idle",
      backoff: "backoff",
      live: "live",
    });
  });

  it("ends a draining session only for that session", () => {
    const other: Session = { terminalId: "term-a", ended: true };
    expect(transitionAttach(draining, { type: "drained", session: other })).toBe(draining);
    expect(transitionAttach(draining, { type: "drained", session })).toEqual(idle);
    expect(transitionAttach(live, { type: "drained", session })).toBe(live);
  });

  it("retires only a live session on End session", () => {
    expect(transitionAttach(live, { type: "endSession" })).toEqual(retired);
    expect(transitionAttach(draining, { type: "endSession" })).toBe(draining);
  });

  it("backs off and awaits the identity only without a session", () => {
    for (const stage of [live, retired, draining]) {
      expect(transitionAttach(stage, { type: "backoff", timer })).toBe(stage);
      expect(transitionAttach(stage, { type: "awaitIdentity" })).toBe(stage);
    }
    expect(transitionAttach(idle, { type: "backoff", timer }).stage).toBe("backoff");
    expect(transitionAttach(backoff, { type: "backoffElapsed" })).toEqual(idle);
    expect(transitionAttach(backoff, { type: "awaitIdentity" })).toEqual(awaiting);
    expect(transitionAttach(awaiting, { type: "retry" })).toEqual(idle);
    expect(transitionAttach(backoff, { type: "retry" })).toBe(backoff);
  });

  it("classifies stages", () => {
    expect(
      Object.entries(all)
        .filter(([, stage]) => attachIdle(stage))
        .map(([n]) => n),
    ).toEqual(["idle", "awaiting", "backoff"]);
    expect(
      Object.entries(all)
        .filter(([, stage]) => handshakeUnderWay(stage))
        .map(([n]) => n),
    ).toEqual(["checking", "sent", "establishing"]);
    expect(stageSession(retired)).toBe(session);
    expect(stageSession(establishing)).toBeNull();
  });
});

describe("TerminalAttachments", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function attachments() {
    const retire = vi.fn((target: Session, _dropOutput: boolean) => {
      target.ended = true;
    });
    return { store: new TerminalAttachments<Handshake, Session, string>({ retire }), retire };
  }

  function goLive(
    store: TerminalAttachments<Handshake, Session, string>,
    localId: string,
    terminalId: string,
  ): Session {
    const own: Session = { terminalId, ended: false };
    store.apply(localId, { type: "check", mode: "attach" });
    store.apply(localId, { type: "handshakeSent", handshake: { localId, terminalId } });
    store.apply(localId, { type: "establishing" });
    store.apply(localId, { type: "established", session: own });
    return own;
  }

  it("clears a backoff's timer when the tab leaves backoff", () => {
    vi.useFakeTimers();
    const { store } = attachments();
    store.add("local-a", { terminalId: "term-a" });
    const fired = vi.fn();
    store.apply("local-a", { type: "backoff", timer: later(fired, 100) });
    store.apply("local-a", { type: "check", mode: "attach" });
    vi.advanceTimersByTime(200);
    expect(fired).not.toHaveBeenCalled();

    store.apply("local-a", { type: "abandon" });
    store.apply("local-a", { type: "backoff", timer: later(fired, 100) });
    store.delete("local-a");
    vi.advanceTimersByTime(200);
    expect(fired).not.toHaveBeenCalled();
  });

  it("ends a live attach on leaving live, keeping its output only into retired or draining", () => {
    const { store, retire } = attachments();
    store.add("local-a", { terminalId: "term-a" });
    const first = goLive(store, "local-a", "term-a");
    store.apply("local-a", { type: "endSession" });
    expect(retire).toHaveBeenLastCalledWith(first, false);
    expect(store.sessionOf("term-a")).toBe(first);
    store.apply("local-a", { type: "endAttach" });
    // Already retired: leaving `retired` does not retire again.
    expect(retire).toHaveBeenCalledTimes(1);
    expect(store.sessionOf("term-a")).toBeUndefined();

    const second = goLive(store, "local-a", "term-a");
    store.apply("local-a", { type: "socketClosed" });
    expect(retire).toHaveBeenLastCalledWith(second, true);

    const third = goLive(store, "local-a", "term-a");
    store.delete("local-a");
    expect(retire).toHaveBeenLastCalledWith(third, true);
    expect(store.get("local-a")).toBeUndefined();
  });

  it("matches a handshake only to its own terminal id, never the only one under way", () => {
    const { store } = attachments();
    store.add("local-a", { terminalId: "term-a" });
    store.add("local-b", { terminalId: "term-b" });
    store.add("local-open", { terminalId: null });
    store.apply("local-a", { type: "check", mode: "attach" });
    store.apply("local-a", { type: "handshakeSent", handshake });
    const open: Handshake = { localId: "local-open", terminalId: null };
    store.apply("local-open", { type: "check", mode: "open" });
    store.apply("local-open", { type: "handshakeSent", handshake: open });
    expect(store.handshakeFor("term-a")).toBe(handshake);
    expect(store.handshakeFor("term-b")).toBeUndefined();
    expect(store.handshakeFor("term-missing")).toBeUndefined();
    expect(store.handshakeFor("")).toBeUndefined();
    // Once `opening` names it, the open's handshake answers for that terminal.
    open.terminalId = "term-open";
    store.setTerminal("local-open", "term-open");
    expect(store.handshakeFor("term-open")).toBe(open);
  });

  it("starts an attach only while nothing holds the tab or its terminal", () => {
    const { store } = attachments();
    store.add("local-a", { terminalId: "term-a" });
    store.add("local-b", { terminalId: "term-a" });
    expect(store.canStartAttach("local-a", "term-a")).toBe(true);
    store.apply("local-b", { type: "check", mode: "attach" });
    expect(store.canStartAttach("local-a", "term-a")).toBe(false);
    store.abandon("local-a", "term-a");
    expect(store.stage("local-b")?.stage).toBe("idle");
    expect(store.canStartAttach("local-a", "term-a")).toBe(true);
    store.apply("local-a", { type: "awaitIdentity" });
    expect(store.canStartAttach("local-a", "term-a")).toBe(true);
    goLive(store, "local-a", "term-a");
    expect(store.canStartAttach("local-a", "term-a")).toBe(false);
    expect(store.canStartAttach("missing", "term-a")).toBe(false);
  });

  it("keeps a bounded early-frame buffer for the tab attaching the terminal", () => {
    const { store } = attachments();
    store.add("local-a", { terminalId: "term-a" });
    store.add("local-b", { terminalId: "term-a" });
    store.apply("local-b", { type: "check", mode: "attach" });
    for (const frame of ["1", "2", "3"]) store.bufferEarly("term-a", frame, 2);
    store.bufferEarly("term-unknown", "x", 2);
    expect(store.get("local-b")?.early).toEqual(["2", "3"]);
    expect(store.get("local-a")?.early).toEqual([]);
    store.clearEarly("term-a");
    expect(store.get("local-b")?.early).toEqual([]);
  });

  it("finds the session for a terminal and ends it from any tab", () => {
    const { store, retire } = attachments();
    store.add("local-a", { terminalId: "term-a" });
    const own = goLive(store, "local-a", "term-a");
    expect(store.sessionEntry("term-a")?.localId).toBe("local-a");
    store.endAttachOf("term-a");
    expect(retire).toHaveBeenCalledWith(own, true);
    expect(store.stage("local-a")?.stage).toBe("idle");
    expect(store.localIdsIn("idle")).toEqual(["local-a"]);
  });

  it("ends every attach on dispose", () => {
    vi.useFakeTimers();
    const { store, retire } = attachments();
    store.add("local-a", { terminalId: "term-a" });
    store.add("local-b", { terminalId: "term-b" });
    const own = goLive(store, "local-a", "term-a");
    const fired = vi.fn();
    store.apply("local-b", { type: "backoff", timer: later(fired, 10) });
    store.dispose();
    vi.advanceTimersByTime(20);
    expect(retire).toHaveBeenCalledWith(own, true);
    expect(fired).not.toHaveBeenCalled();
  });
});
