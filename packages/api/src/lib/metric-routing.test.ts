import { describe, expect, it } from "vitest";
import {
  describeSeries,
  ENDPOINT_LOAD_STALE_AFTER_MS,
  endpointLoadSeries,
  evaluateRoutingRules,
  type MetricSeries,
  NODE_METRICS_STALE_AFTER_MS,
  nodeMetricSeries,
  parseStoredRemoteMetricSources,
  parseStoredRoutingRules,
  type RoutingRule,
  remoteMetricSourceDefinitionsSchema,
  routingRulesSchema,
} from "./metric-routing";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

function series(overrides: Partial<MetricSeries>): MetricSeries {
  return {
    name: "gpu_temp",
    labels: {},
    value: 50,
    ageMs: 0,
    staleAfterMs: 30_000,
    origin: "custom",
    ...overrides,
  };
}

function rule(overrides: Partial<RoutingRule>): RoutingRule {
  return {
    metric: "gpu_temp",
    aggregate: "max",
    op: ">",
    threshold: 80,
    effect: "full",
    ...overrides,
  };
}

describe("routing rule schema", () => {
  it("accepts flat rules and defaults the aggregate to max", () => {
    const parsed = routingRulesSchema.parse([
      {
        metric: "node.gpu.temperature_c",
        labels: { gpu: "0" },
        op: ">=",
        threshold: 85,
        effect: "full",
      },
    ]);
    expect(parsed[0]?.aggregate).toBe("max");
  });

  it.each([
    [{ metric: "bad name", op: ">", threshold: 1, effect: "full" }],
    [{ metric: "x", op: "==", threshold: 1, effect: "full" }],
    [{ metric: "x", op: ">", threshold: Number.POSITIVE_INFINITY, effect: "full" }],
    [{ metric: "x", op: ">", threshold: 1, effect: "drain" }],
    [{ metric: "x", op: ">", threshold: 1, effect: "full", aggregate: "avg" }],
    [{ metric: "x", op: ">", threshold: 1, effect: "full", labels: { gpu: "0 1" } }],
    [{ metric: "x", op: ">", threshold: 1, effect: "full", extra: true }],
  ])("rejects %j", (candidate) => {
    expect(routingRulesSchema.safeParse([candidate]).success).toBe(false);
  });

  it("caps the list at 16 rules", () => {
    const rules = Array.from({ length: 17 }, () => ({
      metric: "x",
      op: ">",
      threshold: 1,
      effect: "avoid",
    }));
    expect(routingRulesSchema.safeParse(rules).success).toBe(false);
    expect(routingRulesSchema.safeParse(rules.slice(0, 16)).success).toBe(true);
  });

  it("treats an invalid stored column as no rules", () => {
    expect(parseStoredRoutingRules({ not: "an array" })).toEqual([]);
    expect(parseStoredRoutingRules(null)).toEqual([]);
  });
});

describe("remote metric source definitions", () => {
  const source = {
    name: "fans",
    command: "sensors -j",
    intervalSecs: 10,
    timeoutSecs: 5,
    format: "json",
  };

  it("rejects duplicate names, short intervals and unknown formats", () => {
    expect(remoteMetricSourceDefinitionsSchema.safeParse([source, source]).success).toBe(false);
    expect(
      remoteMetricSourceDefinitionsSchema.safeParse([{ ...source, intervalSecs: 4 }]).success,
    ).toBe(false);
    expect(
      remoteMetricSourceDefinitionsSchema.safeParse([{ ...source, format: "yaml" }]).success,
    ).toBe(false);
    expect(parseStoredRemoteMetricSources([source])).toEqual([source]);
    expect(parseStoredRemoteMetricSources("garbage")).toEqual([]);
  });
});

describe("evaluateRoutingRules", () => {
  it("returns full when a full rule triggers and records per-rule states", () => {
    const evaluation = evaluateRoutingRules(
      [rule({}), rule({ metric: "queue", op: ">=", threshold: 3, effect: "avoid" })],
      [series({ value: 90 }), series({ name: "queue", value: 1 })],
      NOW,
    );
    expect(evaluation.verdict).toBe("full");
    expect(evaluation.ruleStates).toEqual(["triggered", "clear"]);
    // Fresh for the series' remaining window.
    expect(evaluation.expiresAt).toEqual(at(30_000));
  });

  it("returns avoid when only an avoid rule triggers", () => {
    const evaluation = evaluateRoutingRules(
      [rule({ effect: "avoid" })],
      [series({ value: 81 })],
      NOW,
    );
    expect(evaluation.verdict).toBe("avoid");
  });

  it("ignores a stale metric (fail open) and marks the rule stale", () => {
    const evaluation = evaluateRoutingRules(
      [rule({})],
      [series({ value: 99, ageMs: 30_001 })],
      NOW,
    );
    expect(evaluation.verdict).toBe("none");
    expect(evaluation.ruleStates).toEqual(["stale"]);
    expect(evaluation.expiresAt).toEqual(NOW);
  });

  it("ignores a missing metric", () => {
    const evaluation = evaluateRoutingRules([rule({ metric: "absent" })], [series({})], NOW);
    expect(evaluation).toMatchObject({ verdict: "none", ruleStates: ["stale"] });
  });

  it("aggregates with max over the series that match the label subset", () => {
    const gpus = [
      series({ name: "node.gpu.temperature_c", labels: { gpu: "0" }, value: 70 }),
      series({ name: "node.gpu.temperature_c", labels: { gpu: "1" }, value: 88 }),
    ];
    const anyGpu = rule({ metric: "node.gpu.temperature_c", threshold: 85 });
    expect(evaluateRoutingRules([anyGpu], gpus, NOW).verdict).toBe("full");
    expect(evaluateRoutingRules([{ ...anyGpu, labels: { gpu: "0" } }], gpus, NOW).verdict).toBe(
      "none",
    );
    // A stale high reading does not count; the fresh low one decides.
    expect(
      evaluateRoutingRules([anyGpu], [gpus[0]!, { ...gpus[1]!, ageMs: 60_000 }], NOW).verdict,
    ).toBe("none");
  });

  it.each([
    [">", 80, false],
    [">=", 80, true],
    ["<", 80, false],
    ["<=", 80, true],
  ] as const)("compares with %s", (op, threshold, expected) => {
    const evaluation = evaluateRoutingRules(
      [rule({ op, threshold })],
      [series({ value: 80 })],
      NOW,
    );
    expect(evaluation.verdict === "full").toBe(expected);
  });

  it("keeps full while any triggering full rule is fresh", () => {
    const evaluation = evaluateRoutingRules(
      [rule({}), rule({ metric: "other" })],
      [series({ value: 90, ageMs: 25_000 }), series({ name: "other", value: 90, ageMs: 0 })],
      NOW,
    );
    expect(evaluation.expiresAt).toEqual(at(30_000));
  });
});

describe("series flattening", () => {
  it("names built-ins, derives percentages, and ages custom series on the CLI clock", () => {
    const receivedAt = at(-10_000);
    const flattened = nodeMetricSeries(
      {
        ts: "2026-09-28T11:59:50.000Z",
        cpu: { usagePercent: 42.5, load1: 1 },
        memory: { totalMiB: 1000, availableMiB: 250 },
        disks: [{ mount: "/", freeMiB: 5000 }],
        gpus: [{ index: 0, vramUsedMiB: 12_000, vramTotalMiB: 24_000, temperatureC: 71 }],
        custom: [
          // Sampled 5 s before the frame (CLI clock): 15 s old now.
          {
            source: "fans",
            name: "fan_rpm",
            labels: { fan: "1" },
            value: 1200,
            ts: "2026-09-28T11:59:45.000Z",
          },
          {
            source: "fans",
            name: "node.cpu.usage_percent",
            value: 1,
            ts: "2026-09-28T11:59:45.000Z",
          },
          { source: "fans", name: "not ok", value: 1, ts: "2026-09-28T11:59:45.000Z" },
        ],
        sources: [{ name: "fans", origin: "local", state: "active", intervalSecs: 10 }],
      },
      receivedAt,
      NOW,
    );
    const byName = new Map(flattened.map((entry) => [entry.name, entry]));
    expect(byName.get("node.cpu.usage_percent")).toMatchObject({
      value: 42.5,
      ageMs: 10_000,
      staleAfterMs: NODE_METRICS_STALE_AFTER_MS,
      origin: "builtin",
    });
    expect(byName.get("node.memory.used_percent")?.value).toBe(75);
    expect(byName.get("node.disk.free_mib")?.value).toBe(5000);
    expect(byName.get("node.gpu.vram_used_percent")).toMatchObject({
      value: 50,
      labels: { gpu: "0" },
    });
    expect(byName.get("fan_rpm")).toMatchObject({
      value: 1200,
      labels: { fan: "1" },
      ageMs: 15_000,
      staleAfterMs: 30_000,
      origin: "custom",
    });
    // Reserved prefixes and invalid names from custom sources are ignored.
    expect(flattened.filter((entry) => entry.name === "node.cpu.usage_percent")).toHaveLength(1);
    expect(byName.has("not ok")).toBe(false);
  });

  it("uses the member's own endpoint load, preferring a model-specific reading", () => {
    const loads = [
      { endpointSlug: "a", modelSlug: null, running: 1, waiting: 0, receivedAt: at(-2_000) },
      {
        endpointSlug: "a",
        modelSlug: "m",
        running: 3,
        waiting: 2,
        kvUsage: 0.5,
        receivedAt: at(-1_000),
      },
      { endpointSlug: "b", modelSlug: null, running: 9, waiting: 9, receivedAt: at(-1_000) },
    ];
    const forModel = endpointLoadSeries(loads, { endpointSlug: "a", modelSlug: "m" }, NOW);
    expect(forModel.find((entry) => entry.name === "endpoint.running")?.value).toBe(3);
    expect(forModel.find((entry) => entry.name === "endpoint.kv_usage")?.value).toBe(0.5);
    expect(forModel[0]?.staleAfterMs).toBe(ENDPOINT_LOAD_STALE_AFTER_MS);
    const endpointWide = endpointLoadSeries(loads, { endpointSlug: "a", modelSlug: "other" }, NOW);
    expect(endpointWide.find((entry) => entry.name === "endpoint.running")?.value).toBe(1);
    expect(endpointLoadSeries(loads, { endpointSlug: "c", modelSlug: null }, NOW)).toEqual([]);
  });

  it("describes series for discovery with a stale flag", () => {
    const described = describeSeries([
      series({ name: "b", ageMs: 40_000 }),
      series({ name: "a", value: 3 }),
    ]);
    expect(described.map((entry) => [entry.name, entry.stale])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });
});
