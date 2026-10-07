import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent } from "@ws-model-proxy/ui/components/card";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "@/components/access/confirm-action";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/activity/requests")({
  component: ActivityRequestsPage,
});

const STATUSES = ["ALL", "PENDING", "SUCCEEDED", "FAILED", "CANCELED"] as const;
const SOURCES = ["ALL", "API_KEY", "TEST", "AGENT_TEST", "SIDECAR"] as const;
type StatusFilter = (typeof STATUSES)[number];
type SourceFilter = (typeof SOURCES)[number];
const PAGE = 50;
const KNOWN_REASONS = new Set([
  "over_capacity",
  "wait_expired",
  "context_too_large",
  "no_member",
  "cloud_cap_reached",
  "unauthorized_external",
]);

type RequestRow = {
  id: string;
  createdAt: string;
  source: Exclude<SourceFilter, "ALL">;
  status: Exclude<StatusFilter, "ALL">;
  callableId: string | null;
  operation: string | null;
  route: "local" | "cloud" | "own_key" | null;
  queueWaitMs: number | null;
  ttftMs: number | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  rejection: string | null;
  errorClass: string | null;
  upstreamError: string | null;
  httpStatusCode: number | null;
  attempts: number;
};

function ActivityRequestsPage() {
  const { t } = useTranslation(["activity"]);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [source, setSource] = useState<SourceFilter>("ALL");
  const [clearOpen, setClearOpen] = useState(false);
  const requests = useInfiniteQuery(
    orpc.activity.requests.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
        ...(status !== "ALL" ? { status } : {}),
        ...(source !== "ALL" ? { source } : {}),
      }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const deleteBatch = useMutation(orpc.activity.requests.delete.mutationOptions());
  // The server deletes in bounded batches and skips rows a finalizer holds (a batch can come
  // back short while more remain), so keep going until a batch deletes nothing.
  // `before` runs a minute ahead so a slow browser clock still covers finished rows (running
  // ones are never deleted).
  const clear = useMutation({
    mutationFn: async () => {
      const before = new Date(Date.now() + 60_000).toISOString();
      let total = 0;
      for (let batch = 0; batch < 100; batch += 1) {
        const { deleted } = await deleteBatch.mutateAsync({ before });
        total += deleted;
        if (deleted === 0) break;
      }
      return total;
    },
    onSuccess: async (total) => {
      setClearOpen(false);
      toast.success(t("activity:requests.cleared", { count: total }));
      await queryClient.invalidateQueries({ queryKey: orpc.activity.requests.list.key() });
    },
  });
  const rows = requests.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <PageHeading page="activityRequests" />
        <Button type="button" variant="outline" size="touch" onClick={() => setClearOpen(true)}>
          {t("activity:requests.clear")}
        </Button>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <SegmentedControl
          value={status}
          onChange={setStatus}
          ariaLabel={t("activity:requests.status")}
          items={STATUSES.map((value) => ({
            value,
            label:
              value === "ALL"
                ? t("activity:requests.all")
                : t(`activity:requests.statusValue.${value}`),
          }))}
        />
        <SegmentedControl
          value={source}
          onChange={setSource}
          ariaLabel={t("activity:requests.source")}
          items={SOURCES.map((value) => ({
            value,
            label:
              value === "ALL"
                ? t("activity:requests.all")
                : t(`activity:requests.sourceValue.${value}`),
          }))}
        />
      </div>
      {requests.isPending ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((key) => (
            <Skeleton key={key} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : requests.isError ? (
        <InlineRetry
          message={t("activity:requests.loadFailed")}
          onRetry={() => requests.refetch()}
        />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            {t("activity:requests.empty")}
          </CardContent>
        </Card>
      ) : (
        <>
          <ul className="flex min-w-0 flex-col gap-2">
            {rows.map((row) => (
              <li key={row.id}>
                <RequestCard row={row} />
              </li>
            ))}
          </ul>
          {requests.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="self-center"
              disabled={requests.isFetchingNextPage}
              onClick={() => void requests.fetchNextPage()}
            >
              {t("activity:requests.loadMore")}
            </Button>
          ) : null}
        </>
      )}
      <ConfirmAction
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={t("activity:requests.clearTitle")}
        description={t("activity:requests.clearDescription")}
        confirmLabel={t("activity:requests.clear")}
        isPending={clear.isPending}
        onConfirm={() => clear.mutate()}
      />
    </div>
  );
}

const STATUS_TONE: Record<RequestRow["status"], string> = {
  PENDING: "text-sky-700 dark:text-sky-400",
  SUCCEEDED: "text-emerald-700 dark:text-emerald-400",
  FAILED: "text-destructive",
  CANCELED: "text-muted-foreground",
};

function RequestCard({ row }: { row: RequestRow }) {
  const { t } = useTranslation(["activity"]);
  const facts = [
    row.route ? t(`activity:requests.routeValue.${row.route}`) : null,
    row.queueWaitMs ? t("activity:requests.queueWait", { ms: row.queueWaitMs }) : null,
    row.ttftMs !== null ? t("activity:requests.ttft", { ms: row.ttftMs }) : null,
    row.durationMs !== null ? t("activity:requests.duration", { ms: row.durationMs }) : null,
    row.promptTokens !== null || row.completionTokens !== null
      ? t("activity:requests.tokens", {
          prompt: row.promptTokens ?? 0,
          completion: row.completionTokens ?? 0,
        })
      : null,
    row.attempts > 1 ? t("activity:requests.attempts", { count: row.attempts }) : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <Card size="sm">
      <CardContent className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 break-all font-mono text-sm">
            {row.callableId ?? t("activity:requests.direct")}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            <TimeAgo value={row.createdAt} />
          </span>
        </div>
        <p className="text-xs">
          <span className={cn("font-medium", STATUS_TONE[row.status])}>
            {t(`activity:requests.statusValue.${row.status}`)}
            {row.httpStatusCode ? ` ${row.httpStatusCode}` : ""}
          </span>
          <span className="text-muted-foreground">
            {" · "}
            {t(`activity:requests.sourceValue.${row.source}`)}
            {row.operation ? ` · ${row.operation}` : ""}
          </span>
        </p>
        {facts.length > 0 ? (
          <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>
        ) : null}
        {row.rejection ? (
          <p className="break-all text-xs text-destructive">
            {t("activity:requests.rejection", {
              reason: KNOWN_REASONS.has(row.rejection)
                ? t(`activity:requests.reason.${row.rejection}`)
                : t("activity:requests.reason.other", { code: row.rejection }),
            })}
          </p>
        ) : row.errorClass ? (
          <p className="break-all text-xs text-destructive">
            {t("activity:requests.error", { reason: row.errorClass })}
          </p>
        ) : null}
        {row.upstreamError ? (
          <p className="break-words text-xs text-muted-foreground">
            {t("activity:requests.upstreamError", { message: row.upstreamError })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
