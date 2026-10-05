import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { poolGrantSpendCapSchema } from "@ws-model-proxy/api/lib/pool-grant-spend-cap-schema";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { parseLocaleDecimal } from "@ws-model-proxy/config/decimal-input";
import { DEFAULT_LOCALE } from "@ws-model-proxy/config/locales";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { ArrowDown, ArrowRight, ArrowUp, Cpu, Gauge, Network, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import {
  allDirectModels,
  CapacitySetupForm,
  CopyableModelId,
  GrantPoolDialog,
  PoolForm,
  PoolMemberForm,
  resolveCapacityAvailability,
} from "@/components/forwarder-dashboard-sections";
import { Help } from "@/components/help";
import { InlineRetry } from "@/components/inline-retry";
import { PoolCacheStats } from "@/components/pool-cache-stats";
import { CapacityEngineLoadChart } from "@/components/pool-engine-load";
import { PoolExecutionPolicy } from "@/components/pool-execution-policy";
import { ownerFallbackRoutes, PoolFallbackBadge } from "@/components/pool-fallback-badge";
import { PoolMetricRoutingRules } from "@/components/pool-metric-routing-rules";
import { ProviderOperationsSection } from "@/components/provider-operations-section";
import { SlotMeter } from "@/components/slot-meter";
import { Sparkline } from "@/components/sparkline";
import { useDeploymentFlags } from "@/hooks/use-deployment-flags";
import { poolMutationFailureReason } from "@/lib/pool-mutation-failure-reason";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

function PageSkeleton() {
  return (
    <div className="space-y-4" data-testid="page-skeleton">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

type PoolDetailModel = Awaited<
  ReturnType<AppRouterClient["forwarderManagement"]["listModelPools"]>
>[number];
type PoolDetailCapacity = Awaited<
  ReturnType<AppRouterClient["capacityManagement"]["list"]>
>[number];

function PageHeader({
  title,
  description,
  action,
  badge,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          {badge}
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

type PoolDetailContextValue = {
  pool: PoolDetailModel;
  directModels: ReturnType<typeof allDirectModels>;
  capacities: PoolDetailCapacity[];
  capacityAvailability: ReturnType<typeof resolveCapacityAvailability>;
  providerEgressEnabled: boolean;
  deploymentFlags: ReturnType<typeof useDeploymentFlags>["query"];
  openMember: (member: "create" | string | null) => void;
  openGrant: () => void;
  openDelete: () => void;
  removeMember: (id: string | null) => void;
  revokeGrant: (email: string | null) => void;
};

const PoolDetailContext = createContext<PoolDetailContextValue | null>(null);

function usePoolDetail() {
  const detail = useContext(PoolDetailContext);
  if (!detail) throw new Error("Pool detail tabs must be rendered under PoolDetailPage");
  return detail;
}

/** Where a request goes: local members first, the cloud only for :external when they are busy. */
function PoolFlowStrip() {
  const { t } = useTranslation(["dashboard"]);
  const steps = [
    t("dashboard:pools.flow.app"),
    t("dashboard:pools.flow.pool"),
    t("dashboard:pools.flow.models"),
  ];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3 text-xs">
      {steps.map((step, index) => (
        <span key={step} className="flex items-center gap-2">
          {index > 0 ? (
            <ArrowRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
          ) : null}
          <span className="rounded-md border bg-background px-2 py-1 font-medium">{step}</span>
        </span>
      ))}
      <span className="flex items-center gap-2 text-muted-foreground">
        <ArrowRight aria-hidden="true" className="size-3.5" />
        <span className="rounded-md border border-dashed px-2 py-1">
          {t("dashboard:pools.flow.cloud")}
        </span>
      </span>
    </div>
  );
}

function PoolHealthBadge({ healthy, total }: { healthy: number; total: number }) {
  const { t } = useTranslation(["dashboard"]);
  const tone =
    total === 0
      ? "bg-muted-foreground"
      : healthy === total
        ? "bg-state-success"
        : "bg-state-warning";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone)} />
      {total === 0
        ? t("dashboard:pools.healthNoMembers")
        : healthy === total
          ? t("dashboard:pools.healthAll")
          : t("dashboard:pools.healthSome", { healthy, total })}
    </span>
  );
}

export function PoolsListPage({ lang }: { lang: string }) {
  const { t, i18n } = useTranslation(["common", "dashboard"]);
  const pools = useQuery(orpc.forwarderManagement.listModelPools.queryOptions());
  // Optional traffic summary; the list renders without it.
  const traffic = useQuery({
    ...orpc.overview.metrics.queryOptions({ input: { range: "24h" } }),
    retry: false,
  });

  if (pools.isPending) return <PageSkeleton />;
  if (pools.isError) {
    return (
      <InlineRetry message={t("dashboard:pools.loadFailed")} onRetry={() => void pools.refetch()} />
    );
  }

  return (
    <section className="min-w-0 max-w-full space-y-6">
      <PageHeader
        title={t("dashboard:pools.title")}
        description={t("dashboard:pools.description")}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="touch"
              render={<Link to="/$lang/dashboard/pools/new" params={{ lang }} />}
            >
              <Plus className="size-4" />
              {t("dashboard:pools.wizard.open")}
            </Button>
          </div>
        }
      />

      <PoolFlowStrip />

      {pools.data.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("dashboard:pools.empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {pools.data.map((pool) => {
            const primaryCount = pool.members.filter((member) => member.tier === "PRIMARY").length;
            const overflowCount = pool.members.length - primaryCount;
            const healthyCount = pool.members.filter(
              (member) => member.healthStatus === "HEALTHY",
            ).length;
            const poolTraffic = traffic.data?.pools.find((entry) => entry.poolId === pool.id);
            return (
              <article key={pool.id} className="min-w-0 rounded-md border p-4">
                <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h3 className="font-medium">{pool.name}</h3>
                      <PoolFallbackBadge
                        routes={ownerFallbackRoutes(pool.effectiveProviderEgress)}
                        providers={pool.members.flatMap((member) =>
                          member.tier === "PUBLIC_OVERFLOW" &&
                          member.providerModel?.ProviderAccount.label
                            ? [member.providerModel.ProviderAccount.label]
                            : [],
                        )}
                      />
                      <PoolHealthBadge healthy={healthyCount} total={pool.members.length} />
                    </div>
                    <div className="mt-2 max-w-2xl">
                      <CopyableModelId modelId={pool.canonicalModelId} />
                    </div>
                    {pool.description ? (
                      <p className="mt-2 text-sm text-muted-foreground">{pool.description}</p>
                    ) : null}
                    <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-xs text-muted-foreground sm:grid-cols-3 lg:grid-cols-5">
                      <div>
                        <dt>{t("dashboard:pools.localMembers")}</dt>
                        <dd className="font-medium text-foreground">{primaryCount}</dd>
                      </div>
                      <div>
                        <dt>{t("dashboard:pools.memberTiers.PUBLIC_OVERFLOW")}</dt>
                        <dd className="font-medium text-foreground">{overflowCount}</dd>
                      </div>
                      <div>
                        <dt>{t("dashboard:pools.sharedWith")}</dt>
                        <dd className="font-medium text-foreground">{pool.grants.length}</dd>
                      </div>
                      {poolTraffic ? (
                        <>
                          <div>
                            <dt>{t("dashboard:pools.requests24h")}</dt>
                            <dd className="font-medium text-foreground tabular-nums">
                              {poolTraffic.current.requests.toLocaleString(i18n.language)}
                            </dd>
                          </div>
                          <div>
                            <dt>{t("dashboard:pools.errors24h")}</dt>
                            <dd className="font-medium text-foreground tabular-nums">
                              {poolTraffic.current.errors.toLocaleString(i18n.language)}
                            </dd>
                          </div>
                        </>
                      ) : null}
                    </dl>
                    {poolTraffic && poolTraffic.current.requests > 0 ? (
                      <Sparkline
                        className="mt-3 max-w-xs"
                        label={t("dashboard:pools.trafficTrend", { name: pool.name })}
                        values={poolTraffic.series.map((bucket) =>
                          Object.values(bucket.values).reduce((sum, value) => sum + value, 0),
                        )}
                      />
                    ) : null}
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t("dashboard:pools.recommendedSurface")}:{" "}
                      {pool.compatibility.recommendedSurface
                        ? t(`dashboard:connectionTypes.${pool.compatibility.recommendedSurface}`)
                        : t("dashboard:pools.noneAvailable")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {pool.transformer.model
                        ? `${t("dashboard:pools.transformerActive")}: ${pool.transformer.model.canonicalModelId}`
                        : t("dashboard:pools.transformerOff")}
                    </p>
                  </div>
                  <Button
                    size="touch"
                    variant="outline"
                    aria-label={t("dashboard:pools.editPool", { pool: pool.name })}
                    render={
                      <Link
                        to="/$lang/dashboard/pools/$poolId"
                        params={{ lang, poolId: pool.id }}
                      />
                    }
                  >
                    {t("common:actions.edit")}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function PoolDetailPage({ poolId, lang = "en-US" }: { poolId: string; lang?: string }) {
  const { t } = useTranslation(["common", "dashboard"]);

  const queryClient = useQueryClient();
  const pools = useQuery(orpc.forwarderManagement.listModelPools.queryOptions());
  const devices = useQuery(orpc.forwarderManagement.listCliDevices.queryOptions());
  const { providerEgressEnabled, query: deploymentFlags } = useDeploymentFlags();
  const capacityAvailability = resolveCapacityAvailability();
  const capacities = useQuery({
    ...orpc.capacityManagement.list.queryOptions(),
    retry: false,
    enabled: capacityAvailability === "enabled",
  });
  const [memberDialog, setMemberDialog] = useState<"create" | string | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const [deletePoolOpen, setDeletePoolOpen] = useState(false);
  const [deleteMemberId, setDeleteMemberId] = useState<string | null>(null);
  const [revokeEmail, setRevokeEmail] = useState<string | null>(null);
  const navigate = useNavigate();
  const deletePool = useMutation({
    ...orpc.forwarderManagement.deleteModelPool.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        setDeletePoolOpen(false);
        // The pool's own pages no longer exist; return to the list.
        void navigate({ to: "/$lang/dashboard/pools", params: { lang } });
      },
    }),
    meta: { deletionEntity: "pool" },
  });
  const removeMember = useMutation({
    ...orpc.forwarderManagement.removePoolMember.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        setDeleteMemberId(null);
      },
    }),
    meta: { deletionEntity: "poolMember" },
  });
  const revokeGrant = useMutation(
    orpc.forwarderManagement.revokePoolAccessByEmail.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        setRevokeEmail(null);
      },
    }),
  );

  if (pools.isPending || devices.isPending) return <PageSkeleton />;
  if (pools.isError || devices.isError) {
    return (
      <InlineRetry
        message={t("dashboard:pools.loadFailed")}
        onRetry={() => {
          void pools.refetch();
          void devices.refetch();
        }}
      />
    );
  }
  const pool = pools.data.find((candidate) => candidate.id === poolId);
  if (!pool) {
    return (
      <div
        className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground"
        role="status"
      >
        {t("dashboard:pools.notFound")}
      </div>
    );
  }
  const editingMember =
    memberDialog && memberDialog !== "create"
      ? pool.members.find((member) => member.id === memberDialog)
      : undefined;
  const deletingMember = pool.members.find((member) => member.id === deleteMemberId);
  const revokingGrant = pool.grants.find((grant) => grant.granteeEmail === revokeEmail);

  const detail = {
    pool,
    directModels: allDirectModels(devices.data ?? []),
    capacities: capacities.data ?? [],
    capacityAvailability,
    providerEgressEnabled,
    deploymentFlags,
    openMember: setMemberDialog,
    openGrant: () => setGrantOpen(true),
    openDelete: () => setDeletePoolOpen(true),
    removeMember: setDeleteMemberId,
    revokeGrant: setRevokeEmail,
  };

  return (
    <PoolDetailContext.Provider value={detail}>
      <section className="min-w-0 max-w-full space-y-6">
        <PageHeader
          title={pool.name}
          description={pool.description || pool.slug}
          badge={
            <PoolFallbackBadge
              routes={ownerFallbackRoutes(pool.effectiveProviderEgress)}
              providers={pool.members.flatMap((member) =>
                member.tier === "PUBLIC_OVERFLOW" && member.providerModel?.ProviderAccount.label
                  ? [member.providerModel.ProviderAccount.label]
                  : [],
              )}
            />
          }
          action={
            <div className="flex flex-wrap gap-2">
              <Button size="touch" variant="outline" onClick={() => setGrantOpen(true)}>
                <Plus className="size-4" />
                {t("dashboard:pools.grant")}
              </Button>
              <Button size="touch" variant="outline" onClick={() => setMemberDialog("create")}>
                <Plus className="size-4" />
                {t("dashboard:pools.addMember")}
              </Button>
            </div>
          }
        />
        <div className="min-w-0 shrink-0 overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar">
          <nav
            className="flex w-max items-center gap-1"
            aria-label={t("dashboard:pools.detailNavAriaLabel")}
          >
            {(
              [
                ["overview", "/$lang/dashboard/pools/$poolId"],
                ["fallback", "/$lang/dashboard/pools/$poolId/fallback"],
                ["routing", "/$lang/dashboard/pools/$poolId/routing"],
                ["limits", "/$lang/dashboard/pools/$poolId/limits"],
                ["media", "/$lang/dashboard/pools/$poolId/media"],
                ["sharing", "/$lang/dashboard/pools/$poolId/sharing"],
                ["settings", "/$lang/dashboard/pools/$poolId/settings"],
              ] as const
            ).map(([tab, to]) => (
              <Link
                key={tab}
                to={to}
                params={{ lang, poolId: pool.id }}
                className="min-h-11 shrink-0 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
                activeProps={{ className: "bg-muted text-foreground" }}
                activeOptions={{ exact: tab === "overview" }}
              >
                {t(`dashboard:pools.tabs.${tab}`)}
              </Link>
            ))}
          </nav>
        </div>
        <Outlet />
        <Dialog
          open={Boolean(memberDialog)}
          onOpenChange={(open) => !open && setMemberDialog(null)}
        >
          <DialogContent className="max-h-[min(92vh,56rem)] overflow-x-hidden overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {memberDialog === "create"
                  ? t("dashboard:pools.addMember")
                  : t("dashboard:pools.editMemberTitle")}
              </DialogTitle>
              <DialogDescription>
                {memberDialog === "create"
                  ? t("dashboard:pools.addMemberDescription")
                  : t("dashboard:pools.editMemberDescription")}
              </DialogDescription>
            </DialogHeader>
            {memberDialog === "create" ? (
              <PoolMemberForm
                mode="create"
                poolId={pool.id}
                directModels={detail.directModels}
                capacities={capacities.data ?? []}
                capacityAvailability={capacityAvailability}
                onSuccess={() => setMemberDialog(null)}
              />
            ) : editingMember ? (
              <PoolMemberForm
                mode="edit"
                member={editingMember}
                directModels={detail.directModels}
                capacities={capacities.data ?? []}
                capacityAvailability={capacityAvailability}
                onSuccess={() => setMemberDialog(null)}
              />
            ) : null}
          </DialogContent>
        </Dialog>
        <GrantPoolDialog pool={grantOpen ? pool : null} onOpenChange={setGrantOpen} />
        <ConfirmDeleteDialog
          open={deletePoolOpen}
          onOpenChange={setDeletePoolOpen}
          title={t("dashboard:pools.deleteTitle")}
          description={t("dashboard:pools.deleteDescription")}
          confirmToken={pool.name}
          typePrompt={t("dashboard:pools.name")}
          copyAriaLabel={t("dashboard:actions.copyConfirm")}
          isPending={deletePool.isPending}
          onConfirm={() => deletePool.mutate({ id: pool.id })}
        />
        <ConfirmDeleteDialog
          open={Boolean(deletingMember)}
          onOpenChange={(open) => !open && setDeleteMemberId(null)}
          title={t("dashboard:pools.removeMemberTitle")}
          description={t("dashboard:pools.removeMemberDescription")}
          confirmToken={deletingMember?.model?.canonicalModelId ?? deletingMember?.id ?? ""}
          typePrompt={t("dashboard:pools.memberTarget")}
          copyAriaLabel={t("dashboard:actions.copyConfirm")}
          isPending={removeMember.isPending}
          onConfirm={() => deletingMember && removeMember.mutate({ id: deletingMember.id })}
        />
        <ConfirmDeleteDialog
          open={Boolean(revokingGrant)}
          onOpenChange={(open) => !open && setRevokeEmail(null)}
          title={t("dashboard:pools.revokeGrantTitle")}
          description={t("dashboard:pools.revokeGrantDescription")}
          confirmToken={revokingGrant?.granteeEmail ?? ""}
          typePrompt={t("dashboard:pools.email")}
          copyAriaLabel={t("dashboard:actions.copyConfirm")}
          inputMode="email"
          confirmLabel={t("dashboard:pools.revoke")}
          pendingLabel={t("dashboard:pools.revoking")}
          isPending={revokeGrant.isPending}
          onConfirm={() =>
            revokingGrant &&
            revokeGrant.mutate({ poolId: pool.id, email: revokingGrant.granteeEmail })
          }
        />
      </section>
    </PoolDetailContext.Provider>
  );
}

type PoolMemberLimits = {
  capacityPriority: number | null;
  capacityConcurrencyMode: string;
  capacityConcurrencyLimit: number | null;
  capacityReservedSlots: number | null;
  capacityBorrowPolicy: string | null;
  capacityWaitBudgetMode: string;
  capacityWaitBudgetMs: number | null;
  capacityContextCeilingMode: string;
  capacityContextCeiling: number | null;
  capacityContextMargin: number | null;
};

/** The member limits that differ from the pool's, as short "label value" strings. */
function memberCustomLimits(
  member: PoolMemberLimits,
  t: (key: string, options?: { count: number }) => string,
  locale: string,
): string[] {
  const field = (name: string) => t(`dashboard:pools.capacity.fields.${name}`);
  const unlimited = t("dashboard:pools.capacity.modes.unlimited");
  const number = (value: number | null) => (value ?? 0).toLocaleString(locale);
  const seconds = (ms: number | null) =>
    t("dashboard:pools.capacity.presets.seconds", { count: (ms ?? 0) / 1000 });
  const limited = (mode: string, value: number | null, format = number) =>
    mode === "UNLIMITED" ? unlimited : format(value);
  const out: string[] = [];
  if (member.capacityPriority !== null)
    out.push(`${field("capacityPriority")} ${member.capacityPriority}`);
  if (member.capacityConcurrencyMode !== "INHERIT")
    out.push(
      `${field("capacityConcurrencyLimit")} ${limited(member.capacityConcurrencyMode, member.capacityConcurrencyLimit)}`,
    );
  if (member.capacityReservedSlots !== null)
    out.push(`${field("capacityReservedSlots")} ${member.capacityReservedSlots}`);
  if (member.capacityWaitBudgetMode !== "INHERIT")
    out.push(
      `${field("capacityWaitBudgetMs")} ${limited(member.capacityWaitBudgetMode, member.capacityWaitBudgetMs, seconds)}`,
    );
  if (member.capacityContextCeilingMode !== "INHERIT")
    out.push(
      `${field("capacityContextCeiling")} ${limited(member.capacityContextCeilingMode, member.capacityContextCeiling)}`,
    );
  if (member.capacityContextMargin !== null)
    out.push(`${field("capacityContextMargin")} ${number(member.capacityContextMargin)}`);
  if (member.capacityBorrowPolicy !== null)
    out.push(
      `${field("capacityBorrowPolicy")} ${
        member.capacityBorrowPolicy === "NEVER"
          ? t("dashboard:pools.capacity.borrowNever")
          : t("dashboard:pools.capacity.borrowIdle")
      }`,
    );
  return out;
}

type OverflowMember = PoolDetailContextValue["pool"]["members"][number];

/** Cloud fallback members in the order they are tried, with move controls. */
function PoolProviderOrder({
  members,
  enabled,
}: {
  members: readonly OverflowMember[];
  enabled: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  // Failures use the global mutation toast (one toast per failure).
  const reorder = useMutation({
    ...orpc.forwarderManagement.reorderProviderPoolMember.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() }),
    }),
    meta: { errorFallbackKey: "dashboard:providers.feedback.failed" },
  });
  return (
    <section className="space-y-2" aria-labelledby="pool-provider-order-title">
      <h4 id="pool-provider-order-title" className="text-sm font-semibold">
        {t("dashboard:pools.providerOrder.title")}
      </h4>
      <p className="text-xs text-muted-foreground">{t("dashboard:pools.providerOrder.hint")}</p>
      <ol className="space-y-2">
        {members.map((member, index) => {
          const name =
            member.providerModel?.upstreamModelId ?? member.model?.canonicalModelId ?? member.id;
          return (
            <li
              key={member.id}
              className="flex min-w-0 flex-wrap items-center gap-3 border p-3"
              data-testid="provider-order-row"
            >
              <span
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <code className="block break-all text-xs">{name}</code>
                {member.providerModel?.ProviderAccount.label ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {member.providerModel.ProviderAccount.label}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  disabled={!enabled || index === 0 || reorder.isPending}
                  aria-label={t("dashboard:pools.providerOrder.moveEarlier", { name })}
                  onClick={() => reorder.mutate({ id: member.id, direction: "EARLIER" })}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  disabled={!enabled || index === members.length - 1 || reorder.isPending}
                  aria-label={t("dashboard:pools.providerOrder.moveLater", { name })}
                  onClick={() => reorder.mutate({ id: member.id, direction: "LATER" })}
                >
                  <ArrowDown className="size-4" />
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function PoolDetailTab({
  tab,
}: {
  tab: "overview" | "fallback" | "routing" | "limits" | "media" | "sharing" | "settings";
}) {
  const { t, i18n } = useTranslation(["common", "dashboard"]);
  const detail = usePoolDetail();
  const { pool } = detail;

  if (tab === "overview") {
    return (
      <div className="space-y-6">
        <PoolCacheStats poolId={pool.id} />
        <section className="space-y-3 border-t pt-6" aria-labelledby="pool-members-title">
          <h3 id="pool-members-title" className="text-base font-semibold">
            {t("dashboard:pools.membersTitle")}
          </h3>
          {pool.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dashboard:pools.noMembers")}</p>
          ) : (
            <ul className="space-y-2">
              {pool.members.map((member) => {
                const custom = memberCustomLimits(member, t, i18n.language);
                return (
                  <li
                    key={member.id}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-3 border p-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <code className="block break-all font-mono text-xs">
                        {member.model?.canonicalModelId ?? member.discoveredModelId ?? member.id}
                      </code>
                      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span
                          className={cn(
                            "rounded-sm border px-1.5 py-0.5 font-medium",
                            member.routingStatus === "ACTIVE"
                              ? "border-emerald-600/40 text-emerald-700 dark:text-emerald-300"
                              : "border-amber-600/40 text-amber-700 dark:text-amber-300",
                          )}
                        >
                          {t(`dashboard:overview.pools.routing.${member.routingStatus}`)}
                        </span>
                        <span className="text-muted-foreground">
                          {member.tier === "PUBLIC_OVERFLOW"
                            ? t("dashboard:pools.memberTiers.PUBLIC_OVERFLOW")
                            : `${t("dashboard:pools.weight")}: ${member.weight}`}
                        </span>
                      </p>
                      {/* Capacity limits govern local members only. */}
                      {member.tier === "PUBLIC_OVERFLOW" ? null : (
                        <p className="text-xs text-muted-foreground" data-testid="member-limits">
                          {custom.length === 0
                            ? t("dashboard:pools.memberLimits.inherited")
                            : `${t("dashboard:pools.memberLimits.custom", { count: custom.length })}: ${custom.join(" · ")}`}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        size="touch"
                        variant="outline"
                        onClick={() => detail.openMember(member.id)}
                      >
                        {t("common:actions.edit")}
                      </Button>
                      <Button
                        size="touch"
                        variant="destructive"
                        onClick={() => detail.removeMember(member.id)}
                      >
                        {t("dashboard:pools.removeMember")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    );
  }
  if (tab === "settings") {
    return (
      <div className="space-y-8">
        <PoolForm
          key={`${pool.id}-identity`}
          pool={pool}
          directModels={detail.directModels}
          capacities={detail.capacities}
          capacityAvailability={detail.capacityAvailability}
          sections={["identity"]}
          stickySave
          onSuccess={() => undefined}
        />
        <section
          className="space-y-3 rounded-md border border-destructive/40 p-4"
          aria-labelledby="pool-danger-title"
        >
          <h3 id="pool-danger-title" className="text-base font-semibold text-destructive">
            {t("dashboard:pools.dangerZone.title")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("dashboard:pools.dangerZone.body")}</p>
          <Button size="touch" variant="destructive" onClick={detail.openDelete}>
            <Trash2 className="size-4" />
            {t("common:actions.delete")}
          </Button>
        </section>
      </div>
    );
  }
  if (tab === "routing") {
    return (
      <div className="space-y-8">
        <PoolExecutionPolicy
          key={`${pool.id}-${String(pool.paidWarmProtectionEnabled)}-${JSON.stringify(pool.embeddingContract)}`}
          pool={pool}
        />
        <PoolForm
          key={`${pool.id}-${tab}`}
          pool={pool}
          directModels={detail.directModels}
          capacities={detail.capacities}
          capacityAvailability={detail.capacityAvailability}
          sections={[tab]}
          stickySave
          onSuccess={() => undefined}
        />
        <div className="border-t pt-6">
          <PoolMetricRoutingRules poolId={pool.id} />
        </div>
      </div>
    );
  }
  if (tab === "limits" || tab === "media") {
    return (
      <PoolForm
        key={`${pool.id}-${tab}`}
        pool={pool}
        directModels={detail.directModels}
        capacities={detail.capacities}
        capacityAvailability={detail.capacityAvailability}
        sections={[tab === "limits" ? "capacity" : "media"]}
        stickySave
        onSuccess={() => undefined}
      />
    );
  }
  if (tab === "sharing") {
    return (
      <PoolGrantsSection
        pool={pool}
        openGrant={detail.openGrant}
        revokeGrant={detail.revokeGrant}
      />
    );
  }
  if (detail.deploymentFlags.isPending)
    return (
      <div aria-busy="true" className="space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  if (detail.deploymentFlags.isError)
    return (
      <InlineRetry
        message={t("dashboard:deploymentFeatures.loadFailed")}
        onRetry={detail.deploymentFlags.refetch}
      />
    );
  const overflowMembers = pool.members
    .filter((member) => member.tier === "PUBLIC_OVERFLOW")
    // Same order as the server: publicOrder, then id.
    .sort(
      (left, right) =>
        (left.publicOrder ?? Number.MAX_SAFE_INTEGER) -
          (right.publicOrder ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
    );
  const fallbackEnabled = detail.providerEgressEnabled;
  return (
    <section className="space-y-4" aria-labelledby="pool-fallback-title">
      <div>
        <h3 id="pool-fallback-title" className="text-base font-semibold">
          {t("dashboard:pools.tabs.fallback")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("dashboard:pools.fallbackDescription")}
        </p>
      </div>
      {!fallbackEnabled ? (
        <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t("dashboard:pools.fallbackDisabledDeployment")}
        </p>
      ) : null}
      <PoolFallbackSettings
        key={`${pool.id}-fallback`}
        pool={pool}
        providerEgressEnabled={fallbackEnabled}
      />
      <PoolFallbackHistory poolId={pool.id} />
      {overflowMembers.length ? (
        <PoolProviderOrder members={overflowMembers} enabled={fallbackEnabled} />
      ) : (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          <p>{t("dashboard:pools.fallbackEmpty")}</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5">
            <li>{t("dashboard:pools.fallbackSteps.account")}</li>
            <li>{t("dashboard:pools.fallbackSteps.model")}</li>
            <li>{t("dashboard:pools.fallbackSteps.ceiling")}</li>
            <li>{t("dashboard:pools.fallbackSteps.enable")}</li>
          </ol>
          {fallbackEnabled ? (
            <Button className="mt-4" size="touch" render={<a href="#provider-operations" />}>
              {t("dashboard:pools.addFallbackProvider")}
            </Button>
          ) : null}
        </div>
      )}
      <div id="provider-operations">
        <ProviderOperationsSection />
      </div>
    </section>
  );
}

const POOL_FALLBACK_FIELDS = [
  "fallbackEnabled",
  "fallbackForGrantees",
  "externalAfterWaitMs",
] as const;

const poolFallbackAuditMetadata = z.object({
  source: z.enum(["mcp", "dashboard"]).optional(),
  changes: z
    .record(
      z.string(),
      z.object({
        before: z.union([z.boolean(), z.number(), z.null()]),
        after: z.union([z.boolean(), z.number()]),
      }),
    )
    .optional(),
});

/**
 * The pool's external-fallback change history (POOL_FALLBACK_UPDATED audit
 * events). MCP agents change these settings without per-change confirmation
 * (owner decision on #67), so every change, and where it came from, is shown
 * here next to the settings.
 */
function PoolFallbackHistory({ poolId }: { poolId: string }) {
  const { t, i18n } = useTranslation(["common", "dashboard"]);
  const events = useQuery({
    ...orpc.providerManagement.listAuditEvents.queryOptions({ input: { poolId, limit: 20 } }),
    retry: false,
  });
  const dateTime = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const showValue = (value: boolean | number | null) =>
    value === null
      ? t("dashboard:pools.fallbackHistory.unset")
      : typeof value === "boolean"
        ? t(value ? "dashboard:pools.fallbackHistory.on" : "dashboard:pools.fallbackHistory.off")
        : t("dashboard:pools.fallbackHistory.milliseconds", { value });
  return (
    <div className="min-w-0 space-y-2 rounded-md border p-4">
      <h4 className="text-sm font-medium">{t("dashboard:pools.fallbackHistory.title")}</h4>
      {events.isError ? (
        <InlineRetry
          message={t("dashboard:pools.fallbackHistory.failed")}
          onRetry={() => void events.refetch()}
        />
      ) : events.isPending ? (
        <Skeleton className="h-16" />
      ) : events.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("dashboard:pools.fallbackHistory.empty")}
        </p>
      ) : (
        <ol className="space-y-2">
          {events.data.map((event) => {
            const metadata = poolFallbackAuditMetadata.safeParse(event.metadata);
            const source = metadata.success ? metadata.data.source : undefined;
            const changes = metadata.success ? (metadata.data.changes ?? {}) : {};
            return (
              <li
                key={event.id}
                className="min-w-0 border-t pt-2 text-sm first:border-t-0 first:pt-0"
              >
                <p className="text-xs text-muted-foreground">
                  {dateTime.format(new Date(event.createdAt))}
                  {" · "}
                  {source === "mcp"
                    ? t("dashboard:pools.fallbackHistory.sourceMcp")
                    : source === "dashboard"
                      ? t("dashboard:pools.fallbackHistory.sourceDashboard")
                      : t("dashboard:pools.fallbackHistory.sourceUnknown")}
                </p>
                <ul className="mt-1 space-y-1">
                  {POOL_FALLBACK_FIELDS.filter((field) => changes[field] !== undefined).map(
                    (field) => (
                      <li key={field} className="break-words">
                        {t("dashboard:pools.fallbackHistory.change", {
                          field: t(`dashboard:pools.fallbackHistory.fields.${field}`),
                          before: showValue(changes[field]!.before),
                          after: showValue(changes[field]!.after),
                        })}
                      </li>
                    ),
                  )}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

type PoolGrantRow = PoolDetailModel["grants"][number];

/** "Pool default" / "Unprotected" / "N %" for a protection override. */
function protectionOverrideLabel(
  percent: number | null,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (percent === null) return t("dashboard:pools.grantRouting.inherit");
  if (percent === 0) return t("dashboard:pools.protection.override.UNPROTECTED");
  return t("dashboard:pools.grantRouting.percentValue", { percent });
}

function spendCapLabel(
  spend: PoolGrantRow["fallbackSpend"],
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!spend) return t("dashboard:pools.grantRouting.spendCapNone");
  return t("dashboard:pools.grantRouting.spendCapSummary", {
    limit: spend.limit,
    currency: spend.currency,
    period: t(`dashboard:providers.enums.${spend.period}`),
  });
}

function PoolGrantsSection({
  pool,
  openGrant,
  revokeGrant,
}: {
  pool: PoolDetailModel;
  openGrant: () => void;
  revokeGrant: (email: string) => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const [editingGrantId, setEditingGrantId] = useState<string | null>(null);
  const editingGrant = pool.grants.find((grant) => grant.id === editingGrantId);
  return (
    <section className="space-y-3" aria-labelledby="pool-grants-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="pool-grants-title" className="text-base font-semibold">
          {t("dashboard:pools.grantsTitle")}
        </h3>
        <Button size="touch" onClick={openGrant}>
          <Plus className="size-4" />
          {t("dashboard:pools.grant")}
        </Button>
      </div>
      {pool.grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("dashboard:pools.noGrants")}</p>
      ) : (
        <ul className="space-y-2">
          {pool.grants.map((grant) => (
            <li
              key={grant.granteeEmail}
              className="flex min-w-0 flex-wrap items-center justify-between gap-3 border p-3"
            >
              <div className="min-w-0 space-y-1">
                <span className="block break-all text-sm">{grant.granteeEmail}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("dashboard:pools.grantRouting.summary", {
                    protection: protectionOverrideLabel(grant.protectionOverridePercent, t),
                    priority:
                      grant.queuePriority === null
                        ? t("dashboard:pools.grantRouting.inherit")
                        : grant.queuePriority,
                    spendCap: spendCapLabel(grant.fallbackSpend, t),
                  })}
                </span>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  size="touch"
                  variant="outline"
                  onClick={() => setEditingGrantId(grant.id)}
                  aria-label={t("dashboard:pools.grantRouting.editFor", {
                    email: grant.granteeEmail,
                  })}
                >
                  {t("dashboard:pools.grantRouting.edit")}
                </Button>
                <Button
                  size="touch"
                  variant="destructive"
                  onClick={() => revokeGrant(grant.granteeEmail)}
                >
                  {t("dashboard:pools.revokeGrant")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={Boolean(editingGrant)}
        onOpenChange={(open) => !open && setEditingGrantId(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dashboard:pools.grantRouting.title")}</DialogTitle>
            <DialogDescription>
              {t("dashboard:pools.grantRouting.description", {
                email: editingGrant?.granteeEmail ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          {editingGrant ? (
            <PoolGrantRoutingForm
              key={editingGrant.id}
              poolId={pool.id}
              grant={editingGrant}
              onSaved={() => setEditingGrantId(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * Owner-only per-grant routing (saturation S-C): the grantee's warm-session
 * protection override and queue priority.
 */
function PoolGrantRoutingForm({
  poolId,
  grant,
  onSaved,
}: {
  poolId: string;
  grant: PoolGrantRow;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation(["common", "dashboard"]);
  const locale = i18n.language || DEFAULT_LOCALE;
  const queryClient = useQueryClient();
  const update = useMutation({
    ...orpc.forwarderManagement.updatePoolGrant.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.grantRouting.saved"));
        onSaved();
      },
      onError: (error) => {
        toast.error(friendly(error, t("dashboard:pools.grantRouting.failed")));
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: {
      protectionMode: (grant.protectionOverridePercent === null
        ? "INHERIT"
        : grant.protectionOverridePercent === 0
          ? "UNPROTECTED"
          : "PERCENT") as "INHERIT" | "PERCENT" | "UNPROTECTED",
      protectionPercent: grant.protectionOverridePercent || 50,
      priorityMode: (grant.queuePriority === null ? "INHERIT" : "SET") as "INHERIT" | "SET",
      queuePriority: grant.queuePriority ?? 16,
      spendMode: (grant.fallbackSpend == null ? "NONE" : "SET") as "NONE" | "SET",
      spendLimit: grant.fallbackSpend?.limit ?? "10",
      spendCurrency: grant.fallbackSpend?.currency ?? "USD",
      spendPeriod: (grant.fallbackSpend?.period ?? "UTC_MONTH") as "UTC_DAY" | "UTC_MONTH",
    },
    validators: {
      // A hidden field (its mode not selected) is never validated.
      onSubmit: z
        .object({
          protectionMode: z.enum(["INHERIT", "PERCENT", "UNPROTECTED"]),
          protectionPercent: z.number(),
          priorityMode: z.enum(["INHERIT", "SET"]),
          queuePriority: z.number(),
          spendMode: z.enum(["NONE", "SET"]),
          spendLimit: z.string(),
          spendCurrency: z.string(),
          spendPeriod: z.enum(["UTC_DAY", "UTC_MONTH"]),
        })
        .refine(
          (value) =>
            value.protectionMode !== "PERCENT" ||
            (Number.isInteger(value.protectionPercent) &&
              value.protectionPercent >= 1 &&
              value.protectionPercent <= 100),
        )
        .refine(
          (value) =>
            value.priorityMode !== "SET" ||
            (Number.isInteger(value.queuePriority) &&
              value.queuePriority >= 0 &&
              value.queuePriority <= 31),
        )
        .superRefine((value, ctx) => {
          if (value.spendMode !== "SET") return;
          const limit = parseLocaleDecimal(value.spendLimit, locale);
          if (limit === null) {
            ctx.addIssue({
              code: "custom",
              path: ["spendLimit"],
              message: t("dashboard:pools.grantRouting.spendLimitInvalid"),
            });
            return;
          }
          const currency = value.spendCurrency.trim().toUpperCase();
          const parsed = poolGrantSpendCapSchema.safeParse({
            limit,
            currency,
            period: value.spendPeriod,
          });
          const positive = Number(limit) > 0;
          if (parsed.success && positive) return;
          const paths = new Set(
            (parsed.success ? [] : parsed.error.issues).map((issue) => issue.path[0]),
          );
          if (!parsed.success && paths.has("currency")) {
            ctx.addIssue({
              code: "custom",
              path: ["spendCurrency"],
              message: t("dashboard:pools.grantRouting.spendCurrencyInvalid"),
            });
          }
          if (!positive || paths.has("limit") || paths.size === 0) {
            ctx.addIssue({
              code: "custom",
              path: ["spendLimit"],
              message: t("dashboard:pools.grantRouting.spendLimitInvalid"),
            });
          }
        }),
    },
    onSubmit: async ({ value }) => {
      await update
        .mutateAsync({
          poolId,
          grantId: grant.id,
          protectionOverridePercent:
            value.protectionMode === "INHERIT"
              ? null
              : value.protectionMode === "UNPROTECTED"
                ? 0
                : value.protectionPercent,
          queuePriority: value.priorityMode === "INHERIT" ? null : value.queuePriority,
          fallbackSpend:
            value.spendMode === "NONE"
              ? null
              : {
                  limit: parseLocaleDecimal(value.spendLimit, locale) ?? value.spendLimit,
                  currency: value.spendCurrency.trim().toUpperCase(),
                  period: value.spendPeriod,
                },
        })
        .catch(() => undefined);
    },
  });
  return (
    <form
      className="min-w-0 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="protectionMode">
        {(modeField) => (
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`grant-protection-${grant.id}`}>
              {t("dashboard:pools.grantRouting.protection")}
            </Label>
            <select
              id={`grant-protection-${grant.id}`}
              className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
              value={modeField.state.value}
              onChange={(event) =>
                modeField.handleChange(event.target.value as "INHERIT" | "PERCENT" | "UNPROTECTED")
              }
            >
              <option value="INHERIT">{t("dashboard:pools.protection.override.INHERIT")}</option>
              <option value="PERCENT">{t("dashboard:pools.protection.override.PERCENT")}</option>
              <option value="UNPROTECTED">
                {t("dashboard:pools.protection.override.UNPROTECTED")}
              </option>
            </select>
            {modeField.state.value === "PERCENT" ? (
              <form.Field name="protectionPercent">
                {(field) => (
                  <Input
                    className="min-h-11"
                    type="number"
                    min={1}
                    max={100}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(Number(event.target.value))}
                    aria-label={t("dashboard:pools.protection.percentLabel")}
                  />
                )}
              </form.Field>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("dashboard:pools.grantRouting.protectionHint")}
            </p>
          </div>
        )}
      </form.Field>
      <form.Field name="priorityMode">
        {(modeField) => (
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`grant-priority-${grant.id}`}>
              {t("dashboard:pools.grantRouting.queuePriority")}
            </Label>
            <select
              id={`grant-priority-${grant.id}`}
              className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
              value={modeField.state.value}
              onChange={(event) => modeField.handleChange(event.target.value as "INHERIT" | "SET")}
            >
              <option value="INHERIT">{t("dashboard:pools.grantRouting.inherit")}</option>
              <option value="SET">{t("dashboard:pools.grantRouting.prioritySet")}</option>
            </select>
            {modeField.state.value === "SET" ? (
              <form.Field name="queuePriority">
                {(field) => (
                  <Input
                    className="min-h-11"
                    type="number"
                    min={0}
                    max={31}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(Number(event.target.value))}
                    aria-label={t("dashboard:pools.grantRouting.priorityValue")}
                  />
                )}
              </form.Field>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("dashboard:pools.grantRouting.priorityHint")}
            </p>
          </div>
        )}
      </form.Field>
      <form.Field name="spendMode">
        {(modeField) => (
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`grant-spend-${grant.id}`}>
              {t("dashboard:pools.grantRouting.spendCap")}
            </Label>
            <select
              id={`grant-spend-${grant.id}`}
              className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
              value={modeField.state.value}
              onChange={(event) => modeField.handleChange(event.target.value as "NONE" | "SET")}
            >
              <option value="NONE">{t("dashboard:pools.grantRouting.spendCapNone")}</option>
              <option value="SET">{t("dashboard:pools.grantRouting.spendCapSet")}</option>
            </select>
            {modeField.state.value === "SET" ? (
              <div className="grid min-w-0 gap-2 sm:grid-cols-3">
                <form.Field name="spendLimit">
                  {(field) => (
                    <div className="min-w-0 space-y-1">
                      <Input
                        className="min-h-11 min-w-0"
                        inputMode="decimal"
                        aria-invalid={field.state.meta.errors.length > 0}
                        aria-describedby={
                          field.state.meta.errors.length > 0
                            ? `grant-spend-errors-${grant.id}`
                            : undefined
                        }
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-label={t("dashboard:pools.grantRouting.spendLimit")}
                      />
                      <div id={`grant-spend-errors-${grant.id}`}>
                        {field.state.meta.errors.map((error) => (
                          <p key={error?.message} className="text-sm text-destructive">
                            {error?.message}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </form.Field>
                <form.Field name="spendCurrency">
                  {(field) => (
                    <div className="min-w-0 space-y-1">
                      <Input
                        className="min-h-11 min-w-0 uppercase"
                        maxLength={3}
                        aria-invalid={field.state.meta.errors.length > 0}
                        aria-describedby={
                          field.state.meta.errors.length > 0
                            ? `grant-currency-errors-${grant.id}`
                            : undefined
                        }
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value.toUpperCase())}
                        aria-label={t("dashboard:pools.grantRouting.spendCurrency")}
                      />
                      <div id={`grant-currency-errors-${grant.id}`}>
                        {field.state.meta.errors.map((error) => (
                          <p key={error?.message} className="text-sm text-destructive">
                            {error?.message}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </form.Field>
                <form.Field name="spendPeriod">
                  {(field) => (
                    <select
                      className="h-11 min-w-0 rounded-md border bg-transparent px-3 text-sm"
                      value={field.state.value}
                      onChange={(event) =>
                        field.handleChange(event.target.value as "UTC_DAY" | "UTC_MONTH")
                      }
                      aria-label={t("dashboard:pools.grantRouting.spendPeriod")}
                    >
                      <option value="UTC_DAY">
                        {t("dashboard:pools.grantRouting.spendPeriodDay")}
                      </option>
                      <option value="UTC_MONTH">
                        {t("dashboard:pools.grantRouting.spendPeriodMonth")}
                      </option>
                    </select>
                  )}
                </form.Field>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("dashboard:pools.grantRouting.spendCapHint")}
            </p>
          </div>
        )}
      </form.Field>
      <Button type="submit" size="touch" disabled={update.isPending}>
        {t("common:actions.save")}
      </Button>
    </form>
  );
}

/**
 * Owner fallback settings. Callers opt in per request with
 * `owner/pool:external`; the plain name never leaves the deployment.
 */
function PoolFallbackSettings({
  pool,
  providerEgressEnabled,
}: {
  pool: PoolDetailModel;
  providerEgressEnabled: boolean;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const update = useMutation({
    ...orpc.forwarderManagement.updateModelPool.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        // The save wrote a POOL_FALLBACK_UPDATED event: refresh the history.
        void queryClient.invalidateQueries({
          queryKey: orpc.providerManagement.listAuditEvents.key(),
        });
        toast.success(t("dashboard:pools.fallbackSettings.saved"));
      },
      onError: (error) => {
        // The deployment switch turned off after this form loaded: the server
        // refuses turning fallback on. Say so, and refresh the switch state.
        if (poolMutationFailureReason(error) === "PROVIDER_EGRESS_DISABLED") {
          toast.error(t("dashboard:pools.fallbackSettings.enableBlockedDeployment"));
          void queryClient.invalidateQueries({ queryKey: orpc.deploymentFlags.key() });
          return;
        }
        toast.error(friendly(error, t("dashboard:pools.fallbackSettings.failed")));
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: {
      fallbackEnabled: pool.fallbackEnabled,
      fallbackForGrantees: pool.fallbackForGrantees,
      externalAfterWaitMs: String(pool.externalAfterWaitMs),
    },
    validators: {
      onSubmit: z.object({
        fallbackEnabled: z.boolean(),
        fallbackForGrantees: z.boolean(),
        externalAfterWaitMs: z
          .string()
          .trim()
          .regex(/^\d+$/, t("dashboard:pools.fallbackSettings.waitInvalid"))
          .refine(
            (value) => Number(value) <= 600_000,
            t("dashboard:pools.fallbackSettings.waitInvalid"),
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      // Send only what changed, so an unrelated stored value can never make
      // this save fail. Enabling stays gated by the deployment switch
      // server-side; disabling is always allowed and keeps members configured.
      if (!providerEgressEnabled) {
        const enablingFallback = value.fallbackEnabled && !pool.fallbackEnabled;
        const enablingGrantees = value.fallbackForGrantees && !pool.fallbackForGrantees;
        if (enablingFallback || enablingGrantees) {
          toast.error(t("dashboard:pools.fallbackSettings.enableBlockedDeployment"));
          return;
        }
      }
      const externalAfterWaitMs = Number(value.externalAfterWaitMs);
      const changes = {
        ...(value.fallbackEnabled !== pool.fallbackEnabled
          ? { fallbackEnabled: value.fallbackEnabled }
          : {}),
        ...(value.fallbackForGrantees !== pool.fallbackForGrantees
          ? { fallbackForGrantees: value.fallbackForGrantees }
          : {}),
        ...(externalAfterWaitMs !== pool.externalAfterWaitMs ? { externalAfterWaitMs } : {}),
      };
      if (Object.keys(changes).length === 0) return;
      // Errors are surfaced by the mutation's onError (toast).
      await update.mutateAsync({ id: pool.id, ...changes }).catch(() => undefined);
    },
  });
  return (
    <form
      className="min-w-0 space-y-3 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t("dashboard:pools.fallbackSettings.description", {
          externalModelId: `${pool.canonicalModelId}:external`,
          modelId: pool.canonicalModelId,
        })}
      </p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1 rounded-md border p-3">
          <p className="text-sm font-medium">{t("dashboard:pools.fallbackCompare.localTitle")}</p>
          <p className="text-xs text-muted-foreground">
            {t("dashboard:pools.fallbackCompare.localBody")}
          </p>
          <CopyableModelId modelId={pool.canonicalModelId} />
        </div>
        <div className="min-w-0 space-y-1 rounded-md border border-dashed p-3">
          <p className="text-sm font-medium">{t("dashboard:pools.fallbackCompare.cloudTitle")}</p>
          <p className="text-xs text-muted-foreground">
            {t("dashboard:pools.fallbackCompare.cloudBody")}
          </p>
          <CopyableModelId modelId={`${pool.canonicalModelId}:external`} />
        </div>
      </div>
      <form.Field name="fallbackEnabled">
        {(field) => (
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <Checkbox
              disabled={update.isPending || (!providerEgressEnabled && !field.state.value)}
              checked={field.state.value}
              onCheckedChange={(checked) => field.handleChange(checked === true)}
            />
            <span>{t("dashboard:pools.fallbackSettings.enabled")}</span>
          </label>
        )}
      </form.Field>
      <form.Field name="fallbackForGrantees">
        {(field) => (
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <Checkbox
              disabled={update.isPending || (!providerEgressEnabled && !field.state.value)}
              checked={field.state.value}
              onCheckedChange={(checked) => field.handleChange(checked === true)}
            />
            <span>{t("dashboard:pools.fallbackSettings.forGrantees")}</span>
          </label>
        )}
      </form.Field>
      <p className="text-xs text-muted-foreground">
        {t("dashboard:pools.fallbackSettings.granteesHint")}
      </p>
      <form.Field name="externalAfterWaitMs">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={`pool-external-after-${pool.id}`}>
              {t("dashboard:pools.fallbackSettings.externalAfterWaitMs")}
            </Label>
            <Input
              id={`pool-external-after-${pool.id}`}
              name={field.name}
              className="min-h-11"
              inputMode="numeric"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("dashboard:pools.fallbackSettings.externalAfterWaitHint")}
            </p>
            {field.state.meta.errors.map((error) => (
              <p key={error?.message} className="text-sm text-destructive">
                {error?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>
      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button type="submit" size="touch" disabled={!canSubmit || isSubmitting}>
            {t("dashboard:pools.fallbackSettings.save")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

/** Relay 2.7 engine facts the CLI detected for this capacity, and their source. */
function CapacityEngineFacts({ capacity }: { capacity: PoolDetailCapacity }) {
  const { t } = useTranslation(["dashboard"]);
  const hasFacts = Boolean(
    capacity.engineKind ||
      capacity.engineSlots !== null ||
      capacity.kvBudgetTokens !== null ||
      capacity.maxModelLen !== null,
  );
  const showChart = capacity._count.ExecutionTargets === 1;
  if (!hasFacts && !showChart) return null;
  const withProvenance = (text: string, source: PoolDetailCapacity["engineSlotsSource"]) =>
    source ? `${text} · ${t(`dashboard:pools.capacity.engineFacts.factSources.${source}`)}` : text;
  const facts = [
    capacity.engineKind
      ? t("dashboard:pools.capacity.engineFacts.engine", {
          engine: t(`dashboard:pools.capacity.engineFacts.kinds.${capacity.engineKind}`),
        })
      : null,
    capacity.engineSlots !== null
      ? withProvenance(
          t("dashboard:pools.capacity.engineFacts.slots", { count: capacity.engineSlots }),
          capacity.engineSlotsSource,
        )
      : null,
    capacity.kvBudgetTokens !== null
      ? [
          withProvenance(
            t("dashboard:pools.capacity.engineFacts.kvBudget", {
              value: capacity.kvBudgetTokens.toLocaleString(),
            }),
            capacity.kvBudgetTokensSource,
          ),
          typeof capacity.effectiveKvBudgetTokens === "number" &&
          capacity.effectiveKvBudgetTokens < capacity.kvBudgetTokens
            ? t("dashboard:pools.capacity.engineFacts.kvBudgetEffective", {
                value: capacity.effectiveKvBudgetTokens.toLocaleString(),
              })
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" · ")
      : null,
    capacity.maxModelLen !== null
      ? withProvenance(
          t("dashboard:pools.capacity.engineFacts.maxModelLen", {
            value: capacity.maxModelLen.toLocaleString(),
          }),
          capacity.maxModelLenSource,
        )
      : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <div className="mt-2 min-w-0 space-y-1 text-xs text-muted-foreground">
      {hasFacts ? (
        <>
          <p className="break-words">{facts.join(" · ")}</p>
          <p className="break-words">
            {t("dashboard:pools.capacity.engineFacts.preset", {
              preset: t(
                `dashboard:pools.capacity.engineFacts.presets.${capacity.enginePreset.preset}`,
              ),
            })}
            {capacity.engineFactsSource
              ? ` · ${t(`dashboard:pools.capacity.engineFacts.sources.${capacity.engineFactsSource}`)}`
              : null}
          </p>
        </>
      ) : null}
      {showChart ? <CapacityEngineLoadChart capacityId={capacity.id} /> : null}
    </div>
  );
}

/** What a runtime limits versus what a pool's limits divide. */
function RuntimeLayers() {
  const { t } = useTranslation(["dashboard"]);
  return (
    <div className="grid min-w-0 overflow-hidden rounded-md border md:grid-cols-2">
      <div className="min-w-0 space-y-1 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Cpu aria-hidden="true" className="size-4 shrink-0 text-primary" />
          {t("dashboard:pools.capacity.layers.runtimeTitle")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("dashboard:pools.capacity.layers.runtimeBody")}
        </p>
      </div>
      <div className="min-w-0 space-y-1 border-t p-4 md:border-t-0 md:border-s">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Network aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          {t("dashboard:pools.capacity.layers.poolTitle")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("dashboard:pools.capacity.layers.poolBody")}
        </p>
      </div>
    </div>
  );
}

export function InferenceCapacityPage() {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const availability = resolveCapacityAvailability();
  const capacities = useQuery({
    ...orpc.capacityManagement.list.queryOptions(),
    retry: false,
    enabled: availability === "enabled",
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const remove = useMutation({
    ...orpc.capacityManagement.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.capacityManagement.key() });
        setDeletingId(null);
      },
    }),
    meta: { deletionEntity: "capacity" },
  });

  if (availability === "loading" || (availability === "enabled" && capacities.isPending)) {
    return <PageSkeleton />;
  }
  if (capacities.isError) {
    return (
      <InlineRetry
        message={t("dashboard:pools.capacity.settingsFailed")}
        onRetry={() => void capacities.refetch()}
      />
    );
  }
  const editing = capacities.data?.find((capacity) => capacity.id === editingId);
  const deleting = capacities.data?.find((capacity) => capacity.id === deletingId);
  return (
    <section className="min-w-0 max-w-full space-y-6">
      <PageHeader
        title={t("dashboard:pools.capacity.title")}
        description={t("dashboard:pools.capacity.description")}
        action={
          <Button size="touch" onClick={() => setCreating((current) => !current)}>
            <Plus className="size-4" />
            {t("dashboard:pools.capacity.create")}
          </Button>
        }
      />
      <RuntimeLayers />
      {availability !== "enabled" ? (
        <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t(
            availability === "disabled"
              ? "dashboard:pools.capacity.disabledReason"
              : "dashboard:pools.capacity.settingsFailed",
          )}
        </p>
      ) : null}
      {creating ? (
        <div className="min-w-0 border-t pt-6">
          <CapacitySetupForm
            capacityAvailability={availability}
            onSuccess={() => setCreating(false)}
          />
        </div>
      ) : null}
      {capacities.data?.length ? (
        <div className="space-y-3">
          {capacities.data.map((capacity) => (
            <article key={capacity.id} className="min-w-0 rounded-md border p-4">
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Gauge className="size-4 text-primary" />
                    <h3 className="truncate font-medium">{capacity.label}</h3>
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {capacity.runtimeModel}
                  </p>
                  <div className="mt-3 space-y-1">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex items-center gap-1 text-muted-foreground">
                        {t("dashboard:pools.capacity.slotsInUse")}
                        <Help>{t("dashboard:pools.capacity.slotsHelp")}</Help>
                      </span>
                      <span className="font-medium tabular-nums">
                        {capacity._count.CapacityLeases} / {capacity.hardConcurrencyLimit ?? "∞"}
                      </span>
                    </div>
                    <SlotMeter
                      active={capacity._count.CapacityLeases}
                      slots={capacity.hardConcurrencyLimit}
                      waiting={capacity._count.CapacityWaiters}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("dashboard:pools.capacity.usedBy", {
                      count: capacity._count.ExecutionTargets,
                    })}
                  </p>
                  <CapacityEngineFacts capacity={capacity} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="touch" variant="outline" onClick={() => setEditingId(capacity.id)}>
                    {t("dashboard:pools.capacity.edit")}
                  </Button>
                  <Button
                    size="touch"
                    variant="destructive"
                    onClick={() => setDeletingId(capacity.id)}
                  >
                    <Trash2 className="size-4" />
                    {t("common:actions.delete")}
                  </Button>
                </div>
              </div>
              {editing?.id === capacity.id ? (
                <div className="mt-5 border-t pt-5">
                  <CapacitySetupForm
                    key={capacity.id}
                    capacity={capacity}
                    capacityAvailability={availability}
                    onSuccess={() => setEditingId(null)}
                  />
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("dashboard:pools.capacity.empty")}</p>
      )}
      <ConfirmDeleteDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeletingId(null)}
        title={t("dashboard:pools.capacity.deleteTitle")}
        description={t("dashboard:pools.capacity.deleteDescription")}
        confirmToken={deleting?.label ?? ""}
        typePrompt={t("dashboard:pools.capacity.typeName")}
        copyAriaLabel={t("dashboard:actions.copyConfirm")}
        isPending={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate({ id: deleting.id });
        }}
      />
    </section>
  );
}
