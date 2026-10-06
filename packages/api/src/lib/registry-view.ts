/**
 * `{effective, source}` views of the Advanced registries (`pool-defaults.ts`,
 * `runtime-defaults.ts`) and the matching patch application. One place decides what
 * "automatic" means so the pool and runtime views agree.
 */
import type { RegistryEntry } from "@ws-model-proxy/config/pool-defaults";

export type RegistryValue = number | boolean | string;
export type EffectiveValue = {
  effective: RegistryValue | null;
  source: "override" | "auto" | "default";
};

/**
 * One key: an override wins; otherwise a computed value (engine fact, derived) is `auto`
 * (null while unknown), and a fixed default is `default`.
 */
export function effectiveEntry(
  entry: RegistryEntry,
  override: unknown,
  observed: RegistryValue | null = null,
): EffectiveValue {
  if (override !== undefined && override !== null && isRegistryValue(override))
    return { effective: override, source: "override" };
  if ("default" in entry.auto) return { effective: entry.auto.default, source: "default" };
  return { effective: observed, source: "auto" };
}

function isRegistryValue(value: unknown): value is RegistryValue {
  return typeof value === "number" || typeof value === "boolean" || typeof value === "string";
}

/** Views every key of a flat registry. */
export function registryView<R extends Record<string, RegistryEntry>>(
  registry: R,
  overrides: Record<string, unknown>,
  observed: Partial<Record<keyof R, RegistryValue | null>> = {},
): { [K in keyof R]: EffectiveValue } {
  return Object.fromEntries(
    Object.entries(registry).map(([key, entry]) => [
      key,
      effectiveEntry(entry, overrides[key], observed[key] ?? null),
    ]),
  ) as { [K in keyof R]: EffectiveValue };
}

/** A plain JSON object, or `{}` for anything else (stored JSON is validated on write). */
export function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Applies a patch (`undefined` = keep, `null` = back to automatic, value = override) to a stored
 * JSON object. Absent keys are automatic, so `null` deletes the key.
 */
export function applyJsonPatch(
  stored: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!patch) return { ...stored };
  const next: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}
