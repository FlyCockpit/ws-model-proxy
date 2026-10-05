import { cn } from "@ws-model-proxy/ui/lib/utils";

/** A minimal trend line; the accessible label carries the meaning, not the shape alone. */
export function Sparkline({
  values,
  label,
  className,
}: {
  values: readonly number[];
  label: string;
  className?: string;
}) {
  const width = 120;
  const height = 32;
  const max = Math.max(0, ...values);
  const points =
    values.length > 1
      ? values
          .map((value, index) => {
            const x = (index / (values.length - 1)) * width;
            const y = max > 0 ? height - 2 - (value / max) * (height - 4) : height - 2;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : "";
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-8 w-full text-primary", className)}
    >
      {points ? (
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <line
          x1={0}
          x2={width}
          y1={height - 2}
          y2={height - 2}
          stroke="currentColor"
          strokeOpacity={0.3}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
