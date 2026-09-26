import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";

export type OverviewMetrics = Awaited<ReturnType<AppRouterClient["overview"]["metrics"]>>;
export type OverviewHealth = Awaited<ReturnType<AppRouterClient["overview"]["health"]>>;
export type OverviewStats = OverviewMetrics["totals"]["current"];
export type OverviewPool = OverviewMetrics["pools"][number];
export type OverviewMember = OverviewPool["members"][number];

export function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, {
    notation: value >= 100_000 ? "compact" : "standard",
  }).format(value);
}

export function formatPercent(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: value > 0 && value < 0.1 ? 1 : 0,
  }).format(value);
}

export function formatDuration(locale: string, ms: number): string {
  if (ms < 1000)
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "millisecond",
      unitDisplay: "narrow",
      maximumFractionDigits: 0,
    }).format(ms);
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "second",
    unitDisplay: "narrow",
    maximumFractionDigits: ms < 10_000 ? 1 : 0,
  }).format(ms / 1000);
}

export type DeltaKind = "count" | "rate" | "duration";

/**
 * Change versus the previous period. Counts and durations compare relatively
 * (null when the previous period had nothing to compare against); rates
 * compare in absolute percentage points.
 */
export function computeDelta(
  kind: DeltaKind,
  current: number | null,
  previous: number | null,
): { direction: "up" | "down" | "flat"; magnitude: number; unit: "relative" | "points" } | null {
  if (current === null || previous === null) return null;
  if (kind === "rate") {
    const points = current - previous;
    if (Math.abs(points) < 0.0005) return { direction: "flat", magnitude: 0, unit: "points" };
    return { direction: points > 0 ? "up" : "down", magnitude: Math.abs(points), unit: "points" };
  }
  if (previous === 0) return null;
  const relative = (current - previous) / previous;
  if (Math.abs(relative) < 0.005) return { direction: "flat", magnitude: 0, unit: "relative" };
  return {
    direction: relative > 0 ? "up" : "down",
    magnitude: Math.abs(relative),
    unit: "relative",
  };
}

/**
 * Formats a delta's magnitude. Percentage points need a localized unit, so
 * the caller supplies it from the locale bundle (`overview.kpi.deltaPoints`).
 */
export function formatDeltaMagnitude(
  locale: string,
  delta: NonNullable<ReturnType<typeof computeDelta>>,
  formatPoints: (value: string) => string,
): string {
  if (delta.unit === "points")
    return formatPoints(
      new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(delta.magnitude * 100),
    );
  return formatPercent(locale, delta.magnitude);
}

/** Chart series slots. Colours follow the member's configured position. */
export const CHART_SERIES_SLOTS = 8;

export type ChartSeries = { key: string; seriesKeys: string[]; colorSlot: number };

/**
 * Maps pool members onto at most 8 chart series: the first 7 members keep
 * their own slot and anything beyond folds into one "other" series so the
 * palette never repeats a colour for two different members.
 */
export function chartSeriesForMembers(members: readonly OverviewMember[]): ChartSeries[] {
  if (members.length <= CHART_SERIES_SLOTS)
    return members.map((member, index) => ({
      key: `s${index}`,
      seriesKeys: [member.seriesKey],
      colorSlot: index + 1,
    }));
  const head = members.slice(0, CHART_SERIES_SLOTS - 1).map((member, index) => ({
    key: `s${index}`,
    seriesKeys: [member.seriesKey],
    colorSlot: index + 1,
  }));
  return [
    ...head,
    {
      key: "other",
      seriesKeys: members.slice(CHART_SERIES_SLOTS - 1).map((member) => member.seriesKey),
      colorSlot: CHART_SERIES_SLOTS,
    },
  ];
}

export function chartRows(
  pool: OverviewPool,
  series: readonly ChartSeries[],
): Array<Record<string, number | string>> {
  return pool.series.map((bucket) => {
    const row: Record<string, number | string> = { bucketStart: bucket.bucketStart };
    for (const entry of series) {
      row[entry.key] = entry.seriesKeys.reduce(
        (sum, seriesKey) => sum + (bucket.values[seriesKey] ?? 0),
        0,
      );
    }
    return row;
  });
}
