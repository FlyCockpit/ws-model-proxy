import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ws-model-proxy/ui/components/select";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import type { TFunction } from "i18next";
import { Activity, Cable, DatabaseZap, RadioTower, Search } from "lucide-react";
import { parseAsInteger, parseAsString, useQueryState } from "nuqs";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { SegmentedControl } from "@/components/segmented-control";
import { orpc } from "@/utils/orpc";

type CliPage = Awaited<ReturnType<AppRouterClient["adminObservability"]["listCliDevices"]>>;
type EndpointPage = Awaited<ReturnType<AppRouterClient["adminObservability"]["listEndpoints"]>>;
type ModelPage = Awaited<ReturnType<AppRouterClient["adminObservability"]["listModels"]>>;
type PoolPage = Awaited<ReturnType<AppRouterClient["adminObservability"]["listPools"]>>;
type RelayPage = Awaited<
  ReturnType<AppRouterClient["adminObservability"]["listRelayMetadataSummaries"]>
>;

type CliRow = CliPage["items"][number];
type RelayRow = RelayPage["items"][number];
type QuerySnapshot<T> = {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
};

type Tab = "clis" | "endpoints" | "models" | "pools" | "relays";
type CliStatus = "DISCONNECTED" | "CONNECTED" | "STALE" | "REVOKED";
type EndpointStatus = "UNKNOWN" | "ONLINE" | "DEGRADED" | "OFFLINE";
type CapabilityFamily = "TEXT" | "VISION" | "EMBEDDING" | "AUDIO" | "RESPONSES";
type PoolHealth = "UNKNOWN" | "HEALTHY" | "HALF_OPEN" | "DEGRADED" | "UNHEALTHY";
type RelayStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELED";

const tabValues: Tab[] = ["clis", "endpoints", "models", "pools", "relays"];
const cliStatuses: CliStatus[] = ["CONNECTED", "STALE", "DISCONNECTED", "REVOKED"];
const endpointStatuses: EndpointStatus[] = ["ONLINE", "DEGRADED", "OFFLINE", "UNKNOWN"];
const capabilityFamilies: CapabilityFamily[] = [
  "TEXT",
  "VISION",
  "EMBEDDING",
  "AUDIO",
  "RESPONSES",
];
const poolHealthValues: PoolHealth[] = ["HEALTHY", "HALF_OPEN", "DEGRADED", "UNHEALTHY", "UNKNOWN"];
const relayStatuses: RelayStatus[] = ["SUCCEEDED", "FAILED", "PENDING", "CANCELED"];
const pageSize = 25;

export const Route = createFileRoute("/$lang/admin/observability")({
  component: AdminObservability,
});

function isTab(value: string): value is Tab {
  return tabValues.includes(value as Tab);
}

function isCliStatus(value: string): value is CliStatus {
  return cliStatuses.includes(value as CliStatus);
}

function isEndpointStatus(value: string): value is EndpointStatus {
  return endpointStatuses.includes(value as EndpointStatus);
}

function isCapabilityFamily(value: string): value is CapabilityFamily {
  return capabilityFamilies.includes(value as CapabilityFamily);
}

function isPoolHealth(value: string): value is PoolHealth {
  return poolHealthValues.includes(value as PoolHealth);
}

function isRelayStatus(value: string): value is RelayStatus {
  return relayStatuses.includes(value as RelayStatus);
}

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: Date | string | null | undefined, emptyValue: string) {
  if (!value) return emptyValue;
  return dateTimeFormatter.format(new Date(value));
}

function formatNumber(value: number | null | undefined, emptyValue: string) {
  return typeof value === "number" ? value.toLocaleString() : emptyValue;
}

function formatMs(
  value: number | null | undefined,
  emptyValue: string,
  formatDuration: (value: string) => string,
) {
  if (typeof value !== "number") return emptyValue;
  return formatDuration(value.toLocaleString());
}

function dateInputToDate(value: string) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateInputToExclusiveEnd(value: string) {
  const date = dateInputToDate(value);
  if (!date) return undefined;
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function statusLabel(value: string, t: TFunction<["admin", "common"]>) {
  return t(`admin:observability.values.${value}`);
}

function capabilityLabel(value: string, t: TFunction<["admin", "common"]>) {
  if (value === "TEXT_GENERATION") return statusLabel("TEXT", t);
  if (value === "VISION_INPUT") return statusLabel("VISION", t);
  if (value === "EMBEDDING") return statusLabel("EMBEDDING", t);
  if (value === "AUDIO_INPUT" || value === "AUDIO_OUTPUT") return statusLabel("AUDIO", t);
  if (value === "RESPONSES_API") return statusLabel("RESPONSES", t);
  return value;
}

function capabilityList(
  values: readonly string[],
  t: TFunction<["admin", "common"]>,
  emptyValue: string,
) {
  return values.map((value) => capabilityLabel(value, t)).join(", ") || emptyValue;
}

function OwnerCell({ owner }: { owner: CliRow["owner"] }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium">{owner.name || owner.email}</p>
      <p className="truncate text-xs text-muted-foreground">{owner.email}</p>
      <p className="truncate font-mono text-xs text-muted-foreground">{owner.slug}</p>
    </div>
  );
}

function Pill({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <span
      className={
        muted
          ? "inline-flex min-h-6 items-center border bg-muted px-2 text-xs font-medium text-muted-foreground"
          : "inline-flex min-h-6 items-center border border-primary/20 bg-primary/10 px-2 text-xs font-medium text-primary"
      }
    >
      {children}
    </span>
  );
}

function SelectFilter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="min-w-[11rem] space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
      >
        <SelectTrigger className="min-h-[44px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </div>
  );
}

function TableSkeleton({ columns }: { columns: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 6 }).map((_, row) => (
        <div
          key={row}
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }).map((__, column) => (
            <Skeleton key={column} className="h-8 w-full rounded-sm" />
          ))}
        </div>
      ))}
    </div>
  );
}

function DataShell({
  title,
  total,
  page,
  pageCount,
  isPending,
  isError,
  onRetry,
  onPage,
  children,
  columns,
}: {
  title: string;
  total?: number;
  page: number;
  pageCount?: number;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  onPage: (page: number) => void;
  children: ReactNode;
  columns: number;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const lastPage = Math.max(pageCount ?? 1, 1);

  return (
    <section className="rounded-md border">
      <div className="flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">
            {isPending
              ? t("admin:observability.loading")
              : isError
                ? t("admin:observability.loadFailedShort")
                : t("admin:observability.totalRows", { count: total ?? 0 })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-[44px]"
            disabled={isPending || page <= 1}
            onClick={() => onPage(Math.max(page - 1, 1))}
          >
            {t("common:actions.previous")}
          </Button>
          <span className="min-w-20 text-center text-xs tabular-nums text-muted-foreground">
            {t("admin:observability.pageLabel", { page, pageCount: lastPage })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-[44px]"
            disabled={isPending || page >= lastPage}
            onClick={() => onPage(Math.min(page + 1, lastPage))}
          >
            {t("common:actions.next")}
          </Button>
        </div>
      </div>
      {isPending ? (
        <TableSkeleton columns={columns} />
      ) : isError ? (
        <InlineRetry
          className="py-12"
          message={t("admin:observability.loadFailed")}
          onRetry={onRetry}
        />
      ) : (
        children
      )}
    </section>
  );
}

function EmptyRows({ colSpan }: { colSpan: number }) {
  const { t } = useTranslation("admin");
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12 text-center text-sm text-muted-foreground">
        {t("observability.empty")}
      </td>
    </tr>
  );
}

function AdminObservability() {
  const { t } = useTranslation(["admin", "common"]);
  const [tabParam, setTabParam] = useQueryState("tab", parseAsString.withDefault("clis"));
  const [page, setPage] = useQueryState("page", parseAsInteger.withDefault(1));
  const [owner, setOwner] = useQueryState("owner", parseAsString.withDefault(""));
  const [cliStatus, setCliStatus] = useQueryState("cliStatus", parseAsString.withDefault("all"));
  const [endpointStatus, setEndpointStatus] = useQueryState(
    "endpointStatus",
    parseAsString.withDefault("all"),
  );
  const [capability, setCapability] = useQueryState("capability", parseAsString.withDefault("all"));
  const [poolHealth, setPoolHealth] = useQueryState("poolHealth", parseAsString.withDefault("all"));
  const [relayStatus, setRelayStatus] = useQueryState(
    "relayStatus",
    parseAsString.withDefault("all"),
  );
  const [errorClass, setErrorClass] = useQueryState("errorClass", parseAsString.withDefault(""));
  const [createdAfter, setCreatedAfter] = useQueryState(
    "createdAfter",
    parseAsString.withDefault(""),
  );
  const [createdBefore, setCreatedBefore] = useQueryState(
    "createdBefore",
    parseAsString.withDefault(""),
  );

  const tab = isTab(tabParam) ? tabParam : "clis";
  const ownerQuery = owner.trim() || undefined;
  const pageInput = Math.max(page, 1);
  const relayDateInput = useMemo(
    () => ({
      createdAfter: dateInputToDate(createdAfter),
      createdBefore: dateInputToExclusiveEnd(createdBefore),
    }),
    [createdAfter, createdBefore],
  );

  const {
    data: cliData,
    isPending: cliIsPending,
    isError: cliIsError,
    refetch: refetchClis,
  } = useQuery(
    orpc.adminObservability.listCliDevices.queryOptions({
      input: {
        page: pageInput,
        pageSize,
        ownerQuery,
        status: isCliStatus(cliStatus) ? cliStatus : undefined,
      },
    }),
  );
  const {
    data: endpointData,
    isPending: endpointIsPending,
    isError: endpointIsError,
    refetch: refetchEndpoints,
  } = useQuery(
    orpc.adminObservability.listEndpoints.queryOptions({
      input: {
        page: pageInput,
        pageSize,
        ownerQuery,
        status: isEndpointStatus(endpointStatus) ? endpointStatus : undefined,
      },
    }),
  );
  const {
    data: modelData,
    isPending: modelIsPending,
    isError: modelIsError,
    refetch: refetchModels,
  } = useQuery(
    orpc.adminObservability.listModels.queryOptions({
      input: {
        page: pageInput,
        pageSize,
        ownerQuery,
        capabilityFamily: isCapabilityFamily(capability) ? capability : undefined,
      },
    }),
  );
  const {
    data: poolData,
    isPending: poolIsPending,
    isError: poolIsError,
    refetch: refetchPools,
  } = useQuery(
    orpc.adminObservability.listPools.queryOptions({
      input: {
        page: pageInput,
        pageSize,
        ownerQuery,
        memberHealth: isPoolHealth(poolHealth) ? poolHealth : undefined,
      },
    }),
  );
  const {
    data: relayData,
    isPending: relayIsPending,
    isError: relayIsError,
    refetch: refetchRelays,
  } = useQuery(
    orpc.adminObservability.listRelayMetadataSummaries.queryOptions({
      input: {
        page: pageInput,
        pageSize,
        ownerQuery,
        status: isRelayStatus(relayStatus) ? relayStatus : undefined,
        errorClass: errorClass.trim() || undefined,
        ...relayDateInput,
      },
    }),
  );

  const resetPage = () => {
    void setPage(1);
  };
  const changeTab = (next: Tab) => {
    void setTabParam(next);
    resetPage();
  };

  return (
    <div className="container mx-auto max-w-7xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("admin:observability.title")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("admin:observability.description")}
        </p>
      </header>

      <div className="space-y-4">
        <SegmentedControl
          value={tab}
          onChange={changeTab}
          ariaLabel={t("admin:observability.tabsAriaLabel")}
          items={[
            { value: "clis", label: t("admin:observability.tabs.clis") },
            { value: "endpoints", label: t("admin:observability.tabs.endpoints") },
            { value: "models", label: t("admin:observability.tabs.models") },
            { value: "pools", label: t("admin:observability.tabs.pools") },
            { value: "relays", label: t("admin:observability.tabs.relays") },
          ]}
        />

        <div className="rounded-md border p-4">
          <div className="grid gap-3 md:grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(10rem,auto))]">
            <div className="space-y-1">
              <Label htmlFor="owner-filter" className="text-xs">
                {t("admin:observability.filters.owner")}
              </Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
                <Input
                  id="owner-filter"
                  type="search"
                  inputMode="search"
                  autoComplete="off"
                  value={owner}
                  onChange={(event) => {
                    void setOwner(event.target.value);
                    resetPage();
                  }}
                  placeholder={t("admin:observability.filters.ownerPlaceholder")}
                  className="min-h-[44px] pl-9"
                />
              </div>
            </div>

            {tab === "clis" ? (
              <SelectFilter
                label={t("admin:observability.filters.cliStatus")}
                value={cliStatus}
                onChange={(value) => {
                  void setCliStatus(value);
                  resetPage();
                }}
              >
                <SelectItem value="all">{t("admin:observability.filters.allStatuses")}</SelectItem>
                {cliStatuses.map((value) => (
                  <SelectItem key={value} value={value}>
                    {statusLabel(value, t)}
                  </SelectItem>
                ))}
              </SelectFilter>
            ) : null}

            {tab === "endpoints" ? (
              <SelectFilter
                label={t("admin:observability.filters.endpointHealth")}
                value={endpointStatus}
                onChange={(value) => {
                  void setEndpointStatus(value);
                  resetPage();
                }}
              >
                <SelectItem value="all">{t("admin:observability.filters.allHealth")}</SelectItem>
                {endpointStatuses.map((value) => (
                  <SelectItem key={value} value={value}>
                    {statusLabel(value, t)}
                  </SelectItem>
                ))}
              </SelectFilter>
            ) : null}

            {tab === "models" ? (
              <SelectFilter
                label={t("admin:observability.filters.capability")}
                value={capability}
                onChange={(value) => {
                  void setCapability(value);
                  resetPage();
                }}
              >
                <SelectItem value="all">
                  {t("admin:observability.filters.allCapabilities")}
                </SelectItem>
                {capabilityFamilies.map((value) => (
                  <SelectItem key={value} value={value}>
                    {statusLabel(value, t)}
                  </SelectItem>
                ))}
              </SelectFilter>
            ) : null}

            {tab === "pools" ? (
              <SelectFilter
                label={t("admin:observability.filters.poolHealth")}
                value={poolHealth}
                onChange={(value) => {
                  void setPoolHealth(value);
                  resetPage();
                }}
              >
                <SelectItem value="all">{t("admin:observability.filters.allHealth")}</SelectItem>
                {poolHealthValues.map((value) => (
                  <SelectItem key={value} value={value}>
                    {statusLabel(value, t)}
                  </SelectItem>
                ))}
              </SelectFilter>
            ) : null}

            {tab === "relays" ? (
              <>
                <SelectFilter
                  label={t("admin:observability.filters.relayStatus")}
                  value={relayStatus}
                  onChange={(value) => {
                    void setRelayStatus(value);
                    resetPage();
                  }}
                >
                  <SelectItem value="all">
                    {t("admin:observability.filters.allStatuses")}
                  </SelectItem>
                  {relayStatuses.map((value) => (
                    <SelectItem key={value} value={value}>
                      {statusLabel(value, t)}
                    </SelectItem>
                  ))}
                </SelectFilter>
                <div className="space-y-1">
                  <Label htmlFor="error-class-filter" className="text-xs">
                    {t("admin:observability.filters.errorClass")}
                  </Label>
                  <Input
                    id="error-class-filter"
                    type="search"
                    inputMode="search"
                    autoComplete="off"
                    value={errorClass}
                    onChange={(event) => {
                      void setErrorClass(event.target.value);
                      resetPage();
                    }}
                    placeholder={t("admin:observability.filters.errorClassPlaceholder")}
                    className="min-h-[44px]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="created-after-filter" className="text-xs">
                      {t("admin:observability.filters.createdAfter")}
                    </Label>
                    <Input
                      id="created-after-filter"
                      type="date"
                      value={createdAfter}
                      onChange={(event) => {
                        void setCreatedAfter(event.target.value);
                        resetPage();
                      }}
                      className="min-h-[44px]"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="created-before-filter" className="text-xs">
                      {t("admin:observability.filters.createdBefore")}
                    </Label>
                    <Input
                      id="created-before-filter"
                      type="date"
                      value={createdBefore}
                      onChange={(event) => {
                        void setCreatedBefore(event.target.value);
                        resetPage();
                      }}
                      className="min-h-[44px]"
                    />
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {tab === "clis" ? (
        <CliTable
          query={{
            data: cliData,
            isPending: cliIsPending,
            isError: cliIsError,
            refetch: refetchClis,
          }}
          page={pageInput}
          onPage={(next) => void setPage(next)}
        />
      ) : null}
      {tab === "endpoints" ? (
        <EndpointTable
          query={{
            data: endpointData,
            isPending: endpointIsPending,
            isError: endpointIsError,
            refetch: refetchEndpoints,
          }}
          page={pageInput}
          onPage={(next) => void setPage(next)}
        />
      ) : null}
      {tab === "models" ? (
        <ModelTable
          query={{
            data: modelData,
            isPending: modelIsPending,
            isError: modelIsError,
            refetch: refetchModels,
          }}
          page={pageInput}
          onPage={(next) => void setPage(next)}
        />
      ) : null}
      {tab === "pools" ? (
        <PoolTable
          query={{
            data: poolData,
            isPending: poolIsPending,
            isError: poolIsError,
            refetch: refetchPools,
          }}
          page={pageInput}
          onPage={(next) => void setPage(next)}
        />
      ) : null}
      {tab === "relays" ? (
        <RelayTable
          query={{
            data: relayData,
            isPending: relayIsPending,
            isError: relayIsError,
            refetch: refetchRelays,
          }}
          page={pageInput}
          onPage={(next) => void setPage(next)}
        />
      ) : null}
    </div>
  );
}

function CliTable({
  query,
  page,
  onPage,
}: {
  query: QuerySnapshot<CliPage>;
  page: number;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const data = query.data;
  const emptyValue = t("admin:observability.notAvailable");
  return (
    <DataShell
      title={t("admin:observability.tables.clis")}
      total={data?.total}
      page={page}
      pageCount={data?.pageCount}
      isPending={query.isPending}
      isError={query.isError}
      onRetry={() => query.refetch()}
      onPage={onPage}
      columns={7}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-xs">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.owner")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.cli")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.status")}</th>
              <th className="px-4 py-2 font-medium">
                {t("admin:observability.columns.heartbeat")}
              </th>
              <th className="px-4 py-2 font-medium">
                {t("admin:observability.columns.endpoints")}
              </th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.tokens")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.updated")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.length === 0 ? <EmptyRows colSpan={7} /> : null}
            {data?.items.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 align-top">
                  <OwnerCell owner={row.owner} />
                </td>
                <td className="px-4 py-3 align-top">
                  <p className="font-medium">{row.label}</p>
                  <p className="font-mono text-muted-foreground">{row.slug}</p>
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="flex flex-wrap gap-1">
                    <Pill muted={row.isStale}>{statusLabel(row.status, t)}</Pill>
                    {row.isStale ? <Pill muted>{statusLabel("STALE", t)}</Pill> : null}
                  </div>
                </td>
                <td className="px-4 py-3 align-top tabular-nums">
                  {formatDate(row.lastHeartbeatAt, emptyValue)}
                </td>
                <td className="px-4 py-3 align-top tabular-nums">
                  {formatNumber(row.endpointCount, emptyValue)}
                </td>
                <td className="px-4 py-3 align-top tabular-nums">
                  {formatNumber(row.cliTokenCount + row.credentialCount, emptyValue)}
                </td>
                <td className="px-4 py-3 align-top tabular-nums">
                  {formatDate(row.updatedAt, emptyValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DataShell>
  );
}

function EndpointTable({
  query,
  page,
  onPage,
}: {
  query: QuerySnapshot<EndpointPage>;
  page: number;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const data = query.data;
  const emptyValue = t("admin:observability.notAvailable");
  return (
    <DataShell
      title={t("admin:observability.tables.endpoints")}
      total={data?.total}
      page={page}
      pageCount={data?.pageCount}
      isPending={query.isPending}
      isError={query.isError}
      onRetry={() => query.refetch()}
      onPage={onPage}
      columns={7}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] text-left text-xs">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.owner")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.endpoint")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.cli")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.health")}</th>
              <th className="px-4 py-2 font-medium">
                {t("admin:observability.columns.capabilities")}
              </th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.models")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.lastSeen")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.length === 0 ? <EmptyRows colSpan={7} /> : null}
            {data?.items.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 align-top">
                  <OwnerCell owner={row.owner} />
                </td>
                <td className="px-4 py-3 align-top">
                  <p className="font-medium">{row.label}</p>
                  <p className="font-mono text-muted-foreground">{row.slug}</p>
                </td>
                <td className="px-4 py-3 align-top">
                  <p>{row.cliDevice.label}</p>
                  <p className="font-mono text-muted-foreground">{row.cliDevice.slug}</p>
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="flex flex-wrap gap-1">
                    <Pill muted={row.healthState !== "HEALTHY"}>{statusLabel(row.status, t)}</Pill>
                    {row.cliDevice.isStale ? <Pill muted>{statusLabel("STALE", t)}</Pill> : null}
                  </div>
                </td>
                <td className="px-4 py-3 align-top">
                  {capabilityList(row.defaultCapabilities, t, emptyValue)}
                </td>
                <td className="px-4 py-3 align-top tabular-nums">
                  {formatNumber(row.discoveredModelCount, emptyValue)}
                </td>
                <td className="px-4 py-3 align-top tabular-nums">
                  {formatDate(row.lastSeenAt, emptyValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DataShell>
  );
}

function ModelTable({
  query,
  page,
  onPage,
}: {
  query: QuerySnapshot<ModelPage>;
  page: number;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const data = query.data;
  const emptyValue = t("admin:observability.notAvailable");
  return (
    <DataShell
      title={t("admin:observability.tables.models")}
      total={data?.total}
      page={page}
      pageCount={data?.pageCount}
      isPending={query.isPending}
      isError={query.isError}
      onRetry={() => query.refetch()}
      onPage={onPage}
      columns={7}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] text-left text-xs">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.owner")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.model")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.endpoint")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.health")}</th>
              <th className="px-4 py-2 font-medium">
                {t("admin:observability.columns.capabilities")}
              </th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.pools")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.lastSeen")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.length === 0 ? <EmptyRows colSpan={7} /> : null}
            {data?.items.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 align-top">
                  <OwnerCell owner={row.owner} />
                </td>
                <td className="px-4 py-3 align-top">
                  <p className="font-mono">{row.canonicalModelId}</p>
                  <p className="font-mono text-muted-foreground">{row.upstreamModelId}</p>
                </td>
                <td className="px-4 py-3 align-top">
                  <p>{row.endpoint.label}</p>
                  <p className="font-mono text-muted-foreground">
                    {row.cliDevice.slug}/{row.endpoint.slug}
                  </p>
                </td>
                <td className="px-4 py-3 align-top">
                  <Pill muted={row.healthState !== "AVAILABLE"}>
                    {statusLabel(row.healthState, t)}
                  </Pill>
                </td>
                <td className="px-4 py-3 align-top">
                  {capabilityList(row.effectiveCapabilities.coarse, t, emptyValue)}
                  <p className="mt-1 text-muted-foreground">
                    {statusLabel(row.effectiveCapabilities.source, t)}
                  </p>
                </td>
                <td className="px-4 py-3 align-top tabular-nums">
                  {formatNumber(row.poolMemberCount, emptyValue)}
                </td>
                <td className="px-4 py-3 align-top tabular-nums">
                  {formatDate(row.lastSeenAt, emptyValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DataShell>
  );
}

function PoolTable({
  query,
  page,
  onPage,
}: {
  query: QuerySnapshot<PoolPage>;
  page: number;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const data = query.data;
  const emptyValue = t("admin:observability.notAvailable");
  return (
    <DataShell
      title={t("admin:observability.tables.pools")}
      total={data?.total}
      page={page}
      pageCount={data?.pageCount}
      isPending={query.isPending}
      isError={query.isError}
      onRetry={() => query.refetch()}
      onPage={onPage}
      columns={6}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1060px] text-left text-xs">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.owner")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.pool")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.members")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.health")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.grants")}</th>
              <th className="px-4 py-2 font-medium">{t("admin:observability.columns.updated")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.length === 0 ? <EmptyRows colSpan={6} /> : null}
            {data?.items.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 align-top">
                  <OwnerCell owner={row.owner} />
                </td>
                <td className="px-4 py-3 align-top">
                  <p className="font-medium">{row.name}</p>
                  <p className="font-mono text-muted-foreground">{row.canonicalModelId}</p>
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="space-y-1">
                    {row.members.length === 0 ? emptyValue : null}
                    {row.members.slice(0, 4).map((member) => (
                      <p key={member.id} className="font-mono">
                        {member.model.canonicalModelId}
                      </p>
                    ))}
                    {row.members.length > 4 ? (
                      <p className="text-muted-foreground">
                        {t("admin:observability.moreMembers", {
                          count: row.members.length - 4,
                        })}
                      </p>
                    ) : null}
                  </div>
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="flex flex-wrap gap-1">
                    {row.members.length === 0 ? (
                      <Pill muted>{statusLabel("UNKNOWN", t)}</Pill>
                    ) : null}
                    {row.members.slice(0, 4).map((member) => (
                      <Pill key={member.id} muted={member.healthStatus !== "HEALTHY"}>
                        {statusLabel(member.healthStatus, t)}
                      </Pill>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 align-top tabular-nums">
                  {formatNumber(row.grantCount, emptyValue)}
                </td>
                <td className="px-4 py-3 align-top tabular-nums">
                  {formatDate(row.updatedAt, emptyValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DataShell>
  );
}

function RelayTable({
  query,
  page,
  onPage,
}: {
  query: QuerySnapshot<RelayPage>;
  page: number;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const data = query.data;
  const emptyValue = t("admin:observability.notAvailable");
  const formatDuration = (value: string) => t("admin:observability.durationMs", { value });
  return (
    <div className="space-y-4">
      {data ? <RelaySummary data={data} /> : null}
      <DataShell
        title={t("admin:observability.tables.relays")}
        total={data?.total}
        page={page}
        pageCount={data?.pageCount}
        isPending={query.isPending}
        isError={query.isError}
        onRetry={() => query.refetch()}
        onPage={onPage}
        columns={8}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-xs">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t("admin:observability.columns.owner")}</th>
                <th className="px-4 py-2 font-medium">{t("admin:observability.columns.key")}</th>
                <th className="px-4 py-2 font-medium">{t("admin:observability.columns.target")}</th>
                <th className="px-4 py-2 font-medium">
                  {t("admin:observability.columns.selected")}
                </th>
                <th className="px-4 py-2 font-medium">{t("admin:observability.columns.status")}</th>
                <th className="px-4 py-2 font-medium">
                  {t("admin:observability.columns.duration")}
                </th>
                <th className="px-4 py-2 font-medium">{t("admin:observability.columns.tokens")}</th>
                <th className="px-4 py-2 font-medium">
                  {t("admin:observability.columns.created")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data?.items.length === 0 ? <EmptyRows colSpan={8} /> : null}
              {data?.items.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 align-top">
                    <OwnerCell owner={row.owner} />
                  </td>
                  <td className="px-4 py-3 align-top">
                    <p>{row.modelApiToken?.name ?? emptyValue}</p>
                    <p className="font-mono text-muted-foreground">
                      {row.modelApiToken?.lookupPrefix ?? emptyValue}
                    </p>
                  </td>
                  <td className="px-4 py-3 align-top font-mono">{relayTarget(row, emptyValue)}</td>
                  <td className="px-4 py-3 align-top font-mono">
                    {row.selectedModel?.canonicalModelId ?? emptyValue}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <Pill muted={row.status !== "SUCCEEDED"}>{statusLabel(row.status, t)}</Pill>
                    {row.errorClass ? (
                      <p className="mt-1 text-muted-foreground">{row.errorClass}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 align-top tabular-nums">
                    {formatMs(row.durationMs, emptyValue, formatDuration)}
                  </td>
                  <td className="px-4 py-3 align-top tabular-nums">
                    {formatNumber(row.totalTokens, emptyValue)}
                  </td>
                  <td className="px-4 py-3 align-top tabular-nums">
                    {formatDate(row.createdAt, emptyValue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataShell>
    </div>
  );
}

function relayTarget(row: RelayRow, emptyValue: string) {
  if (row.requestedPool) return row.requestedPool.canonicalModelId;
  return row.requestedModel?.canonicalModelId ?? emptyValue;
}

function RelaySummary({ data }: { data: RelayPage }) {
  const { t } = useTranslation("admin");
  const emptyValue = t("observability.notAvailable");
  const formatDuration = (value: string) => t("observability.durationMs", { value });
  return (
    <div className="grid gap-3 md:grid-cols-4">
      <SummaryTile
        icon={<DatabaseZap className="size-4" />}
        label={t("observability.summary.requests")}
        value={formatNumber(data.total, emptyValue)}
      />
      <SummaryTile
        icon={<Activity className="size-4" />}
        label={t("observability.summary.averageDuration")}
        value={formatMs(data.summary.durationMs.average, emptyValue, formatDuration)}
      />
      <SummaryTile
        icon={<Cable className="size-4" />}
        label={t("observability.summary.tokens")}
        value={formatNumber(data.summary.tokens.total, emptyValue)}
      />
      <SummaryTile
        icon={<RadioTower className="size-4" />}
        label={t("observability.summary.failures")}
        value={formatNumber(
          data.summary.statusCounts.find((row) => row.status === "FAILED")?.count ?? 0,
          emptyValue,
        )}
      />
    </div>
  );
}

function SummaryTile({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <p className="text-xs font-medium">{label}</p>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
