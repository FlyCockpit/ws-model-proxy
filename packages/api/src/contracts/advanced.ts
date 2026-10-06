/**
 * zod schemas derived from the Advanced registries (`@ws-model-proxy/config/pool-defaults`,
 * `runtime-defaults`). Inputs are partial: an absent key is left as is, `null` returns the
 * setting to automatic. Views carry `{effective, source}` per key.
 */
import {
  POOL_ADVANCED_COLUMNS,
  POOL_ADVANCED_OVERRIDES,
  type RegistryEntry,
} from "@ws-model-proxy/config/pool-defaults";
import { RUNTIME_ADVANCED, RUNTIME_LIMIT_COLUMNS } from "@ws-model-proxy/config/runtime-defaults";
import { z } from "zod";
import { VALUE_SOURCE } from "./common";

type FieldSchema<E> = E extends { kind: "bool" }
  ? z.ZodBoolean
  : E extends { kind: "enum"; values: readonly (infer V extends string)[] }
    ? z.ZodEnum<{ [K in V]: K }>
    : z.ZodNumber;

/** The zod schema of one registry entry (bounds included). */
export function registryValueSchema(
  entry: RegistryEntry,
): z.ZodBoolean | z.ZodNumber | z.ZodEnum<Record<string, string>> {
  switch (entry.kind) {
    case "bool":
      return z.boolean();
    case "enum":
      return z.enum(entry.values as readonly [string, ...string[]]);
    case "int":
      return z.number().int().min(entry.min).max(entry.max);
    case "number":
      return z.number().finite().min(entry.min).max(entry.max);
  }
}

type PatchShape<R extends Record<string, RegistryEntry>> = {
  [K in keyof R]: z.ZodOptional<z.ZodNullable<FieldSchema<R[K]>>>;
};
function patchShape<R extends Record<string, RegistryEntry>>(registry: R): PatchShape<R> {
  return Object.fromEntries(
    Object.entries(registry).map(([key, entry]) => [
      key,
      registryValueSchema(entry).nullable().optional(),
    ]),
  ) as PatchShape<R>;
}

type ViewShape<R extends Record<string, RegistryEntry>> = {
  [K in keyof R]: z.ZodObject<{
    effective: z.ZodNullable<FieldSchema<R[K]>>;
    source: z.ZodEnum<{ [S in (typeof VALUE_SOURCE)[number]]: S }>;
  }>;
};
function viewShape<R extends Record<string, RegistryEntry>>(registry: R): ViewShape<R> {
  return Object.fromEntries(
    Object.entries(registry).map(([key, entry]) => [
      key,
      z
        .object({ effective: registryValueSchema(entry).nullable(), source: z.enum(VALUE_SOURCE) })
        .strict(),
    ]),
  ) as ViewShape<R>;
}

// ── Pool ──

const { affinity, protection, ...poolFlat } = POOL_ADVANCED_OVERRIDES;

/** `PoolAdvanced.overrides` as stored (every key optional; absent = automatic). */
export const poolOverridesSchema = z
  .object({
    affinity: z.object(patchShape(affinity)).strict().optional(),
    protection: z.object(patchShape(protection)).strict().optional(),
    ...patchShape(poolFlat),
  })
  .strict();
export type PoolOverrides = z.infer<typeof poolOverridesSchema>;

export const poolAdvancedPatchSchema = z
  .object({
    ...patchShape(POOL_ADVANCED_COLUMNS),
    overrides: poolOverridesSchema.optional(),
  })
  .strict();

export const poolAdvancedViewSchema = z
  .object({
    ...viewShape(POOL_ADVANCED_COLUMNS),
    affinity: z.object(viewShape(affinity)).strict(),
    protection: z.object(viewShape(protection)).strict(),
    ...viewShape(poolFlat),
  })
  .strict();

// ── Runtime ──

export const runtimeLimitsPatchSchema = z.object(patchShape(RUNTIME_LIMIT_COLUMNS)).strict();
export const runtimeAdvancedPatchSchema = z.object(patchShape(RUNTIME_ADVANCED)).strict();
export const runtimeLimitsViewSchema = z.object(viewShape(RUNTIME_LIMIT_COLUMNS)).strict();
export const runtimeAdvancedViewSchema = z.object(viewShape(RUNTIME_ADVANCED)).strict();
