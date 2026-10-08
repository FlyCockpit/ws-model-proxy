import { describe, expect, it } from "vitest";

import {
  chartRows,
  defaultStep,
  formatMetricValue,
  groupByOptions,
  parseActivityMetricsSearch,
  rangesFor,
  stepsFor,
  summaryMetrics,
} from "./activity-metrics";

describe("parseActivityMetricsSearch", () => {
  it("keeps valid fields and drops the rest", () => {
    expect(
      parseActivityMetricsSearch({
        scope: "runtime",
        id: "rt_1",
        metric: "ttft_p95",
        range: "7d",
        step: "1h",
        groupBy: "version",
        tests: true,
        view: "table",
      }),
    ).toEqual({
      scope: "runtime",
      id: "rt_1",
      metric: "ttft_p95",
      range: "7d",
      step: "1h",
      groupBy: "version",
      tests: true,
      view: "table",
    });
    expect(
      parseActivityMetricsSearch({
        scope: "galaxy",
        id: "../x",
        metric: "nope",
        range: "2y",
        step: "2s",
        groupBy: "color",
        tests: "yes",
        view: "pie",
      }),
    ).toEqual({});
  });

  it("accepts custom node metrics and a string tests flag", () => {
    expect(parseActivityMetricsSearch({ metric: "custom:fan_rpm", tests: "true" })).toEqual({
      metric: "custom:fan_rpm",
      tests: true,
    });
  });
});

describe("ranges and steps", () => {
  it("keeps load and node metrics to the ranges they are kept for", () => {
    expect(rangesFor("requests")).toEqual(["1h", "24h", "7d", "30d"]);
    expect(rangesFor("kv_usage_avg")).toEqual(["1h", "24h", "7d"]);
    expect(rangesFor("cpu_pct")).toEqual(["1h", "24h", "7d"]);
  });

  it("offers only steps the contract accepts", () => {
    expect(stepsFor("1h", "requests")).toEqual(["1m", "5m"]);
    expect(stepsFor("24h", "requests")).toEqual(["5m", "1h"]);
    expect(stepsFor("7d", "requests")).toEqual(["1h", "1d"]);
    expect(stepsFor("30d", "requests")).toEqual(["1d"]);
    expect(defaultStep("24h", "requests")).toBe("5m");
    expect(defaultStep("30d", "requests")).toBe("1d");
  });

  it("puts the chart metric first in the totals", () => {
    expect(summaryMetrics("decode_tps")[0]).toBe("decode_tps");
    expect(summaryMetrics("requests").filter((metric) => metric === "requests")).toHaveLength(1);
  });

  it("limits group-by to the scope and to source for a shared pool", () => {
    expect(groupByOptions("runtime", "requests", false)).toContain("version");
    expect(groupByOptions("instance", "kv_usage_max", false)).toEqual([]);
    expect(groupByOptions("pool", "requests", true)).toEqual(["source"]);
  });
});

describe("chartRows", () => {
  const start = "2026-10-08T00:00:00.000Z";

  it("fills missing counter buckets with 0 and leaves gaps for other metrics", () => {
    const counts = chartRows([{ at: [1], values: { requests: [4] } }], "requests", start, "1h", 3);
    expect(counts.map((row) => row.s0)).toEqual([0, 4, 0]);
    expect(counts[1]?.time).toBe(Date.parse(start) + 3_600_000);

    const latency = chartRows(
      [
        { group: { key: "a" }, at: [0, 2], values: { latency_p95: [120, null] } },
        { group: { key: "b" }, at: [1], values: { latency_p95: [80] } },
      ],
      "latency_p95",
      start,
      "1h",
      3,
    );
    expect(latency.map((row) => [row.s0, row.s1])).toEqual([
      [120, null],
      [null, 80],
      [null, null],
    ]);
  });
});

describe("formatMetricValue", () => {
  const tps = (value: string) => `${value} tok/s`;

  it("formats each unit", () => {
    expect(formatMetricValue("requests", 1234, "en-US", tps)).toBe("1,234");
    expect(formatMetricValue("latency_p95", 420, "en-US", tps)).toBe("420 ms");
    // Unit wording comes from the runtime's ICU data.
    expect(formatMetricValue("latency_p95", 12_500, "en-US", tps)).toMatch(/^12\.5\s?s/);
    expect(formatMetricValue("kv_usage_avg", 0.5, "en-US", tps)).toBe("50%");
    expect(formatMetricValue("decode_tps", 41.25, "en-US", tps)).toBe("41.3 tok/s");
    expect(formatMetricValue("memory_available_gb", 12.34, "en-US", tps)).toBe("12.3 GB");
  });
});
