// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ENGINE_LOAD_SPARKLINE_HEIGHT_PX, EngineLoadSparkline } from "./engine-load-sparkline";

afterEach(() => {
  cleanup();
});

const SERIES = [
  {
    start: "2026-09-30T12:00:00.000Z",
    running: 2,
    waiting: 1,
    kvUsage: 0.4,
    kvOccupancy: 0.7,
    gap: false,
  },
  {
    start: "2026-09-30T12:00:10.000Z",
    running: null,
    waiting: null,
    kvUsage: null,
    kvOccupancy: null,
    gap: true,
  },
  {
    start: "2026-09-30T12:00:20.000Z",
    running: 3,
    waiting: 0,
    kvUsage: 0.95,
    kvOccupancy: 0.8,
    gap: false,
  },
];

describe("EngineLoadSparkline", () => {
  it("exposes the threshold, caption, and a min-w-0 shell", () => {
    render(
      <EngineLoadSparkline
        series={SERIES}
        threshold={0.95}
        caption="Engine load over the last 30 minutes"
        labels={{
          running: "Running",
          waiting: "Waiting",
          kvUsage: "KV usage",
          kvOccupancy: "KV occupancy",
          threshold: "FULL threshold",
        }}
      />,
    );
    const chart = screen.getByTestId("engine-load-sparkline");
    expect(chart.getAttribute("data-threshold")).toBe("0.95");
    expect(chart.className).toContain("min-w-0");
    expect(chart.className).toContain("overflow-x-hidden");
    expect(chart.parentElement?.tagName).toBe("FIGURE");
    expect(screen.getByText("Engine load over the last 30 minutes").className).toContain("sr-only");
    expect(chart.style.height || chart.firstElementChild).toBeTruthy();
    expect(ENGINE_LOAD_SPARKLINE_HEIGHT_PX).toBe(96);
  });
});
