import type { Metric } from "@ws-model-proxy/api/contracts/metrics";
import { type ChartConfig, ChartContainer } from "@ws-model-proxy/ui/components/chart";
import { useTranslation } from "react-i18next";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- this module is the lazy chunk: metrics-results.tsx imports it with React.lazy
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

import {
  colorOf,
  type MetricsColumn,
  PALETTE_SIZE,
  useMetricFormatter,
  useMetricLabel,
  useTimeFormatter,
} from "@/components/activity/metrics-results";
import { WideContent } from "@/components/wide-content";
import type { ChartRow, MetricStep } from "@/lib/activity-metrics";

/**
 * The metrics line chart. Loaded lazily through `MetricsChart` in metrics-results.tsx, so
 * Recharts reaches the browser only when a chart is shown.
 */
export function MetricsChart({
  rows,
  columns,
  metric,
  step,
}: {
  rows: readonly ChartRow[];
  columns: readonly MetricsColumn[];
  metric: Metric;
  step: MetricStep;
}) {
  const { t } = useTranslation(["activity"]);
  const label = useMetricLabel();
  const formatValue = useMetricFormatter();
  const formatTime = useTimeFormatter(step);
  const config: ChartConfig = Object.fromEntries(
    columns.map((column, index) => [column.key, { label: column.label, color: colorOf(index) }]),
  );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <WideContent>
        <ChartContainer
          config={config}
          role="img"
          aria-label={t("activity:metrics.chartLabel", {
            metric: label(metric),
            count: columns.length,
          })}
          className="aspect-auto h-64 w-full min-w-[480px] sm:h-80"
        >
          <LineChart
            data={[...rows]}
            // The table view is the accessible form; the chart stays an image.
            accessibilityLayer={false}
            margin={{ top: 8, right: 12, bottom: 0, left: 4 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={formatTime}
              tickLine={false}
              axisLine={false}
              minTickGap={32}
            />
            <YAxis
              tickFormatter={(value: number) => formatValue(metric, value)}
              tickLine={false}
              axisLine={false}
              width={72}
            />
            <Tooltip
              labelFormatter={(time) => (typeof time === "number" ? formatTime(time) : "")}
              formatter={(value, name) => [
                typeof value === "number" ? formatValue(metric, value) : "—",
                columns.find((column) => column.key === name)?.label ?? String(name),
              ]}
              contentStyle={{
                background: "var(--popover)",
                color: "var(--popover-foreground)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
              }}
            />
            {columns.map((column, index) => (
              <Line
                key={column.key}
                dataKey={column.key}
                name={column.key}
                type="monotone"
                stroke={`var(--color-${column.key})`}
                strokeDasharray={index >= PALETTE_SIZE ? "4 3" : undefined}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      </WideContent>
      {columns.length > 1 ? (
        <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs" aria-hidden="true">
          {columns.map((column, index) => (
            <li key={column.key} className="flex min-w-0 items-center gap-1.5">
              <svg viewBox="0 0 16 4" className="h-1 w-4 shrink-0" aria-hidden="true">
                <line
                  x1={0}
                  x2={16}
                  y1={2}
                  y2={2}
                  stroke={colorOf(index)}
                  strokeWidth={4}
                  strokeDasharray={index >= PALETTE_SIZE ? "4 3" : undefined}
                />
              </svg>
              <span className="min-w-0 break-all">{column.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The chart's values as a table: buckets with any value, one column per series. */
