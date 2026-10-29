import { describe, expect, it } from "vitest";

import {
  nodeLiveInterval,
  nodeLiveReconnectDelayMs,
  parseNodeLiveEvent,
} from "./node-live-updates";

describe("nodeLiveReconnectDelayMs", () => {
  it("doubles from 0.5 s to 15 s, plus up to 250 ms of jitter", () => {
    expect([0, 1, 2, 5, 10].map((attempt) => nodeLiveReconnectDelayMs(attempt, () => 0))).toEqual([
      500, 1_000, 2_000, 15_000, 15_000,
    ]);
    expect(nodeLiveReconnectDelayMs(0, () => 0.999)).toBe(749);
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
