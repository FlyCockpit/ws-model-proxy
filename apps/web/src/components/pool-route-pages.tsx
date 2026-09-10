import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
import { useState } from "react";
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

export function PoolDetailPage({ poolId }: { poolId: string }) {
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

  return (
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
      <div className="min-w-0">
        <PoolForm
          key={pool.id}
          mode="edit"
          pool={pool}
          directModels={allDirectModels(devices.data ?? [])}
          capacities={capacities.data ?? []}
          capacityAvailability={capacityAvailability}
          protocolAdaptationAvailable={appConfig.data?.protocolAdaptationAvailable ?? false}
          stickySave
          onSuccess={() => undefined}
        />
      </div>
      <section className="space-y-3 border-t pt-6" aria-labelledby="pool-members-title">
        <h3 id="pool-members-title" className="text-base font-semibold">
          {t("dashboard:pools.membersTitle")}
        </h3>
        {pool.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:pools.noMembers")}</p>
        ) : (
          <ul className="space-y-2">
            {pool.members.map((member) => (
              <li
                key={member.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-3 border p-3"
              >
                <div className="min-w-0">
                  <code className="block break-all font-mono text-xs">
                    {member.model?.canonicalModelId ?? member.discoveredModelId ?? member.id}
                  </code>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {member.routingStatus} · {t("dashboard:pools.weight")}: {member.weight}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button size="touch" variant="outline" onClick={() => setMemberDialog(member.id)}>
                    {t("common:actions.edit")}
                  </Button>
                  <Button
                    size="touch"
                    variant="destructive"
                    onClick={() => setDeleteMemberId(member.id)}
                  >
                    {t("dashboard:pools.removeMember")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-3 border-t pt-6" aria-labelledby="pool-grants-title">
        <h3 id="pool-grants-title" className="text-base font-semibold">
          {t("dashboard:pools.grantsTitle")}
        </h3>
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
                  onClick={() => setRevokeEmail(grant.granteeEmail)}
                >
                  {t("dashboard:pools.revokeGrant")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Dialog open={Boolean(memberDialog)} onOpenChange={(open) => !open && setMemberDialog(null)}>
        <DialogContent className="max-h-[min(92vh,56rem)] overflow-x-hidden overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {memberDialog === "create"
                ? t("dashboard:pools.addMember")
                : t("dashboard:pools.editMemberTitle")}
            </DialogTitle>
            <DialogDescription>
              {memberDialog === "create"
                ? t("dashboard:pools.noDirectModels")
                : t("dashboard:pools.editMemberDescription")}
            </DialogDescription>
          </DialogHeader>
          {memberDialog === "create" ? (
            <PoolMemberForm
              mode="create"
              poolId={pool.id}
              directModels={allDirectModels(devices.data ?? [])}
              capacities={capacities.data ?? []}
              capacityAvailability={capacityAvailability}
              onSuccess={() => setMemberDialog(null)}
            />
          ) : editingMember ? (
            <PoolMemberForm
              mode="edit"
              member={editingMember}
              directModels={allDirectModels(devices.data ?? [])}
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
