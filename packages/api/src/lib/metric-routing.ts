/**
 * Metric-driven pool routing (S-B part 2).
 *
 * A pool carries a short list of flat rules. Each rule names one metric
 * (built-in or a CLI custom series), an optional label subset, an aggregate
 * (`max`, `min`, or `avg`; default `max`), a comparison and a threshold, and
 * an effect:
 *
 * - `full`: the member is treated as FULL (ineligible at candidate build and
 *   at grant time, with fail-open when every candidate is metric-FULL);
 * - `avoid`: the member ranks last among free members (ordering only).
 *
 * Optional `memberId` limits the rule to that pool member; optional
 * `excludeMemberId` applies it to every other member. The two are mutually
 * exclusive. Rules are evaluated against the member's own device: `node.*`
 * series come from relay 2.7 `node.metrics` built-ins, `endpoint.*` series
 * from the member's endpoint `endpoint.load`, and any other name from the
 * CLI's custom series. A stale or missing metric makes its rule inert (fail
 * open). An out-of-scope rule is `clear` and does not look at metrics.
 *
 * Nothing here ever sees prompt text: the inputs are numbers, names and
 * labels that the relay schema already restricted.
 */
import { z } from "zod";

/** Metric names, label keys and label values. Same charset as the relay schema. */
export const METRIC_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
export const ROUTING_RULES_MAX = 16;
export const ROUTING_RULE_LABELS_MAX = 16;
/** Custom series names under these prefixes are ignored (built-ins own them). */
export const RESERVED_METRIC_PREFIXES = ["node.", "endpoint."] as const;
export const ROUTING_RULE_OPS = [">", ">=", "<", "<="] as const;
export const ROUTING_RULE_EFFECTS = ["full", "avoid"] as const;
export const ROUTING_RULE_AGGREGATES = ["max", "min", "avg"] as const;

/** `node.metrics` built-ins arrive every 20–30 s: stale after 3 × 30 s. */
export const NODE_METRICS_STALE_AFTER_MS = 90_000;
/** `endpoint.load` is re-sent at least every 5 s: stale after 3 × 5 s. */
export const ENDPOINT_LOAD_STALE_AFTER_MS = 15_000;
/** A custom series is stale after 3 × its source interval. */
export const CUSTOM_STALE_INTERVALS = 3;
/** Used when a custom series' source reported no interval. */
export const CUSTOM_DEFAULT_INTERVAL_SECS = 30;

const metricNameSchema = z.string().regex(METRIC_NAME_PATTERN, {
  message: "Use 1-64 characters from A-Z a-z 0-9 _ . : -",
});

/**
 * A label key becomes an object key: `__proto__` matches the pattern but
 * zod's record drops it silently (before any key schema runs), which would
 * widen a rule's label filter. Reject it on the input. The relay schema and
 * the CLI reject it too.
 */
const RESERVED_LABEL_KEYS = ["__proto__"] as const;
const labelsSchema = z
  .custom<Record<string, string>>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !RESERVED_LABEL_KEYS.some((key) => Object.hasOwn(value, key)),
    { message: "A label key is reserved." },
  )
  .pipe(z.record(metricNameSchema, metricNameSchema));

/** Shared id schema for pool and member references. */
export const idSchema = z.string().min(1);
const optionalMemberId = idSchema.nullable().optional();

export const routingRuleSchema = z
  .object({
    metric: metricNameSchema,
    labels: labelsSchema
      .refine((labels) => Object.keys(labels).length <= ROUTING_RULE_LABELS_MAX, {
        message: `At most ${ROUTING_RULE_LABELS_MAX} labels per rule.`,
      })
      .optional(),
    aggregate: z.enum(ROUTING_RULE_AGGREGATES).default("max"),
    op: z.enum(ROUTING_RULE_OPS),
    threshold: z.number().finite(),
    effect: z.enum(ROUTING_RULE_EFFECTS),
    /** When set, the rule applies only to this pool member. */
    memberId: optionalMemberId,
    /** When set, the rule applies to every member except this one. */
    excludeMemberId: optionalMemberId,
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.memberId && rule.excludeMemberId) {
      context.addIssue({
        code: "custom",
        path: ["excludeMemberId"],
        message: "Set memberId or excludeMemberId, not both.",
      });
    }
  });
export type RoutingRule = z.output<typeof routingRuleSchema>;
export type RoutingRuleInput = z.input<typeof routingRuleSchema>;

export const routingRulesSchema = z.array(routingRuleSchema).max(ROUTING_RULES_MAX);

/** Stored rules, validated again on read; an invalid column counts as no rules. */
export function parseStoredRoutingRules(value: unknown): RoutingRule[] {
  const parsed = routingRulesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** One `pool_routing_rule` row as evaluation and the dashboard read it. */
export type StoredRoutingRuleRow = {
  position?: number;
  metric: string;
  labels?: unknown;
  aggregate?: string | null;
  op: string;
  threshold: number;
  effect: string;
  memberId?: string | null;
  exclude?: boolean;
};

function labelsFromStored(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

/** Map persisted rule rows to the evaluation schema; invalid rows are dropped. */
export function routingRulesFromRows(rows: readonly StoredRoutingRuleRow[]): RoutingRule[] {
  const ordered = [...rows].sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
  const parsed: RoutingRule[] = [];
  for (const row of ordered) {
    if (parsed.length >= ROUTING_RULES_MAX) break;
    const rule = routingRuleSchema.safeParse({
      metric: row.metric,
      labels: labelsFromStored(row.labels),
      aggregate: row.aggregate ?? "max",
      op: row.op,
      threshold: row.threshold,
      effect: row.effect,
      memberId: row.exclude ? null : (row.memberId ?? null),
      excludeMemberId: row.exclude ? (row.memberId ?? null) : null,
    });
    if (rule.success) parsed.push(rule.data);
  }
  return parsed;
}

/** Persist API rules as table rows (`exclude` + one member FK). */
export function toStoredRoutingRuleRows(value: unknown): StoredRoutingRuleRow[] {
  return parseStoredRoutingRules(value).map((rule, position) => ({
    position,
    metric: rule.metric,
    labels: rule.labels ?? null,
    aggregate: rule.aggregate,
    op: rule.op,
    threshold: rule.threshold,
    effect: rule.effect,
    memberId: rule.memberId ?? rule.excludeMemberId ?? null,
    exclude: Boolean(rule.excludeMemberId),
  }));
}

/** Member ids a rule list names (include or exclude). */
export function scopedRoutingMemberIds(rules: readonly RoutingRule[]): string[] {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (rule.memberId) ids.add(rule.memberId);
    if (rule.excludeMemberId) ids.add(rule.excludeMemberId);
  }
  return [...ids];
}

/**
 * Blank as the CLI's `str::trim().is_empty()` sees it: every Unicode
 * White_Space character (NOT JS `trim()`, which also strips U+FEFF and misses
 * U+0085), so both sides agree on what a blank command is.
 */
const BLANK_COMMAND = /^\p{White_Space}*$/u;

/** Server-to-CLI remote source definition (mirrors the relay 2.7 schema). */
export const remoteMetricSourceDefinitionSchema = z
  .object({
    name: metricNameSchema,
    // One definition of a runnable command on every side (the CLI's
    // `validate_command`): non-blank, at most 4096 BYTES, no NUL.
    command: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (command) =>
          !BLANK_COMMAND.test(command) &&
          !command.includes("\u0000") &&
          new TextEncoder().encode(command).length <= 4096,
        { message: "command must be non-blank, at most 4096 bytes and contain no NUL" },
      ),
    intervalSecs: z.number().int().min(5).max(86_400),
    timeoutSecs: z.number().int().min(1).max(300),
    format: z.enum(["number", "json", "prometheus"]),
  })
  .strict();
export type RemoteMetricSourceDefinition = z.infer<typeof remoteMetricSourceDefinitionSchema>;
export const REMOTE_METRIC_SOURCES_MAX = 50;
export const remoteMetricSourceDefinitionsSchema = z
  .array(remoteMetricSourceDefinitionSchema)
  .max(REMOTE_METRIC_SOURCES_MAX)
  .superRefine((sources, context) => {
    const seen = new Set<string>();
    for (const [index, source] of sources.entries()) {
      if (seen.has(source.name)) {
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: "Source names must be unique.",
        });
      }
      seen.add(source.name);
    }
  });

export function parseStoredRemoteMetricSources(value: unknown): RemoteMetricSourceDefinition[] {
  const parsed = remoteMetricSourceDefinitionsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * The subset of a relay 2.7 `node.metrics` body this module reads. Parsed
 * leniently: the relay already validated it strictly, and a stored snapshot
 * from an older build must not break reads.
 */
const optionalNumber = z.number().finite().nullable().optional();
export const nodeMetricsSampleSchema = z.object({
  ts: z.string().optional(),
  cpu: z
    .object({
      usagePercent: optionalNumber,
      load1: optionalNumber,
      load5: optionalNumber,
      load15: optionalNumber,
    })
    .partial()
    .optional(),
  memory: z
    .object({
      totalMiB: optionalNumber,
      availableMiB: optionalNumber,
      swapTotalMiB: optionalNumber,
      swapFreeMiB: optionalNumber,
    })
    .partial()
    .optional(),
  disks: z
    .array(z.object({ mount: z.string(), totalMiB: optionalNumber, freeMiB: optionalNumber }))
    .optional(),
  gpus: z
    .array(
      z.object({
        index: z.number().int(),
        vramUsedMiB: optionalNumber,
        vramTotalMiB: optionalNumber,
        gttUsedMiB: optionalNumber,
        utilizationPercent: optionalNumber,
        temperatureC: optionalNumber,
        powerW: optionalNumber,
      }),
    )
    .optional(),
  custom: z
    .array(
      z.object({
        source: z.string(),
        name: z.string(),
        labels: z.record(z.string(), z.string()).optional(),
        value: z.number(),
        ts: z.string(),
      }),
    )
    .optional(),
  sources: z
    .array(
      z.object({
        name: z.string(),
        origin: z.enum(["local", "remote"]),
        state: z.string(),
        commandSha256: z.string().optional(),
        error: z.string().optional(),
        intervalSecs: z.number().int().optional(),
      }),
    )
    .optional(),
  abandonedRecovery: z.number().int().nonnegative().optional(),
});
export type NodeMetricsSample = z.infer<typeof nodeMetricsSampleSchema>;

export function parseNodeMetricsSample(value: unknown): NodeMetricsSample | null {
  const parsed = nodeMetricsSampleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One flattened, timestamped series a rule can reference. */
export type MetricSeries = {
  name: string;
  labels: Record<string, string>;
  value: number;
  /** Age at `now`, from server receive time plus the CLI-relative sample age. */
  ageMs: number;
  staleAfterMs: number;
  origin: "builtin" | "endpoint" | "custom";
};

export function isStale(series: Pick<MetricSeries, "ageMs" | "staleAfterMs">): boolean {
  return series.ageMs > series.staleAfterMs;
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Flatten a `node.metrics` sample into series: built-ins under `node.*` and
 * the CLI's custom series. `receivedAt` is when the server accepted the frame.
 */
export function nodeMetricSeries(
  sample: NodeMetricsSample,
  receivedAt: Date,
  now: Date,
): MetricSeries[] {
  const sinceReceiptMs = Math.max(0, now.getTime() - receivedAt.getTime());
  const series: MetricSeries[] = [];
  const builtin = (name: string, value: number | null | undefined, labels = {}) => {
    if (!finite(value)) return;
    series.push({
      name,
      labels,
      value,
      ageMs: sinceReceiptMs,
      staleAfterMs: NODE_METRICS_STALE_AFTER_MS,
      origin: "builtin",
    });
  };
  builtin("node.cpu.usage_percent", sample.cpu?.usagePercent);
  builtin("node.cpu.load1", sample.cpu?.load1);
  builtin("node.cpu.load5", sample.cpu?.load5);
  builtin("node.cpu.load15", sample.cpu?.load15);
  const memory = sample.memory;
  builtin("node.memory.available_mib", memory?.availableMiB);
  if (finite(memory?.totalMiB) && memory.totalMiB > 0 && finite(memory?.availableMiB)) {
    builtin(
      "node.memory.used_percent",
      round(((memory.totalMiB - memory.availableMiB) / memory.totalMiB) * 100),
    );
  }
  builtin("node.swap.free_mib", memory?.swapFreeMiB);
  const root = sample.disks?.find((disk) => disk.mount === "/");
  builtin("node.disk.free_mib", root?.freeMiB);
  for (const gpu of sample.gpus ?? []) {
    const labels = { gpu: String(gpu.index) };
    builtin("node.gpu.vram_used_mib", gpu.vramUsedMiB, labels);
    if (finite(gpu.vramTotalMiB) && gpu.vramTotalMiB > 0 && finite(gpu.vramUsedMiB)) {
      builtin(
        "node.gpu.vram_used_percent",
        round((gpu.vramUsedMiB / gpu.vramTotalMiB) * 100),
        labels,
      );
    }
    builtin("node.gpu.gtt_used_mib", gpu.gttUsedMiB, labels);
    builtin("node.gpu.utilization_percent", gpu.utilizationPercent, labels);
    builtin("node.gpu.temperature_c", gpu.temperatureC, labels);
    builtin("node.gpu.power_w", gpu.powerW, labels);
  }
  const intervals = new Map<string, number>();
  for (const source of sample.sources ?? []) {
    // Only a source that is running reports a series, so only its interval
    // counts: a shadowed or refused same-named remote must not set it.
    if (source.state !== "active" && source.state !== "failing") continue;
    if (finite(source.intervalSecs)) intervals.set(source.name, source.intervalSecs);
  }
  const frameTs = parseTime(sample.ts);
  for (const custom of sample.custom ?? []) {
    if (!finite(custom.value)) continue;
    if (!METRIC_NAME_PATTERN.test(custom.name)) continue;
    if (RESERVED_METRIC_PREFIXES.some((prefix) => custom.name.startsWith(prefix))) continue;
    const seriesTs = parseTime(custom.ts);
    // Both timestamps are on the CLI clock, so their difference is skew-free.
    const ageAtFrameMs =
      frameTs !== null && seriesTs !== null ? Math.max(0, frameTs - seriesTs) : 0;
    const intervalSecs = intervals.get(custom.source) ?? CUSTOM_DEFAULT_INTERVAL_SECS;
    series.push({
      name: custom.name,
      labels: custom.labels ?? {},
      value: custom.value,
      ageMs: ageAtFrameMs + sinceReceiptMs,
      staleAfterMs: CUSTOM_STALE_INTERVALS * intervalSecs * 1000,
      origin: "custom",
    });
  }
  return series;
}

/** The subset of relay `endpoint.load` this module reads. */
export type EndpointLoadSample = {
  endpointSlug: string;
  modelSlug: string | null;
  running: number;
  waiting?: number;
  kvUsage?: number;
  kvOccupancy?: number;
  slotsBusy?: number;
  deferred?: number;
  source?: string;
  /** Consecutive accepted frames with `waiting > 0` (S-D; 0 when unknown). */
  waitingStreak?: number;
  /** Prefix cache totals accumulated by the session (S-D dashboard). */
  prefixCacheHitsTotal?: number;
  prefixCacheQueriesTotal?: number;
  receivedAt: Date;
};

/**
 * The reading that speaks for one member: a model-specific `endpoint.load`
 * wins over the endpoint-wide one.
 */
export function pickEndpointLoad<T extends EndpointLoadSample>(
  loads: readonly T[],
  member: { endpointSlug: string; modelSlug: string | null },
): T | null {
  const forEndpoint = loads.filter((load) => load.endpointSlug === member.endpointSlug);
  return (
    (member.modelSlug
      ? forEndpoint.find((entry) => entry.modelSlug === member.modelSlug)
      : undefined) ??
    forEndpoint.find((entry) => entry.modelSlug === null) ??
    null
  );
}

/** Same key as live load / the in-memory history store: null slug is endpoint-wide. */
export function engineLoadHistoryKey(
  cliDeviceId: string,
  endpointSlug: string,
  modelSlug: string | null,
): string {
  return `${cliDeviceId}\u0000${endpointSlug}\u0000${modelSlug ?? ""}`;
}

/**
 * History lookup mirrors `pickEndpointLoad`: a model-specific series wins;
 * otherwise the endpoint-wide (`modelSlug: null`) sample is used. CLI samples
 * always arrive with a null slug.
 */
export function pickEngineLoadHistorySeries<T extends { gap: boolean }>(
  byKey: ReadonlyMap<string, readonly T[]>,
  member: { cliDeviceId: string; endpointSlug: string; modelSlug: string | null },
): T[] {
  const exact =
    byKey.get(engineLoadHistoryKey(member.cliDeviceId, member.endpointSlug, member.modelSlug)) ??
    [];
  if (member.modelSlug && !exact.some((point) => !point.gap)) {
    const fallback =
      byKey.get(engineLoadHistoryKey(member.cliDeviceId, member.endpointSlug, null)) ?? [];
    if (fallback.some((point) => !point.gap)) return [...fallback];
  }
  return [...exact];
}

/** Exact member keys plus the endpoint-wide fallback when the member has a model slug. */
export function engineLoadHistoryLookupKeys(
  members: readonly { cliDeviceId: string; endpointSlug: string; modelSlug: string | null }[],
): Array<{ cliDeviceId: string; endpointSlug: string; modelSlug: string | null }> {
  const keys: Array<{ cliDeviceId: string; endpointSlug: string; modelSlug: string | null }> = [];
  const seen = new Set<string>();
  for (const member of members) {
    for (const modelSlug of member.modelSlug ? [member.modelSlug, null] : [member.modelSlug]) {
      const key = engineLoadHistoryKey(member.cliDeviceId, member.endpointSlug, modelSlug);
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push({
        cliDeviceId: member.cliDeviceId,
        endpointSlug: member.endpointSlug,
        modelSlug,
      });
    }
  }
  return keys;
}

/**
 * `endpoint.*` series for one member: the load of its own endpoint. A
 * model-specific reading wins over the endpoint-wide one.
 */
export function endpointLoadSeries(
  loads: readonly EndpointLoadSample[],
  member: { endpointSlug: string; modelSlug: string | null },
  now: Date,
): MetricSeries[] {
  const load = pickEndpointLoad(loads, member);
  if (!load) return [];
  const ageMs = Math.max(0, now.getTime() - load.receivedAt.getTime());
  const series: MetricSeries[] = [];
  const push = (name: string, value: number | undefined) => {
    if (!finite(value)) return;
    series.push({
      name,
      labels: {},
      value,
      ageMs,
      staleAfterMs: ENDPOINT_LOAD_STALE_AFTER_MS,
      origin: "endpoint",
    });
  };
  push("endpoint.running", load.running);
  push("endpoint.waiting", load.waiting);
  push("endpoint.kv_usage", load.kvUsage);
  push("endpoint.kv_occupancy", load.kvOccupancy);
  push("endpoint.slots_busy", load.slotsBusy);
  push("endpoint.deferred", load.deferred);
  return series;
}

export type RuleState = "triggered" | "clear" | "stale";
export type RoutingVerdict = "none" | "avoid" | "full";

export type RoutingEvaluation = {
  verdict: RoutingVerdict;
  /** Aligned with the rule list. */
  ruleStates: RuleState[];
  /**
   * When the verdict stops being trustworthy: the latest staleness among
   * the triggered rules of the verdict's effect (it holds while one of them
   * has fresh data). For `none`, the earliest staleness of any fresh series a
   * rule used (or `now` when every rule is stale).
   */
  expiresAt: Date;
};

function labelsMatch(series: Record<string, string>, wanted: Record<string, string> | undefined) {
  if (!wanted) return true;
  return Object.entries(wanted).every(([key, value]) => series[key] === value);
}

function compare(value: number, op: RoutingRule["op"], threshold: number): boolean {
  switch (op) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
  }
}

function remainingMs(entry: Pick<MetricSeries, "ageMs" | "staleAfterMs">): number {
  return Math.max(0, entry.staleAfterMs - entry.ageMs);
}

/** `memberId` / `excludeMemberId` are mutually exclusive at parse time. */
function ruleAppliesToMember(
  rule: Pick<RoutingRule, "memberId" | "excludeMemberId">,
  poolMemberId: string | null | undefined,
): boolean {
  if (rule.memberId) return rule.memberId === poolMemberId;
  if (rule.excludeMemberId) return rule.excludeMemberId !== poolMemberId;
  return true;
}

function aggregateMatching(
  matching: readonly MetricSeries[],
  aggregate: RoutingRule["aggregate"],
  nowMs: number,
): { value: number; expiresAtMs: number } {
  if (aggregate === "avg") {
    let sum = 0;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of matching) {
      sum += entry.value;
      earliest = Math.min(earliest, nowMs + remainingMs(entry));
    }
    return { value: sum / matching.length, expiresAtMs: earliest };
  }
  let best = matching[0]!;
  for (const entry of matching) {
    if (aggregate === "min" ? entry.value < best.value : entry.value > best.value) best = entry;
  }
  return { value: best.value, expiresAtMs: nowMs + remainingMs(best) };
}

/**
 * Evaluate a pool's rules against one member's series. Fresh series only:
 * a rule whose metric has no fresh matching series is `stale` and ignored.
 * `poolMemberId` is this member; a `memberId` / `excludeMemberId` rule that
 * does not apply is `clear` and does not consult metrics.
 */
export function evaluateRoutingRules(
  rules: readonly RoutingRule[],
  series: readonly MetricSeries[],
  now: Date,
  poolMemberId?: string | null,
): RoutingEvaluation {
  const ruleStates: RuleState[] = [];
  let full = false;
  let avoid = false;
  let decidingExpiry = Number.NEGATIVE_INFINITY;
  let anyExpiry = Number.POSITIVE_INFINITY;
  const decisive: Array<{ effect: RoutingRule["effect"]; expiresAtMs: number }> = [];
  const nowMs = now.getTime();
  for (const rule of rules) {
    if (!ruleAppliesToMember(rule, poolMemberId)) {
      ruleStates.push("clear");
      continue;
    }
    const matching = series.filter(
      (entry) =>
        entry.name === rule.metric && labelsMatch(entry.labels, rule.labels) && !isStale(entry),
    );
    if (matching.length === 0) {
      ruleStates.push("stale");
      continue;
    }
    const { value, expiresAtMs } = aggregateMatching(matching, rule.aggregate, nowMs);
    anyExpiry = Math.min(anyExpiry, expiresAtMs);
    if (compare(value, rule.op, rule.threshold)) {
      ruleStates.push("triggered");
      decisive.push({ effect: rule.effect, expiresAtMs });
      if (rule.effect === "full") full = true;
      else avoid = true;
    } else {
      ruleStates.push("clear");
    }
  }
  const verdict: RoutingVerdict = full ? "full" : avoid ? "avoid" : "none";
  // The verdict holds while any rule that produced it still has fresh data.
  for (const entry of decisive) {
    if (entry.effect === verdict) decidingExpiry = Math.max(decidingExpiry, entry.expiresAtMs);
  }
  const expiresAtMs =
    verdict === "none" ? (Number.isFinite(anyExpiry) ? anyExpiry : now.getTime()) : decidingExpiry;
  return { verdict, ruleStates, expiresAt: new Date(expiresAtMs) };
}

/** Distinct metric names and label sets, for discovery (dashboard, MCP). */
export function describeSeries(series: readonly MetricSeries[]) {
  return series
    .map((entry) => ({
      name: entry.name,
      labels: entry.labels,
      value: entry.value,
      origin: entry.origin,
      ageSeconds: Math.round(entry.ageMs / 1000),
      stale: isStale(entry),
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)),
    );
}
