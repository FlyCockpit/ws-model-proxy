import { describe, expect, it } from "vitest";
import { shapeEngineLoadOverview } from "./engine-load-overview";
import { overviewWindow } from "./overview-metrics";

describe("shapeEngineLoadOverview", () => {
  it("aggregates max gauges into overview buckets and leaves occupancy display-only", () => {
    const window = overviewWindow("24h", new Date("2026-09-30T12:00:00.000Z"));
    const first = window.start;
    const series = shapeEngineLoadOverview({
      window,
      capacityIds: ["cap-1"],
      rows: [
        {
          bucketStart: first,
          capacityId: "cap-1",
          maxRunning: 2,
          maxWaiting: 1,
          maxKvUsage: 0.4,
          maxKvOccupancy: 0.9,
        },
        {
          bucketStart: new Date(first.getTime() + 60_000),
          capacityId: "cap-1",
          maxRunning: 5,
          maxWaiting: null,
          maxKvUsage: 0.2,
          maxKvOccupancy: 0.3,
        },
        {
          bucketStart: new Date(first.getTime() + window.bucketMs),
          capacityId: "cap-1",
          maxRunning: 1,
          maxWaiting: 0,
          maxKvUsage: 0.1,
          maxKvOccupancy: 0.2,
        },
        {
          bucketStart: first,
          capacityId: "cap-other",
          maxRunning: 99,
          maxWaiting: 99,
          maxKvUsage: 1,
          maxKvOccupancy: 1,
        },
      ],
    });
    expect(series).toHaveLength(window.bucketCount);
    expect(series[0]).toMatchObject({
      running: 5,
      waiting: 1,
      kvUsage: 0.4,
      kvOccupancy: 0.9,
      gap: false,
    });
    expect(series[1]).toMatchObject({ running: 1, gap: false });
    expect(series[2]?.gap).toBe(true);
    expect(series[2]?.running).toBeNull();
  });
});
