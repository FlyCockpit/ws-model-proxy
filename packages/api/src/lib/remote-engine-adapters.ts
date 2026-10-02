/**
 * Remote engine-adapter definitions (relay 2.9 `engine.adapters.set`).
 * Canonical JSON is hashed with SHA-256 on both sides; a changed spec needs
 * a new local approval. Occupancy is never part of this contract's routing
 * use (display only).
 */
import { createHash } from "node:crypto";
import { z } from "zod";

const BLANK_COMMAND = /^\p{White_Space}*$/u;
const ADAPTER_SIGNALS = [
  "running",
  "waiting",
  "kvUsage",
  "kvOccupancy",
  "slotsBusy",
  "deferred",
  "prefixCacheHitsTotal",
  "prefixCacheQueriesTotal",
  "kvTokens",
  "slots",
  "maxModelLen",
  "ctxPerSlot",
] as const;

function runnableCommand(command: string): boolean {
  return (
    !BLANK_COMMAND.test(command) &&
    !command.includes("\u0000") &&
    new TextEncoder().encode(command).length <= 4096
  );
}

const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function hasAsciiControlOrWhitespace(route: string): boolean {
  for (let i = 0; i < route.length; i += 1) {
    const code = route.charCodeAt(i);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

/** Path on the endpoint origin: one leading `/`, no scheme, host, whitespace, `..`, query, or fragment. */
export function adapterRouteIsValid(route: string): boolean {
  if (route.length === 0) return false;
  if (hasAsciiControlOrWhitespace(route)) return false;
  if (route.includes("\\")) return false;
  if (SCHEME_PREFIX.test(route)) return false;
  if (!route.startsWith("/") || route.startsWith("//")) return false;
  if (route.includes("..")) return false;
  if (route.includes("?")) return false;
  if (route.includes("#")) return false;
  return true;
}

const adapterInputSchema = z.union([
  z
    .object({
      route: z
        .string()
        .min(1)
        .max(1024)
        .refine((route) => adapterRouteIsValid(route), {
          message:
            "adapter route must start with / and stay on the endpoint origin (no scheme, host, whitespace, .., query, or fragment)",
        }),
    })
    .strict(),
  z
    .object({
      command: z.string().min(1).max(4096).refine(runnableCommand, {
        message: "command must be non-blank, at most 4096 bytes and contain no NUL",
      }),
    })
    .strict(),
]);

const signalSelectorSchema = z
  .object({
    series: z.string().trim().min(1).max(256),
    labels: z.record(z.string().min(1).max(64), z.string().min(1).max(64)).optional(),
    aggregate: z.enum(["sum", "max", "first"]).optional(),
    scale: z.number().finite().optional(),
  })
  .strict();

export const remoteEngineAdapterDefinitionSchema = z
  .object({
    endpointSlug: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "endpoint slug must be a lowercase kebab slug"),
    input: adapterInputSchema,
    format: z.enum(["json", "prometheus"]),
    intervalSecs: z.number().int().min(2).max(5),
    timeoutSecs: z.number().int().min(1).max(4),
    map: z.partialRecord(z.enum(ADAPTER_SIGNALS), signalSelectorSchema).optional(),
    countRoute: z
      .string()
      .min(1)
      .max(1024)
      .refine((route) => adapterRouteIsValid(route), {
        message:
          "adapter count route must start with / and stay on the endpoint origin (no scheme, host, whitespace, .., query, or fragment)",
      })
      .optional(),
  })
  .strict()
  .superRefine((adapter, context) => {
    if (adapter.format === "prometheus" && Object.keys(adapter.map ?? {}).length === 0) {
      context.addIssue({
        code: "custom",
        path: ["map"],
        message: "prometheus adapters need a map from signals to series",
      });
    }
  });
export type RemoteEngineAdapterDefinition = z.infer<typeof remoteEngineAdapterDefinitionSchema>;

export const REMOTE_ENGINE_ADAPTERS_MAX = 64;
export const remoteEngineAdapterDefinitionsSchema = z
  .array(remoteEngineAdapterDefinitionSchema)
  .max(REMOTE_ENGINE_ADAPTERS_MAX)
  .superRefine((adapters, context) => {
    const seen = new Set<string>();
    for (const [index, adapter] of adapters.entries()) {
      if (seen.has(adapter.endpointSlug)) {
        context.addIssue({
          code: "custom",
          path: [index, "endpointSlug"],
          message: "Endpoint slugs must be unique.",
        });
      }
      seen.add(adapter.endpointSlug);
    }
  });

export function parseStoredRemoteEngineAdapters(value: unknown): RemoteEngineAdapterDefinition[] {
  const parsed = remoteEngineAdapterDefinitionsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      next[key] = sortJson(item);
    }
    return next;
  }
  return value;
}

function compactSelector(selector: {
  series: string;
  labels?: Record<string, string>;
  aggregate?: "sum" | "max" | "first";
  scale?: number;
}) {
  const labels = selector.labels ?? {};
  return {
    series: selector.series,
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    ...(selector.aggregate ? { aggregate: selector.aggregate } : {}),
    ...(selector.scale !== undefined ? { scale: selector.scale } : {}),
  };
}

/** Compact JSON with sorted keys; SHA-256 of this is the approval pin. */
export function canonicalRemoteEngineAdapterJson(adapter: RemoteEngineAdapterDefinition): string {
  const map: Record<string, ReturnType<typeof compactSelector>> = {};
  for (const [signal, selector] of Object.entries(adapter.map ?? {})) {
    if (!selector) continue;
    map[signal] = compactSelector(selector);
  }
  return JSON.stringify(
    sortJson({
      endpointSlug: adapter.endpointSlug,
      format: adapter.format,
      input: adapter.input,
      intervalSecs: adapter.intervalSecs,
      map,
      timeoutSecs: adapter.timeoutSecs,
      ...(adapter.countRoute ? { countRoute: adapter.countRoute } : {}),
    }),
  );
}

export function remoteEngineAdapterSpecSha256(adapter: RemoteEngineAdapterDefinition): string {
  return createHash("sha256")
    .update(canonicalRemoteEngineAdapterJson(adapter), "utf8")
    .digest("hex");
}

export function serializeRemoteEngineAdapters(value: unknown) {
  return parseStoredRemoteEngineAdapters(value).map((adapter) => ({
    ...adapter,
    specSha256: remoteEngineAdapterSpecSha256(adapter),
  }));
}
