import { useTranslation } from "react-i18next";

import type { TransformDebug } from "./chat-test-types";

export function TransformDebugPanel({ debug }: { debug: TransformDebug }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <details className="mt-3 rounded-md border border-border/70 bg-muted/30 p-2 text-xs">
      <summary className="flex min-h-11 cursor-pointer items-center font-medium">
        {t("dashboard:chatTest.transform.title")}
      </summary>
      <p className="mt-2 text-muted-foreground">
        {t("dashboard:chatTest.transform.summary", {
          model: debug.modelId,
          latency: (debug.latencyMs / 1000).toFixed(2),
          cache: debug.cacheHit
            ? t("dashboard:chatTest.transform.cacheHit")
            : t("dashboard:chatTest.transform.cacheMiss"),
          tools: debug.includePrimaryTools ? debug.toolCount : 0,
        })}
      </p>
      {debug.envelope ? (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
          {debug.envelope}
        </pre>
      ) : null}
    </details>
  );
}
