import { type ChartConfig, ChartContainer } from "@ws-model-proxy/ui/components/chart";
import { Area, ComposedChart, Line, ReferenceLine, YAxis } from "recharts";

export const ENGINE_LOAD_SPARKLINE_HEIGHT_PX = 96;

export type EngineLoadSparklinePoint = {
  start: Date | string;
  running: number | null;
  waiting: number | null;
  kvUsage: number | null;
  kvOccupancy: number | null;
  gap: boolean;
};

export function EngineLoadSparkline({
  series,
  threshold,
  caption,
  labels,
}: {
  series: readonly EngineLoadSparklinePoint[];
  threshold: number;
  caption: string;
  labels: {
    running: string;
    waiting: string;
    kvUsage: string;
    kvOccupancy: string;
    threshold: string;
  };
}) {
  const rows = series.map((point) => ({
    start: typeof point.start === "string" ? point.start : point.start.toISOString(),
    running: point.gap ? null : point.running,
    waiting: point.gap ? null : point.waiting,
    kvUsage: point.gap ? null : point.kvUsage,
    kvOccupancy: point.gap ? null : point.kvOccupancy,
    threshold,
  }));
  const config: ChartConfig = {
    running: { label: labels.running, color: "var(--chart-1)" },
    waiting: { label: labels.waiting, color: "var(--chart-2)" },
    kvUsage: { label: labels.kvUsage, color: "var(--chart-3)" },
    kvOccupancy: { label: labels.kvOccupancy, color: "var(--chart-4)" },
    threshold: { label: labels.threshold, color: "var(--chart-5)" },
  };
  return (
    <figure className="m-0 min-w-0 max-w-full">
      <figcaption className="sr-only">{caption}</figcaption>
      <div
        className="min-w-0 max-w-full overflow-x-hidden"
        data-testid="engine-load-sparkline"
        data-threshold={String(threshold)}
      >
        <ChartContainer
          config={config}
          className="aspect-auto w-full min-w-0"
          style={{ height: ENGINE_LOAD_SPARKLINE_HEIGHT_PX }}
          initialDimension={{ width: 640, height: ENGINE_LOAD_SPARKLINE_HEIGHT_PX }}
        >
          <ComposedChart data={rows} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
            <YAxis yAxisId="count" hide />
            <YAxis yAxisId="frac" domain={[0, 1]} hide />
            <Area
              yAxisId="count"
              type="monotone"
              dataKey="running"
              stackId="load"
              stroke="var(--color-running)"
              fill="var(--color-running)"
              fillOpacity={0.35}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Area
              yAxisId="count"
              type="monotone"
              dataKey="waiting"
              stackId="load"
              stroke="var(--color-waiting)"
              fill="var(--color-waiting)"
              fillOpacity={0.35}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              yAxisId="frac"
              type="monotone"
              dataKey="kvUsage"
              stroke="var(--color-kvUsage)"
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              yAxisId="frac"
              type="monotone"
              dataKey="kvOccupancy"
              stroke="var(--color-kvOccupancy)"
              strokeOpacity={0.4}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            <ReferenceLine
              yAxisId="frac"
              y={threshold}
              stroke="var(--color-threshold)"
              strokeDasharray="4 4"
            />
          </ComposedChart>
        </ChartContainer>
      </div>
    </figure>
  );
}
