import { describe, expect, it } from "vitest";

import {
  NODE_LIVE_OFF,
  type NodeLiveEventKind,
  type NodeLiveState,
  nodeLiveInterval,
  nodeLiveTransition,
  parseNodeLiveEvent,
} from "./node-live-updates";

const run = (events: NodeLiveEventKind[], from: NodeLiveState = NODE_LIVE_OFF) =>
  events.reduce(nodeLiveTransition, from);

const DOWN: NodeLiveState = { status: "down", notice: false };
const NOTICED: NodeLiveState = { status: "down", notice: true };

describe("nodeLiveTransition", () => {
  it("connects, goes live, and goes down on a failure", () => {
    expect(run(["connecting"])).toEqual({ status: "connecting", notice: false });
    expect(run(["connecting", "opened"])).toEqual({ status: "live", notice: false });
    expect(run(["connecting", "opened", "failed"])).toEqual(DOWN);
    expect(run(["connecting", "failed"])).toEqual(DOWN);
  });

  it("stays down (keeping its notice) while reconnect attempts fail, and clears it once live", () => {
    expect(run(["connecting", "failed", "connecting"])).toEqual(DOWN);
    expect(run(["connecting", "failed", "noticeDue", "connecting", "failed"])).toEqual(NOTICED);
    expect(run(["noticeDue", "connecting", "opened"], NOTICED)).toEqual({
      status: "live",
      notice: false,
    });
  });

  it("sets the notice only while down", () => {
    for (const state of [
      NODE_LIVE_OFF,
      run(["connecting"]),
      run(["connecting", "opened"]),
      run(["connecting", "unauthorized"]),
    ])
      expect(nodeLiveTransition(state, "noticeDue")).toBe(state);
    expect(nodeLiveTransition(DOWN, "noticeDue")).toEqual(NOTICED);
  });

  it("keeps unauthorized until off, from any active state", () => {
    for (const from of [run(["connecting"]), run(["connecting", "opened"]), DOWN, NOTICED]) {
      const stopped = nodeLiveTransition(from, "unauthorized");
      expect(stopped).toEqual({ status: "unauthorized", notice: false });
      for (const event of ["connecting", "opened", "failed", "noticeDue"] as const)
        expect(nodeLiveTransition(stopped, event)).toBe(stopped);
      expect(nodeLiveTransition(stopped, "off")).toEqual(NODE_LIVE_OFF);
    }
  });

  it("ignores late reports while off, and goes off from anywhere", () => {
    for (const event of ["opened", "failed", "noticeDue", "unauthorized"] as const)
      expect(nodeLiveTransition(NODE_LIVE_OFF, event)).toBe(NODE_LIVE_OFF);
    for (const from of [run(["connecting"]), run(["connecting", "opened"]), NOTICED])
      expect(nodeLiveTransition(from, "off")).toEqual(NODE_LIVE_OFF);
  });
});

describe("parseNodeLiveEvent", () => {
  it("reads a node event of any type, and nothing else", () => {
    expect(parseNodeLiveEvent('{"v":1,"type":"node.connection","nodeId":"n1"}')).toEqual({
      type: "node.connection",
      nodeId: "n1",
    });
    // A type a newer server added still refreshes.
    expect(parseNodeLiveEvent('{"v":2,"type":"node.renamed","nodeId":"n1"}')).toEqual({
      type: "node.renamed",
      nodeId: "n1",
    });
    for (const data of ["not json", "null", "[]", '{"type":"node.trust"}', '{"nodeId":3}'])
      expect(parseNodeLiveEvent(data)).toBeNull();
  });
});

describe("nodeLiveInterval", () => {
  it("polls at the old interval unless the stream is live", () => {
    for (const status of ["off", "connecting", "down", "unauthorized"] as const)
      expect(nodeLiveInterval(status, 5_000)).toBe(5_000);
    expect(nodeLiveInterval("live", 5_000)).toBe(false);
    expect(nodeLiveInterval("live", 10_000, 60_000)).toBe(60_000);
  });
});
