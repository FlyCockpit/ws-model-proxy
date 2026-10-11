import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent } from "@ws-model-proxy/ui/components/card";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useDebounce } from "@ws-model-proxy/ui/hooks/use-async-search";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { SegmentedControl } from "@/components/segmented-control";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/admin/observability")({
  component: AdminObservability,
});

const TABS = ["nodes", "runtimes", "pools", "requests"] as const;
type Tab = (typeof TABS)[number];
const PAGE_SIZE = 25;

type Admin = AppRouterClient["adminObservability"];
type Owner = Awaited<ReturnType<Admin["nodes"]>>["items"][number]["owner"];
type PageInput = { page: number; pageSize: number; ownerQuery?: string };

/** Every node, runtime, pool and request across accounts (admin only, read-only). */
function AdminObservability() {
  const { t } = useTranslation(["admin"]);
  const [tab, setTab] = useState<Tab>("nodes");
  const [owner, setOwner] = useState("");
  const [page, setPage] = useState(1);
  const ownerQuery = useDebounce(owner.trim(), 300);
  const input: PageInput = {
    page,
    pageSize: PAGE_SIZE,
    ...(ownerQuery ? { ownerQuery } : {}),
  };
  return (
    <div className="container mx-auto min-w-0 max-w-7xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("admin:observability.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("admin:observability.description")}</p>
      </header>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <SegmentedControl
          value={tab}
          onChange={(next) => {
            setTab(next);
            setPage(1);
          }}
          ariaLabel={t("admin:observability.tabsAriaLabel")}
          items={TABS.map((value) => ({ value, label: t(`admin:observability.tabs.${value}`) }))}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
          <Label htmlFor="observability-owner">{t("admin:observability.ownerLabel")}</Label>
          <Input
            id="observability-owner"
            className="min-h-[44px]"
            value={owner}
            placeholder={t("admin:observability.ownerPlaceholder")}
            onChange={(event) => {
              setOwner(event.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>
      {tab === "nodes" ? (
        <NodesTab input={input} onPage={setPage} />
      ) : tab === "runtimes" ? (
        <RuntimesTab input={input} onPage={setPage} />
      ) : tab === "pools" ? (
        <PoolsTab input={input} onPage={setPage} />
      ) : (
        <RequestsTab input={input} onPage={setPage} />
      )}
    </div>
  );
}

type Paged<T> = { items: T[]; total: number; page: number; pageSize: number; partial?: true };
type PagedQuery<T> = {
  isPending: boolean;
  isError: boolean;
  data: Paged<T> | undefined;
  refetch: () => unknown;
};

/** Loading, error, empty and paging around one list. */
function PagedList<T extends { id: string }>({
  query,
  onPage,
  row,
}: {
  query: PagedQuery<T>;
  onPage: (page: number) => void;
  row: (item: T) => ReactNode;
}) {
  const { t } = useTranslation(["admin"]);
  if (query.isPending)
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((key) => (
          <Skeleton key={key} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  if (query.isError || !query.data)
    return (
      <InlineRetry message={t("admin:observability.loadFailed")} onRetry={() => query.refetch()} />
    );
  const { items, total, page, pageSize, partial } = query.data;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {partial
          ? t("admin:observability.totalAtLeast", { count: total })
          : t("admin:observability.total", { count: total })}
      </p>
      {items.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            {t("admin:observability.empty")}
          </CardContent>
        </Card>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="min-w-0">
              <Card size="sm">
                <CardContent className="flex min-w-0 flex-col gap-1 text-sm">
                  {row(item)}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 ? (
        <nav className="flex min-w-0 flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            {t("admin:observability.previous")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t("admin:observability.page", { page, pages })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={page >= pages}
            onClick={() => onPage(page + 1)}
          >
            {t("admin:observability.next")}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function OwnerLine({ owner }: { owner: Owner }) {
  return (
    <span className="min-w-0 truncate text-xs text-muted-foreground" title={owner.email}>
      {owner.name} · {owner.email}
    </span>
  );
}

function Title({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <span className={cn("min-w-0 break-all font-medium", mono && "font-mono")}>{children}</span>
  );
}

function NodesTab({ input, onPage }: { input: PageInput; onPage: (page: number) => void }) {
  const { t } = useTranslation(["admin", "dashboard"]);
  const query = useQuery({
    ...orpc.adminObservability.nodes.queryOptions({ input }),
    placeholderData: keepPreviousData,
  });
  return (
    <PagedList
      query={query}
      onPage={onPage}
      row={(node) => (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Title>{node.slug}</Title>
            <StatusPill tone={node.connection === "ONLINE" ? "good" : "muted"}>
              {node.connection === "ONLINE"
                ? t("dashboard:nodes.status.online")
                : t("dashboard:nodes.status.offline")}
            </StatusPill>
            <StatusPill tone={node.trust === "FULL" ? "info" : "muted"}>
              {node.trust === "FULL"
                ? t("dashboard:nodes.trust.full")
                : t("dashboard:nodes.trust.relay")}
            </StatusPill>
          </div>
          <OwnerLine owner={node.owner} />
          <p className="text-xs text-muted-foreground">
            {[
              node.version ? t("admin:observability.version", { version: node.version }) : null,
              t("admin:observability.running", { count: node.runningInstances }),
            ]
              .filter((part): part is string => part !== null)
              .join(" · ")}
            {node.lastHeartbeatAt ? (
              <>
                {" · "}
                {t("admin:observability.heartbeat")} <TimeAgo value={node.lastHeartbeatAt} />
              </>
            ) : null}
          </p>
        </>
      )}
    />
  );
}

function RuntimesTab({ input, onPage }: { input: PageInput; onPage: (page: number) => void }) {
  const { t } = useTranslation(["admin", "dashboard"]);
  const query = useQuery({
    ...orpc.adminObservability.runtimes.queryOptions({ input }),
    placeholderData: keepPreviousData,
  });
  return (
    <PagedList
      query={query}
      onPage={onPage}
      row={(runtime) => (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Title>{runtime.slug}</Title>
            <StatusPill tone="muted">{t(`dashboard:runtime.kind.${runtime.kind}`)}</StatusPill>
            <StatusPill tone="info">
              {runtime.modelType
                ? t(`dashboard:models.type.${runtime.modelType}`)
                : t("admin:observability.service")}
            </StatusPill>
          </div>
          <OwnerLine owner={runtime.owner} />
          {runtime.instances.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("admin:observability.noInstances")}</p>
          ) : (
            <ul className="flex min-w-0 flex-wrap gap-1">
              {runtime.instances.map((instance) => (
                <li key={instance.id}>
                  <StatusPill
                    tone={
                      instance.phase === "READY"
                        ? "good"
                        : instance.phase === "FAILED" || instance.phase === "UNHEALTHY"
                          ? "bad"
                          : "busy"
                    }
                  >
                    {t(`dashboard:nodes.phase.${instance.phase}`)}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    />
  );
}

function PoolsTab({ input, onPage }: { input: PageInput; onPage: (page: number) => void }) {
  const { t } = useTranslation(["admin", "dashboard"]);
  const query = useQuery({
    ...orpc.adminObservability.pools.queryOptions({ input }),
    placeholderData: keepPreviousData,
  });
  return (
    <PagedList
      query={query}
      onPage={onPage}
      row={(pool) => (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Title mono>{pool.callableId}</Title>
            <StatusPill tone="info">{t(`dashboard:models.type.${pool.modelType}`)}</StatusPill>
          </div>
          <OwnerLine owner={pool.owner} />
          <p className="text-xs text-muted-foreground">
            {t("admin:observability.members", { count: pool.members })}
            {" · "}
            {t("admin:observability.shares", { count: pool.shares })}
          </p>
        </>
      )}
    />
  );
}

function RequestsTab({ input, onPage }: { input: PageInput; onPage: (page: number) => void }) {
  const { t } = useTranslation(["admin", "activity"]);
  const query = useQuery({
    ...orpc.adminObservability.relay.queryOptions({ input }),
    placeholderData: keepPreviousData,
  });
  return (
    <PagedList
      query={query}
      onPage={onPage}
      row={(request) => (
        <>
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <Title mono>{request.callableId ?? t("admin:observability.direct")}</Title>
            <span className="shrink-0 text-xs text-muted-foreground">
              <TimeAgo value={request.createdAt} />
            </span>
          </div>
          <OwnerLine owner={request.owner} />
          <p className="text-xs">
            <span
              className={cn(
                "font-medium",
                request.status === "FAILED" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {t(`activity:requests.statusValue.${request.status}`)}
            </span>
            {request.durationMs !== null ? (
              <span className="text-muted-foreground">
                {" · "}
                {t("admin:observability.duration", { value: request.durationMs })}
              </span>
            ) : null}
            {request.errorClass ? (
              <span className="break-all text-destructive"> · {request.errorClass}</span>
            ) : null}
          </p>
        </>
      )}
    />
  );
}
