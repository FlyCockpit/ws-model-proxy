import { useTranslation } from "react-i18next";

import type { ChatTimingMetrics } from "./chat-test-types";

export function MetricsRow({ metrics }: { metrics: ChatTimingMetrics }) {
  const { t } = useTranslation(["dashboard"]);
  if (metrics.ttftMs === undefined) return null;
  return (
    <p className="mt-3 text-xs tabular-nums text-muted-foreground">
      {t("dashboard:chatTest.metrics.ttft", { value: (metrics.ttftMs / 1000).toFixed(2) })}
      <span aria-hidden="true"> · </span>
      {metrics.tokensPerSecond !== undefined
        ? t("dashboard:chatTest.metrics.tokensPerSecondShared", {
            value: metrics.tokensPerSecond.toFixed(1),
            count: metrics.completionTokens ?? 0,
          })
        : t("dashboard:chatTest.metrics.throughputUnavailable")}
    </p>
  );
}
