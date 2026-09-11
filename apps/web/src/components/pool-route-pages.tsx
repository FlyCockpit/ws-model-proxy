import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ws-model-proxy/ui/components/dialog";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Gauge, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";

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
import { InlineRetry } from "@/components/inline-retry";
import { ProviderOperationsSection } from "@/components/provider-operations-section";
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
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">{title}</h2>
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
  protocolAdaptationAvailable: boolean;
  providerEgressEnabled: boolean;
  capacityEnabled: boolean;
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

export function PoolsListPage({ lang }: { lang: string }) {
  const { t } = useTranslation(["common", "dashboard"]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const pools = useQuery(orpc.forwarderManagement.listModelPools.queryOptions());
  const devices = useQuery(orpc.forwarderManagement.listCliDevices.queryOptions());
  const appConfig = useQuery(orpc.appConfig.queryOptions());
  const capacityAvailability = resolveCapacityAvailability(
    appConfig.data?.capacityEnabled,
    appConfig.isError,
  );
  const capacities = useQuery({
    ...orpc.capacityManagement.list.queryOptions(),
    retry: false,
    enabled: capacityAvailability === "enabled",
  });

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

  const directModels = allDirectModels(devices.data ?? []);
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
            <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <DialogTrigger
                render={
                  <Button size="touch" variant="outline">
                    <Plus className="size-4" />
                    {t("dashboard:pools.advancedCreate")}
                  </Button>
                }
              />
              <DialogContent className="max-h-[min(92vh,56rem)] overflow-x-hidden overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{t("dashboard:pools.createTitle")}</DialogTitle>
                  <DialogDescription>{t("dashboard:pools.createDescription")}</DialogDescription>
                </DialogHeader>
                <PoolForm
                  mode="create"
                  directModels={directModels}
                  capacities={capacities.data ?? []}
                  capacityAvailability={capacityAvailability}
                  protocolAdaptationAvailable={appConfig.data?.protocolAdaptationAvailable ?? false}
                  onSuccess={() => setAdvancedOpen(false)}
                />
              </DialogContent>
            </Dialog>
          </div>
        }
      />

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
            return (
              <article key={pool.id} className="min-w-0 rounded-md border p-4">
                <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h3 className="font-medium">{pool.name}</h3>
                      <span className="text-xs text-muted-foreground">{pool.slug}</span>
                    </div>
                    <div className="mt-2 max-w-2xl">
                      <CopyableModelId modelId={pool.canonicalModelId} />
                    </div>
                    {pool.description ? (
                      <p className="mt-2 text-sm text-muted-foreground">{pool.description}</p>
                    ) : null}
                    <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <dt>{t("dashboard:pools.memberTiers.PRIMARY")}</dt>
                        <dd className="font-medium text-foreground">{primaryCount}</dd>
                      </div>
                      <div>
                        <dt>{t("dashboard:pools.memberTiers.PUBLIC_OVERFLOW")}</dt>
                        <dd className="font-medium text-foreground">{overflowCount}</dd>
                      </div>
                      <div>
                        <dt>{t("dashboard:pools.health")}</dt>
                        <dd className="font-medium text-foreground">
                          {healthyCount}/{pool.members.length}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("dashboard:pools.grantsLabel")}</dt>
                        <dd className="font-medium text-foreground">{pool.grants.length}</dd>
                      </div>
                    </dl>
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

      {appConfig.data?.providerEgressEnabled ? <ProviderOperationsSection /> : null}
    </section>
  );
}

export function PoolDetailPage({ poolId, lang = "en-US" }: { poolId: string; lang?: string }) {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const pools = useQuery(orpc.forwarderManagement.listModelPools.queryOptions());
  const devices = useQuery(orpc.forwarderManagement.listCliDevices.queryOptions());
  const appConfig = useQuery(orpc.appConfig.queryOptions());
  const capacityAvailability = resolveCapacityAvailability(
    appConfig.data?.capacityEnabled,
    appConfig.isError,
  );
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
  const deletePool = useMutation(
    orpc.forwarderManagement.deleteModelPool.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        setDeletePoolOpen(false);
      },
    }),
  );
  const removeMember = useMutation(
    orpc.forwarderManagement.removePoolMember.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        setDeleteMemberId(null);
      },
    }),
  );
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
    protocolAdaptationAvailable: appConfig.data?.protocolAdaptationAvailable ?? false,
    providerEgressEnabled: appConfig.data?.providerEgressEnabled ?? false,
    capacityEnabled: appConfig.data?.capacityEnabled ?? false,
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
              <Button size="touch" variant="destructive" onClick={() => setDeletePoolOpen(true)}>
                <Trash2 className="size-4" />
                {t("common:actions.delete")}
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
                ["capacity", "/$lang/dashboard/pools/$poolId/capacity"],
                ["media", "/$lang/dashboard/pools/$poolId/media"],
                ["access", "/$lang/dashboard/pools/$poolId/access"],
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

export function PoolDetailTab({
  tab,
}: {
  tab: "overview" | "fallback" | "routing" | "capacity" | "media" | "access";
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const detail = usePoolDetail();
  const { pool } = detail;

  if (tab === "overview") {
    return (
      <div className="space-y-6">
        <PoolForm
          key={`${pool.id}-identity`}
          mode="edit"
          pool={pool}
          directModels={detail.directModels}
          capacities={detail.capacities}
          capacityAvailability={detail.capacityAvailability}
          protocolAdaptationAvailable={detail.protocolAdaptationAvailable}
          sections={["identity"]}
          stickySave
          onSuccess={() => undefined}
        />
        <section className="space-y-3 border-t pt-6" aria-labelledby="pool-members-title">
          <h3 id="pool-members-title" className="text-base font-semibold">
            {t("dashboard:pools.membersTitle")}
          </h3>
          {pool.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dashboard:pools.noMembers")}</p>
          ) : (
            <ul className="space-y-2">
              {pool.members.map((member) => {
                const hasOverride =
                  member.capacityPriority !== null ||
                  member.capacityConcurrencyMode !== "INHERIT" ||
                  member.capacityReservedSlots !== null ||
                  member.capacityBorrowPolicy !== null ||
                  member.capacityWaitBudgetMode !== "INHERIT" ||
                  member.capacityContextCeilingMode !== "INHERIT" ||
                  member.capacityContextMargin !== null;
                const concurrencyLimit =
                  member.capacityConcurrencyMode === "INHERIT"
                    ? pool.capacityConcurrencyLimit
                    : member.capacityConcurrencyMode === "UNLIMITED"
                      ? null
                      : member.capacityConcurrencyLimit;
                const waitBudget =
                  member.capacityWaitBudgetMode === "INHERIT"
                    ? pool.capacityWaitBudgetMs
                    : member.capacityWaitBudgetMode === "UNLIMITED"
                      ? null
                      : member.capacityWaitBudgetMs;
                const contextCeiling =
                  member.capacityContextCeilingMode === "INHERIT"
                    ? pool.capacityContextCeiling
                    : member.capacityContextCeilingMode === "UNLIMITED"
                      ? null
                      : member.capacityContextCeiling;
                const borrowPolicy = member.capacityBorrowPolicy ?? pool.capacityBorrowPolicy;
                return (
                  <li
                    key={member.id}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-3 border p-3"
                  >
                    <div className="min-w-0">
                      <code className="block break-all font-mono text-xs">
                        {member.model?.canonicalModelId ?? member.discoveredModelId ?? member.id}
                      </code>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {member.routingStatus} ·{" "}
                        {member.tier === "PUBLIC_OVERFLOW"
                          ? t("dashboard:pools.memberTiers.PUBLIC_OVERFLOW")
                          : `${t("dashboard:pools.weight")}: ${member.weight}`}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {hasOverride
                          ? t("dashboard:pools.capacity.modes.override")
                          : t("dashboard:pools.inherited")}
                        : {t("dashboard:pools.capacity.fields.capacityPriority")}{" "}
                        {member.capacityPriority ?? pool.capacityPriority}
                        {" · "}
                        {t("dashboard:pools.capacity.fields.capacityConcurrencyLimit")}{" "}
                        {concurrencyLimit ?? t("dashboard:pools.capacity.modes.unlimited")}
                        {" · "}
                        {t("dashboard:pools.capacity.fields.capacityReservedSlots")}{" "}
                        {member.capacityReservedSlots ?? pool.capacityReservedSlots}
                        {" · "}
                        {t("dashboard:pools.capacity.fields.capacityWaitBudgetMs")}{" "}
                        {waitBudget ?? t("dashboard:pools.capacity.modes.unlimited")}
                        {" · "}
                        {t("dashboard:pools.capacity.fields.capacityContextCeiling")}{" "}
                        {contextCeiling ?? t("dashboard:pools.capacity.modes.unlimited")}
                        {" · "}
                        {t("dashboard:pools.capacity.fields.capacityContextMargin")}{" "}
                        {member.capacityContextMargin ?? pool.capacityContextMargin}
                        {" · "}
                        {t("dashboard:pools.capacity.fields.capacityBorrowPolicy")}{" "}
                        {borrowPolicy === "NEVER"
                          ? t("dashboard:pools.capacity.borrowNever")
                          : t("dashboard:pools.capacity.borrowIdle")}
                      </p>
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
  if (tab === "routing" || tab === "capacity" || tab === "media") {
    return (
      <PoolForm
        key={`${pool.id}-${tab}`}
        mode="edit"
        pool={pool}
        directModels={detail.directModels}
        capacities={detail.capacities}
        capacityAvailability={detail.capacityAvailability}
        protocolAdaptationAvailable={detail.protocolAdaptationAvailable}
        sections={[tab]}
        stickySave
        onSuccess={() => undefined}
      />
    );
  }
  if (tab === "access") {
    return (
      <section className="space-y-3" aria-labelledby="pool-grants-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="pool-grants-title" className="text-base font-semibold">
            {t("dashboard:pools.grantsTitle")}
          </h3>
          <Button size="touch" onClick={detail.openGrant}>
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
                <span className="min-w-0 break-all text-sm">{grant.granteeEmail}</span>
                <Button
                  size="touch"
                  variant="destructive"
                  onClick={() => detail.revokeGrant(grant.granteeEmail)}
                >
                  {t("dashboard:pools.revokeGrant")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t("dashboard:pools.accessEgressHint")}
        </p>
      </section>
    );
  }
  const overflowMembers = pool.members
    .filter((member) => member.tier === "PUBLIC_OVERFLOW")
    .sort(
      (left, right) =>
        (left.publicOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.publicOrder ?? Number.MAX_SAFE_INTEGER),
    );
  const fallbackEnabled = detail.providerEgressEnabled && detail.capacityEnabled;
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
      {overflowMembers.length ? (
        <ol className="space-y-2">
          {overflowMembers.map((member, index) => (
            <li key={member.id} className="min-w-0 border p-3">
              <code className="break-all text-xs">
                {member.providerModel?.upstreamModelId ??
                  member.model?.canonicalModelId ??
                  member.id}
              </code>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("dashboard:pools.publicOrder", { order: member.publicOrder ?? index + 1 })}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          <p>{t("dashboard:pools.fallbackEmpty")}</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5">
            <li>{t("dashboard:pools.fallbackSteps.account")}</li>
            <li>{t("dashboard:pools.fallbackSteps.model")}</li>
            <li>{t("dashboard:pools.fallbackSteps.ceiling")}</li>
            <li>{t("dashboard:pools.fallbackSteps.acknowledge")}</li>
          </ol>
          {fallbackEnabled ? (
            <Button className="mt-4" size="touch" render={<a href="#provider-operations" />}>
              {t("dashboard:pools.addFallbackProvider")}
            </Button>
          ) : null}
        </div>
      )}
      {detail.providerEgressEnabled ? (
        <div id="provider-operations">
          <ProviderOperationsSection />
        </div>
      ) : null}
    </section>
  );
}

export function InferenceCapacityPage() {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const appConfig = useQuery(orpc.appConfig.queryOptions());
  const availability = resolveCapacityAvailability(
    appConfig.data?.capacityEnabled,
    appConfig.isError,
  );
  const capacities = useQuery({
    ...orpc.capacityManagement.list.queryOptions(),
    retry: false,
    enabled: availability === "enabled",
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const remove = useMutation(
    orpc.capacityManagement.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.capacityManagement.key() });
        setDeletingId(null);
      },
    }),
  );

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
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("dashboard:pools.capacity.active", {
                      count: capacity._count.CapacityLeases,
                      limit: capacity.hardConcurrencyLimit ?? "∞",
                    })}
                  </p>
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
