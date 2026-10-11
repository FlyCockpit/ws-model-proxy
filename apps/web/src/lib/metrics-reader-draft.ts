import {
  type MetricsReader,
  READER_SIGNALS,
  type ReaderMap,
  type ReaderSignal,
} from "@ws-model-proxy/api/lib/runtime-spec";

/**
 * The metrics reader form (`spec.metricsReader`) on a runtime's Advanced page. The API has no
 * reader presets, so the starting points live here: the engine's own reader, or a route reader
 * that maps the engine's Prometheus series by name (the same series the node's built-in
 * adapters read, `apps/cli/src/engine.rs`).
 */

export type ReaderKind = "none" | "builtin" | "route" | "command";
export type ReaderAggregate = "" | "sum" | "max" | "first";
export type ReaderMapRow = {
  signal: ReaderSignal;
  series: string;
  aggregate: ReaderAggregate;
  scale: string;
  divideBy: string;
};
export type ReaderDraft = {
  kind: ReaderKind;
  route: string;
  command: string;
  format: "json" | "prometheus";
  intervalSecs: string;
  countRoute: string;
  map: ReaderMapRow[];
};

export const READER_PRESETS = [
  "builtin",
  "vllm",
  "sglang",
  "llama_cpp",
  "custom_route",
  "custom_command",
] as const;
export type ReaderPresetId = (typeof READER_PRESETS)[number];

function prometheus(map: ReaderMap): MetricsReader {
  return { kind: "route", route: "/metrics", format: "prometheus", map };
}

export const READER_PRESET_VALUES: Record<ReaderPresetId, MetricsReader> = {
  builtin: { kind: "builtin" },
  vllm: prometheus({
    running: { series: "vllm:num_requests_running", aggregate: "sum" },
    waiting: { series: "vllm:num_requests_waiting", aggregate: "sum" },
    kvUsage: { series: "vllm:kv_cache_usage_perc", aggregate: "max" },
  }),
  sglang: prometheus({
    running: { series: "sglang:num_running_reqs", aggregate: "sum" },
    waiting: { series: "sglang:num_queue_reqs", aggregate: "sum" },
    kvUsage: { series: "sglang:token_usage", aggregate: "max" },
  }),
  llama_cpp: prometheus({
    running: { series: "llamacpp:requests_processing", aggregate: "first" },
    deferred: { series: "llamacpp:requests_deferred", aggregate: "first" },
    kvOccupancy: { series: "llamacpp:kv_cache_usage_ratio", aggregate: "first" },
  }),
  custom_route: { kind: "route", route: "/metrics", format: "json", map: {} },
  custom_command: { kind: "command", command: "echo '{}'", format: "json", map: {} },
};

function str(value: number | string | undefined): string {
  return value === undefined ? "" : String(value);
}

export function readerToDraft(reader: MetricsReader | undefined): ReaderDraft {
  const map = reader && reader.kind !== "builtin" ? reader.map : {};
  return {
    kind: reader?.kind ?? "none",
    route: reader?.kind === "route" ? reader.route : "/metrics",
    command: reader?.kind === "command" ? reader.command : "",
    format: reader && reader.kind !== "builtin" ? reader.format : "prometheus",
    intervalSecs: reader && reader.kind !== "builtin" ? str(reader.intervalSecs) : "",
    countRoute: reader?.kind === "route" ? (reader.countRoute ?? "") : "",
    map: READER_SIGNALS.flatMap((signal) => {
      const entry = map[signal];
      return entry
        ? [
            {
              signal,
              series: entry.series,
              aggregate: entry.aggregate ?? "",
              scale: str(entry.scale),
              divideBy: entry.divideBy ?? "",
            },
          ]
        : [];
    }),
  };
}

function num(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value.trim());
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}

/**
 * The reader a draft describes (unvalidated: check it with `metricsReaderSchema`). Series
 * labels have no input; they are kept from `base` for the same signal.
 */
export function draftToReader(draft: ReaderDraft, base: MetricsReader | undefined): unknown {
  if (draft.kind === "none") return undefined;
  if (draft.kind === "builtin") return { kind: "builtin" };
  const baseMap: ReaderMap = base && base.kind !== "builtin" ? base.map : {};
  const map = Object.fromEntries(
    draft.map.map((row) => [
      row.signal,
      compact({
        series: row.series,
        // Labels select samples of one series: kept only while the series stays the same.
        labels:
          baseMap[row.signal]?.series === row.series ? baseMap[row.signal]?.labels : undefined,
        aggregate: row.aggregate === "" ? undefined : row.aggregate,
        scale: num(row.scale),
        divideBy: row.divideBy.trim() === "" ? undefined : row.divideBy,
      }),
    ]),
  );
  return draft.kind === "route"
    ? compact({
        kind: "route",
        route: draft.route,
        format: draft.format,
        intervalSecs: num(draft.intervalSecs),
        map,
        countRoute: draft.countRoute.trim() === "" ? undefined : draft.countRoute,
      })
    : compact({
        kind: "command",
        command: draft.command,
        format: draft.format,
        intervalSecs: num(draft.intervalSecs),
        map,
      });
}

/** The first signal no row maps yet (for "Add a signal"). */
export function nextFreeSignal(rows: readonly ReaderMapRow[]): ReaderSignal | null {
  const used = new Set(rows.map((row) => row.signal));
  return READER_SIGNALS.find((signal) => !used.has(signal)) ?? null;
}
