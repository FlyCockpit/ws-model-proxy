import { describe, expect, it } from "vitest";

import { getScrollBoundaryDecision } from "./use-chat-scroll-engine";

describe("getScrollBoundaryDecision", () => {
  const scrollable = {
    clientHeight: 100,
    scrollHeight: 300,
  };

  it("chains upward scroll input when the transcript is at the top", () => {
    expect(
      getScrollBoundaryDecision({
        ...scrollable,
        scrollTop: 0,
        deltaY: -1,
      }),
    ).toBe("chain-parent");
  });

  it("chains downward scroll input when the transcript is at the bottom", () => {
    expect(
      getScrollBoundaryDecision({
        ...scrollable,
        scrollTop: 200,
        deltaY: 1,
      }),
    ).toBe("chain-parent");
  });

  it("keeps scroll input in the transcript when it can still scroll upward", () => {
    expect(
      getScrollBoundaryDecision({
        ...scrollable,
        scrollTop: 24,
        deltaY: -1,
      }),
    ).toBe("scroll-container");
  });

  it("keeps scroll input in the transcript when it can still scroll downward", () => {
    expect(
      getScrollBoundaryDecision({
        ...scrollable,
        scrollTop: 176,
        deltaY: 1,
      }),
    ).toBe("scroll-container");
  });

  it("chains in the scroll direction when content is not scrollable", () => {
    expect(
      getScrollBoundaryDecision({
        clientHeight: 300,
        scrollHeight: 100,
        scrollTop: 0,
        deltaY: 1,
      }),
    ).toBe("chain-parent");
  });
});
