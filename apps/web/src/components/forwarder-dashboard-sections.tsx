import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  parseOpenAiCompatibleCapabilities,
  resolveEffectiveCapabilityMetadata,
  transformerSupportedModalities,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
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
import { Copy, Eye, EyeOff, Gauge, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { SegmentedControl } from "@/components/segmented-control";
import { WideContent } from "@/components/wide-content";
import {
  capacityFormSchema,
  capacityMutationPayload,
  directPolicyIsValid,
  directPolicyPayload,
  type FiniteLimitMode,
  memberPolicyPayload,
  newCapacityDefaults,
} from "@/lib/capacity-forms";
import { publicEgressResourceNames } from "@/lib/public-egress-disclosure";
import { orpc } from "@/utils/orpc";

type CliDevice = Awaited<
  ReturnType<AppRouterClient["forwarderManagement"]["listCliDevices"]>
>[number];
type ModelPool = Awaited<
  ReturnType<AppRouterClient["forwarderManagement"]["listModelPools"]>
>[number];
type PoolMember = ModelPool["members"][number];
type CliToken = Awaited<ReturnType<AppRouterClient["cliCredentials"]["listTokens"]>>[number];
type ModelApiToken = Awaited<ReturnType<AppRouterClient["modelApiTokens"]["list"]>>[number];
type VisibleModels = Awaited<ReturnType<AppRouterClient["forwarderManagement"]["visibleModels"]>>;
type TokenPreview = Awaited<ReturnType<AppRouterClient["modelApiTokens"]["preview"]>>;
type RelayRow = Awaited<ReturnType<AppRouterClient["relayMetadata"]["listOwn"]>>[number];
type CapacityRow = Awaited<ReturnType<AppRouterClient["capacityManagement"]["list"]>>[number];
type CapacityAvailability = "enabled" | "disabled" | "loading" | "error";
type ScopeMode = "ALL_VISIBLE" | "ALLOWLIST";
type RoutingStatus = "ACTIVE" | "DRAINING" | "DISABLED";
type EndpointHealthFilter = "all" | "online" | "offline" | "stale";
type DeleteTarget =
  | { kind: "cli"; id: string; label: string }
  | { kind: "endpoint"; id: string; label: string }
  | { kind: "model"; id: string; label: string };

export function resolveCapacityAvailability(
  capacityEnabled: boolean | undefined,
  isConfigError: boolean,
): CapacityAvailability {
  if (capacityEnabled !== undefined) return capacityEnabled ? "enabled" : "disabled";
  if (isConfigError) return "error";
  return "loading";
}

export function visiblePoolCompatibilitySurfaces<
  Availability extends { native: number; adapted: number },
>(surfaces: Record<string, Availability>, recommendedSurfaceOverride: string | null) {
  return Object.entries(surfaces).filter(
    ([surface, availability]) =>
      (surface !== "OPENAI_COMPLETIONS" ||
        availability.native > 0 ||
        recommendedSurfaceOverride === "OPENAI_COMPLETIONS") &&
      (availability.native > 0 || availability.adapted > 0),
  ) as Array<[string, Availability]>;
}

export function unavailablePoolCompatibilitySurfaceCount(
  surfaces: Record<string, { native: number; adapted: number }>,
  recommendedSurfaceOverride: string | null,
) {
  return Object.entries(surfaces).filter(
    ([surface, availability]) =>
      (surface !== "OPENAI_COMPLETIONS" ||
        availability.native > 0 ||
        recommendedSurfaceOverride === "OPENAI_COMPLETIONS") &&
      availability.native === 0 &&
      availability.adapted === 0,
  ).length;
}

function capacityUnavailableReasonKey(availability: CapacityAvailability) {
  if (availability === "loading") return "dashboard:pools.capacity.settingsLoading";
  if (availability === "error") return "dashboard:pools.capacity.settingsFailed";
  return "dashboard:pools.capacity.disabledReason";
}

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

const poolSurfaceValues = [
  "OPENAI_CHAT_COMPLETIONS",
  "OPENAI_RESPONSES",
  "ANTHROPIC_MESSAGES",
] as const;

type PoolSurface = (typeof poolSurfaceValues)[number];

function poolSurfaceOverrideValue(value: string | null | undefined): PoolSurface | "" {
  return value && poolSurfaceValues.includes(value as PoolSurface) ? (value as PoolSurface) : "";
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
  const [visible, setVisible] = useState(false);

  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap border bg-background px-3 py-3 font-mono text-xs tracking-wide">
          {visible ? secret : "••••••••••••••••••••••••"}
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
        <Button
          type="button"
          size="icon-touch"
          variant="outline"
          onClick={() => setVisible((current) => !current)}
          aria-label={
            visible ? t("dashboard:actions.hideSecret") : t("dashboard:actions.showSecret")
          }
          aria-pressed={visible}
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("dashboard:tokens.oneTimeSecretHelp")}</p>
    </div>
  );
}

export function CopyableModelId({ modelId }: { modelId: string }) {
  const { t } = useTranslation(["common", "dashboard"]);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{modelId}</code>
      <Button
        type="button"
        size="icon-touch"
        variant="ghost"
        className="shrink-0"
        onClick={() => copyToClipboard(modelId, t("common:actions.copied"))}
        aria-label={t("dashboard:actions.copyModelId")}
      >
        <Copy className="size-4" />
      </Button>
    </div>
  );
}

export function allDirectModels(devices: CliDevice[]) {
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
  const appConfigQuery = useQuery(orpc.appConfig.queryOptions());
  const appConfig = appConfigQuery.data;
  const capacityAvailability = resolveCapacityAvailability(
    appConfig?.capacityEnabled,
    appConfigQuery.isError,
  );
  const capacityEnabled = capacityAvailability === "enabled";
  const {
    data: devicesData,
    isPending: devicesIsPending,
    isError: devicesIsError,
    refetch: refetchDevices,
  } = useQuery({
    ...orpc.forwarderManagement.listCliDevices.queryOptions(),
  });
  const { data: capacitiesData } = useQuery({
    ...orpc.capacityManagement.list.queryOptions(),
    retry: false,
    enabled: capacityEnabled,
  });
  const [policyModel, setPolicyModel] = useState<DirectModelOption | null>(null);
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
                                  <CopyableModelId modelId={model.canonicalModelId} />
                                  {model.suggestedConnectionType ? (
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      {t("dashboard:models.suggestedConnectionType", {
                                        type: t(
                                          `dashboard:connectionTypes.${model.suggestedConnectionType}`,
                                        ),
                                      })}
                                    </p>
                                  ) : null}
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
                                  {model.executionTarget ? (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-touch"
                                      onClick={() =>
                                        setPolicyModel({
                                          ...model,
                                          endpointPublished: endpoint.published,
                                          cliSlug: device.slug,
                                          endpointSlug: endpoint.slug,
                                          endpointLabel: endpoint.label,
                                          endpointCapabilityMetadata: endpoint.capabilityMetadata,
                                        })
                                      }
                                      aria-label={t("dashboard:pools.capacity.directPolicy")}
                                    >
                                      <Gauge className="size-4" />
                                    </Button>
                                  ) : null}
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

      <Sheet open={Boolean(policyModel)} onOpenChange={(open) => !open && setPolicyModel(null)}>
        <SheetContent className="w-full overflow-hidden sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t("dashboard:pools.capacity.directPolicy")}</SheetTitle>
            <SheetDescription>{policyModel?.canonicalModelId}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto overflow-x-clip px-4 pb-4">
            {policyModel?.executionTarget ? (
              <DirectCapacityPolicyForm
                target={policyModel.executionTarget}
                capacities={capacitiesData ?? []}
                capacityAvailability={capacityAvailability}
                onSuccess={() => setPolicyModel(null)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

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

function DirectCapacityPolicyForm({
  target,
  capacities,
  capacityAvailability,
  onSuccess,
}: {
  target: NonNullable<DirectModelOption["executionTarget"]>;
  capacities: CapacityRow[];
  capacityAvailability: CapacityAvailability;
  onSuccess: () => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const capacityEnabled = capacityAvailability === "enabled";
  const queryClient = useQueryClient();
  const [capacityId, setCapacityId] = useState(target.inferenceCapacityId ?? "");
  const [priority, setPriority] = useState(String(target.directPriority));
  const [concurrencyMode, setConcurrencyMode] = useState<FiniteLimitMode>(
    target.directConcurrencyLimit === null ? "UNLIMITED" : "LIMITED",
  );
  const [concurrency, setConcurrency] = useState(String(target.directConcurrencyLimit ?? 1));
  const [reserved, setReserved] = useState(String(target.directReservedSlots));
  const [waitMode, setWaitMode] = useState<FiniteLimitMode>(
    target.directWaitBudgetMs === null ? "UNLIMITED" : "LIMITED",
  );
  const [wait, setWait] = useState(String(target.directWaitBudgetMs ?? 30_000));
  const [ceilingMode, setCeilingMode] = useState<FiniteLimitMode>(
    target.directContextCeiling === null ? "UNLIMITED" : "LIMITED",
  );
  const [ceiling, setCeiling] = useState(String(target.directContextCeiling ?? 32_768));
  const [margin, setMargin] = useState(String(target.directContextMargin));
  const [borrow, setBorrow] = useState<"NEVER" | "WHEN_IDLE">(
    target.directBorrowPolicy === "NEVER" ? "NEVER" : "WHEN_IDLE",
  );
  const mutation = useMutation(
    orpc.capacityManagement.updateDirectPolicy.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        queryClient.invalidateQueries({ queryKey: orpc.capacityManagement.key() });
        toast.success(t("dashboard:pools.capacity.policyUpdated"));
        onSuccess();
      },
    }),
  );
  const valid = directPolicyIsValid({
    priority,
    concurrency,
    reserved,
    wait,
    ceiling,
    margin,
    hardLimit: capacityId
      ? (capacities.find((capacity) => capacity.id === capacityId)?.hardConcurrencyLimit ?? null)
      : null,
    concurrencyMode,
    waitMode,
    ceilingMode,
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!capacityEnabled || !valid) return;
        mutation.mutate(
          directPolicyPayload({
            executionTargetId: target.id,
            capacityId,
            priority,
            concurrency,
            reserved,
            wait,
            ceiling,
            margin,
            borrow,
            concurrencyMode,
            waitMode,
            ceilingMode,
          }),
        );
      }}
    >
      {!capacityEnabled ? (
        <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t(capacityUnavailableReasonKey(capacityAvailability))}
        </p>
      ) : null}
      <fieldset disabled={!capacityEnabled} className="min-w-0 space-y-4 disabled:opacity-60">
        <p className="text-sm text-muted-foreground">
          {t("dashboard:pools.capacity.directGlobalEffect")}
        </p>
        <div className="space-y-2">
          <Label htmlFor="direct-capacity">{t("dashboard:pools.capacity.attachment")}</Label>
          <select
            id="direct-capacity"
            className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
            value={capacityId}
            onChange={(event) => setCapacityId(event.target.value)}
          >
            <option value="">{t("dashboard:pools.capacity.unattached")}</option>
            {capacities.map((capacity) => (
              <option key={capacity.id} value={capacity.id}>
                {capacity.label}
              </option>
            ))}
          </select>
        </div>
        {[
          ["direct-priority", "capacityPriority", priority, setPriority, 0, 31],
          ["direct-reserved", "capacityReservedSlots", reserved, setReserved, 0],
          ["direct-margin", "capacityContextMargin", margin, setMargin, 0],
        ].map(([id, label, value, setter, min, max]) => (
          <div key={String(id)} className="space-y-2">
            <Label htmlFor={String(id)}>{t(`dashboard:pools.capacity.fields.${label}`)}</Label>
            <Input
              id={String(id)}
              className="min-h-11"
              type="number"
              min={Number(min)}
              max={max == null ? undefined : Number(max)}
              value={String(value)}
              onChange={(event) =>
                (setter as React.Dispatch<React.SetStateAction<string>>)(event.target.value)
              }
            />
          </div>
        ))}
        {(
          [
            [
              "direct-concurrency",
              "hardConcurrencyLimit",
              concurrencyMode,
              setConcurrencyMode,
              concurrency,
              setConcurrency,
              1,
            ],
            ["direct-wait", "capacityWaitBudgetMs", waitMode, setWaitMode, wait, setWait, 0],
            [
              "direct-ceiling",
              "capacityContextCeiling",
              ceilingMode,
              setCeilingMode,
              ceiling,
              setCeiling,
              1,
            ],
          ] as const
        ).map(([id, label, mode, setMode, value, setValue, min]) => (
          <div key={id} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)]">
            <div className="space-y-2">
              <Label htmlFor={`${id}-mode`}>{t(`dashboard:pools.capacity.fields.${label}`)}</Label>
              <select
                id={`${id}-mode`}
                className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
                value={mode}
                onChange={(event) => setMode(event.target.value as FiniteLimitMode)}
              >
                <option value="LIMITED">{t("dashboard:pools.capacity.modes.limited")}</option>
                <option value="UNLIMITED">{t("dashboard:pools.capacity.modes.unlimited")}</option>
              </select>
            </div>
            {mode === "LIMITED" ? (
              <div className="space-y-2">
                <Label htmlFor={id}>{t("dashboard:pools.capacity.limitValue")}</Label>
                <Input
                  id={id}
                  className="min-h-11"
                  type="number"
                  min={min}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              </div>
            ) : null}
          </div>
        ))}
        <div className="space-y-2">
          <Label htmlFor="direct-borrow">
            {t("dashboard:pools.capacity.fields.capacityBorrowPolicy")}
          </Label>
          <select
            id="direct-borrow"
            className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
            value={borrow}
            onChange={(event) => setBorrow(event.target.value as "NEVER" | "WHEN_IDLE")}
          >
            <option value="WHEN_IDLE">{t("dashboard:pools.capacity.borrowIdle")}</option>
            <option value="NEVER">{t("dashboard:pools.capacity.borrowNever")}</option>
          </select>
        </div>
        <Button
          type="submit"
          size="touch"
          disabled={!capacityEnabled || !valid || mutation.isPending}
        >
          {mutation.isPending ? t("common:actions.saving") : t("common:actions.save")}
        </Button>
      </fieldset>
    </form>
  );
}

export function shouldShowCapacitySection(
  enabled: boolean,
  isLoading: boolean,
  data: CapacityRow[] | undefined,
): boolean {
  return enabled && (isLoading || data !== undefined);
}

export function shouldShowProviderOperationsSection(providerEgressEnabled: boolean | undefined) {
  return providerEgressEnabled === true;
}

export function CapacitySetupForm({
  onSuccess,
  capacity,
  capacityAvailability,
}: {
  onSuccess: () => void;
  capacity?: CapacityRow;
  capacityAvailability: CapacityAvailability;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const capacityEnabled = capacityAvailability === "enabled";
  const queryClient = useQueryClient();
  const createCapacity = useMutation(
    orpc.capacityManagement.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.capacityManagement.key() });
        toast.success(t("dashboard:pools.capacity.created"));
        onSuccess();
      },
    }),
  );
  const updateCapacity = useMutation(
    orpc.capacityManagement.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.capacityManagement.key() });
        toast.success(t("dashboard:pools.capacity.updated"));
        onSuccess();
      },
    }),
  );
  const form = useForm({
    defaultValues: {
      ...newCapacityDefaults,
      label: capacity?.label ?? newCapacityDefaults.label,
      runtimeModel: capacity?.runtimeModel ?? newCapacityDefaults.runtimeModel,
      runtimeIdentityKey: capacity?.runtimeIdentityKey ?? newCapacityDefaults.runtimeIdentityKey,
      hardConcurrencyMode: capacity
        ? capacity.hardConcurrencyLimit === null
          ? "UNLIMITED"
          : "LIMITED"
        : newCapacityDefaults.hardConcurrencyMode,
      hardConcurrencyLimit:
        capacity?.hardConcurrencyLimit ?? newCapacityDefaults.hardConcurrencyLimit,
      physicalMaxContextMode: capacity
        ? capacity.physicalMaxContext === null
          ? "UNLIMITED"
          : "LIMITED"
        : newCapacityDefaults.physicalMaxContextMode,
      physicalMaxContext: capacity?.physicalMaxContext ?? newCapacityDefaults.physicalMaxContext,
      countStrategy: (capacity?.countStrategy ?? newCapacityDefaults.countStrategy) as
        | "CONSERVATIVE_ESTIMATE"
        | "ENGINE_REPORTED"
        | "TOKENIZER"
        | "TEMPLATE_AWARE",
      runtimeRevision: capacity?.runtimeRevision ?? "",
      tokenizer: capacity?.tokenizer ?? "",
      template: capacity?.template ?? "",
    },
    validators: { onSubmit: capacityFormSchema },
    onSubmit: async ({ value }) => {
      if (!capacityEnabled) return;
      const data = capacityMutationPayload(value);
      if (capacity) await updateCapacity.mutateAsync({ id: capacity.id, ...data });
      else await createCapacity.mutateAsync(data);
    },
  });
  if (!capacityEnabled)
    return (
      <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        {t(capacityUnavailableReasonKey(capacityAvailability))}
      </p>
    );
  const textField = (name: "label" | "runtimeModel" | "runtimeIdentityKey") => (
    <form.Field name={name}>
      {(field) => (
        <div className="space-y-2">
          <Label htmlFor={`capacity-${field.name}`}>
            {t(`dashboard:pools.capacity.fields.${field.name}`)}
          </Label>
          <Input
            id={`capacity-${field.name}`}
            className="min-h-11"
            value={field.state.value}
            onBlur={field.handleBlur}
            onChange={(event) => field.handleChange(event.target.value)}
            autoComplete="off"
          />
        </div>
      )}
    </form.Field>
  );
  return (
    <form
      className="min-w-0 space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        {textField("label")}
        {textField("runtimeModel")}
        <div className="sm:col-span-2">{textField("runtimeIdentityKey")}</div>
        {(["hardConcurrency", "physicalMaxContext"] as const).map((kind) => {
          const modeName =
            kind === "hardConcurrency" ? "hardConcurrencyMode" : "physicalMaxContextMode";
          const valueName =
            kind === "hardConcurrency" ? "hardConcurrencyLimit" : "physicalMaxContext";
          return (
            <form.Field key={kind} name={modeName}>
              {(modeField) => (
                <div className="min-w-0 space-y-2">
                  <Label htmlFor={`capacity-${valueName}-mode`}>
                    {t(`dashboard:pools.capacity.fields.${valueName}`)}
                  </Label>
                  <select
                    id={`capacity-${valueName}-mode`}
                    className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={modeField.state.value}
                    onChange={(event) =>
                      modeField.handleChange(event.target.value as FiniteLimitMode)
                    }
                  >
                    <option value="LIMITED">{t("dashboard:pools.capacity.modes.limited")}</option>
                    <option value="UNLIMITED">
                      {t("dashboard:pools.capacity.modes.unlimited")}
                    </option>
                  </select>
                  {modeField.state.value === "LIMITED" ? (
                    <form.Field name={valueName}>
                      {(field) => (
                        <Input
                          id={`capacity-${field.name}`}
                          className="min-h-11"
                          type="number"
                          min={1}
                          inputMode="numeric"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(Number(event.target.value))}
                          aria-label={t("dashboard:pools.capacity.limitValue")}
                        />
                      )}
                    </form.Field>
                  ) : null}
                </div>
              )}
            </form.Field>
          );
        })}
      </div>
      <p className="text-sm text-muted-foreground">{t("dashboard:pools.capacity.safeDefaults")}</p>
      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
          {t("dashboard:pools.capacity.advanced")}
        </summary>
        <div className="grid gap-4 pt-3 sm:grid-cols-2">
          <form.Field name="countStrategy">
            {(field) => (
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="capacity-countStrategy">
                  {t("dashboard:pools.capacity.fields.countStrategy")}
                </Label>
                <select
                  id="capacity-countStrategy"
                  className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  value={field.state.value}
                  onChange={(event) =>
                    field.handleChange(event.target.value as typeof field.state.value)
                  }
                >
                  <option value="CONSERVATIVE_ESTIMATE">
                    {t("dashboard:pools.capacity.strategies.estimate")}
                  </option>
                  <option value="ENGINE_REPORTED">
                    {t("dashboard:pools.capacity.strategies.engine")}
                  </option>
                  <option value="TOKENIZER">
                    {t("dashboard:pools.capacity.strategies.tokenizer")}
                  </option>
                  <option value="TEMPLATE_AWARE">
                    {t("dashboard:pools.capacity.strategies.template")}
                  </option>
                </select>
                {field.state.value === "ENGINE_REPORTED" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("dashboard:pools.capacity.strategies.engineRequirement")}
                  </p>
                ) : field.state.value === "TOKENIZER" || field.state.value === "TEMPLATE_AWARE" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("dashboard:pools.capacity.strategies.registeredRequirement")}
                  </p>
                ) : null}
              </div>
            )}
          </form.Field>
          {(["runtimeRevision", "tokenizer", "template"] as const).map((name) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor={`capacity-${field.name}`}>
                    {t(`dashboard:pools.capacity.fields.${field.name}`)}
                  </Label>
                  <Input
                    id={`capacity-${field.name}`}
                    className="min-h-11"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    autoComplete="off"
                  />
                </div>
              )}
            </form.Field>
          ))}
        </div>
      </details>
      <DialogFooter>
        <Button
          type="submit"
          size="touch"
          disabled={createCapacity.isPending || updateCapacity.isPending}
        >
          {createCapacity.isPending || updateCapacity.isPending
            ? t("common:actions.saving")
            : t("dashboard:pools.capacity.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function PoolForm({
  mode,
  pool,
  onSuccess,
  stickySave = false,
  directModels,
  capacities = [],
  capacityAvailability,
  protocolAdaptationAvailable,
}: {
  mode: "create" | "edit";
  pool?: ModelPool;
  onSuccess: () => void;
  stickySave?: boolean;
  directModels: ReturnType<typeof allDirectModels>;
  capacities?: CapacityRow[];
  capacityAvailability: CapacityAvailability;
  protocolAdaptationAvailable: boolean;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const capacityEnabled = capacityAvailability === "enabled";
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
    recommendedSurfaceOverride: z.enum(["", ...poolSurfaceValues]),
    capacityPriority: z.number().int().min(0).max(31),
    capacityConcurrencyMode: z.enum(["LIMITED", "UNLIMITED"]),
    capacityConcurrencyLimit: z.number().int().min(1).max(10_000),
    capacityReservedSlots: z.number().int().min(0).max(10_000),
    capacityWaitBudgetMode: z.enum(["LIMITED", "UNLIMITED"]),
    capacityWaitBudgetMs: z.number().int().min(0).max(600_000),
    capacityContextCeilingMode: z.enum(["LIMITED", "UNLIMITED"]),
    capacityContextCeiling: z.number().int().min(1).max(100_000_000),
    capacityContextMargin: z.number().int().min(0).max(100_000_000),
    capacityBorrowPolicy: z.enum(["NEVER", "WHEN_IDLE"]),
    affinityEnabled: z.boolean(),
    affinityTtlSeconds: z.number().int().min(60).max(604_800),
    affinityMaxRecords: z.number().int().min(100).max(100_000),
    affinityPrefixWeight: z.number().int().min(0).max(10_000),
    affinityConversationWeight: z.number().int().min(0).max(10_000),
    affinityLoadPenaltyWeight: z.number().int().min(0).max(10_000),
  });
  const createPool = useMutation(
    orpc.forwarderManagement.createModelPool.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
      },
    }),
  );
  const updatePool = useMutation(
    orpc.forwarderManagement.updateModelPool.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
      },
    }),
  );
  const affinityStats = useQuery({
    ...orpc.forwarderManagement.cacheAffinityStats.queryOptions({
      input: { poolId: pool?.id ?? "disabled" },
    }),
    enabled: Boolean(pool?.id),
  });
  const clearAffinity = useMutation(
    orpc.forwarderManagement.clearCacheAffinity.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: orpc.forwarderManagement.cacheAffinityStats.key(),
        });
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
      allowLossyDeveloperRoleCollapse:
        pool?.protocolAdaptationEnabled === true ? pool.allowLossyDeveloperRoleCollapse : false,
      recommendedSurfaceOverride: poolSurfaceOverrideValue(pool?.recommendedSurfaceOverride),
      capacityPriority: pool?.capacityPriority ?? 16,
      capacityConcurrencyMode: (pool?.capacityConcurrencyLimit === null
        ? "UNLIMITED"
        : "LIMITED") as FiniteLimitMode,
      capacityConcurrencyLimit: pool?.capacityConcurrencyLimit ?? 1,
      capacityReservedSlots: pool?.capacityReservedSlots ?? 0,
      capacityWaitBudgetMode: (pool?.capacityWaitBudgetMs === null
        ? "UNLIMITED"
        : "LIMITED") as FiniteLimitMode,
      capacityWaitBudgetMs: pool?.capacityWaitBudgetMs ?? 30_000,
      capacityContextCeilingMode: (pool?.capacityContextCeiling === null
        ? "UNLIMITED"
        : "LIMITED") as FiniteLimitMode,
      capacityContextCeiling: pool?.capacityContextCeiling ?? 32_768,
      capacityContextMargin: pool?.capacityContextMargin ?? 1_024,
      capacityBorrowPolicy: (pool?.capacityBorrowPolicy === "NEVER" ? "NEVER" : "WHEN_IDLE") as
        | "NEVER"
        | "WHEN_IDLE",
      affinityEnabled: pool?.affinity.enabled ?? false,
      affinityTtlSeconds: pool?.affinity.ttlSeconds ?? 3600,
      affinityMaxRecords: pool?.affinity.maxRecords ?? 10_000,
      affinityPrefixWeight: pool?.affinity.prefixWeight ?? 100,
      affinityConversationWeight: pool?.affinity.conversationWeight ?? 150,
      affinityLoadPenaltyWeight: pool?.affinity.loadPenaltyWeight ?? 100,
    },
    validators: { onSubmit: poolSchema },
    onSubmit: async ({ value }) => {
      const transformer = {
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
      };
      const capacityPolicy = capacityEnabled
        ? {
            capacityPriority: value.capacityPriority,
            capacityConcurrencyLimit:
              value.capacityConcurrencyMode === "LIMITED" ? value.capacityConcurrencyLimit : null,
            capacityReservedSlots: value.capacityReservedSlots,
            capacityWaitBudgetMs:
              value.capacityWaitBudgetMode === "LIMITED" ? value.capacityWaitBudgetMs : null,
            capacityContextCeiling:
              value.capacityContextCeilingMode === "LIMITED" ? value.capacityContextCeiling : null,
            capacityContextMargin: value.capacityContextMargin,
            capacityBorrowPolicy: value.capacityBorrowPolicy,
          }
        : {};
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
            value.recommendedSurfaceOverride === "" ? null : value.recommendedSurfaceOverride,
          ...transformer,
          ...capacityPolicy,
          affinityEnabled: value.affinityEnabled,
          affinityTtlSeconds: value.affinityTtlSeconds,
          affinityMaxRecords: value.affinityMaxRecords,
          affinityPrefixWeight: value.affinityPrefixWeight,
          affinityConversationWeight: value.affinityConversationWeight,
          affinityLoadPenaltyWeight: value.affinityLoadPenaltyWeight,
        });
        toast.success(t("dashboard:pools.created"));
        onSuccess();
      } else if (pool) {
        await updatePool.mutateAsync({
          id: pool.id,
          slug: value.slug.trim(),
          name: value.name.trim(),
          description: value.description.trim() || null,
          ...transformer,
          maxAttachmentBytes: value.maxAttachmentMiB.trim()
            ? Number(value.maxAttachmentMiB) * MEBIBYTE
            : null,
          optimisticBasicTranscription: value.optimisticBasicTranscription,
          protocolAdaptationEnabled: value.protocolAdaptationEnabled,
          allowLossyDeveloperRoleCollapse: value.allowLossyDeveloperRoleCollapse,
          recommendedSurfaceOverride:
            value.recommendedSurfaceOverride === "" ? null : value.recommendedSurfaceOverride,
          affinityEnabled: value.affinityEnabled,
          affinityTtlSeconds: value.affinityTtlSeconds,
          affinityMaxRecords: value.affinityMaxRecords,
          affinityPrefixWeight: value.affinityPrefixWeight,
          affinityConversationWeight: value.affinityConversationWeight,
          affinityLoadPenaltyWeight: value.affinityLoadPenaltyWeight,
          ...capacityPolicy,
        });
        toast.success(t("dashboard:pools.updated"));
        onSuccess();
      }
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit().catch(() => undefined);
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
                {poolSurfaceValues.map((surface) => (
                  <option key={surface} value={surface}>
                    {t(`dashboard:pools.wizard.surfaces.${surface}`)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </form.Field>
        <form.Field name="protocolAdaptationEnabled">
          {(field) => (
            <label className="flex min-h-11 items-center gap-3 text-sm disabled:cursor-not-allowed">
              <input
                type="checkbox"
                className="size-4"
                checked={field.state.value}
                disabled={!protocolAdaptationAvailable}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  field.handleChange(enabled);
                  if (!enabled) form.setFieldValue("allowLossyDeveloperRoleCollapse", false);
                }}
              />
              {t("dashboard:pools.enableProtocolAdaptation")}
            </label>
          )}
        </form.Field>
        {!protocolAdaptationAvailable ? (
          <p className="text-xs text-muted-foreground">
            {t("dashboard:pools.protocolAdaptationDisabledReason")}
          </p>
        ) : null}
        <form.Subscribe selector={(state) => state.values.protocolAdaptationEnabled}>
          {(protocolAdaptationEnabled) => (
            <form.Field name="allowLossyDeveloperRoleCollapse">
              {(field) => (
                <div>
                  <label className="flex min-h-11 items-center gap-3 text-sm disabled:cursor-not-allowed">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={field.state.value}
                      disabled={!protocolAdaptationAvailable || !protocolAdaptationEnabled}
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
          )}
        </form.Subscribe>
      </div>

      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
          {t("dashboard:pools.affinity.title")}
        </summary>
        <p className="mb-3 text-xs text-muted-foreground">
          {t("dashboard:pools.affinity.description")}
        </p>
        <form.Field name="affinityEnabled">
          {(field) => (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={field.state.value}
                onChange={(event) => field.handleChange(event.target.checked)}
              />
              {t("dashboard:pools.affinity.enabled")}
            </label>
          )}
        </form.Field>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {(
            [
              "affinityTtlSeconds",
              "affinityMaxRecords",
              "affinityPrefixWeight",
              "affinityConversationWeight",
              "affinityLoadPenaltyWeight",
            ] as const
          ).map((name) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <div className="min-w-0 space-y-2">
                  <Label htmlFor={name}>{t(`dashboard:pools.affinity.fields.${name}`)}</Label>
                  <Input
                    id={name}
                    className="min-h-11"
                    type="number"
                    value={field.state.value}
                    min={
                      name === "affinityTtlSeconds" ? 60 : name === "affinityMaxRecords" ? 100 : 0
                    }
                    max={
                      name === "affinityTtlSeconds"
                        ? 604800
                        : name === "affinityMaxRecords"
                          ? 100000
                          : 10000
                    }
                    onChange={(event) => field.handleChange(Number(event.target.value))}
                  />
                </div>
              )}
            </form.Field>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {t("dashboard:pools.affinity.privacy")}
        </p>
        {pool ? (
          <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
            <span>
              {t("dashboard:pools.affinity.stats", {
                records: affinityStats.data?.activeRecords ?? 0,
                targets: affinityStats.data?.targets.length ?? 0,
              })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              disabled={clearAffinity.isPending || !affinityStats.data?.activeRecords}
              onClick={() => clearAffinity.mutate({ poolId: pool.id })}
            >
              {t("dashboard:pools.affinity.clear")}
            </Button>
          </div>
        ) : null}
      </details>

      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
          {t("dashboard:pools.capacity.poolPolicy")}
        </summary>
        <p className="mb-3 text-xs text-muted-foreground">
          {t("dashboard:pools.capacity.poolPolicyHint", { count: capacities.length })}
        </p>
        {!capacityEnabled ? (
          <p className="mb-3 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
            {t(capacityUnavailableReasonKey(capacityAvailability))}
          </p>
        ) : null}
        <fieldset disabled={!capacityEnabled} className="min-w-0 disabled:opacity-60">
          <div className="grid gap-4 sm:grid-cols-2">
            {(["capacityPriority", "capacityReservedSlots", "capacityContextMargin"] as const).map(
              (name) => (
                <form.Field key={name} name={name}>
                  {(field) => (
                    <div className="space-y-2">
                      <Label htmlFor={name}>{t(`dashboard:pools.capacity.fields.${name}`)}</Label>
                      <Input
                        id={name}
                        className="min-h-11"
                        type="number"
                        value={field.state.value}
                        min={0}
                        max={name === "capacityPriority" ? 31 : undefined}
                        onChange={(event) => field.handleChange(Number(event.target.value))}
                      />
                    </div>
                  )}
                </form.Field>
              ),
            )}
            {(
              [
                ["capacityConcurrencyMode", "capacityConcurrencyLimit"],
                ["capacityWaitBudgetMode", "capacityWaitBudgetMs"],
                ["capacityContextCeilingMode", "capacityContextCeiling"],
              ] as const
            ).map(([modeName, valueName]) => (
              <form.Field key={modeName} name={modeName}>
                {(modeField) => (
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor={modeName}>
                      {t(`dashboard:pools.capacity.fields.${valueName}`)}
                    </Label>
                    <select
                      id={modeName}
                      className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
                      value={modeField.state.value}
                      onChange={(event) =>
                        modeField.handleChange(event.target.value as FiniteLimitMode)
                      }
                    >
                      <option value="LIMITED">{t("dashboard:pools.capacity.modes.limited")}</option>
                      <option value="UNLIMITED">
                        {t("dashboard:pools.capacity.modes.unlimited")}
                      </option>
                    </select>
                    {modeField.state.value === "LIMITED" ? (
                      <form.Field name={valueName}>
                        {(field) => (
                          <Input
                            className="min-h-11"
                            type="number"
                            min={valueName === "capacityWaitBudgetMs" ? 0 : 1}
                            value={field.state.value}
                            onChange={(event) => field.handleChange(Number(event.target.value))}
                            aria-label={t("dashboard:pools.capacity.limitValue")}
                          />
                        )}
                      </form.Field>
                    ) : null}
                  </div>
                )}
              </form.Field>
            ))}
            <form.Field name="capacityBorrowPolicy">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor="capacityBorrowPolicy">
                    {t("dashboard:pools.capacity.fields.capacityBorrowPolicy")}
                  </Label>
                  <select
                    id="capacityBorrowPolicy"
                    className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={field.state.value}
                    onChange={(event) =>
                      field.handleChange(event.target.value as "NEVER" | "WHEN_IDLE")
                    }
                  >
                    <option value="WHEN_IDLE">{t("dashboard:pools.capacity.borrowIdle")}</option>
                    <option value="NEVER">{t("dashboard:pools.capacity.borrowNever")}</option>
                  </select>
                </div>
              )}
            </form.Field>
          </div>
          <form.Subscribe
            selector={(state) =>
              state.values.capacityConcurrencyMode === "UNLIMITED" ||
              state.values.capacityWaitBudgetMode === "UNLIMITED" ||
              state.values.capacityContextCeilingMode === "UNLIMITED"
            }
          >
            {(hasUnlimited) =>
              hasUnlimited ? (
                <p
                  className="mt-3 rounded-md bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100"
                  role="alert"
                >
                  {t("dashboard:pools.capacity.unlimitedWarning")}
                </p>
              ) : null
            }
          </form.Subscribe>
        </fieldset>
      </details>

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

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <div
            className={cn(
              stickySave &&
                "sticky bottom-0 z-10 -mx-1 border-t bg-background/95 px-1 py-[max(0.75rem,var(--safe-area-bottom))]",
            )}
          >
            <Button type="submit" size="touch" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? t("common:actions.saving") : t("common:actions.save")}
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

/**
 * Existing-pool member editor. This deliberately remains separate from PoolForm:
 * members are lifecycle records, while PoolForm owns pool metadata and policy.
 */
function CapacityPolicyModeField({
  id,
  label,
  mode,
  onModeChange,
  options,
  value,
  onValueChange,
  min = 0,
  max,
}: {
  id: string;
  label: string;
  mode: string;
  onModeChange: (mode: string) => void;
  options: Array<{ value: string; label: string }>;
  value?: string;
  onValueChange?: (value: string) => void;
  min?: number;
  max?: number;
}) {
  const showsValue = mode === "LIMITED" || mode === "OVERRIDE";
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={`${id}-mode`}>{label}</Label>
      <select
        id={`${id}-mode`}
        className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
        value={mode}
        onChange={(event) => onModeChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {showsValue && value !== undefined && onValueChange ? (
        <Input
          id={id}
          className="min-h-11"
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          aria-label={label}
        />
      ) : null}
    </div>
  );
}

export function PoolMemberForm({
  mode,
  poolId,
  member,
  directModels,
  capacities,
  capacityAvailability,
  onSuccess,
}: {
  mode: "create" | "edit";
  poolId?: string;
  member?: PoolMember;
  directModels: ReturnType<typeof allDirectModels>;
  capacities: CapacityRow[];
  capacityAvailability: CapacityAvailability;
  onSuccess: () => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const capacityEnabled = capacityAvailability === "enabled";
  const queryClient = useQueryClient();
  const selectId = useId();
  const [discoveredModelId, setDiscoveredModelId] = useState(directModels[0]?.id ?? "");
  const [weight, setWeight] = useState(String(member?.weight ?? 1));
  const [routingStatus, setRoutingStatus] = useState<RoutingStatus>(() =>
    routingStatusValue(member?.routingStatus),
  );
  const [memberTier, setMemberTier] = useState<"PRIMARY" | "PUBLIC_OVERFLOW">(
    member?.tier ?? "PRIMARY",
  );
  const [capacityId, setCapacityId] = useState(member?.inferenceCapacityId ?? "");
  const [priorityMode, setPriorityMode] = useState<"INHERIT" | "OVERRIDE">(
    member?.capacityPriority == null ? "INHERIT" : "OVERRIDE",
  );
  const [priority, setPriority] = useState(String(member?.capacityPriority ?? 16));
  const [concurrencyMode, setConcurrencyMode] = useState<"INHERIT" | "LIMITED" | "UNLIMITED">(
    member?.capacityConcurrencyMode ?? "INHERIT",
  );
  const [concurrency, setConcurrency] = useState(String(member?.capacityConcurrencyLimit ?? 1));
  const [reservedMode, setReservedMode] = useState<"INHERIT" | "OVERRIDE">(
    member?.capacityReservedSlots == null ? "INHERIT" : "OVERRIDE",
  );
  const [reservedSlots, setReservedSlots] = useState(String(member?.capacityReservedSlots ?? 0));
  const [waitMode, setWaitMode] = useState<"INHERIT" | "LIMITED" | "UNLIMITED">(
    member?.capacityWaitBudgetMode ?? "INHERIT",
  );
  const [waitBudget, setWaitBudget] = useState(String(member?.capacityWaitBudgetMs ?? 30_000));
  const [ceilingMode, setCeilingMode] = useState<"INHERIT" | "LIMITED" | "UNLIMITED">(
    member?.capacityContextCeilingMode ?? "INHERIT",
  );
  const [contextCeiling, setContextCeiling] = useState(
    String(member?.capacityContextCeiling ?? 32_768),
  );
  const [marginMode, setMarginMode] = useState<"INHERIT" | "LIMITED">(
    member?.capacityContextMargin == null ? "INHERIT" : "LIMITED",
  );
  const [contextMargin, setContextMargin] = useState(String(member?.capacityContextMargin ?? 0));
  const [borrowMode, setBorrowMode] = useState<"INHERIT" | "OVERRIDE">(
    member?.capacityBorrowPolicy == null ? "INHERIT" : "OVERRIDE",
  );
  const [borrow, setBorrow] = useState<"NEVER" | "WHEN_IDLE">(
    member?.capacityBorrowPolicy === "NEVER" ? "NEVER" : "WHEN_IDLE",
  );
  const createMember = useMutation(
    orpc.forwarderManagement.addPoolMember.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
      },
    }),
  );
  const updateMember = useMutation(
    orpc.forwarderManagement.updatePoolMember.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
      },
    }),
  );
  const updateMemberPolicy = useMutation(
    orpc.capacityManagement.updateMemberPolicy.mutationOptions(),
  );
  const attachCapacity = useMutation(orpc.capacityManagement.updateDirectPolicy.mutationOptions());
  const parsedWeight = Number.parseInt(weight, 10);
  const hardLimit = capacityId
    ? (capacities.find((capacity) => capacity.id === capacityId)?.hardConcurrencyLimit ?? null)
    : null;
  const memberPolicyValid =
    (priorityMode === "INHERIT" ||
      (Number.isInteger(Number(priority)) && Number(priority) >= 0 && Number(priority) <= 31)) &&
    (concurrencyMode !== "LIMITED" ||
      (Number.isInteger(Number(concurrency)) &&
        Number(concurrency) > 0 &&
        (hardLimit === null || Number(concurrency) <= hardLimit))) &&
    (reservedMode === "INHERIT" ||
      (Number.isInteger(Number(reservedSlots)) &&
        Number(reservedSlots) >= 0 &&
        (hardLimit === null || Number(reservedSlots) <= hardLimit))) &&
    (waitMode !== "LIMITED" || (Number.isInteger(Number(waitBudget)) && Number(waitBudget) > 0)) &&
    (ceilingMode !== "LIMITED" ||
      (Number.isInteger(Number(contextCeiling)) && Number(contextCeiling) > 0)) &&
    (marginMode === "INHERIT" ||
      (Number.isInteger(Number(contextMargin)) && Number(contextMargin) >= 0));
  const canSubmit =
    Number.isInteger(parsedWeight) &&
    parsedWeight >= 0 &&
    parsedWeight <= 10_000 &&
    !(memberTier === "PRIMARY" && routingStatus === "ACTIVE" && parsedWeight === 0) &&
    (mode === "edit" || discoveredModelId.length > 0) &&
    (!capacityEnabled || memberPolicyValid);
  const isPending = createMember.isPending || updateMember.isPending;

  class MutationFailure extends Error {}

  async function runMutation<T>(mutation: () => Promise<T>): Promise<T> {
    try {
      return await mutation();
    } catch {
      throw new MutationFailure();
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!canSubmit) return;
        try {
          if (mode === "create" && poolId) {
            const created = await runMutation(() =>
              createMember.mutateAsync({
                poolId,
                discoveredModelId,
                weight: parsedWeight,
                routingStatus,
              }),
            );
            if (capacityEnabled) {
              await runMutation(() =>
                updateMemberPolicy.mutateAsync(
                  memberPolicyPayload({
                    poolMemberId: created.id,
                    priority,
                    concurrency,
                    reserved: reservedSlots,
                    wait: waitBudget,
                    ceiling: contextCeiling,
                    margin: contextMargin,
                    borrow,
                    priorityMode,
                    concurrencyMode,
                    reservedMode,
                    waitMode,
                    ceilingMode,
                    marginMode,
                    borrowMode,
                  }),
                ),
              );
              const createdExecutionTargetId = created.executionTargetId;
              if (createdExecutionTargetId) {
                await runMutation(() =>
                  attachCapacity.mutateAsync({
                    executionTargetId: createdExecutionTargetId,
                    inferenceCapacityId: capacityId || null,
                  }),
                );
              }
              await queryClient.invalidateQueries({ queryKey: orpc.capacityManagement.key() });
            }
            toast.success(t("dashboard:pools.memberAdded"));
            onSuccess();
          }
          if (mode === "edit" && member) {
            if (member.providerModel) {
              await runMutation(() =>
                updateMember.mutateAsync({
                  id: member.id,
                  tier: memberTier,
                  weight: parsedWeight,
                  routingStatus,
                  ...(capacityEnabled
                    ? {
                        capacityPriority: priorityMode === "INHERIT" ? null : Number(priority),
                        capacityConcurrencyMode: concurrencyMode,
                        capacityConcurrencyLimit:
                          concurrencyMode === "LIMITED" ? Number(concurrency) : null,
                        capacityReservedSlots:
                          reservedMode === "INHERIT" ? null : Number(reservedSlots),
                        capacityBorrowPolicy: borrowMode === "INHERIT" ? null : borrow,
                        capacityWaitBudgetMode: waitMode,
                        capacityWaitBudgetMs: waitMode === "LIMITED" ? Number(waitBudget) : null,
                        capacityContextCeilingMode: ceilingMode,
                        capacityContextCeiling:
                          ceilingMode === "LIMITED" ? Number(contextCeiling) : null,
                        capacityContextMargin:
                          marginMode === "INHERIT" ? null : Number(contextMargin),
                      }
                    : {}),
                }),
              );
            } else {
              await runMutation(() =>
                updateMember.mutateAsync({ id: member.id, weight: parsedWeight, routingStatus }),
              );
              if (capacityEnabled) {
                await runMutation(() =>
                  updateMemberPolicy.mutateAsync(
                    memberPolicyPayload({
                      poolMemberId: member.id,
                      priority,
                      concurrency,
                      reserved: reservedSlots,
                      wait: waitBudget,
                      ceiling: contextCeiling,
                      margin: contextMargin,
                      borrow,
                      priorityMode,
                      concurrencyMode,
                      reservedMode,
                      waitMode,
                      ceilingMode,
                      marginMode,
                      borrowMode,
                    }),
                  ),
                );
              }
            }
            if (capacityEnabled && member.executionTargetId && !member.providerModel) {
              const memberExecutionTargetId = member.executionTargetId;
              await runMutation(() =>
                attachCapacity.mutateAsync({
                  executionTargetId: memberExecutionTargetId,
                  inferenceCapacityId: capacityId || null,
                }),
              );
            }
            if (capacityEnabled) {
              await queryClient.invalidateQueries({ queryKey: orpc.capacityManagement.key() });
            }
            toast.success(t("dashboard:pools.memberUpdated"));
            onSuccess();
          }
        } catch (error) {
          if (!(error instanceof MutationFailure)) toast.error(t("common:somethingWentWrong"));
        }
      }}
    >
      {mode === "create" ? (
        <div className="space-y-2">
          <Label htmlFor={selectId}>{t("dashboard:pools.directModel")}</Label>
          <select
            id={selectId}
            className="h-11 w-full rounded-md border bg-background px-3 text-sm"
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
          <Label>{t("dashboard:pools.memberTarget")}</Label>
          <code className="block break-all border bg-muted px-2 py-2 font-mono text-xs">
            {member?.model?.canonicalModelId ?? member?.discoveredModelId ?? member?.id}
          </code>
        </div>
      )}
      {mode === "edit" && member?.providerModel ? (
        <div className="space-y-2">
          <Label htmlFor="member-tier">{t("dashboard:pools.memberTier")}</Label>
          <select
            id="member-tier"
            className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
            value={memberTier}
            onChange={(event) => setMemberTier(event.target.value as typeof memberTier)}
          >
            <option value="PRIMARY">{t("dashboard:pools.memberTiers.PRIMARY")}</option>
            <option value="PUBLIC_OVERFLOW">
              {t("dashboard:pools.memberTiers.PUBLIC_OVERFLOW")}
            </option>
          </select>
          <p className="text-xs text-muted-foreground">
            {t("dashboard:pools.memberTierDisclosure")}
          </p>
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="member-weight">{t("dashboard:pools.weight")}</Label>
        <Input
          id="member-weight"
          inputMode="numeric"
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
        />
      </div>
      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
          {t("dashboard:pools.capacity.memberPolicy")}
        </summary>
        {!capacityEnabled ? (
          <p className="pt-3 text-sm text-muted-foreground">
            {t(capacityUnavailableReasonKey(capacityAvailability))}
          </p>
        ) : null}
        <fieldset
          disabled={!capacityEnabled}
          className="grid min-w-0 gap-4 pt-3 disabled:opacity-60 sm:grid-cols-2"
        >
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="member-capacity">{t("dashboard:pools.capacity.attachment")}</Label>
            <select
              id="member-capacity"
              className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
              value={capacityId}
              onChange={(event) => setCapacityId(event.target.value)}
            >
              <option value="">{t("dashboard:pools.capacity.unattached")}</option>
              {capacities.map((capacity) => (
                <option key={capacity.id} value={capacity.id}>
                  {capacity.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {t("dashboard:pools.capacity.attachmentGlobalEffect")}
            </p>
          </div>
          <CapacityPolicyModeField
            id="member-priority"
            label={t("dashboard:pools.capacity.fields.capacityPriority")}
            mode={priorityMode}
            onModeChange={(value) => setPriorityMode(value as typeof priorityMode)}
            options={[
              { value: "INHERIT", label: t("dashboard:pools.capacity.modes.inherit") },
              { value: "OVERRIDE", label: t("dashboard:pools.capacity.modes.override") },
            ]}
            value={priority}
            onValueChange={setPriority}
            max={31}
          />
          <CapacityPolicyModeField
            id="member-concurrency"
            label={t("dashboard:pools.capacity.fields.capacityConcurrencyLimit")}
            mode={concurrencyMode}
            onModeChange={(value) => setConcurrencyMode(value as typeof concurrencyMode)}
            options={[
              { value: "INHERIT", label: t("dashboard:pools.capacity.modes.inherit") },
              { value: "LIMITED", label: t("dashboard:pools.capacity.modes.limited") },
              { value: "UNLIMITED", label: t("dashboard:pools.capacity.modes.unlimited") },
            ]}
            value={concurrency}
            onValueChange={setConcurrency}
            min={1}
          />
          <CapacityPolicyModeField
            id="member-reserved"
            label={t("dashboard:pools.capacity.fields.capacityReservedSlots")}
            mode={reservedMode}
            onModeChange={(value) => setReservedMode(value as typeof reservedMode)}
            options={[
              { value: "INHERIT", label: t("dashboard:pools.capacity.modes.inherit") },
              { value: "OVERRIDE", label: t("dashboard:pools.capacity.modes.override") },
            ]}
            value={reservedSlots}
            onValueChange={setReservedSlots}
          />
          <CapacityPolicyModeField
            id="member-wait"
            label={t("dashboard:pools.capacity.fields.capacityWaitBudgetMs")}
            mode={waitMode}
            onModeChange={(value) => setWaitMode(value as typeof waitMode)}
            options={[
              { value: "INHERIT", label: t("dashboard:pools.capacity.modes.inherit") },
              { value: "LIMITED", label: t("dashboard:pools.capacity.modes.limited") },
              { value: "UNLIMITED", label: t("dashboard:pools.capacity.modes.unlimited") },
            ]}
            value={waitBudget}
            onValueChange={setWaitBudget}
            min={1}
          />
          <CapacityPolicyModeField
            id="member-context"
            label={t("dashboard:pools.capacity.fields.capacityContextCeiling")}
            mode={ceilingMode}
            onModeChange={(value) => setCeilingMode(value as typeof ceilingMode)}
            options={[
              { value: "INHERIT", label: t("dashboard:pools.capacity.modes.inherit") },
              { value: "LIMITED", label: t("dashboard:pools.capacity.modes.limited") },
              { value: "UNLIMITED", label: t("dashboard:pools.capacity.modes.unlimited") },
            ]}
            value={contextCeiling}
            onValueChange={setContextCeiling}
            min={1}
          />
          <CapacityPolicyModeField
            id="member-margin"
            label={t("dashboard:pools.capacity.fields.capacityContextMargin")}
            mode={marginMode}
            onModeChange={(value) => setMarginMode(value as typeof marginMode)}
            options={[
              { value: "INHERIT", label: t("dashboard:pools.capacity.modes.inherit") },
              { value: "LIMITED", label: t("dashboard:pools.capacity.modes.limited") },
            ]}
            value={contextMargin}
            onValueChange={setContextMargin}
          />
          <div className="min-w-0 space-y-2">
            <Label htmlFor="member-borrow-mode">
              {t("dashboard:pools.capacity.fields.capacityBorrowPolicy")}
            </Label>
            <select
              id="member-borrow-mode"
              className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
              value={borrowMode}
              onChange={(event) => setBorrowMode(event.target.value as typeof borrowMode)}
            >
              <option value="INHERIT">{t("dashboard:pools.capacity.modes.inherit")}</option>
              <option value="OVERRIDE">{t("dashboard:pools.capacity.modes.override")}</option>
            </select>
            {borrowMode === "OVERRIDE" ? (
              <select
                aria-label={t("dashboard:pools.capacity.fields.capacityBorrowPolicy")}
                className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
                value={borrow}
                onChange={(event) => setBorrow(event.target.value as typeof borrow)}
              >
                <option value="WHEN_IDLE">{t("dashboard:pools.capacity.borrowIdle")}</option>
                <option value="NEVER">{t("dashboard:pools.capacity.borrowNever")}</option>
              </select>
            ) : null}
          </div>
        </fieldset>
      </details>
      <div className="space-y-2">
        <Label htmlFor="member-routing">{t("dashboard:pools.routing")}</Label>
        <select
          id="member-routing"
          className="h-11 w-full rounded-md border bg-background px-3 text-sm"
          value={routingStatus}
          onChange={(event) => setRoutingStatus(event.target.value as RoutingStatus)}
        >
          <option value="ACTIVE">{t("dashboard:pools.routingActive")}</option>
          <option value="DRAINING">{t("dashboard:pools.routingDraining")}</option>
          <option value="DISABLED">{t("dashboard:pools.routingDisabled")}</option>
        </select>
      </div>
      <Button type="submit" size="touch" disabled={!canSubmit || isPending}>
        {isPending ? t("common:actions.saving") : t("common:actions.save")}
      </Button>
    </form>
  );
}

export function GrantPoolDialog({
  pool,
  onOpenChange,
}: {
  pool: ModelPool | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [publicEgressAcknowledged, setPublicEgressAcknowledged] = useState(false);
  const providerEgress = pool?.members.some((member) => member.providerModel) ?? false;
  const grant = useMutation(
    orpc.forwarderManagement.grantPoolAccessByEmail.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.grantAdded"));
        setEmail("");
        setPublicEgressAcknowledged(false);
        onOpenChange(false);
      },
    }),
  );
  const validEmail =
    /^\S+@\S+\.\S+$/.test(email.trim()) && (!providerEgress || publicEgressAcknowledged);

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
            if (!pool || !validEmail) return;
            grant.mutate({
              poolId: pool.id,
              email: email.trim(),
              publicEgressAcknowledged,
            });
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
            />
            <p className="text-xs text-muted-foreground">{t("dashboard:pools.exactEmailOnly")}</p>
          </div>
          {providerEgress ? (
            <label className="flex min-h-11 items-center gap-3 rounded-md border p-3 text-sm">
              <Checkbox
                checked={publicEgressAcknowledged}
                onCheckedChange={(checked) => setPublicEgressAcknowledged(checked === true)}
              />
              <span>{t("dashboard:pools.grantEgressAcknowledge")}</span>
            </label>
          ) : null}
          <DialogFooter>
            <Button type="submit" size="touch" disabled={!validEmail || grant.isPending}>
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
      <TokenEgressWarnings pools={visibleModelsData.modelPools} />
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
      <TokenEgressWarnings pools={preview.modelPools} compact />
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

function TokenEgressWarnings({
  pools,
  compact = false,
}: {
  pools: Array<{
    id: string;
    name: string;
    publicEgressEnabled: boolean;
    publicEgressAcknowledged: boolean;
    effectiveProviderEgress?: boolean;
    providerPrimaryMemberCount?: number;
  }>;
  compact?: boolean;
}) {
  const { t } = useTranslation("dashboard");
  const egressPoolNames = publicEgressResourceNames(pools);
  if (egressPoolNames.length === 0) return null;
  return (
    <div
      className={cn(
        "rounded-md bg-amber-500/10 text-sm text-amber-900 dark:text-amber-100",
        compact ? "mt-3 p-3" : "mb-4 p-4",
      )}
      role="note"
    >
      <p className="font-medium">{t("tokens.publicEgressWarningTitle")}</p>
      <p className="mt-1">
        {t("tokens.publicEgressWarning", { pools: egressPoolNames.join(", ") })}
      </p>
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
          <table className="w-full min-w-[1000px] text-left text-xs">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">{t("dashboard:relay.createdAt")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.status")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.operation")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.requestBytes")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.responseBytes")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.attempts")}</th>
                <th className="p-3 font-medium">{t("dashboard:relay.affinity")}</th>
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
                  <td className="p-3 align-top" title={row.affinityReason ?? undefined}>
                    {row.affinityOutcome
                      ? `${row.affinityOutcome} · ${row.affinityScore ?? 0} · ${row.affinityPrefixDepth ?? 0}`
                      : "—"}
                  </td>
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
