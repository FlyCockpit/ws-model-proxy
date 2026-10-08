import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { healthHttpStatus, isHealthFailure } from "@ws-model-proxy/config/health-reasons";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AddToSharedPool } from "@/components/access/contribute";
import { CopyableCode } from "@/components/copy-button";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { InstanceLoad } from "@/components/runtimes/instance-load";
import {
  HeldUntilConfirmed,
  MarkStoppedAction,
  StopNotConfirmedHelp,
} from "@/components/runtimes/mark-stopped";
import { RuntimeSharingCard } from "@/components/runtimes/runtime-sharing-card";
import { ServedModelCapabilities } from "@/components/runtimes/served-model-capabilities";
import { type PillTone, StatusPill } from "@/components/status-pill";
import { refusalText } from "@/lib/refusal-text";
import { slugify } from "@/lib/slugify";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/runtimes/$runtimeId/")({
  component: RuntimeOverviewPage,
});

type RuntimeDetail = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>;
type Instance = RuntimeDetail["instanceList"][number];
type ServedModel = RuntimeDetail["servedModels"][number];
type StartResult = Awaited<ReturnType<AppRouterClient["runtimes"]["start"]>>;
type StartPreview = Extract<StartResult, { mode: "preview" }>["preview"];

const PHASE_TONE: Record<Instance["phase"], PillTone> = {
  STARTING: "busy",
  READY: "good",
  UNHEALTHY: "bad",
  UNAVAILABLE: "muted",
  STOPPING: "busy",
  STOPPED: "muted",
  FAILED: "bad",
};

function useRuntimeInvalidation() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
    await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
    await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
    // A restart or stop changes what needs the person (Overview and the nav badge).
    await queryClient.invalidateQueries({ queryKey: orpc.activity.needsYou.key() });
  };
}

function RuntimeOverviewPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { runtimeId } = Route.useParams();
  const runtime = useQuery({
    ...orpc.runtimes.get.queryOptions({ input: { runtimeId } }),
    // Follow instances while they move between states.
    refetchInterval: (query) =>
      query.state.data?.instanceList.some(
        (instance) =>
          instance.phase === "STARTING" ||
          instance.phase === "STOPPING" ||
          instance.needsOperator !== null,
      )
        ? 3_000
        : false,
  });
  if (runtime.isPending)
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  if (runtime.isError)
    return (
      <InlineRetry message={t("dashboard:runtime.loadFailed")} onRetry={() => runtime.refetch()} />
    );
  return <RuntimeOverview runtime={runtime.data} />;
}

function RuntimeOverview({ runtime }: { runtime: RuntimeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="flex min-w-0 flex-wrap items-center gap-2 text-2xl font-semibold">
          <span className="break-all">{runtime.name}</span>
          <StatusPill tone="info">{t(`dashboard:runtime.kind.${runtime.kind}`)}</StatusPill>
          {runtime.service ? (
            <StatusPill tone="muted">{t("dashboard:runtime.service")}</StatusPill>
          ) : null}
        </h1>
        <p className="break-all font-mono text-sm text-muted-foreground">
          {runtime.slug} · v{runtime.currentVersion.version}
        </p>
        {runtime.origin === "NODE" ? <NodeOriginNote runtime={runtime} /> : null}
      </div>
      {runtime.service ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("dashboard:runtime.service")}</CardTitle>
            <CardDescription>{t("dashboard:runtime.serviceHint")}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ServedModelsCard runtime={runtime} />
      )}
      <InstancesCard runtime={runtime} />
      {runtime.service ? null : <MetricsByVersionCard runtime={runtime} />}
      <RuntimeSharingCard lang={lang} runtime={runtime} />
      <DeleteRuntime runtime={runtime} />
    </div>
  );
}

function NodeOriginNote({ runtime }: { runtime: RuntimeDetail }) {
  const { t } = useTranslation(["dashboard"]);
  const { lang } = Route.useParams();
  return (
    <Link
      to="/$lang/runtimes/$runtimeId/definition"
      params={{ lang, runtimeId: runtime.id }}
      className="inline-flex min-h-[44px] items-center text-sm text-muted-foreground underline"
    >
      {t("dashboard:runtime.nodeOrigin")}
    </Link>
  );
}

function ServedModelsCard({ runtime }: { runtime: RuntimeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const active = runtime.servedModels.filter((model) => !model.retired);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:runtime.servedModels")}</CardTitle>
        <CardDescription>{t("dashboard:runtime.servedModelsHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:runtime.noModelsYet")}</p>
        ) : (
          active.map((model) => <ServedModelRow key={model.id} runtime={runtime} model={model} />)
        )}
      </CardContent>
    </Card>
  );
}

function ServedModelRow({ runtime, model }: { runtime: RuntimeDetail; model: ServedModel }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const invalidate = useRuntimeInvalidation();
  const pools = useQuery(orpc.pools.list.queryOptions());
  const [poolId, setPoolId] = useState("");
  const update = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const create = useMutation({
    ...orpc.pools.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const inPools = new Set(model.pools.map((pool) => pool.poolId));
  const candidates = (pools.data?.pools ?? []).filter(
    (pool) => pool.modelType === model.type && !inPools.has(pool.id),
  );
  const navigate = useNavigate();
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await invalidate();
      toast.success(t("dashboard:pool.memberAdded"));
      setPoolId("");
    } catch (error) {
      toast.error(refusalText(error));
    }
  };
  const createPool = async () => {
    try {
      const pool = await create.mutateAsync({
        name: model.upstreamModelId.slice(0, 120),
        slug: slugify(`${runtime.slug}-${model.upstreamModelId}`) || runtime.slug,
        type: model.type,
        members: [{ runtimeModelId: model.id }],
      });
      await invalidate();
      toast.success(t("dashboard:runtime.poolCreated"));
      await navigate({ to: "/$lang/pools/$poolId", params: { lang, poolId: pool.id } });
    } catch (error) {
      toast.error(refusalText(error));
    }
  };
  const fieldId = `add-to-pool-${model.id}`;
  return (
    <div className="flex min-w-0 flex-col gap-2 border-b pb-4 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="break-all font-mono text-sm">{model.upstreamModelId}</span>
        <StatusPill tone="info">{t(`dashboard:models.type.${model.type}`)}</StatusPill>
      </div>
      <ServedModelCapabilities model={model} />
      {model.pools.length > 0 ? (
        model.pools.map((pool) => (
          <div key={pool.poolId} className="flex min-w-0 flex-wrap items-center gap-2">
            <CopyableCode
              value={pool.callableId}
              label={t("dashboard:models.copyId", { id: pool.callableId })}
            />
            {pool.contributed ? (
              <StatusPill tone="info">{t("dashboard:runtime.contributed")}</StatusPill>
            ) : (
              <Link
                to="/$lang/pools/$poolId"
                params={{ lang, poolId: pool.poolId }}
                className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
              >
                {t("dashboard:runtime.openPool")}
              </Link>
            )}
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">{t("dashboard:runtime.notInPoolHint")}</p>
      )}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor={fieldId}>{t("dashboard:runtime.addToPool")}</Label>
          <NativeSelect
            id={fieldId}
            value={poolId}
            onChange={(event) => setPoolId(event.target.value)}
            disabled={pools.isPending}
          >
            <option value="">{t("dashboard:runtime.pickPool")}</option>
            {candidates.map((pool) => (
              <option key={pool.id} value={pool.id}>
                {pool.callableIds[0] ?? pool.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          size="touch"
          disabled={!poolId || update.isPending}
          onClick={() =>
            run(() =>
              update.mutateAsync({
                poolId,
                members: { add: [{ runtimeModelId: model.id }] },
              }),
            )
          }
        >
          {t("dashboard:pool.add")}
        </Button>
        <Button size="touch" variant="outline" disabled={create.isPending} onClick={createPool}>
          {t("dashboard:runtime.newPoolFromModel")}
        </Button>
      </div>
      <AddToSharedPool model={model} />
    </div>
  );
}

/** Why the instance is unhealthy or failed to start, when the node said. */
function InstanceReasonNote({ instance }: { instance: Instance }) {
  const { t } = useTranslation();
  const detail = instance.healthDetail;
  const status = detail ? healthHttpStatus(detail) : null;
  const reason = !detail
    ? null
    : status
      ? t("dashboard:runtime.healthReason.http", { status })
      : isHealthFailure(detail)
        ? t(`dashboard:runtime.healthReason.${detail}`)
        : detail;
  return (
    <>
      {reason ? (
        <p className="break-words text-xs text-muted-foreground">
          {t("dashboard:runtime.healthReason.label", { reason })}
        </p>
      ) : null}
      {instance.phaseReason === "process_detached" ? (
        <p className="break-words text-sm text-destructive">
          {t("dashboard:runtime.processDetached")}
        </p>
      ) : null}
    </>
  );
}

function InstancesCard({ runtime }: { runtime: RuntimeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const invalidate = useRuntimeInvalidation();
  const [starting, setStarting] = useState<{ instanceId?: string } | null>(null);
  const stop = useMutation({
    ...orpc.runtimes.stop.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const startable = runtime.kind === "STARTABLE";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          {t("dashboard:runtime.instances")}
          {startable ? (
            <Button size="touch" onClick={() => setStarting({})}>
              {t("dashboard:runtime.start")}
            </Button>
          ) : null}
        </CardTitle>
        <CardDescription>
          {startable ? t("dashboard:runtime.instancesHint") : t("dashboard:runtime.alwaysOnHint")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {runtime.instanceList.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:runtime.notRunning")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y">
            {runtime.instanceList.map((instance) => (
              <li key={instance.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-sm">{instance.handle}</span>
                    <StatusPill tone={PHASE_TONE[instance.phase]}>
                      {t(`dashboard:runtime.phase.${instance.phase}`)}
                    </StatusPill>
                    {instance.needsOperator ? (
                      <StatusPill tone="bad">
                        {t(`dashboard:runtime.needsOperator.${instance.needsOperator}`)}
                      </StatusPill>
                    ) : null}
                    {instance.needsOperator === "MARK_STOPPED" ? <StopNotConfirmedHelp /> : null}
                    <HeldUntilConfirmed instance={instance} />
                  </p>
                  {instance.needsOperator === "STEP" ? (
                    <Link
                      to="/$lang/terminals"
                      params={{ lang }}
                      className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                    >
                      {t("dashboard:runtime.answerInTerminals")}
                    </Link>
                  ) : null}
                  <p className="break-all text-xs text-muted-foreground">
                    v{instance.versionNumber}
                    {instance.ranks.map(
                      (rank) =>
                        ` · ${rank.nodeSlug ?? t("dashboard:runtime.nodeGone")}:${rank.port}`,
                    )}
                    {instance.phaseReason ? ` · ${instance.phaseReason}` : ""}
                  </p>
                  <InstanceLoad live={instance.live} />
                  <InstanceReasonNote instance={instance} />
                </div>
                {instance.needsOperator === "MARK_STOPPED" ? (
                  <MarkStoppedAction runtimeId={runtime.id} instanceId={instance.id} />
                ) : null}
                {startable && instance.desiredState === "RUNNING" ? (
                  <Button
                    variant="outline"
                    size="touch"
                    disabled={stop.isPending}
                    onClick={async () => {
                      try {
                        await stop.mutateAsync({ instanceId: instance.id });
                        await invalidate();
                        toast.success(t("dashboard:runtime.stopping"));
                      } catch (error) {
                        toast.error(refusalText(error));
                      }
                    }}
                  >
                    {t("dashboard:runtime.stop")}
                  </Button>
                ) : null}
                {startable ? (
                  <Button
                    variant="ghost"
                    size="touch"
                    onClick={() => setStarting({ instanceId: instance.id })}
                  >
                    {t("dashboard:runtime.restart")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {starting ? (
        <StartDialog
          runtime={runtime}
          instanceId={starting.instanceId}
          onClose={() => setStarting(null)}
        />
      ) : null}
    </Card>
  );
}

/** Start or restart: preview (placements, warnings, refusals), then confirm with its fingerprint. */
function StartDialog({
  runtime,
  instanceId,
  onClose,
}: {
  runtime: RuntimeDetail;
  instanceId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useRuntimeInvalidation();
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), retry: false });
  const groupSize = runtime.current.spec.launch?.groupSize ?? 1;
  // One node per rank, in rank order; all empty: the planner picks.
  const [nodeIds, setNodeIds] = useState<string[]>(() => Array(groupSize).fill(""));
  const [preview, setPreview] = useState<StartPreview | null>(null);
  const start = useMutation({
    ...orpc.runtimes.start.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const chosen = nodeIds.filter((nodeId) => nodeId !== "");
  const pickProblem =
    chosen.length > 0 && chosen.length < groupSize
      ? "pickEveryRank"
      : new Set(chosen).size < chosen.length
        ? "pickDistinct"
        : null;
  const target = instanceId
    ? { instanceId }
    : chosen.length === groupSize
      ? { nodeIds: chosen }
      : {};

  const requestPreview = async () => {
    try {
      const result = await start.mutateAsync({ runtimeId: runtime.id, ...target, preview: true });
      if (result.mode === "preview") setPreview(result.preview);
    } catch (error) {
      toast.error(refusalText(error));
    }
  };
  const confirm = async () => {
    if (!preview) return;
    try {
      await start.mutateAsync({
        runtimeId: runtime.id,
        ...target,
        fingerprint: preview.fingerprint,
      });
      await invalidate();
      toast.success(t("dashboard:runtime.startRequested"));
      onClose();
    } catch (error) {
      toast.error(refusalText(error));
      setPreview(null);
    }
  };

  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={instanceId ? t("dashboard:runtime.restart") : t("dashboard:runtime.start")}
      description={t("dashboard:runtime.startHint")}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" size="touch" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          {preview && preview.refusals.length === 0 ? (
            <Button size="touch" disabled={start.isPending} onClick={confirm}>
              {t("dashboard:runtime.confirmStart")}
            </Button>
          ) : (
            <Button
              size="touch"
              disabled={start.isPending || pickProblem !== null}
              onClick={requestPreview}
            >
              {t("dashboard:runtime.preview")}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-3 pb-4 text-sm">
        {!instanceId && nodes.isSuccess ? (
          <NodePicker
            groupSize={groupSize}
            nodes={nodes.data.nodes}
            value={nodeIds}
            onChange={(next) => {
              setNodeIds(next);
              setPreview(null);
            }}
          />
        ) : null}
        {pickProblem ? (
          <p className="text-destructive">{t(`dashboard:runtime.nodePicker.${pickProblem}`)}</p>
        ) : null}
        {preview ? (
          <>
            {preview.starts.flatMap((startEntry) =>
              startEntry.placements.map((placement) => (
                <p key={`${placement.nodeId}-${placement.nodeNumber}`}>
                  {t("dashboard:runtime.placement", {
                    node: placement.nodeSlug,
                    port: placement.port,
                    number: placement.nodeNumber,
                  })}
                </p>
              )),
            )}
            {preview.stops.length > 0 ? (
              <div className="font-medium text-amber-700 dark:text-amber-300">
                <p>{t("dashboard:runtime.stops")}</p>
                <ul className="list-disc pl-5">
                  {preview.stops.map((stopEntry) => (
                    <li key={stopEntry.instanceId}>
                      {t(`dashboard:runtime.stopReason.${stopEntry.reason}`, {
                        handle:
                          runtime.instanceList.find((item) => item.id === stopEntry.instanceId)
                            ?.handle ?? stopEntry.instanceId,
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {preview.warnings.map((warning) => (
              <p
                key={`${warning.code}-${warning.nodeId ?? ""}`}
                className="text-amber-700 dark:text-amber-300"
              >
                {t(`dashboard:runtime.warnings.${warning.code}`)}
              </p>
            ))}
            {preview.refusals.map((refusal) => (
              <p key={`${refusal.reason}-${refusal.subjectId ?? ""}`} className="text-destructive">
                {t(`dashboard:runtime.refusals.${refusal.reason}`, {
                  defaultValue: t("dashboard:runtime.refusals.other"),
                })}
              </p>
            ))}
          </>
        ) : (
          <p className="text-muted-foreground">{t("dashboard:runtime.previewFirst")}</p>
        )}
      </div>
    </ResponsiveDialog>
  );
}

const LIVE_PHASES = new Set<Instance["phase"]>(["STARTING", "READY", "UNHEALTHY", "UNAVAILABLE"]);

/**
 * Load and request metrics of this runtime per version, in the Activity explorer: all versions
 * compared, or one version (the current one and any other an instance still runs).
 */
function MetricsByVersionCard({ runtime }: { runtime: RuntimeDetail }) {
  const { t } = useTranslation(["dashboard"]);
  const { lang } = Route.useParams();
  const versions = new Map<string, number>([
    [runtime.currentVersion.id, runtime.currentVersion.version],
  ]);
  for (const instance of runtime.instanceList)
    if (LIVE_PHASES.has(instance.phase)) versions.set(instance.versionId, instance.versionNumber);
  const linkClass = "inline-flex min-h-11 items-center text-sm underline underline-offset-4";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:runtime.metrics.title")}</CardTitle>
        <CardDescription>{t("dashboard:runtime.metrics.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-wrap items-center gap-x-4">
        <Link
          to="/$lang/activity"
          params={{ lang }}
          search={{ scope: "runtime", id: runtime.id, groupBy: "version" }}
          className={linkClass}
        >
          {t("dashboard:runtime.metrics.compare")}
        </Link>
        {[...versions].map(([versionId, version]) => (
          <Link
            key={versionId}
            to="/$lang/activity"
            params={{ lang }}
            search={{ scope: "version", runtime: runtime.id, id: versionId }}
            className={linkClass}
          >
            {versionId === runtime.currentVersion.id
              ? t("dashboard:runtime.metrics.current", { version })
              : t("dashboard:runtime.metrics.running", { version })}
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Where a start runs: any eligible node (the planner picks), or one node per rank, in rank
 * order (a multi-node runtime's rank 1 is its head). The API takes exactly one node per rank.
 */
function NodePicker({
  groupSize,
  nodes,
  value,
  onChange,
}: {
  groupSize: number;
  nodes: ReadonlyArray<{ id: string; slug: string; name: string | null }>;
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {groupSize > 1 ? (
        <p className="text-muted-foreground">
          {t("dashboard:runtime.nodePicker.multiHint", { count: groupSize })}
        </p>
      ) : null}
      {value.map((nodeId, index) => {
        const id = `start-node-${index}`;
        return (
          <div key={index} className="space-y-1.5">
            <Label htmlFor={id}>
              {groupSize > 1
                ? t("dashboard:runtime.nodePicker.rank", { number: index + 1 })
                : t("dashboard:runtime.startOn")}
            </Label>
            <NativeSelect
              id={id}
              value={nodeId}
              onChange={(event) =>
                onChange(value.map((item, at) => (at === index ? event.target.value : item)))
              }
            >
              <option value="">{t("dashboard:runtime.anyNode")}</option>
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name ?? node.slug}
                </option>
              ))}
            </NativeSelect>
          </div>
        );
      })}
    </div>
  );
}

function DeleteRuntime({ runtime }: { runtime: RuntimeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const navigate = useNavigate();
  const invalidate = useRuntimeInvalidation();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    ...orpc.runtimes.delete.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <>
      <div>
        <Button variant="destructive" size="touch" onClick={() => setOpen(true)}>
          {t("dashboard:runtime.delete")}
        </Button>
      </div>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title={t("dashboard:runtime.deleteTitle", { name: runtime.name })}
        description={t(
          runtime.origin === "NODE"
            ? "dashboard:runtime.deleteHintNodeOrigin"
            : "dashboard:runtime.deleteHint",
        )}
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" size="touch" onClick={() => setOpen(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="touch"
              disabled={remove.isPending}
              onClick={async () => {
                try {
                  await remove.mutateAsync({ runtimeId: runtime.id });
                  setOpen(false);
                  // Leave first: the deleted runtime's own query must not refetch.
                  await navigate({ to: "/$lang/runtimes", params: { lang } });
                  await invalidate();
                } catch (error) {
                  toast.error(refusalText(error));
                }
              }}
            >
              {remove.isPending ? t("common:actions.deleting") : t("common:actions.delete")}
            </Button>
          </div>
        }
      >
        <span />
      </ResponsiveDialog>
    </>
  );
}
