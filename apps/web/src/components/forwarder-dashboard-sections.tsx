import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  parseOpenAiCompatibleCapabilities,
  resolveEffectiveCapabilityMetadata,
  transformerSupportedModalities,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { validateForwarderPoolSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import { env } from "@ws-model-proxy/env/web";
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
import { WideContent } from "@/components/wide-content";
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
type EndpointHealthFilter = "all" | "online" | "offline" | "stale";
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

function statusPillToneClass(status: string | undefined, muted: boolean) {
  const normalized = (status ?? "").toUpperCase();
  // Offline / disconnected should read as caution (yellow), not healthy green.
  if (normalized === "OFFLINE" || normalized === "DISCONNECTED") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (muted) {
    return "border-border bg-muted text-muted-foreground";
  }
  return "border-primary/20 bg-primary/10 text-primary";
}

function StatusPill({
  children,
  muted = false,
  status,
}: {
  children: ReactNode;
  muted?: boolean;
  /** Raw status value used for tone; falls back to string children. */
  status?: string;
}) {
  const toneStatus = status ?? (typeof children === "string" ? children : undefined);
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center border px-2 text-xs font-medium tabular-nums",
        statusPillToneClass(toneStatus, muted),
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
        <WideContent className="flex-1">
          <code className="block border bg-background px-2 py-2 font-mono text-xs">{secret}</code>
        </WideContent>
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
        endpointPublished: endpoint.published,
        // Needed for OVERRIDE→endpoint fallback (same as pool management).
        endpointCapabilityMetadata: endpoint.capabilityMetadata,
      })),
    ),
  );
}

type DirectModelOption = ReturnType<typeof allDirectModels>[number];

/**
 * Same capability path as server/pool management: strict parse of OVERRIDE
 * metadata with fall back to endpoint defaults, then transformer modalities.
 * Coarse VISION_INPUT enums alone never override a parseable chatCompletions
 * object that disables vision.
 */
function modelTransformerCaps(model: DirectModelOption): {
  images: boolean;
  audio: boolean;
  video: boolean;
} {
  const parsed = resolveEffectiveCapabilityMetadata({
    capabilityOverrideMode: model.capabilityOverrideMode,
    capabilityOverrideMetadata: model.capabilityOverrideMetadata,
    endpointCapabilityMetadata: model.endpointCapabilityMetadata,
  });
  if (parsed) {
    return transformerSupportedModalities(parsed);
  }
  // No parseable chatCompletions metadata — last resort for enum-only inventory.
  // Prefer override coarse when mode is OVERRIDE (even if metadata was malformed),
  // else endpoint/default coarse from effectiveCapabilities.
  const effective = model.effectiveCapabilities;
  const coarse =
    model.capabilityOverrideMode === "OVERRIDE"
      ? (model.capabilityOverrides ?? [])
      : (effective?.coarse ?? []);
  return {
    images: Array.isArray(coarse) && coarse.includes("VISION_INPUT"),
    video: Array.isArray(coarse) && coarse.includes("VIDEO_INPUT"),
    audio: Array.isArray(coarse) && coarse.includes("AUDIO_INPUT"),
  };
}

function ModelCapabilityToggles({
  modelId,
  vision,
  audio,
  video,
  disabled,
  onChange,
}: {
  modelId: string;
  vision: boolean;
  audio: boolean;
  video: boolean;
  disabled: boolean;
  onChange: (next: { vision: boolean; audio: boolean; video: boolean }) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const options = [
    { key: "vision" as const, label: t("dashboard:models.vision"), checked: vision },
    { key: "audio" as const, label: t("dashboard:models.audio"), checked: audio },
    { key: "video" as const, label: t("dashboard:models.video"), checked: video },
  ];
  return (
    <div className="flex flex-wrap gap-3" aria-label={t("dashboard:models.capabilities")}>
      {options.map((option) => (
        <label
          key={`${modelId}-${option.key}`}
          className="inline-flex min-h-11 items-center gap-2 text-xs"
        >
          <input
            type="checkbox"
            className="size-4"
            checked={option.checked}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                vision: option.key === "vision" ? event.target.checked : vision,
                audio: option.key === "audio" ? event.target.checked : audio,
                video: option.key === "video" ? event.target.checked : video,
              })
            }
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

function ModelCapabilityProfileEditor({
  model,
  endpointCapabilityMetadata,
  disabled,
  onSave,
}: {
  model: DirectModelOption;
  endpointCapabilityMetadata: unknown;
  disabled: boolean;
  onSave: (
    input:
      | { id: string; mode: "inherit"; optimisticBasicTranscription: boolean }
      | {
          id: string;
          mode: "override";
          capabilities: NonNullable<ReturnType<typeof parseOpenAiCompatibleCapabilities>>;
          optimisticBasicTranscription: boolean;
        },
  ) => Promise<void>;
}) {
  const { t } = useTranslation(["dashboard"]);
  const [open, setOpen] = useState(false);
  const effective = resolveEffectiveCapabilityMetadata({
    capabilityOverrideMode: model.capabilityOverrideMode,
    capabilityOverrideMetadata: model.capabilityOverrideMetadata,
    endpointCapabilityMetadata,
  });
  const [raw, setRaw] = useState(() =>
    JSON.stringify(effective ?? { version: 2, protocol: "openai-compatible" }, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [optimisticBasic, setOptimisticBasic] = useState(model.optimisticBasicTranscription);
  const source = model.capabilityOverrideMode === "OVERRIDE" ? "model" : "endpoint";
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setRaw(
            JSON.stringify(effective ?? { version: 2, protocol: "openai-compatible" }, null, 2),
          );
          setOptimisticBasic(model.optimisticBasicTranscription);
          setError(null);
        }
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" size="touch" variant="outline" className="mt-2">
            {t("dashboard:models.editCapabilityProfile")}
          </Button>
        }
      />
      <DialogContent className="max-h-[90dvh] overflow-x-hidden overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("dashboard:models.capabilityProfile")}</DialogTitle>
          <DialogDescription>
            {t("dashboard:models.capabilityProfileHint", { source })}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          className="min-h-80 max-w-full font-mono text-xs"
          value={raw}
          onChange={(event) => {
            setRaw(event.target.value);
            setError(null);
          }}
          aria-label={t("dashboard:models.capabilityProfile")}
        />
        <p className="text-xs text-muted-foreground">
          {t("dashboard:models.capabilityUnknownHint")}
        </p>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox
            checked={optimisticBasic}
            onCheckedChange={(value) => setOptimisticBasic(value === true)}
          />
          {t("dashboard:models.optimisticBasicTranscription")}
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={async () => {
              setError(null);
              try {
                await onSave({
                  id: model.id,
                  mode: "inherit",
                  optimisticBasicTranscription: optimisticBasic,
                });
                setOpen(false);
              } catch {
                setError(t("dashboard:models.capabilitySaveFailed"));
              }
            }}
          >
            {t("dashboard:models.inheritCapabilities")}
          </Button>
          <Button
            type="button"
            disabled={disabled}
            onClick={async () => {
              try {
                const parsed = parseOpenAiCompatibleCapabilities(JSON.parse(raw));
                if (!parsed) throw new Error(t("dashboard:models.invalidCapabilityProfile"));
                await onSave({
                  id: model.id,
                  mode: "override",
                  capabilities: parsed,
                  optimisticBasicTranscription: optimisticBasic,
                });
                setOpen(false);
              } catch (cause) {
                setError(
                  cause instanceof SyntaxError
                    ? t("dashboard:models.invalidCapabilityProfile")
                    : cause instanceof Error &&
                        cause.message === t("dashboard:models.invalidCapabilityProfile")
                      ? cause.message
                      : t("dashboard:models.capabilitySaveFailed"),
                );
              }
            }}
          >
            {t("dashboard:models.saveCapabilityProfile")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MEBIBYTE = 1024 * 1024;

function AttachmentLimitControl({
  currentBytes,
  disabled,
  onSave,
}: {
  currentBytes: number | null;
  disabled: boolean;
  onSave: (maxAttachmentBytes: number | null) => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const [value, setValue] = useState(
    currentBytes === null ? "" : String(Math.ceil(currentBytes / MEBIBYTE)),
  );
  const parsed = Number(value);
  const valid = value.trim() === "" || (Number.isInteger(parsed) && parsed > 0);

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSave(value.trim() === "" ? null : parsed * MEBIBYTE);
      }}
    >
      <div className="space-y-1">
        <Label className="text-xs">{t("dashboard:models.attachmentLimit")}</Label>
        <Input
          className="min-h-11 w-28"
          type="number"
          min={1}
          inputMode="numeric"
          placeholder={t("dashboard:models.attachmentLimitInherit")}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <Button type="submit" size="touch" disabled={disabled || !valid}>
        {t("common:actions.save")}
      </Button>
      <p className="basis-full text-xs text-muted-foreground">
        {t("dashboard:models.attachmentLimitHint")}
      </p>
    </form>
  );
}

/** Model is eligible if published (model + endpoint) and supports enabled modalities. */
function modelSupportsTransformerModalities(
  model: DirectModelOption,
  needed: { images: boolean; audio: boolean; video: boolean },
): boolean {
  if (!model.published || !model.endpointPublished) return false;
  const caps = modelTransformerCaps(model);
  if (needed.images && !caps.images) return false;
  if (needed.audio && !caps.audio) return false;
  if (needed.video && !caps.video) return false;
  // At least one modality should be useful when nothing is toggled yet — allow vision models.
  if (!needed.images && !needed.audio && !needed.video) {
    return caps.images || caps.audio || caps.video;
  }
  return true;
}

export function CliEndpointsModelsSection() {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const {
    data: devicesData,
    isPending: devicesIsPending,
    isError: devicesIsError,
    refetch: refetchDevices,
  } = useQuery({
    ...orpc.forwarderManagement.listCliDevices.queryOptions(),
  });
  const [search, setSearch] = useState("");
  const [healthFilter, setHealthFilter] = useState<EndpointHealthFilter>("all");
  const matchingDevices = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return (devicesData ?? []).flatMap((device) => {
      const deviceMatches = [device.slug, device.label].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      );
      const endpoints = device.endpoints.flatMap((endpoint) => {
        const matchesHealth =
          healthFilter === "all" ||
          (healthFilter === "online" && endpoint.status === "ONLINE") ||
          (healthFilter === "offline" && endpoint.status === "OFFLINE") ||
          (healthFilter === "stale" && device.isStale);
        if (!matchesHealth) return [];
        if (!needle) return [{ ...endpoint }];
        const endpointMatches = [endpoint.slug, endpoint.label].some((value) =>
          value.toLocaleLowerCase().includes(needle),
        );
        const models = endpoint.models.filter((model) =>
          [model.canonicalModelId, model.upstreamModelId].some((value) =>
            value.toLocaleLowerCase().includes(needle),
          ),
        );
        if (!endpointMatches && models.length === 0) return [];
        return [{ ...endpoint, models: endpointMatches ? endpoint.models : models }];
      });
      if (!needle) {
        if (healthFilter === "all") return [{ ...device, endpoints }];
        return endpoints.length > 0 ? [{ ...device, endpoints }] : [];
      }
      if (!deviceMatches && endpoints.length === 0) return [];
      // A device-name search expands the matching device, but must not undo an
      // active endpoint-health filter. `endpoints` is already filtered above.
      return [{ ...device, endpoints }];
    });
  }, [devicesData, healthFilter, search]);
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
  const updateModelCapabilities = useMutation(
    orpc.forwarderManagement.updateDiscoveredModelCapabilities.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:models.capabilitySaved"));
      },
    }),
  );
  const setModelCapabilityProfile = useMutation(
    orpc.forwarderManagement.setDiscoveredModelCapabilityProfile.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:models.capabilitySaved"));
      },
      onError: () => toast.error(t("dashboard:models.capabilitySaveFailed")),
    }),
  );
  const updateModelAttachmentLimit = useMutation(
    orpc.forwarderManagement.updateDiscoveredModelAttachmentLimit.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:models.attachmentLimitSaved"));
      },
      onError: () => toast.error(t("dashboard:models.attachmentLimitSaveFailed")),
    }),
  );

  if (devicesIsPending) return <ListSkeleton />;
  if (devicesIsError) {
    return <InlineRetry message={t("dashboard:clis.loadFailed")} onRetry={refetchDevices} />;
  }

  const isDeleting = removeCli.isPending || removeEndpoint.isPending || removeModel.isPending;

  return (
    <section className="min-w-0 max-w-full">
      <SectionHeader
        title={t("dashboard:clis.title")}
        description={t("dashboard:clis.description")}
        action={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("dashboard:clis.searchPlaceholder")}
              aria-label={t("dashboard:clis.searchLabel")}
              className="min-h-11 w-full sm:w-80"
            />
            <div
              className="flex flex-wrap gap-1"
              aria-label={t("dashboard:clis.healthFilterLabel")}
            >
              {(["all", "online", "offline", "stale"] as const).map((filter) => (
                <Button
                  key={filter}
                  type="button"
                  size="touch"
                  variant={healthFilter === filter ? "secondary" : "ghost"}
                  onClick={() => setHealthFilter(filter)}
                >
                  {t(`dashboard:clis.filters.${filter}`)}
                </Button>
              ))}
            </div>
          </div>
        }
      />

      {devicesData.length === 0 ? (
        <EmptyState>{t("dashboard:clis.empty")}</EmptyState>
      ) : matchingDevices.length === 0 ? (
        <EmptyState>{t("dashboard:clis.noSearchResults")}</EmptyState>
      ) : (
        <div className="space-y-4">
          {matchingDevices.map((device) => (
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
                  <p className="mt-1 text-xs text-muted-foreground">
                    {device.inventoryConfirmed && device.inventoryAcknowledgedAt
                      ? t("dashboard:clis.inventoryAcknowledged", {
                          sequence: device.inventorySeq,
                          value: formatDate(device.inventoryAcknowledgedAt),
                        })
                      : t("dashboard:clis.inventoryUnconfirmed")}
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
                    <div key={endpoint.id} className="min-w-0 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-sm font-medium">{endpoint.label}</h4>
                            <StatusPill>{endpoint.status}</StatusPill>
                            <StatusPill muted>{endpoint.kind}</StatusPill>
                            {!endpoint.published ? (
                              <StatusPill muted>
                                {t("dashboard:publication.unpublished")}
                              </StatusPill>
                            ) : null}
                          </div>
                          <p className="mt-1 font-mono text-xs text-muted-foreground">
                            {device.slug}/{endpoint.slug}
                          </p>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {t("dashboard:endpoints.lastSeen", {
                              value: formatDate(endpoint.lastSeenAt),
                            })}
                          </p>
                          {endpoint.failureReasonCode ? (
                            <p className="mt-1 text-xs text-destructive">
                              {t("dashboard:endpoints.failureReason", {
                                reason: endpoint.failureReasonCode,
                              })}
                            </p>
                          ) : null}
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

                      <WideContent className="mt-3">
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
                                  {!model.published ? (
                                    <StatusPill muted>
                                      {t("dashboard:publication.unpublished")}
                                    </StatusPill>
                                  ) : null}
                                  <p className="mt-1 text-muted-foreground">
                                    {t("dashboard:models.immutable")}
                                  </p>
                                </td>
                                <td className="py-2 pr-3 align-top font-mono">
                                  {model.upstreamModelId}
                                </td>
                                <td className="py-2 pr-3 align-top">
                                  <ModelCapabilityToggles
                                    modelId={model.id}
                                    vision={
                                      modelTransformerCaps({
                                        ...model,
                                        endpointPublished: endpoint.published,
                                        cliSlug: device.slug,
                                        endpointSlug: endpoint.slug,
                                        endpointLabel: endpoint.label,
                                        endpointCapabilityMetadata: endpoint.capabilityMetadata,
                                      }).images
                                    }
                                    audio={
                                      modelTransformerCaps({
                                        ...model,
                                        endpointPublished: endpoint.published,
                                        cliSlug: device.slug,
                                        endpointSlug: endpoint.slug,
                                        endpointLabel: endpoint.label,
                                        endpointCapabilityMetadata: endpoint.capabilityMetadata,
                                      }).audio
                                    }
                                    video={
                                      modelTransformerCaps({
                                        ...model,
                                        endpointPublished: endpoint.published,
                                        cliSlug: device.slug,
                                        endpointSlug: endpoint.slug,
                                        endpointLabel: endpoint.label,
                                        endpointCapabilityMetadata: endpoint.capabilityMetadata,
                                      }).video
                                    }
                                    disabled={updateModelCapabilities.isPending}
                                    onChange={(next) =>
                                      updateModelCapabilities.mutate({ id: model.id, ...next })
                                    }
                                  />
                                  <ModelCapabilityProfileEditor
                                    model={{
                                      ...model,
                                      endpointPublished: endpoint.published,
                                      cliSlug: device.slug,
                                      endpointSlug: endpoint.slug,
                                      endpointLabel: endpoint.label,
                                      endpointCapabilityMetadata: endpoint.capabilityMetadata,
                                    }}
                                    endpointCapabilityMetadata={endpoint.capabilityMetadata}
                                    disabled={setModelCapabilityProfile.isPending}
                                    onSave={(input) =>
                                      setModelCapabilityProfile
                                        .mutateAsync(input)
                                        .then(() => undefined)
                                    }
                                  />
                                  <AttachmentLimitControl
                                    key={`${model.id}-${model.maxAttachmentBytes ?? "inherit"}`}
                                    currentBytes={model.maxAttachmentBytes}
                                    disabled={updateModelAttachmentLimit.isPending}
                                    onSave={(maxAttachmentBytes) =>
                                      updateModelAttachmentLimit.mutate({
                                        id: model.id,
                                        maxAttachmentBytes,
                                      })
                                    }
                                  />
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
                      </WideContent>
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
  const [testingMemberId, setTestingMemberId] = useState<string | null>(null);
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
    <section className="min-w-0 max-w-full">
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
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <StatusPill muted>
                      {t("dashboard:pools.recommendedSurface")}:{" "}
                      {pool.compatibility.recommendedSurface ?? t("dashboard:pools.noneAvailable")}
                    </StatusPill>
                    {pool.compatibility.warnings.map((warning) => (
                      <StatusPill key={warning} muted>
                        {t(`dashboard:pools.warnings.${warning}`)}
                      </StatusPill>
                    ))}
                  </div>
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      {t("dashboard:pools.compatibilityDetails")}
                    </summary>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {Object.entries(pool.compatibility.surfaces).map(
                        ([surface, availability]) => (
                          <div key={surface} className="rounded border p-2">
                            <div className="font-medium">{surface}</div>
                            <div className="mt-1 text-muted-foreground">
                              {t("dashboard:pools.surfaceCounts", availability)}
                              {availability.streaming ? ` · ${t("dashboard:pools.streaming")}` : ""}
                            </div>
                            {availability.limitations.length > 0 ? (
                              <div className="mt-1 break-words text-muted-foreground">
                                {availability.limitations
                                  .map((limitation) =>
                                    t(`dashboard:pools.limitations.${limitation}`),
                                  )
                                  .join(", ")}
                              </div>
                            ) : null}
                          </div>
                        ),
                      )}
                    </div>
                  </details>
                  {pool.transformer.model ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t("dashboard:pools.transformerActive")}:{" "}
                      <code className="font-mono text-xs">
                        {pool.transformer.model.canonicalModelId}
                      </code>
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t("dashboard:pools.transformerOff")}
                    </p>
                  )}
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

              <div className="grid min-w-0 gap-0 divide-y lg:grid-cols-[1fr_22rem] lg:divide-x lg:divide-y-0">
                <div className="min-w-0 p-4">
                  <h4 className="mb-2 text-sm font-medium">{t("dashboard:pools.membersTitle")}</h4>
                  {pool.members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("dashboard:pools.noMembers")}
                    </p>
                  ) : (
                    <WideContent>
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
                                <code className="font-mono">
                                  {member.model?.canonicalModelId ??
                                    member.discoveredModelId ??
                                    member.id}
                                </code>
                              </td>
                              <td className="py-2 pr-3 align-top tabular-nums">{member.weight}</td>
                              <td className="py-2 pr-3 align-top">{member.routingStatus}</td>
                              <td className="py-2 pr-3 align-top">{member.healthStatus}</td>
                              <td className="py-2 pl-3 align-top">
                                <div className="flex justify-end gap-1">
                                  {member.model?.surfaces.OPENAI_CHAT_COMPLETIONS.mode !==
                                  "unavailable" ? (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="touch"
                                      disabled={testingMemberId === member.id}
                                      onClick={async () => {
                                        setTestingMemberId(member.id);
                                        try {
                                          const response = await fetch(
                                            `${env.VITE_SERVER_URL}/api/internal/pools/members/${member.id}/test`,
                                            {
                                              method: "POST",
                                              credentials: "include",
                                            },
                                          );
                                          const payload = (await response.json()) as {
                                            ok?: boolean;
                                            error?: string;
                                          };
                                          if (!response.ok || !payload.ok) {
                                            throw new Error(
                                              payload.error ?? `HTTP ${response.status}`,
                                            );
                                          }
                                          onChanged();
                                          toast.success(t("dashboard:pools.testMemberSuccess"));
                                        } catch (error) {
                                          toast.error(
                                            t("dashboard:pools.testMemberFailed", {
                                              error:
                                                error instanceof Error
                                                  ? error.message
                                                  : String(error),
                                            }),
                                          );
                                        } finally {
                                          setTestingMemberId(null);
                                        }
                                      }}
                                    >
                                      {t("dashboard:pools.testMember")}
                                    </Button>
                                  ) : null}
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
                    </WideContent>
                  )}
                </div>

                <div className="min-w-0 p-4">
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
        <SheetContent className="w-full overflow-hidden sm:max-w-md">
          <SheetHeader className="shrink-0">
            <SheetTitle>{t("dashboard:pools.editTitle")}</SheetTitle>
            <SheetDescription>{t("dashboard:pools.editDescription")}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip overscroll-y-contain px-4 pb-[max(1rem,var(--safe-area-bottom))]">
            {editingPool ? (
              <PoolForm
                key={editingPool.id}
                mode="edit"
                pool={editingPool}
                directModels={directModels}
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
        <SheetContent className="w-full overflow-hidden sm:max-w-md">
          <SheetHeader className="shrink-0">
            <SheetTitle>{t("dashboard:pools.editMemberTitle")}</SheetTitle>
            <SheetDescription>{t("dashboard:pools.editMemberDescription")}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip overscroll-y-contain px-4 pb-[max(1rem,var(--safe-area-bottom))]">
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
        confirmToken={
          deleteMember?.model?.canonicalModelId ?? deleteMember?.discoveredModelId ?? ""
        }
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
  directModels = [],
}: {
  mode: "create" | "edit";
  pool?: ModelPool;
  onSuccess: () => void;
  directModels?: ReturnType<typeof allDirectModels>;
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
    transformerDiscoveredModelId: z.string(),
    transformerImages: z.boolean(),
    transformerAudio: z.boolean(),
    transformerVideo: z.boolean(),
    transformerCacheMode: z.enum(["OFF", "MEMORY"]),
    transformerSystemPrompt: z.string().max(16_000),
    transformerIncludePrimaryTools: z.boolean(),
    transformerMaxTools: z.number().int().min(1).max(128),
    transformerMaxToolChars: z.number().int().min(256).max(32_000),
    transformerTimeoutMs: z.string(),
    transformerMaxAssets: z.string(),
    maxAttachmentMiB: z
      .string()
      .refine(
        (value) => value.trim() === "" || (/^\d+$/.test(value.trim()) && Number(value) > 0),
        t("dashboard:pools.attachmentLimitInvalid"),
      ),
    optimisticBasicTranscription: z.boolean(),
    protocolAdaptationEnabled: z.boolean(),
    allowLossyDeveloperRoleCollapse: z.boolean(),
    recommendedSurfaceOverride: z.enum([
      "",
      "OPENAI_CHAT_COMPLETIONS",
      "OPENAI_RESPONSES",
      "ANTHROPIC_MESSAGES",
      "OPENAI_COMPLETIONS",
    ]),
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
      transformerDiscoveredModelId: pool?.transformer.discoveredModelId ?? "",
      transformerImages: pool?.transformer.images ?? true,
      transformerAudio: pool?.transformer.audio ?? false,
      transformerVideo: pool?.transformer.video ?? false,
      transformerCacheMode: pool?.transformer.cacheMode === "MEMORY" ? "MEMORY" : "OFF",
      transformerSystemPrompt: pool?.transformer.systemPrompt ?? "",
      transformerIncludePrimaryTools: pool?.transformer.includePrimaryTools ?? false,
      transformerMaxTools: pool?.transformer.maxTools ?? 32,
      transformerMaxToolChars: pool?.transformer.maxToolChars ?? 8000,
      transformerTimeoutMs:
        pool?.transformer.timeoutMs != null ? String(pool.transformer.timeoutMs) : "",
      transformerMaxAssets:
        pool?.transformer.maxAssets != null ? String(pool.transformer.maxAssets) : "",
      maxAttachmentMiB:
        pool?.maxAttachmentBytes != null
          ? String(Math.ceil(pool.maxAttachmentBytes / MEBIBYTE))
          : "",
      optimisticBasicTranscription: pool?.optimisticBasicTranscription ?? false,
      protocolAdaptationEnabled: pool?.protocolAdaptationEnabled ?? false,
      allowLossyDeveloperRoleCollapse: pool?.allowLossyDeveloperRoleCollapse ?? false,
      recommendedSurfaceOverride: pool?.recommendedSurfaceOverride ?? "",
    },
    validators: { onSubmit: poolSchema },
    onSubmit: async ({ value }) => {
      if (mode === "create") {
        await createPool.mutateAsync({
          slug: value.slug.trim(),
          name: value.name.trim(),
          description: value.description.trim() || null,
          maxAttachmentBytes: value.maxAttachmentMiB.trim()
            ? Number(value.maxAttachmentMiB) * MEBIBYTE
            : null,
          optimisticBasicTranscription: value.optimisticBasicTranscription,
          protocolAdaptationEnabled: value.protocolAdaptationEnabled,
          allowLossyDeveloperRoleCollapse: value.allowLossyDeveloperRoleCollapse,
          recommendedSurfaceOverride:
            value.recommendedSurfaceOverride === ""
              ? null
              : (value.recommendedSurfaceOverride as
                  | "OPENAI_CHAT_COMPLETIONS"
                  | "OPENAI_RESPONSES"
                  | "ANTHROPIC_MESSAGES"
                  | "OPENAI_COMPLETIONS"),
        });
      } else if (pool) {
        await updatePool.mutateAsync({
          id: pool.id,
          slug: value.slug.trim(),
          name: value.name.trim(),
          description: value.description.trim() || null,
          transformerDiscoveredModelId: value.transformerDiscoveredModelId.trim()
            ? value.transformerDiscoveredModelId.trim()
            : null,
          transformerImages: value.transformerImages,
          transformerAudio: value.transformerAudio,
          transformerVideo: value.transformerVideo,
          transformerCacheMode: value.transformerCacheMode as "OFF" | "MEMORY",
          transformerSystemPrompt: value.transformerSystemPrompt.trim()
            ? value.transformerSystemPrompt.trim()
            : null,
          transformerIncludePrimaryTools: value.transformerIncludePrimaryTools,
          transformerMaxTools: value.transformerMaxTools,
          transformerMaxToolChars: value.transformerMaxToolChars,
          transformerTimeoutMs: value.transformerTimeoutMs.trim()
            ? Number(value.transformerTimeoutMs)
            : null,
          transformerMaxAssets: value.transformerMaxAssets.trim()
            ? Number(value.transformerMaxAssets)
            : null,
          maxAttachmentBytes: value.maxAttachmentMiB.trim()
            ? Number(value.maxAttachmentMiB) * MEBIBYTE
            : null,
          optimisticBasicTranscription: value.optimisticBasicTranscription,
          protocolAdaptationEnabled: value.protocolAdaptationEnabled,
          allowLossyDeveloperRoleCollapse: value.allowLossyDeveloperRoleCollapse,
          recommendedSurfaceOverride:
            value.recommendedSurfaceOverride === ""
              ? null
              : (value.recommendedSurfaceOverride as
                  | "OPENAI_CHAT_COMPLETIONS"
                  | "OPENAI_RESPONSES"
                  | "ANTHROPIC_MESSAGES"
                  | "OPENAI_COMPLETIONS"),
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
      <form.Field name="optimisticBasicTranscription">
        {(field) => (
          <div>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.checked)}
              />
              {t("dashboard:pools.optimisticBasicTranscription")}
            </label>
            <p className="text-xs text-muted-foreground">
              {t("dashboard:pools.optimisticBasicTranscriptionHint")}
            </p>
          </div>
        )}
      </form.Field>

      <div className="space-y-3 rounded-md border p-3">
        <div>
          <h4 className="text-sm font-medium">{t("dashboard:pools.protocolCompatibility")}</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("dashboard:pools.protocolCompatibilityHint")}
          </p>
        </div>
        <form.Field name="recommendedSurfaceOverride">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor={field.name}>{t("dashboard:pools.recommendedSurfaceOverride")}</Label>
              <select
                id={field.name}
                className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={field.state.value}
                onChange={(event) =>
                  field.handleChange(event.target.value as typeof field.state.value)
                }
              >
                <option value="">{t("dashboard:pools.recommendedAutomatic")}</option>
                <option value="OPENAI_RESPONSES">OpenAI Responses</option>
                <option value="OPENAI_CHAT_COMPLETIONS">OpenAI Chat Completions</option>
                <option value="ANTHROPIC_MESSAGES">Anthropic Messages</option>
                <option value="OPENAI_COMPLETIONS">OpenAI Completions</option>
              </select>
            </div>
          )}
        </form.Field>
        <form.Field name="protocolAdaptationEnabled">
          {(field) => (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={field.state.value}
                onChange={(event) => field.handleChange(event.target.checked)}
              />
              {t("dashboard:pools.enableProtocolAdaptation")}
            </label>
          )}
        </form.Field>
        <form.Field name="allowLossyDeveloperRoleCollapse">
          {(field) => (
            <div>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                {t("dashboard:pools.allowLossyDeveloperRoleCollapse")}
              </label>
              <p className="text-xs text-destructive">
                {t("dashboard:pools.lossyDeveloperRoleWarning")}
              </p>
            </div>
          )}
        </form.Field>
      </div>

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

      <form.Field name="maxAttachmentMiB">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("dashboard:pools.attachmentLimit")}</Label>
            <Input
              id={field.name}
              name={field.name}
              className="min-h-11 max-w-48"
              type="number"
              min={1}
              inputMode="numeric"
              placeholder={t("dashboard:pools.attachmentLimitInherit")}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("dashboard:pools.attachmentLimitHint")}
            </p>
            {field.state.meta.errors.map((error) => (
              <p key={error?.message} className="text-sm text-destructive">
                {error?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>

      {mode === "edit" ? (
        <div className="space-y-4 rounded-md border p-3">
          <div>
            <h4 className="text-sm font-medium">{t("dashboard:pools.transformerTitle")}</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("dashboard:pools.transformerDescription")}
            </p>
          </div>
          <form.Subscribe
            selector={(state) => ({
              images: state.values.transformerImages,
              audio: state.values.transformerAudio,
              video: state.values.transformerVideo,
            })}
          >
            {({ images, audio, video }) => (
              <form.Field name="transformerDiscoveredModelId">
                {(field) => {
                  const eligible = directModels.filter((model) =>
                    modelSupportsTransformerModalities(model, { images, audio, video }),
                  );
                  return (
                    <div className="space-y-2">
                      <Label htmlFor={field.name}>{t("dashboard:pools.transformerModel")}</Label>
                      <select
                        id={field.name}
                        name={field.name}
                        className="flex h-11 w-full min-h-11 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      >
                        <option value="">{t("dashboard:pools.transformerNone")}</option>
                        {eligible.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.canonicalModelId}
                          </option>
                        ))}
                      </select>
                      {field.state.value &&
                      !eligible.some((model) => model.id === field.state.value) ? (
                        <p className="text-sm text-destructive">
                          {t("dashboard:pools.transformerIncompatible")}
                        </p>
                      ) : null}
                      {eligible.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {t("dashboard:pools.transformerNoEligible")}
                        </p>
                      ) : null}
                    </div>
                  );
                }}
              </form.Field>
            )}
          </form.Subscribe>
          <form.Field name="transformerImages">
            {(field) => (
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                {t("dashboard:pools.transformerImages")}
              </label>
            )}
          </form.Field>
          <form.Field name="transformerAudio">
            {(field) => (
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                {t("dashboard:pools.transformerAudio")}
              </label>
            )}
          </form.Field>
          <form.Field name="transformerVideo">
            {(field) => (
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                {t("dashboard:pools.transformerVideo")}
              </label>
            )}
          </form.Field>
          <form.Field name="transformerCacheMode">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>{t("dashboard:pools.transformerCacheMode")}</Label>
                <select
                  id={field.name}
                  name={field.name}
                  className="flex h-11 w-full min-h-11 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value as "OFF" | "MEMORY")}
                >
                  <option value="OFF">{t("dashboard:pools.transformerCacheOff")}</option>
                  <option value="MEMORY">{t("dashboard:pools.transformerCacheMemory")}</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  {t("dashboard:pools.transformerCacheHint")}
                </p>
              </div>
            )}
          </form.Field>
          <form.Field name="transformerIncludePrimaryTools">
            {(field) => (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                {t("dashboard:pools.transformerIncludeTools")}
              </label>
            )}
          </form.Field>
          <p className="-mt-2 text-xs text-muted-foreground">
            {t("dashboard:pools.transformerIncludeToolsHint")}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <form.Field name="transformerMaxTools">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor={field.name}>{t("dashboard:pools.transformerMaxTools")}</Label>
                  <Input
                    id={field.name}
                    type="number"
                    min={1}
                    max={128}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(Number(event.target.value))}
                  />
                </div>
              )}
            </form.Field>
            <form.Field name="transformerMaxToolChars">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor={field.name}>{t("dashboard:pools.transformerMaxToolChars")}</Label>
                  <Input
                    id={field.name}
                    type="number"
                    min={256}
                    max={32000}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(Number(event.target.value))}
                  />
                </div>
              )}
            </form.Field>
            <form.Field name="transformerTimeoutMs">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor={field.name}>{t("dashboard:pools.transformerTimeoutMs")}</Label>
                  <Input
                    id={field.name}
                    inputMode="numeric"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    placeholder="120000"
                  />
                </div>
              )}
            </form.Field>
            <form.Field name="transformerMaxAssets">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor={field.name}>{t("dashboard:pools.transformerMaxAssets")}</Label>
                  <Input
                    id={field.name}
                    inputMode="numeric"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    placeholder="16"
                  />
                </div>
              )}
            </form.Field>
          </div>
          <form.Field name="transformerSystemPrompt">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>{t("dashboard:pools.transformerPrompt")}</Label>
                <Textarea
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  autoComplete="off"
                  rows={3}
                  placeholder={t("dashboard:pools.transformerPromptPlaceholder")}
                />
              </div>
            )}
          </form.Field>
        </div>
      ) : null}

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
            {member?.model?.canonicalModelId ?? member?.discoveredModelId ?? member?.id}
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
    <section className="min-w-0 max-w-full">
      <SectionHeader
        title={t("dashboard:tokens.cliTitle")}
        description={t("dashboard:tokens.cliDescription")}
        action={
          <Dialog
            open={createOpen}
            onOpenChange={(open: boolean) => {
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
                {secret ? (
                  <p className="text-sm">
                    {t("dashboard:tokens.name")}: <span className="font-medium">{name}</span>
                  </p>
                ) : (
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
                )}
                {secret ? (
                  <SecretDisplay secret={secret} label={t("dashboard:tokens.cliSecret")} />
                ) : null}
                <DialogFooter>
                  {secret ? (
                    <Button type="button" size="touch" onClick={() => setCreateOpen(false)}>
                      {t("common:close")}
                    </Button>
                  ) : (
                    <Button type="submit" size="touch" disabled={!name || create.isPending}>
                      {create.isPending
                        ? t("dashboard:tokens.creating")
                        : t("dashboard:tokens.create")}
                    </Button>
                  )}
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
    <WideContent className="rounded-md border">
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
    </WideContent>
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
    <section className="min-w-0 max-w-full">
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
      <div className="max-h-56 overflow-y-auto overflow-x-clip rounded-md border">
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
      <div className="mt-2 max-h-40 overflow-y-auto overflow-x-clip space-y-1">
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
    <section className="min-w-0 max-w-full">
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
        <WideContent className="rounded-md border">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">{t("dashboard:relay.createdAt")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.status")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.operation")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.requestBytes")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.responseBytes")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.attempts")}</th>
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
                  <td className="p-3 align-top font-mono">{row.operation ?? "—"}</td>
                  <td className="p-3 align-top tabular-nums">{numberOrDash(row.requestBytes)}</td>
                  <td className="p-3 align-top tabular-nums">{numberOrDash(row.responseBytes)}</td>
                  <td className="p-3 align-top tabular-nums">{numberOrDash(row.attemptCount)}</td>
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
        </WideContent>
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
