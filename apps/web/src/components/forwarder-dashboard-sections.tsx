import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { validateForwarderPoolSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ws-model-proxy/ui/components/dialog";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@ws-model-proxy/ui/components/sheet";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Copy, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { SegmentedControl } from "@/components/segmented-control";
import { orpc } from "@/utils/orpc";

type CliDevice = Awaited<
  ReturnType<AppRouterClient["forwarderManagement"]["listCliDevices"]>
>[number];
type ModelPool = Awaited<
  ReturnType<AppRouterClient["forwarderManagement"]["listModelPools"]>
>[number];
type PoolMember = ModelPool["members"][number];
type PoolGrant = ModelPool["grants"][number];
type CliToken = Awaited<ReturnType<AppRouterClient["cliCredentials"]["listTokens"]>>[number];
type ModelApiToken = Awaited<ReturnType<AppRouterClient["modelApiTokens"]["list"]>>[number];
type VisibleModels = Awaited<ReturnType<AppRouterClient["forwarderManagement"]["visibleModels"]>>;
type TokenPreview = Awaited<ReturnType<AppRouterClient["modelApiTokens"]["preview"]>>;
type RelayRow = Awaited<ReturnType<AppRouterClient["relayMetadata"]["listOwn"]>>[number];
type ScopeMode = "ALL_VISIBLE" | "ALLOWLIST";
type RoutingStatus = "ACTIVE" | "DRAINING" | "DISABLED";
type DeleteTarget =
  | { kind: "cli"; id: string; label: string }
  | { kind: "endpoint"; id: string; label: string }
  | { kind: "model"; id: string; label: string };

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  return dateTimeFormatter.format(new Date(value));
}

function numberOrDash(value: number | null | undefined) {
  return typeof value === "number" ? value.toLocaleString() : "—";
}

function routingStatusValue(value: string | undefined): RoutingStatus {
  if (value === "DRAINING" || value === "DISABLED") return value;
  return "ACTIVE";
}

function copyToClipboard(value: string, message: string) {
  void navigator.clipboard.writeText(value).then(() => toast.success(message));
}

function StatusPill({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center border px-2 text-xs font-medium tabular-nums",
        muted
          ? "border-border bg-muted text-muted-foreground"
          : "border-primary/20 bg-primary/10 text-primary",
      )}
    >
      {children}
    </span>
  );
}

function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3 rounded-md border p-4">
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function SecretDisplay({ secret, label }: { secret: string; label: string }) {
  const { t } = useTranslation(["common", "dashboard"]);

  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto border bg-background px-2 py-2 font-mono text-xs">
          {secret}
        </code>
        <Button
          type="button"
          size="icon-touch"
          variant="outline"
          onClick={() => copyToClipboard(secret, t("common:actions.copied"))}
          aria-label={t("dashboard:actions.copySecret")}
        >
          <Copy className="size-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("dashboard:tokens.oneTimeSecretHelp")}</p>
    </div>
  );
}

function allDirectModels(devices: CliDevice[]) {
  return devices.flatMap((device) =>
    device.endpoints.flatMap((endpoint) =>
      endpoint.models.map((model) => ({
        ...model,
        cliSlug: device.slug,
        endpointSlug: endpoint.slug,
        endpointLabel: endpoint.label,
      })),
    ),
  );
}

export function CliEndpointsModelsSection() {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const {
    data: devicesData,
    isPending: devicesIsPending,
    isError: devicesIsError,
    refetch: refetchDevices,
  } = useQuery(orpc.forwarderManagement.listCliDevices.queryOptions());
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const removeCli = useMutation(
    orpc.forwarderManagement.removeCliDeviceMetadata.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:metadata.deleted"));
        setDeleteTarget(null);
      },
    }),
  );
  const removeEndpoint = useMutation(
    orpc.forwarderManagement.removeEndpointMetadata.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:metadata.deleted"));
        setDeleteTarget(null);
      },
    }),
  );
  const removeModel = useMutation(
    orpc.forwarderManagement.removeDiscoveredModelMetadata.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:metadata.deleted"));
        setDeleteTarget(null);
      },
    }),
  );

  if (devicesIsPending) return <ListSkeleton />;
  if (devicesIsError) {
    return <InlineRetry message={t("dashboard:clis.loadFailed")} onRetry={refetchDevices} />;
  }

  const isDeleting = removeCli.isPending || removeEndpoint.isPending || removeModel.isPending;

  return (
    <section>
      <SectionHeader
        title={t("dashboard:clis.title")}
        description={t("dashboard:clis.description")}
      />

      {devicesData.length === 0 ? (
        <EmptyState>{t("dashboard:clis.empty")}</EmptyState>
      ) : (
        <div className="space-y-4">
          {devicesData.map((device) => (
            <div key={device.id} className="rounded-md border">
              <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium">{device.label}</h3>
                    <StatusPill muted={device.isStale}>{device.status}</StatusPill>
                    {device.isStale ? (
                      <StatusPill muted>{t("dashboard:status.stale")}</StatusPill>
                    ) : null}
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{device.slug}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("dashboard:clis.lastHeartbeat", {
                      value: formatDate(device.lastHeartbeatAt),
                    })}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="touch"
                  onClick={() =>
                    setDeleteTarget({ kind: "cli", id: device.id, label: device.slug })
                  }
                >
                  <Trash2 className="size-4" />
                  {t("dashboard:metadata.delete")}
                </Button>
              </div>

              <div className="divide-y">
                {device.endpoints.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    {t("dashboard:endpoints.empty")}
                  </div>
                ) : (
                  device.endpoints.map((endpoint) => (
                    <div key={endpoint.id} className="p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-sm font-medium">{endpoint.label}</h4>
                            <StatusPill>{endpoint.status}</StatusPill>
                            <StatusPill muted>{endpoint.kind}</StatusPill>
                          </div>
                          <p className="mt-1 font-mono text-xs text-muted-foreground">
                            {device.slug}/{endpoint.slug}
                          </p>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {t("dashboard:endpoints.lastSeen", {
                              value: formatDate(endpoint.lastSeenAt),
                            })}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="touch"
                          onClick={() =>
                            setDeleteTarget({
                              kind: "endpoint",
                              id: endpoint.id,
                              label: `${device.slug}/${endpoint.slug}`,
                            })
                          }
                        >
                          <Trash2 className="size-4" />
                          {t("dashboard:metadata.delete")}
                        </Button>
                      </div>

                      <div className="mt-3 overflow-x-auto">
                        <table className="w-full min-w-[680px] text-left text-xs">
                          <thead className="border-b text-muted-foreground">
                            <tr>
                              <th className="py-2 pr-3 font-medium">
                                {t("dashboard:models.modelId")}
                              </th>
                              <th className="py-2 pr-3 font-medium">
                                {t("dashboard:models.upstream")}
                              </th>
                              <th className="py-2 pr-3 font-medium">
                                {t("dashboard:models.capabilities")}
                              </th>
                              <th className="py-2 pr-3 font-medium">
                                {t("dashboard:models.lastSeen")}
                              </th>
                              <th className="py-2 pl-3 text-right font-medium">
                                {t("dashboard:actions.header")}
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {endpoint.models.map((model) => (
                              <tr key={model.id}>
                                <td className="py-2 pr-3 align-top">
                                  <code className="font-mono text-xs">
                                    {model.canonicalModelId}
                                  </code>
                                  <p className="mt-1 text-muted-foreground">
                                    {t("dashboard:models.immutable")}
                                  </p>
                                </td>
                                <td className="py-2 pr-3 align-top font-mono">
                                  {model.upstreamModelId}
                                </td>
                                <td className="py-2 pr-3 align-top">
                                  {model.effectiveCapabilities.coarse.length > 0
                                    ? model.effectiveCapabilities.coarse.join(", ")
                                    : "—"}
                                </td>
                                <td className="py-2 pr-3 align-top tabular-nums">
                                  {formatDate(model.lastSeenAt)}
                                </td>
                                <td className="py-2 pl-3 text-right align-top">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-touch"
                                    onClick={() =>
                                      setDeleteTarget({
                                        kind: "model",
                                        id: model.id,
                                        label: model.canonicalModelId,
                                      })
                                    }
                                    aria-label={t("dashboard:metadata.deleteModel")}
                                  >
                                    <Trash2 className="size-4" />
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("dashboard:metadata.deleteTitle")}
        description={t("dashboard:metadata.deleteDescription")}
        confirmToken={deleteTarget?.label ?? ""}
        typePrompt={t("dashboard:metadata.typePrompt")}
        copyAriaLabel={t("dashboard:actions.copyConfirm")}
        isPending={isDeleting}
        onConfirm={() => {
          if (!deleteTarget) return;
          if (deleteTarget.kind === "cli") removeCli.mutate({ id: deleteTarget.id });
          if (deleteTarget.kind === "endpoint") removeEndpoint.mutate({ id: deleteTarget.id });
          if (deleteTarget.kind === "model") removeModel.mutate({ id: deleteTarget.id });
        }}
      />
    </section>
  );
}

export function PoolsSection() {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const {
    data: poolsData,
    isPending: poolsIsPending,
    isError: poolsIsError,
    refetch: refetchPools,
  } = useQuery(orpc.forwarderManagement.listModelPools.queryOptions());
  const {
    data: devicesData,
    isPending: devicesIsPending,
    isError: devicesIsError,
    refetch: refetchDevices,
  } = useQuery(orpc.forwarderManagement.listCliDevices.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPool, setEditingPool] = useState<ModelPool | null>(null);
  const [deletePool, setDeletePool] = useState<ModelPool | null>(null);
  const [memberPool, setMemberPool] = useState<ModelPool | null>(null);
  const [editingMember, setEditingMember] = useState<PoolMember | null>(null);
  const [deleteMember, setDeleteMember] = useState<PoolMember | null>(null);
  const [grantPool, setGrantPool] = useState<ModelPool | null>(null);
  const [revokeGrant, setRevokeGrant] = useState<{ pool: ModelPool; grant: PoolGrant } | null>(
    null,
  );
  const directModels = useMemo(() => allDirectModels(devicesData ?? []), [devicesData]);

  const onChanged = () => {
    queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
  };

  const deletePoolMutation = useMutation(
    orpc.forwarderManagement.deleteModelPool.mutationOptions({
      onSuccess: () => {
        onChanged();
        toast.success(t("dashboard:pools.deleted"));
        setDeletePool(null);
      },
    }),
  );
  const removeMember = useMutation(
    orpc.forwarderManagement.removePoolMember.mutationOptions({
      onSuccess: () => {
        onChanged();
        toast.success(t("dashboard:pools.memberRemoved"));
        setDeleteMember(null);
      },
    }),
  );
  const revokeGrantMutation = useMutation(
    orpc.forwarderManagement.revokePoolAccessByEmail.mutationOptions({
      onSuccess: () => {
        onChanged();
        toast.success(t("dashboard:pools.grantRevoked"));
        setRevokeGrant(null);
      },
    }),
  );

  if (poolsIsPending || devicesIsPending) return <ListSkeleton />;
  if (poolsIsError || devicesIsError) {
    return (
      <InlineRetry
        message={t("dashboard:pools.loadFailed")}
        onRetry={() => {
          refetchPools();
          refetchDevices();
        }}
      />
    );
  }

  return (
    <section>
      <SectionHeader
        title={t("dashboard:pools.title")}
        description={t("dashboard:pools.description")}
        action={
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger
              render={
                <Button size="touch">
                  <Plus className="size-4" />
                  {t("dashboard:pools.create")}
                </Button>
              }
            />
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{t("dashboard:pools.createTitle")}</DialogTitle>
                <DialogDescription>{t("dashboard:pools.createDescription")}</DialogDescription>
              </DialogHeader>
              <PoolForm mode="create" onSuccess={() => setCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        }
      />

      {poolsData.length === 0 ? (
        <EmptyState>{t("dashboard:pools.empty")}</EmptyState>
      ) : (
        <div className="space-y-4">
          {poolsData.map((pool) => (
            <div key={pool.id} className="rounded-md border">
              <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium">{pool.name}</h3>
                    <StatusPill muted>
                      {pool.members.length} {t("dashboard:pools.membersLabel")}
                    </StatusPill>
                    <StatusPill muted>
                      {pool.grants.length} {t("dashboard:pools.grantsLabel")}
                    </StatusPill>
                  </div>
                  <code className="mt-2 block break-all font-mono text-xs">
                    {pool.canonicalModelId}
                  </code>
                  {pool.description ? (
                    <p className="mt-2 text-sm text-muted-foreground">{pool.description}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    onClick={() => setGrantPool(pool)}
                  >
                    <Plus className="size-4" />
                    {t("dashboard:pools.grant")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    onClick={() => setMemberPool(pool)}
                  >
                    <Plus className="size-4" />
                    {t("dashboard:pools.addMember")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    onClick={() => setEditingPool(pool)}
                  >
                    {t("common:actions.edit")}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="touch"
                    onClick={() => setDeletePool(pool)}
                  >
                    <Trash2 className="size-4" />
                    {t("common:actions.delete")}
                  </Button>
                </div>
              </div>

              <div className="grid gap-0 divide-y lg:grid-cols-[1fr_22rem] lg:divide-x lg:divide-y-0">
                <div className="p-4">
                  <h4 className="mb-2 text-sm font-medium">{t("dashboard:pools.membersTitle")}</h4>
                  {pool.members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("dashboard:pools.noMembers")}
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[620px] text-left text-xs">
                        <thead className="border-b text-muted-foreground">
                          <tr>
                            <th className="py-2 pr-3 font-medium">
                              {t("dashboard:models.modelId")}
                            </th>
                            <th className="py-2 pr-3 font-medium">{t("dashboard:pools.weight")}</th>
                            <th className="py-2 pr-3 font-medium">
                              {t("dashboard:pools.routing")}
                            </th>
                            <th className="py-2 pr-3 font-medium">{t("dashboard:pools.health")}</th>
                            <th className="py-2 pl-3 text-right font-medium">
                              {t("dashboard:actions.header")}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {pool.members.map((member) => (
                            <tr key={member.id}>
                              <td className="py-2 pr-3 align-top">
                                <code className="font-mono">{member.model.canonicalModelId}</code>
                              </td>
                              <td className="py-2 pr-3 align-top tabular-nums">{member.weight}</td>
                              <td className="py-2 pr-3 align-top">{member.routingStatus}</td>
                              <td className="py-2 pr-3 align-top">{member.healthStatus}</td>
                              <td className="py-2 pl-3 align-top">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="touch"
                                    onClick={() => setEditingMember(member)}
                                  >
                                    {t("common:actions.edit")}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-touch"
                                    onClick={() => setDeleteMember(member)}
                                    aria-label={t("dashboard:pools.removeMember")}
                                  >
                                    <Trash2 className="size-4" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="p-4">
                  <h4 className="mb-2 text-sm font-medium">{t("dashboard:pools.grantsTitle")}</h4>
                  {pool.grants.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("dashboard:pools.noGrants")}</p>
                  ) : (
                    <div className="divide-y">
                      {pool.grants.map((grant) => (
                        <div
                          key={grant.id}
                          className="flex items-center justify-between gap-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm">{grant.granteeName}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {grant.granteeEmail}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-touch"
                            onClick={() => setRevokeGrant({ pool, grant })}
                            aria-label={t("dashboard:pools.revokeGrant")}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Sheet open={Boolean(editingPool)} onOpenChange={(open) => !open && setEditingPool(null)}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t("dashboard:pools.editTitle")}</SheetTitle>
            <SheetDescription>{t("dashboard:pools.editDescription")}</SheetDescription>
          </SheetHeader>
          <div className="px-4">
            {editingPool ? (
              <PoolForm
                key={editingPool.id}
                mode="edit"
                pool={editingPool}
                onSuccess={() => setEditingPool(null)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={Boolean(memberPool)} onOpenChange={(open) => !open && setMemberPool(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("dashboard:pools.addMemberTitle")}</DialogTitle>
            <DialogDescription>{t("dashboard:pools.addMemberDescription")}</DialogDescription>
          </DialogHeader>
          {memberPool ? (
            <PoolMemberForm
              mode="create"
              poolId={memberPool.id}
              directModels={directModels}
              onSuccess={() => setMemberPool(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Sheet open={Boolean(editingMember)} onOpenChange={(open) => !open && setEditingMember(null)}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t("dashboard:pools.editMemberTitle")}</SheetTitle>
            <SheetDescription>{t("dashboard:pools.editMemberDescription")}</SheetDescription>
          </SheetHeader>
          <div className="px-4">
            {editingMember ? (
              <PoolMemberForm
                key={editingMember.id}
                mode="edit"
                member={editingMember}
                directModels={directModels}
                onSuccess={() => setEditingMember(null)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <GrantPoolDialog pool={grantPool} onOpenChange={(open) => !open && setGrantPool(null)} />

      <ConfirmDeleteDialog
        open={Boolean(deletePool)}
        onOpenChange={(open) => !open && setDeletePool(null)}
        title={t("dashboard:pools.deleteTitle")}
        description={t("dashboard:pools.deleteDescription")}
        confirmToken={deletePool?.name ?? ""}
        typePrompt={t("dashboard:pools.typePoolName")}
        copyAriaLabel={t("dashboard:actions.copyConfirm")}
        isPending={deletePoolMutation.isPending}
        onConfirm={() => {
          if (deletePool) deletePoolMutation.mutate({ id: deletePool.id });
        }}
      />

      <ConfirmDeleteDialog
        open={Boolean(deleteMember)}
        onOpenChange={(open) => !open && setDeleteMember(null)}
        title={t("dashboard:pools.removeMemberTitle")}
        description={t("dashboard:pools.removeMemberDescription")}
        confirmToken={deleteMember?.model.canonicalModelId ?? ""}
        typePrompt={t("dashboard:pools.typeModelId")}
        copyAriaLabel={t("dashboard:actions.copyConfirm")}
        isPending={removeMember.isPending}
        onConfirm={() => {
          if (deleteMember) removeMember.mutate({ id: deleteMember.id });
        }}
      />

      <ConfirmDeleteDialog
        open={Boolean(revokeGrant)}
        onOpenChange={(open) => !open && setRevokeGrant(null)}
        title={t("dashboard:pools.revokeGrantTitle")}
        description={t("dashboard:pools.revokeGrantDescription")}
        confirmToken={revokeGrant?.grant.granteeEmail ?? ""}
        typePrompt={t("dashboard:pools.typeEmail")}
        copyAriaLabel={t("dashboard:actions.copyConfirm")}
        inputMode="email"
        confirmLabel={t("dashboard:pools.revoke")}
        pendingLabel={t("dashboard:pools.revoking")}
        isPending={revokeGrantMutation.isPending}
        onConfirm={() => {
          if (revokeGrant) {
            revokeGrantMutation.mutate({
              poolId: revokeGrant.pool.id,
              email: revokeGrant.grant.granteeEmail,
            });
          }
        }}
      />
    </section>
  );
}

function PoolForm({
  mode,
  pool,
  onSuccess,
}: {
  mode: "create" | "edit";
  pool?: ModelPool;
  onSuccess: () => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const poolSchema = z.object({
    slug: z
      .string()
      .trim()
      .superRefine((value, ctx) => {
        const result = validateForwarderPoolSlug(value);
        if (!result.ok) {
          ctx.addIssue({
            code: "custom",
            message:
              result.reason === "reserved"
                ? t("dashboard:pools.reservedSlug")
                : t("dashboard:pools.invalidSlug"),
          });
        }
      }),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000),
  });
  const createPool = useMutation(
    orpc.forwarderManagement.createModelPool.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.created"));
        onSuccess();
      },
    }),
  );
  const updatePool = useMutation(
    orpc.forwarderManagement.updateModelPool.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.updated"));
        onSuccess();
      },
    }),
  );
  const form = useForm({
    defaultValues: {
      slug: pool?.slug ?? "",
      name: pool?.name ?? "",
      description: pool?.description ?? "",
    },
    validators: { onSubmit: poolSchema },
    onSubmit: async ({ value }) => {
      if (mode === "create") {
        await createPool.mutateAsync({
          slug: value.slug.trim(),
          name: value.name.trim(),
          description: value.description.trim() || null,
        });
      } else if (pool) {
        await updatePool.mutateAsync({
          id: pool.id,
          slug: value.slug.trim(),
          name: value.name.trim(),
          description: value.description.trim() || null,
        });
      }
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <form.Field name="slug">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("dashboard:pools.slug")}</Label>
            <Input
              id={field.name}
              name={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              inputMode="text"
              autoComplete="off"
            />
            {field.state.meta.errors.map((error) => (
              <p key={error?.message} className="text-sm text-destructive">
                {error?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>

      <form.Field name="name">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("dashboard:pools.name")}</Label>
            <Input
              id={field.name}
              name={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              inputMode="text"
              autoComplete="off"
            />
            {field.state.meta.errors.map((error) => (
              <p key={error?.message} className="text-sm text-destructive">
                {error?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>

      <form.Field name="description">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("dashboard:pools.descriptionField")}</Label>
            <Textarea
              id={field.name}
              name={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              autoComplete="off"
              rows={4}
            />
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
            {isSubmitting ? t("common:actions.saving") : t("common:actions.save")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

function PoolMemberForm({
  mode,
  poolId,
  member,
  directModels,
  onSuccess,
}: {
  mode: "create" | "edit";
  poolId?: string;
  member?: PoolMember;
  directModels: ReturnType<typeof allDirectModels>;
  onSuccess: () => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const [discoveredModelId, setDiscoveredModelId] = useState(directModels[0]?.id ?? "");
  const [weight, setWeight] = useState(String(member?.weight ?? 1));
  const [routingStatus, setRoutingStatus] = useState<RoutingStatus>(() =>
    routingStatusValue(member?.routingStatus),
  );
  const selectId = useId();
  const createMember = useMutation(
    orpc.forwarderManagement.addPoolMember.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.memberAdded"));
        onSuccess();
      },
    }),
  );
  const updateMember = useMutation(
    orpc.forwarderManagement.updatePoolMember.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.memberUpdated"));
        onSuccess();
      },
    }),
  );
  const isPending = createMember.isPending || updateMember.isPending;
  const parsedWeight = Number.parseInt(weight, 10);
  const canSubmit =
    Number.isInteger(parsedWeight) &&
    parsedWeight >= 0 &&
    parsedWeight <= 10_000 &&
    (mode === "edit" || discoveredModelId.length > 0);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        if (mode === "create" && poolId) {
          createMember.mutate({
            poolId,
            discoveredModelId,
            weight: parsedWeight,
            routingStatus,
          });
        }
        if (mode === "edit" && member) {
          updateMember.mutate({ id: member.id, weight: parsedWeight, routingStatus });
        }
      }}
    >
      {mode === "create" ? (
        <div className="space-y-2">
          <Label htmlFor={selectId}>{t("dashboard:pools.directModel")}</Label>
          <select
            id={selectId}
            className="h-11 w-full border bg-background px-2 text-xs"
            value={discoveredModelId}
            onChange={(event) => setDiscoveredModelId(event.target.value)}
          >
            {directModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.canonicalModelId}
              </option>
            ))}
          </select>
          {directModels.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dashboard:pools.noDirectModels")}</p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          <Label>{t("dashboard:pools.directModel")}</Label>
          <code className="block break-all border bg-muted px-2 py-2 font-mono text-xs">
            {member?.model.canonicalModelId}
          </code>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="member-weight">{t("dashboard:pools.weight")}</Label>
        <Input
          id="member-weight"
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
        />
      </div>
      <div className="space-y-2">
        <Label>{t("dashboard:pools.routing")}</Label>
        <SegmentedControl
          value={routingStatus}
          onChange={setRoutingStatus}
          ariaLabel={t("dashboard:pools.routing")}
          items={[
            { value: "ACTIVE", label: t("dashboard:pools.routingActive") },
            { value: "DRAINING", label: t("dashboard:pools.routingDraining") },
            { value: "DISABLED", label: t("dashboard:pools.routingDisabled") },
          ]}
        />
      </div>
      <Button type="submit" size="touch" disabled={!canSubmit || isPending}>
        {isPending ? t("common:actions.saving") : t("common:actions.save")}
      </Button>
    </form>
  );
}

function GrantPoolDialog({
  pool,
  onOpenChange,
}: {
  pool: ModelPool | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const grant = useMutation(
    orpc.forwarderManagement.grantPoolAccessByEmail.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.grantAdded"));
        setEmail("");
        onOpenChange(false);
      },
    }),
  );

  return (
    <Dialog open={Boolean(pool)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("dashboard:pools.grantTitle")}</DialogTitle>
          <DialogDescription>{t("dashboard:pools.grantDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (pool && email) grant.mutate({ poolId: pool.id, email });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="grant-email">{t("dashboard:pools.email")}</Label>
            <Input
              id="grant-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="user@example.com"
            />
            <p className="text-xs text-muted-foreground">{t("dashboard:pools.exactEmailOnly")}</p>
          </div>
          <DialogFooter>
            <Button type="submit" size="touch" disabled={!email || grant.isPending}>
              {grant.isPending ? t("dashboard:pools.granting") : t("dashboard:pools.grant")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CliTokensSection() {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const {
    data: tokensData,
    isPending: tokensIsPending,
    isError: tokensIsError,
    refetch: refetchTokens,
  } = useQuery(orpc.cliCredentials.listTokens.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [revokeToken, setRevokeToken] = useState<CliToken | null>(null);
  const create = useMutation(
    orpc.cliCredentials.createToken.mutationOptions({
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: orpc.cliCredentials.key() });
        setSecret(result.secret);
        setName("");
        toast.success(t("dashboard:tokens.created"));
      },
    }),
  );
  const revoke = useMutation(
    orpc.cliCredentials.revokeToken.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.cliCredentials.key() });
        toast.success(t("dashboard:tokens.revoked"));
        setRevokeToken(null);
      },
    }),
  );

  if (tokensIsPending) return <ListSkeleton />;
  if (tokensIsError) {
    return <InlineRetry message={t("dashboard:tokens.loadFailed")} onRetry={refetchTokens} />;
  }

  return (
    <section>
      <SectionHeader
        title={t("dashboard:tokens.cliTitle")}
        description={t("dashboard:tokens.cliDescription")}
        action={
          <Dialog
            open={createOpen}
            onOpenChange={(open) => {
              setCreateOpen(open);
              if (!open) {
                setName("");
                setSecret("");
              }
            }}
          >
            <DialogTrigger
              render={
                <Button size="touch">
                  <Plus className="size-4" />
                  {t("dashboard:tokens.createCli")}
                </Button>
              }
            />
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{t("dashboard:tokens.createCliTitle")}</DialogTitle>
                <DialogDescription>{t("dashboard:tokens.createCliDescription")}</DialogDescription>
              </DialogHeader>
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (name) create.mutate({ name });
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="cli-token-name">{t("dashboard:tokens.name")}</Label>
                  <Input
                    id="cli-token-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    inputMode="text"
                    autoComplete="off"
                  />
                </div>
                {secret ? (
                  <SecretDisplay secret={secret} label={t("dashboard:tokens.cliSecret")} />
                ) : null}
                <DialogFooter>
                  <Button
                    type="submit"
                    size="touch"
                    disabled={!name || create.isPending || Boolean(secret)}
                  >
                    {create.isPending
                      ? t("dashboard:tokens.creating")
                      : t("dashboard:tokens.create")}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        }
      />
      <TokenTable tokens={tokensData} onRevoke={setRevokeToken} />
      <ConfirmDeleteDialog
        open={Boolean(revokeToken)}
        onOpenChange={(open) => !open && setRevokeToken(null)}
        title={t("dashboard:tokens.revokeTitle")}
        description={t("dashboard:tokens.revokeDescription")}
        confirmToken={revokeToken?.name ?? ""}
        typePrompt={t("dashboard:tokens.typeTokenName")}
        copyAriaLabel={t("dashboard:actions.copyConfirm")}
        confirmLabel={t("dashboard:tokens.revoke")}
        pendingLabel={t("dashboard:tokens.revoking")}
        isPending={revoke.isPending}
        onConfirm={() => {
          if (revokeToken) revoke.mutate({ id: revokeToken.id });
        }}
      />
    </section>
  );
}

function TokenTable<TToken extends CliToken | ModelApiToken>({
  tokens,
  onRevoke,
}: {
  tokens: TToken[];
  onRevoke: (token: TToken) => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);

  if (tokens.length === 0) return <EmptyState>{t("dashboard:tokens.empty")}</EmptyState>;

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[720px] text-left text-xs">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="p-3 font-medium">{t("dashboard:tokens.name")}</th>
            <th className="p-3 font-medium">{t("dashboard:tokens.prefix")}</th>
            <th className="p-3 font-medium">{t("dashboard:tokens.scope")}</th>
            <th className="p-3 font-medium">{t("dashboard:tokens.lastUsed")}</th>
            <th className="p-3 font-medium">{t("dashboard:tokens.createdAt")}</th>
            <th className="p-3 text-right font-medium">{t("dashboard:actions.header")}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {tokens.map((token) => (
            <tr key={token.id}>
              <td className="p-3 align-top font-medium">{token.name}</td>
              <td className="p-3 align-top font-mono">{token.lookupPrefix}</td>
              <td className="p-3 align-top">
                {"scopeMode" in token ? (
                  <span>
                    {token.scopeMode}
                    {token.scopeMode === "ALLOWLIST"
                      ? ` (${token.allowlist.directModelCount + token.allowlist.modelPoolCount})`
                      : ""}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td className="p-3 align-top tabular-nums">{formatDate(token.lastUsedAt)}</td>
              <td className="p-3 align-top tabular-nums">{formatDate(token.createdAt)}</td>
              <td className="p-3 text-right align-top">
                {token.revokedAt ? (
                  <StatusPill muted>{t("dashboard:tokens.revokedStatus")}</StatusPill>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    size="touch"
                    onClick={() => onRevoke(token)}
                  >
                    <Trash2 className="size-4" />
                    {t("dashboard:tokens.revoke")}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ModelApiTokensSection() {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const {
    data: tokensData,
    isPending: tokensIsPending,
    isError: tokensIsError,
    refetch: refetchTokens,
  } = useQuery(orpc.modelApiTokens.list.queryOptions());
  const {
    data: visibleModelsData,
    isPending: visibleModelsIsPending,
    isError: visibleModelsIsError,
    refetch: refetchVisibleModels,
  } = useQuery(orpc.forwarderManagement.visibleModels.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopeMode, setScopeMode] = useState<ScopeMode>("ALL_VISIBLE");
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [secret, setSecret] = useState("");
  const [revokeToken, setRevokeToken] = useState<ModelApiToken | null>(null);
  const {
    data: previewData,
    isPending: previewIsPending,
    isError: previewIsError,
    refetch: refetchPreview,
  } = useQuery(
    orpc.modelApiTokens.preview.queryOptions({
      input: { scopeMode, modelIds: scopeMode === "ALLOWLIST" ? selectedModelIds : [] },
    }),
  );
  const create = useMutation(
    orpc.modelApiTokens.create.mutationOptions({
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: orpc.modelApiTokens.key() });
        setSecret(result.secret);
        setName("");
        toast.success(t("dashboard:tokens.created"));
      },
    }),
  );
  const revoke = useMutation(
    orpc.modelApiTokens.revoke.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.modelApiTokens.key() });
        toast.success(t("dashboard:tokens.revoked"));
        setRevokeToken(null);
      },
    }),
  );
  const allVisibleIds = useMemo(() => {
    const models = visibleModelsData;
    if (!models) return [];
    return [
      ...models.directModels.map((model) => model.modelId),
      ...models.modelPools.map((pool) => pool.modelId),
    ];
  }, [visibleModelsData]);

  if (tokensIsPending || visibleModelsIsPending) return <ListSkeleton />;
  if (tokensIsError || visibleModelsIsError) {
    return (
      <InlineRetry
        message={t("dashboard:tokens.loadFailed")}
        onRetry={() => {
          refetchTokens();
          refetchVisibleModels();
        }}
      />
    );
  }

  return (
    <section>
      <SectionHeader
        title={t("dashboard:tokens.modelApiTitle")}
        description={t("dashboard:tokens.modelApiDescription")}
        action={
          <Dialog
            open={createOpen}
            onOpenChange={(open) => {
              setCreateOpen(open);
              if (!open) {
                setName("");
                setScopeMode("ALL_VISIBLE");
                setSelectedModelIds([]);
                setSecret("");
              }
            }}
          >
            <DialogTrigger
              render={
                <Button size="touch">
                  <Plus className="size-4" />
                  {t("dashboard:tokens.createModelApi")}
                </Button>
              }
            />
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>{t("dashboard:tokens.createModelApiTitle")}</DialogTitle>
                <DialogDescription>
                  {t("dashboard:tokens.createModelApiDescription")}
                </DialogDescription>
              </DialogHeader>
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!name) return;
                  create.mutate({
                    name,
                    scopeMode,
                    modelIds: scopeMode === "ALLOWLIST" ? selectedModelIds : [],
                  });
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="model-api-token-name">{t("dashboard:tokens.name")}</Label>
                  <Input
                    id="model-api-token-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    inputMode="text"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("dashboard:tokens.scopeMode")}</Label>
                  <SegmentedControl
                    value={scopeMode}
                    onChange={setScopeMode}
                    ariaLabel={t("dashboard:tokens.scopeMode")}
                    items={[
                      { value: "ALL_VISIBLE", label: t("dashboard:tokens.allVisible") },
                      { value: "ALLOWLIST", label: t("dashboard:tokens.allowlist") },
                    ]}
                  />
                </div>
                {scopeMode === "ALLOWLIST" ? (
                  <VisibleModelChecklist
                    visibleModels={visibleModelsData}
                    selectedModelIds={selectedModelIds}
                    onSelectedModelIdsChange={setSelectedModelIds}
                  />
                ) : null}
                {previewIsPending ? (
                  <Skeleton className="h-24 w-full" />
                ) : previewIsError ? (
                  <InlineRetry
                    variant="destructive"
                    message={t("dashboard:tokens.previewFailed")}
                    onRetry={refetchPreview}
                  />
                ) : (
                  <VisibleModelPreview preview={previewData} />
                )}
                {secret ? (
                  <SecretDisplay secret={secret} label={t("dashboard:tokens.modelApiSecret")} />
                ) : null}
                <DialogFooter>
                  <Button
                    type="submit"
                    size="touch"
                    disabled={
                      !name ||
                      create.isPending ||
                      Boolean(secret) ||
                      (scopeMode === "ALLOWLIST" && selectedModelIds.length === 0)
                    }
                  >
                    {create.isPending
                      ? t("dashboard:tokens.creating")
                      : t("dashboard:tokens.create")}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        }
      />
      {allVisibleIds.length === 0 ? (
        <div className="mb-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t("dashboard:tokens.noVisibleModels")}
        </div>
      ) : null}
      <TokenTable tokens={tokensData} onRevoke={setRevokeToken} />
      <ConfirmDeleteDialog
        open={Boolean(revokeToken)}
        onOpenChange={(open) => !open && setRevokeToken(null)}
        title={t("dashboard:tokens.revokeTitle")}
        description={t("dashboard:tokens.revokeDescription")}
        confirmToken={revokeToken?.name ?? ""}
        typePrompt={t("dashboard:tokens.typeTokenName")}
        copyAriaLabel={t("dashboard:actions.copyConfirm")}
        confirmLabel={t("dashboard:tokens.revoke")}
        pendingLabel={t("dashboard:tokens.revoking")}
        isPending={revoke.isPending}
        onConfirm={() => {
          if (revokeToken) revoke.mutate({ id: revokeToken.id });
        }}
      />
    </section>
  );
}

function VisibleModelChecklist({
  visibleModels,
  selectedModelIds,
  onSelectedModelIdsChange,
}: {
  visibleModels: VisibleModels;
  selectedModelIds: string[];
  onSelectedModelIdsChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation("dashboard");
  const rows = [
    ...visibleModels.directModels.map((model) => ({
      id: model.modelId,
      label: model.modelId,
      kind: t("tokens.direct"),
    })),
    ...visibleModels.modelPools.map((pool) => ({
      id: pool.modelId,
      label: pool.modelId,
      kind: t("tokens.pool"),
    })),
  ];

  return (
    <div className="space-y-2">
      <Label>{t("tokens.allowlistModels")}</Label>
      <div className="max-h-56 overflow-y-auto rounded-md border">
        {rows.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">{t("tokens.noVisibleModels")}</p>
        ) : (
          rows.map((row) => {
            const checked = selectedModelIds.includes(row.id);
            return (
              <label
                key={row.id}
                className="flex min-h-[44px] items-start gap-3 border-b p-3 last:border-b-0"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) => {
                    if (next === true) onSelectedModelIdsChange([...selectedModelIds, row.id]);
                    else onSelectedModelIdsChange(selectedModelIds.filter((id) => id !== row.id));
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{row.kind}</span>
                  <code className="block break-all font-mono text-xs text-muted-foreground">
                    {row.label}
                  </code>
                </span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

function VisibleModelPreview({ preview }: { preview: TokenPreview }) {
  const { t } = useTranslation("dashboard");
  const count = preview.directModels.length + preview.modelPools.length;

  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">{t("tokens.visiblePreview", { count })}</p>
      <div className="mt-2 max-h-40 overflow-y-auto space-y-1">
        {[...preview.directModels, ...preview.modelPools].map((model) => (
          <code key={model.id} className="block break-all font-mono text-xs text-muted-foreground">
            {model.id}
          </code>
        ))}
      </div>
    </div>
  );
}

export function RelayMetadataSection() {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const {
    data: rowsData,
    isPending: rowsIsPending,
    isError: rowsIsError,
    refetch: refetchRows,
  } = useQuery(orpc.relayMetadata.listOwn.queryOptions());
  const [deleteRow, setDeleteRow] = useState<RelayRow | null>(null);
  const [createdBefore, setCreatedBefore] = useState("");
  const [deleteRangeOpen, setDeleteRangeOpen] = useState(false);
  const deleteOwn = useMutation(
    orpc.relayMetadata.deleteOwn.mutationOptions({
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: orpc.relayMetadata.key() });
        toast.success(t("dashboard:relay.deleted", { count: result.deletedCount }));
        setDeleteRow(null);
        setDeleteRangeOpen(false);
        setCreatedBefore("");
      },
    }),
  );

  if (rowsIsPending) return <ListSkeleton />;
  if (rowsIsError) {
    return <InlineRetry message={t("dashboard:relay.loadFailed")} onRetry={refetchRows} />;
  }

  return (
    <section>
      <SectionHeader
        title={t("dashboard:relay.title")}
        description={t("dashboard:relay.description")}
        action={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="space-y-1">
              <Label htmlFor="relay-created-before">{t("dashboard:relay.createdBefore")}</Label>
              <Input
                id="relay-created-before"
                type="date"
                inputMode="numeric"
                autoComplete="off"
                value={createdBefore}
                onChange={(event) => setCreatedBefore(event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="destructive"
              size="touch"
              disabled={!createdBefore}
              onClick={() => setDeleteRangeOpen(true)}
            >
              <Trash2 className="size-4" />
              {t("dashboard:relay.deleteRange")}
            </Button>
          </div>
        }
      />
      <ConfirmDeleteDialog
        open={deleteRangeOpen}
        onOpenChange={setDeleteRangeOpen}
        title={t("dashboard:relay.deleteRangeTitle")}
        description={t("dashboard:relay.deleteRangeDescription")}
        confirmToken={createdBefore}
        typePrompt={t("dashboard:relay.typeCreatedBefore")}
        copyAriaLabel={t("dashboard:actions.copyConfirm")}
        confirmLabel={t("dashboard:relay.deleteRange")}
        pendingLabel={t("common:actions.deleting")}
        isPending={deleteOwn.isPending}
        onConfirm={() => {
          if (createdBefore) {
            deleteOwn.mutate({
              ids: [],
              createdBefore: new Date(`${createdBefore}T00:00:00`),
            });
          }
        }}
      />
      {rowsData.length === 0 ? (
        <EmptyState>{t("dashboard:relay.empty")}</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">{t("dashboard:relay.createdAt")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.status")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.tokenPrefix")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.duration")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.tokens")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.http")}</th>
                <th className="p-3 text-right font-medium">{t("dashboard:actions.header")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rowsData.map((row) => (
                <tr key={row.id}>
                  <td className="p-3 align-top tabular-nums">{formatDate(row.createdAt)}</td>
                  <td className="p-3 align-top">{row.status}</td>
                  <td className="p-3 align-top font-mono">
                    {row.modelApiTokenLookupPrefix ?? "—"}
                  </td>
                  <td className="p-3 align-top tabular-nums">{numberOrDash(row.durationMs)}</td>
                  <td className="p-3 align-top tabular-nums">{numberOrDash(row.totalTokens)}</td>
                  <td className="p-3 align-top tabular-nums">
                    {row.httpStatusCode ?? "—"} / {row.upstreamStatusCode ?? "—"}
                  </td>
                  <td className="p-3 text-right align-top">
                    <Button
                      type="button"
                      variant="destructive"
                      size="icon-touch"
                      onClick={() => setDeleteRow(row)}
                      aria-label={t("dashboard:relay.deleteRow")}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDeleteDialog
        open={Boolean(deleteRow)}
        onOpenChange={(open) => !open && setDeleteRow(null)}
        title={t("dashboard:relay.deleteRowTitle")}
        description={t("dashboard:relay.deleteRowDescription")}
        confirmToken={deleteRow?.id ?? ""}
        typePrompt={t("dashboard:relay.typeRelayId")}
        copyAriaLabel={t("dashboard:actions.copyConfirm")}
        isPending={deleteOwn.isPending}
        onConfirm={() => {
          if (deleteRow) deleteOwn.mutate({ ids: [deleteRow.id] });
        }}
      />
    </section>
  );
}
