import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent } from "@ws-model-proxy/ui/components/card";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "@/components/access/confirm-action";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
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
const HOUR = 3_600_000;
/** "Since" and "older than" choices, newest boundary first. */
const RANGES = {
  "1h": HOUR,
  "24h": 24 * HOUR,
  "7d": 7 * 24 * HOUR,
  "30d": 30 * 24 * HOUR,
} as const;
type RangeKey = keyof typeof RANGES;
const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];
const isRange = (value: string): value is RangeKey => value in RANGES;

type Filters = {
  poolId: string;
  runtimeId: string;
  versionId: string;
  nodeId: string;
  /** The chosen range and the instant it was chosen at (a stable query key). */
  since: { range: RangeKey; iso: string } | null;
};
const NO_FILTERS: Filters = { poolId: "", runtimeId: "", versionId: "", nodeId: "", since: null };
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
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [clearOpen, setClearOpen] = useState(false);
  const [olderThan, setOlderThan] = useState<RangeKey>("30d");
  const [olderOpen, setOlderOpen] = useState(false);
  const requests = useInfiniteQuery(
    orpc.activity.requests.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
        ...(status !== "ALL" ? { status } : {}),
        ...(source !== "ALL" ? { source } : {}),
        ...(filters.poolId ? { poolId: filters.poolId } : {}),
        ...(filters.runtimeId ? { runtimeId: filters.runtimeId } : {}),
        ...(filters.versionId ? { versionId: filters.versionId } : {}),
        ...(filters.nodeId ? { nodeId: filters.nodeId } : {}),
        ...(filters.since ? { since: filters.since.iso } : {}),
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
  const deleteBefore = async (before: string) => {
    let total = 0;
    for (let batch = 0; batch < 100; batch += 1) {
      const { deleted } = await deleteBatch.mutateAsync({ before });
      total += deleted;
      if (deleted === 0) break;
    }
    return total;
  };
  const afterDelete = async (total: number) => {
    toast.success(t("activity:requests.cleared", { count: total }));
    await queryClient.invalidateQueries({ queryKey: orpc.activity.requests.list.key() });
  };
  const clear = useMutation({
    mutationFn: () => deleteBefore(new Date(Date.now() + 60_000).toISOString()),
    onSuccess: async (total) => {
      setClearOpen(false);
      await afterDelete(total);
    },
  });
  // Ranged delete: finished requests older than the chosen range (running ones always stay).
  const deleteOlder = useMutation({
    mutationFn: (range: RangeKey) =>
      deleteBefore(new Date(Date.now() - RANGES[range]).toISOString()),
    onSuccess: async (total) => {
      setOlderOpen(false);
      await afterDelete(total);
    },
  });
  const rows = requests.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <PageHeading page="activityRequests" />
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="requests-older-than">{t("activity:requests.olderThan")}</Label>
            <NativeSelect
              id="requests-older-than"
              value={olderThan}
              onChange={(event) => {
                if (isRange(event.target.value)) setOlderThan(event.target.value);
              }}
            >
              {RANGE_KEYS.map((range) => (
                <option key={range} value={range}>
                  {t(`activity:requests.range.${range}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button type="button" variant="outline" size="touch" onClick={() => setOlderOpen(true)}>
            {t("activity:requests.deleteOlder")}
          </Button>
          <Button type="button" variant="outline" size="touch" onClick={() => setClearOpen(true)}>
            {t("activity:requests.clear")}
          </Button>
        </div>
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
        <RequestFilters filters={filters} onChange={setFilters} />
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
      <ConfirmAction
        open={olderOpen}
        onOpenChange={setOlderOpen}
        title={t("activity:requests.deleteOlderTitle", {
          range: t(`activity:requests.range.${olderThan}`),
        })}
        description={t("activity:requests.deleteOlderDescription")}
        confirmLabel={t("activity:requests.deleteOlder")}
        isPending={deleteOlder.isPending}
        onConfirm={() => deleteOlder.mutate(olderThan)}
      />
    </div>
  );
}

/** Pool, runtime, version, node and since pickers (the list contract takes each). */
function RequestFilters({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  const { t } = useTranslation(["activity"]);
  const pools = useQuery({ ...orpc.pools.list.queryOptions(), retry: false });
  const runtimes = useQuery({ ...orpc.runtimes.list.queryOptions(), retry: false });
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), retry: false });
  const versions = useQuery({
    ...orpc.runtimes.versions.list.queryOptions({
      input: { runtimeId: filters.runtimeId, limit: 200 },
    }),
    enabled: filters.runtimeId !== "",
    retry: false,
  });
  const poolOptions = [
    ...(pools.data?.pools ?? []).map((pool) => ({
      id: pool.id,
      label: pool.callableIds[0] ?? pool.slug,
    })),
    ...(pools.data?.sharedWithMe ?? []).map((pool) => ({
      id: pool.poolId,
      label: pool.callableIds[0] ?? pool.poolId,
    })),
  ];
  const fields: Array<{
    key: "poolId" | "runtimeId" | "versionId" | "nodeId";
    options: Array<{ id: string; label: string }>;
    disabled?: boolean;
  }> = [
    { key: "poolId", options: poolOptions },
    {
      key: "runtimeId",
      options: (runtimes.data?.runtimes ?? []).map((runtime) => ({
        id: runtime.id,
        label: runtime.name,
      })),
    },
    {
      key: "versionId",
      disabled: filters.runtimeId === "",
      options: (versions.data?.items ?? []).map((version) => ({
        id: version.id,
        label: t("activity:requests.filter.versionNumber", { version: version.version }),
      })),
    },
    {
      key: "nodeId",
      options: (nodes.data?.nodes ?? []).map((node) => ({
        id: node.id,
        label: node.name ?? node.slug,
      })),
    },
  ];
  const active =
    filters.poolId || filters.runtimeId || filters.versionId || filters.nodeId || filters.since;
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {fields.map((field) => (
        <div key={field.key} className="min-w-0 space-y-1">
          <Label htmlFor={`requests-filter-${field.key}`} className="text-xs">
            {t(`activity:requests.filter.${field.key}`)}
          </Label>
          <NativeSelect
            id={`requests-filter-${field.key}`}
            value={filters[field.key]}
            disabled={field.disabled}
            onChange={(event) => {
              const value = event.target.value;
              // A version belongs to one runtime: a new runtime clears it.
              onChange(
                field.key === "runtimeId"
                  ? { ...filters, runtimeId: value, versionId: "" }
                  : { ...filters, [field.key]: value },
              );
            }}
          >
            <option value="">{t("activity:requests.all")}</option>
            {field.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      ))}
      <div className="min-w-0 space-y-1">
        <Label htmlFor="requests-filter-since" className="text-xs">
          {t("activity:requests.filter.since")}
        </Label>
        <NativeSelect
          id="requests-filter-since"
          value={filters.since?.range ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            onChange({
              ...filters,
              since: isRange(value)
                ? { range: value, iso: new Date(Date.now() - RANGES[value]).toISOString() }
                : null,
            });
          }}
        >
          <option value="">{t("activity:requests.filter.anyTime")}</option>
          {RANGE_KEYS.map((range) => (
            <option key={range} value={range}>
              {t(`activity:requests.sinceRange.${range}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {active ? (
        <Button
          type="button"
          variant="ghost"
          size="touch"
          className="justify-self-start sm:col-span-2 lg:col-span-5"
          onClick={() => onChange(NO_FILTERS)}
        >
          {t("activity:requests.filter.reset")}
        </Button>
      ) : null}
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
