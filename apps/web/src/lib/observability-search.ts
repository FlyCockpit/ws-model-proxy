/**
 * Search-param contract for `/$lang/admin/observability`.
 *
 * Lives here rather than inline in the route so it can be unit tested against
 * the router's real search parser. Route files must not export anything.
 *
 * Defaults match the previous nuqs-backed UI:
 *   tab=clis, page=1, filter selects="all", free-text fields empty.
 *
 * TanStack Router JSON.parses search values, so `?page=1` arrives as the
 * number 1 — not the string "1".
 */

export type ObservabilityTab = "clis" | "endpoints" | "models" | "pools" | "relays";
export type CliStatus = "DISCONNECTED" | "CONNECTED" | "STALE" | "REVOKED";
export type EndpointStatus = "UNKNOWN" | "ONLINE" | "DEGRADED" | "OFFLINE";
export type CapabilityFamily = "TEXT" | "VISION" | "VIDEO" | "EMBEDDING" | "AUDIO" | "RESPONSES";
export type PoolHealth = "UNKNOWN" | "HEALTHY" | "HALF_OPEN" | "DEGRADED" | "UNHEALTHY";
export type RelayStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELED";

export const OBSERVABILITY_TABS: readonly ObservabilityTab[] = [
  "clis",
  "endpoints",
  "models",
  "pools",
  "relays",
] as const;

export const CLI_STATUSES: readonly CliStatus[] = [
  "CONNECTED",
  "STALE",
  "DISCONNECTED",
  "REVOKED",
] as const;

export const ENDPOINT_STATUSES: readonly EndpointStatus[] = [
  "ONLINE",
  "DEGRADED",
  "OFFLINE",
  "UNKNOWN",
] as const;

export const CAPABILITY_FAMILIES: readonly CapabilityFamily[] = [
  "TEXT",
  "VISION",
  "VIDEO",
  "EMBEDDING",
  "AUDIO",
  "RESPONSES",
] as const;

export const POOL_HEALTH_VALUES: readonly PoolHealth[] = [
  "HEALTHY",
  "HALF_OPEN",
  "DEGRADED",
  "UNHEALTHY",
  "UNKNOWN",
] as const;

export const RELAY_STATUSES: readonly RelayStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "PENDING",
  "CANCELED",
] as const;

export type ObservabilitySearch = {
  tab: ObservabilityTab;
  page: number;
  owner: string;
  cliStatus: "all" | CliStatus;
  endpointStatus: "all" | EndpointStatus;
  capability: "all" | CapabilityFamily;
  poolHealth: "all" | PoolHealth;
  relayStatus: "all" | RelayStatus;
  errorClass: string;
  createdAfter: string;
  createdBefore: string;
};

export const DEFAULT_OBSERVABILITY_SEARCH: ObservabilitySearch = {
  tab: "clis",
  page: 1,
  owner: "",
  cliStatus: "all",
  endpointStatus: "all",
  capability: "all",
  poolHealth: "all",
  relayStatus: "all",
  errorClass: "",
  createdAfter: "",
  createdBefore: "",
};

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function parsePage(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(1, parsed);
  }
  return DEFAULT_OBSERVABILITY_SEARCH.page;
}

function parseString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Accepts HTML date inputs (`YYYY-MM-DD`) only; anything else becomes empty. */
function parseDateInput(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

export function parseObservabilitySearch(search: Record<string, unknown>): ObservabilitySearch {
  return {
    tab: isOneOf(search.tab, OBSERVABILITY_TABS) ? search.tab : DEFAULT_OBSERVABILITY_SEARCH.tab,
    page: parsePage(search.page),
    owner: parseString(search.owner),
    cliStatus: isOneOf(search.cliStatus, CLI_STATUSES)
      ? search.cliStatus
      : DEFAULT_OBSERVABILITY_SEARCH.cliStatus,
    endpointStatus: isOneOf(search.endpointStatus, ENDPOINT_STATUSES)
      ? search.endpointStatus
      : DEFAULT_OBSERVABILITY_SEARCH.endpointStatus,
    capability: isOneOf(search.capability, CAPABILITY_FAMILIES)
      ? search.capability
      : DEFAULT_OBSERVABILITY_SEARCH.capability,
    poolHealth: isOneOf(search.poolHealth, POOL_HEALTH_VALUES)
      ? search.poolHealth
      : DEFAULT_OBSERVABILITY_SEARCH.poolHealth,
    relayStatus: isOneOf(search.relayStatus, RELAY_STATUSES)
      ? search.relayStatus
      : DEFAULT_OBSERVABILITY_SEARCH.relayStatus,
    errorClass: parseString(search.errorClass),
    createdAfter: parseDateInput(search.createdAfter),
    createdBefore: parseDateInput(search.createdBefore),
  };
}

export function dateInputToDate(value: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function dateInputToExclusiveEnd(value: string): Date | undefined {
  const date = dateInputToDate(value);
  if (!date) return undefined;
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

/** Coerce a Select value into a known filter enum, falling back to `"all"`. */
export function parseFilterSelect<T extends string>(
  value: string,
  allowed: readonly T[],
): "all" | T {
  if (value === "all") return "all";
  return isOneOf(value, allowed) ? value : "all";
}
