import { describe, expect, it } from "vitest";
import {
  describeSeries,
  ENDPOINT_LOAD_STALE_AFTER_MS,
  endpointLoadSeries,
  engineLoadHistoryKey,
  engineLoadHistoryLookupKeys,
  evaluateRoutingRules,
  type MetricSeries,
  NODE_METRICS_STALE_AFTER_MS,
  nodeMetricSeries,
  parseStoredRemoteMetricSources,
  parseStoredRoutingRules,
  pickEngineLoadHistorySeries,
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
    [{ metric: "x", op: ">", threshold: 1, effect: "full", aggregate: "sum" }],
    [{ metric: "x", op: ">", threshold: 1, effect: "full", labels: { gpu: "0 1" } }],
    [{ metric: "x", op: ">", threshold: 1, effect: "full", extra: true }],
    [
      {
        metric: "x",
        op: ">",
        threshold: 1,
        effect: "full",
        memberId: "m1",
        excludeMemberId: "m2",
      },
    ],
  ])("rejects %j", (candidate) => {
    expect(routingRulesSchema.safeParse([candidate]).success).toBe(false);
  });

  it("rejects the reserved label key __proto__ instead of widening the rule", () => {
    // JSON.parse makes a real own property named __proto__; a record would
    // drop it silently and leave a rule that matches every series.
    const labels = JSON.parse('{"__proto__":"x"}');
    const rule = { metric: "x", op: ">", threshold: 1, effect: "full" };
    expect(routingRulesSchema.safeParse([{ ...rule, labels }]).success).toBe(false);
    for (const key of ["proto", "_proto__", "__proto", "constructor"]) {
      expect(routingRulesSchema.safeParse([{ ...rule, labels: { [key]: "x" } }]).success).toBe(
        true,
      );
    }
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

  it("accepts min/avg aggregates and a single member scope", () => {
    const min = routingRulesSchema.parse([
      { metric: "x", op: "<", threshold: 10, effect: "avoid", aggregate: "min", memberId: "m1" },
    ]);
    expect(min[0]).toMatchObject({ aggregate: "min", memberId: "m1" });
    const avg = routingRulesSchema.parse([
      {
        metric: "x",
        op: ">",
        threshold: 1,
        effect: "full",
        aggregate: "avg",
        excludeMemberId: "m2",
      },
    ]);
    expect(avg[0]).toMatchObject({ aggregate: "avg", excludeMemberId: "m2" });
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
  });

  it("uses the CLI's definition of a runnable command: non-blank, at most 4096 bytes, no NUL", () => {
    const ok = (command: string) =>
      remoteMetricSourceDefinitionsSchema.safeParse([{ ...source, command }]).success;
    expect(ok("echo 1")).toBe(true);
    expect(ok("a".repeat(4096))).toBe(true);
    expect(ok("é".repeat(2048))).toBe(true);
    // 1 509 UTF-16 units but 4 509 bytes: the CLI would call it refused.
    expect(ok("€".repeat(1509))).toBe(false);
    expect(ok("a".repeat(4097))).toBe(false);
    expect(ok("echo\u0000 1")).toBe(false);
    expect(ok("   ")).toBe(false);
    // Blank exactly as the CLI's `str::trim()` sees it: NEL is blank, BOM is not.
    expect(ok("\u0085")).toBe(false);
    expect(ok("\u2003\u3000")).toBe(false);
    expect(ok("\uFEFF")).toBe(true);
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

  it("aggregates with min over the matching series", () => {
    const gpus = [
      series({ name: "node.gpu.temperature_c", labels: { gpu: "0" }, value: 70 }),
      series({ name: "node.gpu.temperature_c", labels: { gpu: "1" }, value: 88 }),
    ];
    const coolest = rule({
      metric: "node.gpu.temperature_c",
      aggregate: "min",
      op: "<",
      threshold: 75,
    });
    expect(evaluateRoutingRules([coolest], gpus, NOW).verdict).toBe("full");
    expect(evaluateRoutingRules([{ ...coolest, threshold: 70 }], gpus, NOW).verdict).toBe("none");
    // A stale low reading does not count; the fresh high one decides.
    expect(
      evaluateRoutingRules([coolest], [{ ...gpus[0]!, ageMs: 60_000 }, gpus[1]!], NOW).verdict,
    ).toBe("none");
  });

  it("aggregates with avg over the matching series", () => {
    const gpus = [
      series({ name: "node.gpu.temperature_c", labels: { gpu: "0" }, value: 70 }),
      series({ name: "node.gpu.temperature_c", labels: { gpu: "1" }, value: 90 }),
    ];
    const average = rule({
      metric: "node.gpu.temperature_c",
      aggregate: "avg",
      op: ">",
      threshold: 79,
    });
    expect(evaluateRoutingRules([average], gpus, NOW).verdict).toBe("full");
    expect(evaluateRoutingRules([{ ...average, threshold: 80 }], gpus, NOW).verdict).toBe("none");
    // Dropping the high reading to stale lowers the average of what remains.
    expect(
      evaluateRoutingRules([average], [gpus[0]!, { ...gpus[1]!, ageMs: 60_000 }], NOW).verdict,
    ).toBe("none");
  });

  it("applies a member-only rule only to that member", () => {
    const scoped = rule({ memberId: "m1" });
    const hot = [series({ value: 90 })];
    expect(evaluateRoutingRules([scoped], hot, NOW, "m1")).toMatchObject({
      verdict: "full",
      ruleStates: ["triggered"],
    });
    expect(evaluateRoutingRules([scoped], hot, NOW, "m2")).toMatchObject({
      verdict: "none",
      ruleStates: ["clear"],
    });
    // Unknown member: the rule does not apply (fail open).
    expect(evaluateRoutingRules([scoped], hot, NOW)).toMatchObject({
      verdict: "none",
      ruleStates: ["clear"],
    });
  });

  it("skips a rule for the excluded member and applies it to everyone else", () => {
    const scoped = rule({ excludeMemberId: "m1" });
    const hot = [series({ value: 90 })];
    expect(evaluateRoutingRules([scoped], hot, NOW, "m1")).toMatchObject({
      verdict: "none",
      ruleStates: ["clear"],
    });
    expect(evaluateRoutingRules([scoped], hot, NOW, "m2")).toMatchObject({
      verdict: "full",
      ruleStates: ["triggered"],
    });
  });

  it("fails open when a member-scoped rule's metric is missing", () => {
    const scoped = rule({ memberId: "m1", metric: "absent" });
    expect(evaluateRoutingRules([scoped], [series({})], NOW, "m1")).toMatchObject({
      verdict: "none",
      ruleStates: ["stale"],
    });
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

  it("keeps full until the freshest triggering full rule goes stale, whatever the rule order", () => {
    const evaluation = evaluateRoutingRules(
      [rule({ metric: "other" }), rule({})],
      [series({ name: "other", value: 90, ageMs: 0 }), series({ value: 90, ageMs: 25_000 })],
      NOW,
    );
    expect(evaluation.expiresAt).toEqual(at(30_000));
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
    // A shadowed or refused remote source of the same name does not set the
    // local source's interval.
    const shadowed = nodeMetricSeries(
      {
        ts: "2026-09-28T11:59:50.000Z",
        custom: [{ source: "fans", name: "fan_rpm", value: 1, ts: "2026-09-28T11:59:50.000Z" }],
        sources: [
          { name: "fans", origin: "local", state: "active", intervalSecs: 10 },
          { name: "fans", origin: "remote", state: "refused", intervalSecs: 86_400 },
        ],
      },
      receivedAt,
      NOW,
    );
    expect(shadowed.find((entry) => entry.name === "fan_rpm")?.staleAfterMs).toBe(30_000);
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
        kvOccupancy: 0.8,
        receivedAt: at(-1_000),
      },
      { endpointSlug: "b", modelSlug: null, running: 9, waiting: 9, receivedAt: at(-1_000) },
    ];
    const forModel = endpointLoadSeries(loads, { endpointSlug: "a", modelSlug: "m" }, NOW);
    expect(forModel.find((entry) => entry.name === "endpoint.running")?.value).toBe(3);
    expect(forModel.find((entry) => entry.name === "endpoint.kv_usage")?.value).toBe(0.5);
    expect(forModel.find((entry) => entry.name === "endpoint.kv_occupancy")?.value).toBe(0.8);
    expect(forModel[0]?.staleAfterMs).toBe(ENDPOINT_LOAD_STALE_AFTER_MS);
    const endpointWide = endpointLoadSeries(loads, { endpointSlug: "a", modelSlug: "other" }, NOW);
    expect(endpointWide.find((entry) => entry.name === "endpoint.running")?.value).toBe(1);
    expect(endpointLoadSeries(loads, { endpointSlug: "c", modelSlug: null }, NOW)).toEqual([]);
  });

  it("falls back to endpoint-wide engine-load history when the sample slug is null", () => {
    const endpointWide = [{ gap: false as const, running: 4 }];
    const modelSpecific = [{ gap: false as const, running: 1 }];
    const byKey = new Map([
      [engineLoadHistoryKey("cli", "gpu", null), endpointWide],
      [engineLoadHistoryKey("cli", "gpu", "qwen"), modelSpecific],
    ]);
    expect(
      pickEngineLoadHistorySeries(byKey, {
        cliDeviceId: "cli",
        endpointSlug: "gpu",
        modelSlug: "other",
      }),
    ).toEqual(endpointWide);
    expect(
      pickEngineLoadHistorySeries(byKey, {
        cliDeviceId: "cli",
        endpointSlug: "gpu",
        modelSlug: "qwen",
      }),
    ).toEqual(modelSpecific);
    expect(
      pickEngineLoadHistorySeries(byKey, {
        cliDeviceId: "cli",
        endpointSlug: "gpu",
        modelSlug: null,
      }),
    ).toEqual(endpointWide);
    expect(
      engineLoadHistoryLookupKeys([{ cliDeviceId: "cli", endpointSlug: "gpu", modelSlug: "qwen" }]),
    ).toEqual([
      { cliDeviceId: "cli", endpointSlug: "gpu", modelSlug: "qwen" },
      { cliDeviceId: "cli", endpointSlug: "gpu", modelSlug: null },
    ]);
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
