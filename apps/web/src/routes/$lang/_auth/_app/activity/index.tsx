import { skipToken, type UseQueryResult, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  type GroupBy,
  METRIC_SCOPES,
  type Metric,
  type MetricScope,
  metricFamily,
} from "@ws-model-proxy/api/contracts/metrics";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Card, CardContent } from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { ArrowRight } from "lucide-react";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";

import {
  MetricsChart,
  type MetricsColumn,
  MetricsTable,
  MetricsTotals,
  useMetricLabel,
} from "@/components/activity/metrics-results";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
import {
  type ActivityMetricsSearch,
  bucketCount,
  chartRows,
  defaultStep,
  groupByOptions,
  isCustomMetric,
  METRIC_GROUPS,
  type MetricRange,
  type MetricStep,
  type MetricsView,
  parseActivityMetricsSearch,
  rangesFor,
  stepsFor,
  summaryMetrics,
} from "@/lib/activity-metrics";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/activity/")({
  validateSearch: parseActivityMetricsSearch,
  component: ActivityMetricsPage,
});

type Target = { id: string; label: string };

/** Search params left out when they hold their default, so shared links stay short. */
function compact(search: ActivityMetricsSearch): ActivityMetricsSearch {
  return Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined && value !== false),
  ) as ActivityMetricsSearch;
}

function ActivityMetricsPage() {
  const { lang } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { t } = useTranslation(["activity"]);
  const metricLabel = useMetricLabel();
  const update = (patch: Partial<ActivityMetricsSearch>) =>
    void navigate({
      search: (prev) => compact({ ...prev, ...patch }),
      replace: true,
      resetScroll: false,
    });

  const scope: MetricScope = search.scope ?? "pool";
  const targets = useScopeTargets(scope, search.runtime);
  const selection = resolveSelection(search, scope, targets);
  const { metric, step, range, groupBy } = selection;

  const totalsMetrics = summaryMetrics(metric);
  const base = metricsBase(selection);
  // Ungrouped, the totals query also carries the chart's series (one request).
  const totals = useQuery({
    ...orpc.activity.metrics.query.queryOptions({
      input: base ? { ...base, metrics: totalsMetrics } : skipToken,
    }),
    // The page shows its own retry.
    meta: { skipGlobalErrorToast: true },
  });
  const series = useQuery({
    ...orpc.activity.metrics.query.queryOptions({
      input: seriesInput(base, metric, groupBy, totalsMetrics),
    }),
    meta: { skipGlobalErrorToast: true },
  });

  const columns: MetricsColumn[] = (series.data?.series ?? []).map((one, index) => ({
    key: `s${index}`,
    label: one.group
      ? (one.group.label ??
        (one.group.key === ""
          ? t("activity:metrics.noGroup")
          : groupBy === "source"
            ? t(`activity:requests.sourceValue.${one.group.key}`, { defaultValue: one.group.key })
            : one.group.key))
      : metricLabel(metric),
  }));
  const rows = series.data
    ? chartRows(series.data.series, metric, series.data.start, step, bucketCount(range, step))
    : [];
  const hasData = series.data?.series.some((one) => one.at.length > 0) ?? false;
  const tests = totals.data?.totals.tests ?? 0;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <PageHeading page="activity" />
        <RequestLogLink lang={lang} />
      </div>

      <MetricsControls selection={selection} targets={targets} onUpdate={update} />

      <MetricsResults
        lang={lang}
        selection={selection}
        targets={targets}
        totals={totals}
        series={series}
        loaded={{
          totalsMetrics,
          columns,
          rows,
          hasData,
          tests,
          title: metricLabel(metric),
        }}
        onUpdate={update}
      />
    </div>
  );
}

type UpdateSearch = (patch: Partial<ActivityMetricsSearch>) => void;

type Targets = ReturnType<typeof useScopeTargets>;

type MetricsAnswer = Awaited<ReturnType<AppRouterClient["activity"]["metrics"]["query"]>>;

type MetricsQuery = UseQueryResult<MetricsAnswer, Error>;

/** What the URL asks for, narrowed to what the scope's target and metric allow. */
type MetricsSelection = {
  scope: MetricScope;
  targetId: string | undefined;
  sharedPool: boolean;
  metric: Metric;
  family: ReturnType<typeof metricFamily>;
  ranges: MetricRange[];
  range: MetricRange;
  steps: MetricStep[];
  step: MetricStep;
  groupOptions: GroupBy[];
  groupBy: GroupBy | undefined;
  includeTests: boolean;
  view: MetricsView;
};

/**
 * Wait for the scope's list: it says whether a pool is shared (request metrics only) and
 * whether a linked target still exists. Instances drop off the list once stopped, so a linked
 * instance is kept; a pool, runtime, version or node that is gone falls back to the first.
 */
function resolveTargetId(
  scope: MetricScope,
  wanted: string | undefined,
  items: Target[] | undefined,
): string | undefined {
  if (items === undefined) return undefined;
  return wanted && (scope === "instance" || items.some((item) => item.id === wanted))
    ? wanted
    : items[0]?.id;
}

function resolveRange(wanted: MetricRange | undefined, ranges: MetricRange[]): MetricRange {
  if (wanted && ranges.includes(wanted)) return wanted;
  return ranges.includes("24h") ? "24h" : (ranges[0] ?? "1h");
}

function resolveSelection(
  search: ActivityMetricsSearch,
  scope: MetricScope,
  targets: Targets,
): MetricsSelection {
  const metricWanted: Metric = search.metric ?? "requests";
  const targetId = resolveTargetId(scope, search.id, targets.items);
  const sharedPool = scope === "pool" && targetId !== undefined && targets.shared.has(targetId);
  // A pool shared with you has request metrics only.
  const metric: Metric =
    sharedPool && metricFamily(metricWanted) !== "request" ? "requests" : metricWanted;
  const family = metricFamily(metric);
  const ranges = rangesFor(metric);
  const range = resolveRange(search.range, ranges);
  const steps = stepsFor(range, metric);
  const step: MetricStep =
    search.step && steps.includes(search.step) ? search.step : defaultStep(range, metric);
  const groupOptions = groupByOptions(scope, metric, sharedPool);
  const groupBy: GroupBy | undefined =
    search.groupBy && groupOptions.includes(search.groupBy) ? search.groupBy : undefined;
  return {
    scope,
    targetId,
    sharedPool,
    metric,
    family,
    ranges,
    range,
    steps,
    step,
    groupOptions,
    groupBy,
    includeTests: family === "request" && search.tests === true,
    view: search.view ?? "chart",
  };
}

function metricsBase(selection: MetricsSelection) {
  const { scope, targetId, range, step, includeTests } = selection;
  return targetId
    ? {
        scope: scopeInput(scope, targetId),
        range,
        step,
        includeTests,
      }
    : null;
}

function seriesInput(
  base: ReturnType<typeof metricsBase>,
  metric: Metric,
  groupBy: GroupBy | undefined,
  totalsMetrics: Metric[],
) {
  if (!base) return skipToken;
  return groupBy ? { ...base, metrics: [metric], groupBy } : { ...base, metrics: totalsMetrics };
}

function isRuntimeChildScope(scope: MetricScope): boolean {
  return scope === "version" || scope === "instance";
}

function MetricsControls({
  selection,
  targets,
  onUpdate: update,
}: {
  selection: MetricsSelection;
  targets: Targets;
  onUpdate: UpdateSearch;
}) {
  const { t } = useTranslation(["activity"]);
  const { scope, targetId, metric, sharedPool, groupBy, groupOptions, ranges, range, steps, step } =
    selection;
  return (
    <Card>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <Field label={t("activity:metrics.scope")}>
          <SegmentedControl
            value={scope}
            onChange={(next) =>
              update({ scope: next, id: undefined, runtime: undefined, groupBy: undefined })
            }
            ariaLabel={t("activity:metrics.scope")}
            items={METRIC_SCOPES.map((value) => ({
              value,
              label: t(`activity:metrics.scopeValue.${value}`),
            }))}
          />
        </Field>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {isRuntimeChildScope(scope) ? (
            <TargetSelect
              label={t("activity:metrics.runtimeOf")}
              items={targets.runtimes}
              value={targets.runtimeId}
              loading={targets.runtimesLoading}
              failed={targets.runtimesFailed}
              empty={t("activity:metrics.noTargets.runtime")}
              onChange={(runtime) => update({ runtime, id: undefined })}
            />
          ) : null}
          <TargetSelect
            label={t(`activity:metrics.scopeValue.${scope}`)}
            items={targets.items}
            value={targetId}
            loading={targets.loading}
            failed={targets.failed}
            empty={t(`activity:metrics.noTargets.${scope}`)}
            onChange={(id) => update({ id })}
          />
          <MetricSelect
            value={metric}
            sharedPool={sharedPool}
            onChange={(next) => update({ metric: next })}
          />
          <GroupBySelect
            value={groupBy}
            options={groupOptions}
            onChange={(next) => update({ groupBy: next })}
          />
        </div>
        <div className="flex min-w-0 flex-wrap gap-4">
          <Field label={t("activity:metrics.range")}>
            <SegmentedControl
              value={range}
              onChange={(next) => update({ range: next, step: undefined })}
              ariaLabel={t("activity:metrics.range")}
              items={ranges.map((value) => ({
                value,
                label: t(`activity:metrics.rangeValue.${value}`),
              }))}
            />
          </Field>
          <Field label={t("activity:metrics.step")}>
            <SegmentedControl
              value={step}
              onChange={(next) => update({ step: next })}
              ariaLabel={t("activity:metrics.step")}
              items={steps.map((value) => ({
                value,
                label: t(`activity:metrics.stepValue.${value}`),
              }))}
            />
          </Field>
        </div>
        <MetricsSwitches selection={selection} onUpdate={update} />
        {sharedPool ? (
          <p className="text-xs text-muted-foreground">{t("activity:metrics.sharedPool")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MetricsSwitches({
  selection,
  onUpdate: update,
}: {
  selection: MetricsSelection;
  onUpdate: UpdateSearch;
}) {
  const { t } = useTranslation(["activity"]);
  const { scope, groupOptions, groupBy, family, includeTests } = selection;
  return (
    <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-1">
      {scope === "runtime" && groupOptions.includes("version") ? (
        <SwitchRow
          label={t("activity:metrics.compareVersions")}
          checked={groupBy === "version"}
          onChange={(checked) => update({ groupBy: checked ? "version" : undefined })}
        />
      ) : null}
      {family === "request" ? (
        <SwitchRow
          label={t("activity:metrics.includeTests")}
          checked={includeTests}
          onChange={(checked) => update({ tests: checked || undefined })}
        />
      ) : null}
    </div>
  );
}

/** What the loaded results show, worked out by the page from the two queries. */
type LoadedResults = {
  totalsMetrics: Metric[];
  columns: MetricsColumn[];
  rows: ReturnType<typeof chartRows>;
  hasData: boolean;
  tests: number;
  title: string;
};

function MetricsResults({
  lang,
  selection,
  targets,
  totals,
  series,
  loaded,
  onUpdate: update,
}: {
  lang: string;
  selection: MetricsSelection;
  targets: Targets;
  totals: MetricsQuery;
  series: MetricsQuery;
  loaded: LoadedResults;
  onUpdate: UpdateSearch;
}) {
  const { t } = useTranslation(["activity"]);
  if (!selection.targetId) {
    return <NoTargetResults lang={lang} scope={selection.scope} targets={targets} />;
  }
  if (totals.isPending || series.isPending) return <ResultsSkeleton />;
  if (series.isError || totals.isError) {
    return (
      <InlineRetry
        message={t("activity:metrics.loadFailed")}
        onRetry={() => {
          void totals.refetch();
          void series.refetch();
        }}
      />
    );
  }
  return (
    <MetricsLoaded
      lang={lang}
      selection={selection}
      totals={totals.data.totals}
      truncated={series.data.truncated}
      loaded={loaded}
      onUpdate={update}
    />
  );
}

function NoTargetResults({
  lang,
  scope,
  targets,
}: {
  lang: string;
  scope: MetricScope;
  targets: Targets;
}) {
  const { t } = useTranslation(["activity"]);
  if (targets.loading) return <ResultsSkeleton />;
  if (targets.failed) {
    return <InlineRetry message={t("activity:metrics.targetsFailed")} onRetry={targets.retry} />;
  }
  return (
    <EmptyCard
      lang={lang}
      message={t(
        isRuntimeChildScope(scope) && targets.runtimes?.length === 0
          ? "activity:metrics.noTargets.runtime"
          : `activity:metrics.noTargets.${scope}`,
      )}
    />
  );
}

function MetricsLoaded({
  lang,
  selection,
  totals,
  truncated,
  loaded,
  onUpdate: update,
}: {
  lang: string;
  selection: MetricsSelection;
  totals: MetricsAnswer["totals"];
  truncated: MetricsAnswer["truncated"];
  loaded: LoadedResults;
  onUpdate: UpdateSearch;
}) {
  const { t } = useTranslation(["activity"]);
  const { metric, step, view, includeTests } = selection;
  const { totalsMetrics, columns, rows, hasData, tests, title } = loaded;
  return (
    <>
      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="metrics-totals">
        <h2 id="metrics-totals" className="text-base font-semibold">
          {t("activity:metrics.totals")}
        </h2>
        <MetricsTotals metrics={totalsMetrics} totals={totals} />
        {tests > 0 && !includeTests ? (
          <p className="text-xs text-muted-foreground">
            {t("activity:metrics.testsLeftOut", { count: tests })}
          </p>
        ) : null}
      </section>
      {hasData ? (
        <Card>
          <CardContent className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">{title}</h2>
              <SegmentedControl
                value={view}
                onChange={(next) => update({ view: next === "chart" ? undefined : next })}
                ariaLabel={t("activity:metrics.view")}
                items={[
                  { value: "chart", label: t("activity:metrics.viewValue.chart") },
                  { value: "table", label: t("activity:metrics.viewValue.table") },
                ]}
              />
            </div>
            {truncated ? (
              <p className="text-xs text-muted-foreground">{t("activity:metrics.truncated")}</p>
            ) : null}
            {view === "table" ? (
              <MetricsTable rows={rows} columns={columns} metric={metric} step={step} />
            ) : (
              <MetricsChart rows={rows} columns={columns} metric={metric} step={step} />
            )}
          </CardContent>
        </Card>
      ) : (
        <EmptyCard lang={lang} message={t("activity:metrics.empty")} />
      )}
    </>
  );
}

function scopeInput(scope: MetricScope, id: string) {
  switch (scope) {
    case "pool":
      return { pool: id };
    case "runtime":
      return { runtime: id };
    case "version":
      return { version: id };
    case "node":
      return { node: id };
    case "instance":
      return { instance: id };
  }
}

type ListQuery<T> = { data: T | undefined; isError: boolean; refetch: () => Promise<unknown> };

type PoolsList = {
  pools: Array<{ id: string; slug: string; callableIds: string[] }>;
  sharedWithMe: Array<{ poolId: string; callableIds: string[] }>;
};

type ScopeLists = {
  pools: ListQuery<PoolsList>;
  runtimes: ListQuery<unknown>;
  versions: ListQuery<{ items: Array<{ id: string; version: number }> }>;
  runtime: ListQuery<{
    instanceList: Array<{ id: string; handle: string; versionNumber: number }>;
  }>;
  nodes: ListQuery<{ nodes: Array<{ id: string; slug: string }> }>;
};

function runtimeTargets(
  data: { runtimes: Array<{ id: string; slug: string; service: unknown }> } | undefined,
): Target[] | undefined {
  return data?.runtimes
    .filter((runtime) => !runtime.service)
    .map((runtime) => ({ id: runtime.id, label: runtime.slug }));
}

function pickRuntimeId(
  runtimeItems: Target[] | undefined,
  runtimeWanted: string | undefined,
): string | undefined {
  return runtimeWanted && runtimeItems?.some((item) => item.id === runtimeWanted)
    ? runtimeWanted
    : runtimeItems?.[0]?.id;
}

function poolTargets(data: PoolsList | undefined): Target[] | undefined {
  return data
    ? [
        ...data.pools.map((pool) => ({
          id: pool.id,
          label: pool.callableIds[0] ?? pool.slug,
        })),
        ...data.sharedWithMe.map((pool) => ({
          id: pool.poolId,
          label: pool.callableIds[0] ?? pool.poolId,
        })),
      ]
    : undefined;
}

/** The scope's target list and the query whose failure or loading it reports. */
function scopeList(
  scope: MetricScope,
  lists: ScopeLists,
  runtimeItems: Target[] | undefined,
  runtimeId: string | undefined,
): { items: Target[] | undefined; query: ListQuery<unknown> } {
  const { pools, runtimes, versions, runtime, nodes } = lists;
  const runtimeSlug = runtimeItems?.find((item) => item.id === runtimeId)?.label ?? "";
  // Version and instance lists hang off the runtime list: its failure or emptiness wins.
  const runtimeGate = runtimes.isError || runtimeItems?.length === 0;
  const noRuntimes = runtimeItems?.length === 0;
  switch (scope) {
    case "pool":
      return { items: poolTargets(pools.data), query: pools };
    case "runtime":
      return { items: runtimeItems, query: runtimes };
    case "version":
      return {
        items: noRuntimes
          ? []
          : versions.data?.items.map((version) => ({
              id: version.id,
              label: `${runtimeSlug} v${version.version}`,
            })),
        query: runtimeGate ? runtimes : versions,
      };
    case "instance":
      return {
        items: noRuntimes
          ? []
          : runtime.data?.instanceList.map((instance) => ({
              id: instance.id,
              label: `${instance.handle} · v${instance.versionNumber}`,
            })),
        query: runtimeGate ? runtimes : runtime,
      };
    case "node":
      return {
        items: nodes.data?.nodes.map((node) => ({ id: node.id, label: node.slug })),
        query: nodes,
      };
  }
}

/**
 * What a scope can pick: pools (yours and shared with you), runtimes, a runtime's versions or
 * current instances, nodes. Only the lists the scope needs are fetched.
 */
function useScopeTargets(scope: MetricScope, runtimeWanted: string | undefined) {
  const needsRuntimes = scope === "runtime" || isRuntimeChildScope(scope);
  const pools = useQuery({ ...orpc.pools.list.queryOptions(), enabled: scope === "pool" });
  const runtimes = useQuery({ ...orpc.runtimes.list.queryOptions(), enabled: needsRuntimes });
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), enabled: scope === "node" });
  const runtimeItems = runtimeTargets(runtimes.data);
  const runtimeId = pickRuntimeId(runtimeItems, runtimeWanted);
  const versions = useQuery(
    orpc.runtimes.versions.list.queryOptions({
      input: scope === "version" && runtimeId ? { runtimeId, limit: 200 } : skipToken,
    }),
  );
  const runtime = useQuery(
    orpc.runtimes.get.queryOptions({
      input: scope === "instance" && runtimeId ? { runtimeId } : skipToken,
    }),
  );

  const shared = new Set(pools.data?.sharedWithMe.map((pool) => pool.poolId) ?? []);
  const { items, query } = scopeList(
    scope,
    { pools, runtimes, versions, runtime, nodes },
    runtimeItems,
    runtimeId,
  );
  return {
    items,
    shared,
    loading: items === undefined && !query.isError,
    failed: query.isError,
    retry: () => void query.refetch(),
    runtimes: runtimeItems,
    runtimeId,
    runtimesLoading: runtimeItems === undefined && !runtimes.isError,
    runtimesFailed: runtimes.isError,
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function TargetSelect({
  label,
  items,
  value,
  loading,
  failed,
  empty,
  onChange,
}: {
  label: string;
  items: Target[] | undefined;
  value: string | undefined;
  loading: boolean;
  failed?: boolean;
  empty: string;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation(["activity"]);
  const id = useId();
  // A shared link may name a target that is no longer listed (a stopped instance): keep it.
  const options =
    value && items && !items.some((item) => item.id === value)
      ? [...items, { id: value, label: value }]
      : (items ?? []);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {loading ? (
        <Skeleton className="h-11 w-full" />
      ) : (
        <NativeSelect
          id={id}
          value={value ?? ""}
          disabled={options.length === 0}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.length === 0 ? (
            <option value="">{failed ? t("activity:metrics.targetsFailed") : empty}</option>
          ) : null}
          {options.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </NativeSelect>
      )}
    </div>
  );
}

function MetricSelect({
  value,
  sharedPool,
  onChange,
}: {
  value: Metric;
  sharedPool: boolean;
  onChange: (metric: Metric) => void;
}) {
  const { t } = useTranslation(["activity"]);
  const label = useMetricLabel();
  const id = useId();
  const groups = METRIC_GROUPS.filter((group) => !sharedPool || group.family === "request");
  const known = groups.flatMap((group) => group.metrics);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {t("activity:metrics.metric")}
      </label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(event) => {
          const next = [...known, value].find((metric) => metric === event.target.value);
          if (next) onChange(next);
        }}
      >
        {groups.map((group) => (
          <optgroup key={group.family} label={t(`activity:metrics.family.${group.family}`)}>
            {group.metrics.map((metric) => (
              <option key={metric} value={metric}>
                {label(metric)}
              </option>
            ))}
          </optgroup>
        ))}
        {isCustomMetric(value) ? (
          <optgroup label={t("activity:metrics.family.custom")}>
            <option value={value}>{value}</option>
          </optgroup>
        ) : null}
      </NativeSelect>
    </div>
  );
}

function GroupBySelect({
  value,
  options,
  onChange,
}: {
  value: GroupBy | undefined;
  options: readonly GroupBy[];
  onChange: (groupBy: GroupBy | undefined) => void;
}) {
  const { t } = useTranslation(["activity"]);
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {t("activity:metrics.groupBy")}
      </label>
      <NativeSelect
        id={id}
        value={value ?? ""}
        disabled={options.length === 0}
        onChange={(event) => onChange(options.find((option) => option === event.target.value))}
      >
        <option value="">{t("activity:metrics.groupByNone")}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {t(`activity:metrics.groupByValue.${option}`)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function SwitchRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-[44px] items-center gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  );
}

function RequestLogLink({ lang }: { lang: string }) {
  const { t } = useTranslation(["activity"]);
  return (
    <Link
      to="/$lang/activity/requests"
      params={{ lang }}
      className="inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-primary hover:underline"
    >
      {t("activity:metrics.requestLog")}
      <ArrowRight aria-hidden="true" className="size-4" />
    </Link>
  );
}

function EmptyCard({ lang, message }: { lang: string; message: string }) {
  const { t } = useTranslation(["activity"]);
  return (
    <Card>
      <CardContent className="flex min-w-0 flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground">{message}</p>
        <p className="text-sm text-muted-foreground">{t("activity:metrics.emptyHint")}</p>
        <RequestLogLink lang={lang} />
      </CardContent>
    </Card>
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-6" aria-hidden="true">
      <div className="flex min-w-0 flex-col gap-2">
        <Skeleton className="h-6 w-24" />
        <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {[0, 1, 2, 3, 4].map((key) => (
            <Skeleton key={key} className="h-[4.5rem] rounded-xl" />
          ))}
        </div>
      </div>
      <Skeleton className="h-80 w-full rounded-xl" />
    </div>
  );
}
