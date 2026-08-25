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
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Gauge,
  MoveDown,
  MoveUp,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { GuardedPoolSetupWizard } from "@/components/guarded-pool-setup-wizard";
import { InlineRetry } from "@/components/inline-retry";
import { ProviderOperationsSection } from "@/components/provider-operations-section";
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
type PoolGrant = ModelPool["grants"][number];
type CliToken = Awaited<ReturnType<AppRouterClient["cliCredentials"]["listTokens"]>>[number];
type ModelApiToken = Awaited<ReturnType<AppRouterClient["modelApiTokens"]["list"]>>[number];
type VisibleModels = Awaited<ReturnType<AppRouterClient["forwarderManagement"]["visibleModels"]>>;
type TokenPreview = Awaited<ReturnType<AppRouterClient["modelApiTokens"]["preview"]>>;
type RelayRow = Awaited<ReturnType<AppRouterClient["relayMetadata"]["listOwn"]>>[number];
type CapacityRow = Awaited<ReturnType<AppRouterClient["capacityManagement"]["list"]>>[number];
type ScopeMode = "ALL_VISIBLE" | "ALLOWLIST";
type RoutingStatus = "ACTIVE" | "DRAINING" | "DISABLED";
type MemberTestSurface = "OPENAI_CHAT_COMPLETIONS" | "OPENAI_RESPONSES" | "ANTHROPIC_MESSAGES";
type MemberTestMode = "PREFER_NATIVE" | "REQUIRE_NATIVE" | "REQUIRE_ADAPTED";
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

const poolSurfaceValues = [
  "OPENAI_CHAT_COMPLETIONS",
  "OPENAI_RESPONSES",
  "ANTHROPIC_MESSAGES",
] as const;

async function testPoolMemberThroughResolver({
  poolModel,
  memberId,
  surface,
  mode,
}: {
  poolModel: string;
  memberId: string;
  surface: MemberTestSurface;
  mode: MemberTestMode;
}) {
  const endpoint =
    surface === "OPENAI_RESPONSES"
      ? "responses"
      : surface === "ANTHROPIC_MESSAGES"
        ? "messages"
        : "chat/completions";
  const body =
    surface === "OPENAI_RESPONSES"
      ? { model: poolModel, input: "Reply with the single word pong.", stream: false }
      : surface === "ANTHROPIC_MESSAGES"
        ? {
            model: poolModel,
            messages: [{ role: "user", content: "Reply with the single word pong." }],
            max_tokens: 8,
            stream: false,
          }
        : {
            model: poolModel,
            messages: [{ role: "user", content: "Reply with the single word pong." }],
            max_tokens: 8,
            stream: false,
          };
  const response = await fetch(`${env.VITE_SERVER_URL}/api/internal/chat-test/${endpoint}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "x-wsmp-chat-test-routing-mode": mode,
      "x-wsmp-chat-test-member-id": memberId,
      ...(surface === "ANTHROPIC_MESSAGES" ? { "anthropic-version": "2023-06-01" } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string } | string;
    } | null;
    const error = payload?.error;
    throw new Error(
      (typeof error === "string" ? error : error?.message) ?? `HTTP ${response.status}`,
    );
  }
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
  const { data: capacitiesData } = useQuery({
    ...orpc.capacityManagement.list.queryOptions(),
    retry: false,
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
  onSuccess,
}: {
  target: NonNullable<DirectModelOption["executionTarget"]>;
  capacities: CapacityRow[];
  onSuccess: () => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
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
        if (!valid) return;
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
      <Button type="submit" size="touch" disabled={!valid || mutation.isPending}>
        {mutation.isPending ? t("common:actions.saving") : t("common:actions.save")}
      </Button>
    </form>
  );
}

function _PoolSetupWizard({
  open,
  onOpenChange,
  directModels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directModels: ReturnType<typeof allDirectModels>;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const createPool = useMutation(orpc.forwarderManagement.createModelPool.mutationOptions());
  const addMember = useMutation(orpc.forwarderManagement.addPoolMember.mutationOptions());
  const schema = z
    .object({
      slug: z
        .string()
        .trim()
        .superRefine((value, ctx) => {
          const result = validateForwarderPoolSlug(value);
          if (!result.ok)
            ctx.addIssue({ code: "custom", message: t("dashboard:pools.invalidSlug") });
        }),
      name: z.string().trim().min(1).max(120),
      localModelIds: z.array(z.string()).min(1, t("dashboard:pools.wizard.localRequired")),
      publicEgress: z.boolean(),
      publicEgressAcknowledged: z.boolean(),
      finiteSpendProtection: z.boolean(),
      concurrency: z.number().int().min(1).max(10_000),
      contextCeiling: z.number().int().min(1).max(100_000_000),
      reservedSlots: z.number().int().min(0).max(10_000),
      waitMs: z.number().int().min(0).max(600_000),
      recommendedSurface: z.enum(poolSurfaceValues),
    })
    .superRefine((value, ctx) => {
      if (value.reservedSlots > value.concurrency) {
        ctx.addIssue({
          code: "custom",
          path: ["reservedSlots"],
          message: t("dashboard:pools.wizard.reservationInvalid"),
        });
      }
      if (value.publicEgress && !value.publicEgressAcknowledged) {
        ctx.addIssue({
          code: "custom",
          path: ["publicEgressAcknowledged"],
          message: t("dashboard:pools.wizard.egressRequired"),
        });
      }
      if (value.publicEgress && !value.finiteSpendProtection) {
        ctx.addIssue({
          code: "custom",
          path: ["finiteSpendProtection"],
          message: t("dashboard:pools.wizard.spendRequired"),
        });
      }
    });
  const form = useForm({
    defaultValues: {
      slug: "",
      name: "",
      localModelIds: [] as string[],
      publicEgress: false,
      publicEgressAcknowledged: false,
      finiteSpendProtection: true,
      concurrency: 1,
      contextCeiling: 32_768,
      reservedSlots: 0,
      waitMs: 30_000,
      recommendedSurface: "OPENAI_RESPONSES" as (typeof poolSurfaceValues)[number],
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const created = await createPool.mutateAsync({
        slug: value.slug.trim(),
        name: value.name.trim(),
        description: null,
        maxAttachmentBytes: null,
        protocolAdaptationEnabled: true,
        publicEgressEnabled: value.publicEgress,
        ...(value.publicEgress ? { publicEgressAcknowledged: true as const } : {}),
        recommendedSurfaceOverride: value.recommendedSurface,
        capacityPriority: 16,
        capacityConcurrencyLimit: value.concurrency,
        capacityReservedSlots: value.reservedSlots,
        capacityWaitBudgetMs: value.waitMs,
        capacityContextCeiling: value.contextCeiling,
        capacityContextMargin: Math.min(1024, Math.max(0, value.contextCeiling - 1)),
        capacityBorrowPolicy: "WHEN_IDLE",
      });
      for (const discoveredModelId of value.localModelIds) {
        await addMember.mutateAsync({
          poolId: created.id,
          discoveredModelId,
          weight: 1,
          routingStatus: "ACTIVE",
        });
      }
      await queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
      toast.success(t("dashboard:pools.created"));
      setStep(0);
      onOpenChange(false);
    },
  });
  const steps = ["models", "capacity", "egress", "review"] as const;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(92vh,54rem)] overflow-x-hidden overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("dashboard:pools.wizard.title")}</DialogTitle>
          <DialogDescription>{t("dashboard:pools.wizard.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1" aria-label={t("dashboard:pools.wizard.progress")}>
          {steps.map((item, index) => (
            <div
              key={item}
              className={cn("h-1.5 flex-1 rounded-full", index <= step ? "bg-primary" : "bg-muted")}
              aria-current={index === step ? "step" : undefined}
            />
          ))}
        </div>
        <p className="text-sm font-medium">
          {t("dashboard:pools.wizard.step", { current: step + 1, total: steps.length })}:{" "}
          {t(`dashboard:pools.wizard.steps.${steps[step]}`)}
        </p>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (step < steps.length - 1) setStep((current) => current + 1);
            else form.handleSubmit();
          }}
        >
          {step === 0 ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {(["slug", "name"] as const).map((name) => (
                  <form.Field key={name} name={name}>
                    {(field) => (
                      <div className="space-y-2">
                        <Label htmlFor={`wizard-${name}`}>{t(`dashboard:pools.${name}`)}</Label>
                        <Input
                          id={`wizard-${name}`}
                          className="min-h-11"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(event.target.value)}
                        />
                        {field.state.meta.errors.map((error) => (
                          <p key={error?.message} className="text-sm text-destructive">
                            {error?.message}
                          </p>
                        ))}
                      </div>
                    )}
                  </form.Field>
                ))}
              </div>
              <form.Field name="localModelIds">
                {(field) => (
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">
                      {t("dashboard:pools.wizard.localModels")}
                    </legend>
                    <p className="text-sm text-muted-foreground">
                      {t("dashboard:pools.wizard.localModelsHint")}
                    </p>
                    <div className="max-h-56 divide-y overflow-x-clip overflow-y-auto overscroll-contain rounded-md border">
                      {directModels.length ? (
                        directModels.map((model) => {
                          const checked = field.state.value.includes(model.id);
                          return (
                            <label key={model.id} className="flex min-h-11 items-center gap-3 p-3">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(next) =>
                                  field.handleChange(
                                    next === true
                                      ? [...field.state.value, model.id]
                                      : field.state.value.filter((id) => id !== model.id),
                                  )
                                }
                              />
                              <code className="min-w-0 break-all font-mono text-xs">
                                {model.canonicalModelId}
                              </code>
                            </label>
                          );
                        })
                      ) : (
                        <p className="p-4 text-sm text-muted-foreground">
                          {t("dashboard:pools.noDirectModels")}
                        </p>
                      )}
                    </div>
                  </fieldset>
                )}
              </form.Field>
            </div>
          ) : null}
          {step === 1 ? (
            <div className="space-y-4">
              <div className="rounded-md bg-muted p-4 text-sm text-muted-foreground">
                {t("dashboard:pools.wizard.capacityHint")}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {(["concurrency", "contextCeiling", "reservedSlots", "waitMs"] as const).map(
                  (name) => (
                    <form.Field key={name} name={name}>
                      {(field) => (
                        <div className="space-y-2">
                          <Label htmlFor={`wizard-${name}`}>
                            {t(`dashboard:pools.wizard.fields.${name}`)}
                          </Label>
                          <Input
                            id={`wizard-${name}`}
                            className="min-h-11"
                            type="number"
                            min={name === "reservedSlots" || name === "waitMs" ? 0 : 1}
                            value={field.state.value}
                            onChange={(event) => field.handleChange(Number(event.target.value))}
                          />
                          {field.state.meta.errors.map((error) => (
                            <p key={error?.message} className="text-sm text-destructive">
                              {error?.message}
                            </p>
                          ))}
                        </div>
                      )}
                    </form.Field>
                  ),
                )}
              </div>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="space-y-4">
              <form.Field name="recommendedSurface">
                {(field) => (
                  <div className="space-y-2">
                    <Label htmlFor="wizard-surface">
                      {t("dashboard:pools.wizard.fields.recommendedSurface")}
                    </Label>
                    <select
                      id="wizard-surface"
                      className="h-11 w-full rounded-md border bg-background px-3 text-sm"
                      value={field.state.value}
                      onChange={(event) =>
                        field.handleChange(event.target.value as typeof field.state.value)
                      }
                    >
                      {poolSurfaceValues.map((surface) => (
                        <option key={surface} value={surface}>
                          {t(`dashboard:pools.wizard.surfaces.${surface}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </form.Field>
              <form.Field name="publicEgress">
                {(field) => (
                  <label className="flex min-h-11 items-start gap-3 rounded-md border p-3">
                    <Checkbox
                      checked={field.state.value}
                      onCheckedChange={(next) => field.handleChange(next === true)}
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        {t("dashboard:pools.wizard.publicEgress")}
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        {t("dashboard:pools.wizard.publicEgressHint")}
                      </span>
                    </span>
                  </label>
                )}
              </form.Field>
              <form.Subscribe selector={(state) => state.values.publicEgress}>
                {(publicEgress) =>
                  publicEgress ? (
                    <div className="space-y-3 rounded-md bg-amber-500/10 p-4 text-amber-900 dark:text-amber-100">
                      <p className="text-sm font-medium">
                        {t("dashboard:pools.wizard.egressWarning")}
                      </p>
                      {(["publicEgressAcknowledged", "finiteSpendProtection"] as const).map(
                        (name) => (
                          <form.Field key={name} name={name}>
                            {(field) => (
                              <label className="flex min-h-11 items-start gap-3 text-sm">
                                <Checkbox
                                  checked={field.state.value}
                                  onCheckedChange={(next) => field.handleChange(next === true)}
                                />
                                <span>{t(`dashboard:pools.wizard.fields.${name}`)}</span>
                              </label>
                            )}
                          </form.Field>
                        ),
                      )}
                      <p className="text-xs">{t("dashboard:pools.wizard.providerOrderHint")}</p>
                    </div>
                  ) : null
                }
              </form.Subscribe>
            </div>
          ) : null}
          {step === 3 ? (
            <form.Subscribe selector={(state) => state.values}>
              {(values) => (
                <div className="space-y-4">
                  <div className="flex items-start gap-3 rounded-md bg-primary/10 p-4 text-sm">
                    <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
                    <p>{t("dashboard:pools.wizard.reviewSafe")}</p>
                  </div>
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">
                        {t("dashboard:pools.wizard.localModels")}
                      </dt>
                      <dd className="font-medium tabular-nums">{values.localModelIds.length}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        {t("dashboard:pools.wizard.fields.concurrency")}
                      </dt>
                      <dd className="font-medium tabular-nums">{values.concurrency}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        {t("dashboard:pools.wizard.fields.contextCeiling")}
                      </dt>
                      <dd className="font-medium tabular-nums">
                        {values.contextCeiling.toLocaleString()}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        {t("dashboard:pools.wizard.publicEgress")}
                      </dt>
                      <dd className="font-medium">
                        {values.publicEgress
                          ? t("dashboard:pools.wizard.enabled")
                          : t("dashboard:pools.wizard.disabled")}
                      </dd>
                    </div>
                  </dl>
                  <p className="text-sm text-muted-foreground">
                    {t("dashboard:pools.wizard.advancedHint")}
                  </p>
                </div>
              )}
            </form.Subscribe>
          ) : null}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              size="touch"
              disabled={step === 0}
              onClick={() => setStep((current) => Math.max(0, current - 1))}
            >
              <ArrowLeft className="size-4" />
              {t("dashboard:pools.wizard.back")}
            </Button>
            <Button
              type="submit"
              size="touch"
              disabled={
                createPool.isPending ||
                addMember.isPending ||
                (step === 0 && directModels.length === 0)
              }
            >
              {step === steps.length - 1 ? (
                createPool.isPending || addMember.isPending ? (
                  t("common:actions.saving")
                ) : (
                  t("dashboard:pools.wizard.create")
                )
              ) : (
                <>
                  {t("dashboard:pools.wizard.next")}
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  const { data: capacitiesData, isPending: capacitiesPending } = useQuery({
    ...orpc.capacityManagement.list.queryOptions(),
    retry: false,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [editingCapacity, setEditingCapacity] = useState<CapacityRow | null>(null);
  const [deleteCapacity, setDeleteCapacity] = useState<CapacityRow | null>(null);
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
  const [memberTestSurface, setMemberTestSurface] = useState<MemberTestSurface>("OPENAI_RESPONSES");
  const [memberTestMode, setMemberTestMode] = useState<MemberTestMode>("PREFER_NATIVE");
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
  const reorderOverflowMember = useMutation(
    orpc.forwarderManagement.reorderProviderPoolMember.mutationOptions({
      onSuccess: () => onChanged(),
      onError: () => toast.error(t("dashboard:pools.reorderFailed")),
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
  const deleteCapacityMutation = useMutation(
    orpc.capacityManagement.remove.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.capacityManagement.key() });
        toast.success(t("dashboard:pools.capacity.deleted"));
        setDeleteCapacity(null);
      },
      onError: () => toast.error(t("dashboard:pools.capacity.deleteConflict")),
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
          <div className="flex flex-wrap gap-2">
            <Button size="touch" onClick={() => setWizardOpen(true)}>
              <Plus className="size-4" />
              {t("dashboard:pools.wizard.open")}
            </Button>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger
                render={
                  <Button size="touch">
                    <Plus className="size-4" />
                    {t("dashboard:pools.advancedCreate")}
                  </Button>
                }
              />
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>{t("dashboard:pools.createTitle")}</DialogTitle>
                  <DialogDescription>{t("dashboard:pools.createDescription")}</DialogDescription>
                </DialogHeader>
                <PoolForm
                  mode="create"
                  capacities={capacitiesData ?? []}
                  onSuccess={() => setCreateOpen(false)}
                />
              </DialogContent>
            </Dialog>
          </div>
        }
      />
      <GuardedPoolSetupWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        directModels={directModels}
      />

      {capacitiesData || capacitiesPending ? (
        <div className="mb-6 border-y bg-muted/30 py-4">
          <div className="flex min-w-0 flex-col gap-4 px-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Gauge className="size-4 text-primary" />
                <h3 className="font-medium">{t("dashboard:pools.capacity.title")}</h3>
              </div>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                {t("dashboard:pools.capacity.description")}
              </p>
            </div>
            <Dialog open={capacityOpen} onOpenChange={setCapacityOpen}>
              <DialogTrigger
                render={
                  <Button type="button" variant="outline" size="touch">
                    <Plus className="size-4" />
                    {t("dashboard:pools.capacity.create")}
                  </Button>
                }
              />
              <DialogContent className="max-h-[min(90vh,52rem)] overflow-x-hidden overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                  <DialogTitle>{t("dashboard:pools.capacity.createTitle")}</DialogTitle>
                  <DialogDescription>
                    {t("dashboard:pools.capacity.createDescription")}
                  </DialogDescription>
                </DialogHeader>
                <CapacitySetupForm onSuccess={() => setCapacityOpen(false)} />
              </DialogContent>
            </Dialog>
          </div>
          <div className="mt-4 px-4">
            {capacitiesPending ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            ) : capacitiesData?.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {capacitiesData.map((capacity: CapacityRow) => (
                  <div key={capacity.id} className="min-w-0 rounded-md border bg-background p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{capacity.label}</div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {capacity.runtimeModel}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-touch"
                          aria-label={t("dashboard:pools.capacity.edit")}
                          onClick={() => setEditingCapacity(capacity)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-touch"
                          aria-label={t("dashboard:pools.capacity.delete")}
                          onClick={() => setDeleteCapacity(capacity)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {t("dashboard:pools.capacity.active", {
                          count: capacity._count.CapacityLeases,
                          limit: capacity.hardConcurrencyLimit ?? "∞",
                        })}
                      </span>
                      <span>
                        {t("dashboard:pools.capacity.waiting", {
                          count: capacity._count.CapacityWaiters,
                        })}
                      </span>
                      <span>
                        {t("dashboard:pools.capacity.targets", {
                          count: capacity._count.ExecutionTargets,
                        })}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("dashboard:pools.capacity.empty")}</p>
            )}
          </div>
        </div>
      ) : null}

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
                            <div className="mt-1 text-muted-foreground">
                              {t("dashboard:pools.surfaceTierCounts", {
                                tier: t("dashboard:pools.memberTiers.PRIMARY"),
                                ...availability.primary,
                              })}
                            </div>
                            <div className="text-muted-foreground">
                              {t("dashboard:pools.surfaceTierCounts", {
                                tier: t("dashboard:pools.memberTiers.PUBLIC_OVERFLOW"),
                                ...availability.publicOverflow,
                              })}
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
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                    <h4 className="text-sm font-medium">{t("dashboard:pools.membersTitle")}</h4>
                    <div className="flex flex-wrap gap-2">
                      <Label className="sr-only" htmlFor={`member-test-surface-${pool.id}`}>
                        {t("dashboard:pools.memberTestSurface")}
                      </Label>
                      <select
                        id={`member-test-surface-${pool.id}`}
                        className="h-11 rounded-md border bg-background px-3 text-xs"
                        value={memberTestSurface}
                        onChange={(event) =>
                          setMemberTestSurface(event.target.value as MemberTestSurface)
                        }
                      >
                        <option value="OPENAI_CHAT_COMPLETIONS">
                          {t("dashboard:pools.memberTestSurfaces.OPENAI_CHAT_COMPLETIONS")}
                        </option>
                        <option value="OPENAI_RESPONSES">
                          {t("dashboard:pools.memberTestSurfaces.OPENAI_RESPONSES")}
                        </option>
                        <option value="ANTHROPIC_MESSAGES">
                          {t("dashboard:pools.memberTestSurfaces.ANTHROPIC_MESSAGES")}
                        </option>
                      </select>
                      <Label className="sr-only" htmlFor={`member-test-mode-${pool.id}`}>
                        {t("dashboard:pools.memberTestMode")}
                      </Label>
                      <select
                        id={`member-test-mode-${pool.id}`}
                        className="h-11 rounded-md border bg-background px-3 text-xs"
                        value={memberTestMode}
                        onChange={(event) =>
                          setMemberTestMode(event.target.value as MemberTestMode)
                        }
                      >
                        <option value="PREFER_NATIVE">
                          {t("dashboard:pools.memberTestPreferred")}
                        </option>
                        <option value="REQUIRE_NATIVE">
                          {t("dashboard:pools.memberTestNative")}
                        </option>
                        <option value="REQUIRE_ADAPTED">
                          {t("dashboard:pools.memberTestAdapted")}
                        </option>
                      </select>
                    </div>
                  </div>
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
                                    member.providerModel?.displayName ??
                                    member.providerModel?.upstreamModelId ??
                                    member.discoveredModelId ??
                                    member.id}
                                </code>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  <StatusPill muted>
                                    {t(`dashboard:pools.memberTiers.${member.tier}`)}
                                  </StatusPill>
                                  {member.publicOrder != null ? (
                                    <StatusPill muted>
                                      {t("dashboard:pools.publicOrder", {
                                        order: member.publicOrder + 1,
                                      })}
                                    </StatusPill>
                                  ) : null}
                                </div>
                                {member.model || member.providerModel ? (
                                  <details className="mt-2">
                                    <summary className="min-h-11 cursor-pointer py-2 text-muted-foreground">
                                      {t("dashboard:pools.memberCapabilities")}
                                    </summary>
                                    <div className="space-y-1">
                                      {Object.entries(
                                        member.model?.surfaces ?? member.providerModel!.surfaces,
                                      ).map(([surface, availability]) => (
                                        <p key={surface} className="break-words">
                                          <span className="font-medium">{surface}</span>:{" "}
                                          {availability.mode}
                                          {availability.limitations.length
                                            ? ` · ${availability.limitations.map((item) => t(`dashboard:pools.limitations.${item}`)).join(", ")}`
                                            : ""}
                                        </p>
                                      ))}
                                    </div>
                                  </details>
                                ) : null}
                              </td>
                              <td className="py-2 pr-3 align-top tabular-nums">{member.weight}</td>
                              <td className="py-2 pr-3 align-top">
                                <div>{member.routingStatus}</div>
                                <details className="mt-1">
                                  <summary className="min-h-11 cursor-pointer py-2 text-muted-foreground">
                                    {t("dashboard:pools.memberPolicyDetails")}
                                  </summary>
                                  <dl className="space-y-1 text-muted-foreground">
                                    <div>
                                      <dt className="inline">
                                        {t(
                                          "dashboard:pools.capacity.fields.capacityConcurrencyLimit",
                                        )}
                                        :{" "}
                                      </dt>
                                      <dd className="inline">
                                        {member.capacityConcurrencyMode}
                                        {member.capacityConcurrencyLimit != null
                                          ? ` ${member.capacityConcurrencyLimit}`
                                          : ""}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="inline">
                                        {t(
                                          "dashboard:pools.capacity.fields.capacityContextCeiling",
                                        )}
                                        :{" "}
                                      </dt>
                                      <dd className="inline">
                                        {member.capacityContextCeilingMode}
                                        {member.capacityContextCeiling != null
                                          ? ` ${member.capacityContextCeiling.toLocaleString()}`
                                          : ""}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="inline">
                                        {t("dashboard:pools.capacity.fields.capacityPriority")}:{" "}
                                      </dt>
                                      <dd className="inline">
                                        {member.capacityPriority ?? t("dashboard:pools.inherited")}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="inline">
                                        {t("dashboard:pools.capacity.fields.capacityReservedSlots")}
                                        :{" "}
                                      </dt>
                                      <dd className="inline">
                                        {member.capacityReservedSlots ??
                                          t("dashboard:pools.inherited")}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="inline">
                                        {t("dashboard:pools.capacity.fields.capacityBorrowPolicy")}:{" "}
                                      </dt>
                                      <dd className="inline">
                                        {member.capacityBorrowPolicy ??
                                          t("dashboard:pools.inherited")}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="inline">
                                        {t("dashboard:pools.capacity.fields.capacityWaitBudgetMs")}:{" "}
                                      </dt>
                                      <dd className="inline">
                                        {member.capacityWaitBudgetMode}
                                        {member.capacityWaitBudgetMs != null
                                          ? ` ${member.capacityWaitBudgetMs} ms`
                                          : ""}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="inline">
                                        {t("dashboard:pools.capacity.fields.capacityContextMargin")}
                                        :{" "}
                                      </dt>
                                      <dd className="inline">
                                        {member.capacityContextMargin ??
                                          t("dashboard:pools.inherited")}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="inline">
                                        {t("dashboard:pools.memberPhysicalCapacity")}:{" "}
                                      </dt>
                                      <dd className="inline">
                                        {member.inferenceCapacityId
                                          ? t("dashboard:pools.memberLoad", {
                                              active:
                                                capacitiesData?.find(
                                                  (capacity) =>
                                                    capacity.id === member.inferenceCapacityId,
                                                )?._count.CapacityLeases ?? 0,
                                              waiting:
                                                capacitiesData?.find(
                                                  (capacity) =>
                                                    capacity.id === member.inferenceCapacityId,
                                                )?._count.CapacityWaiters ?? 0,
                                              limit:
                                                capacitiesData?.find(
                                                  (capacity) =>
                                                    capacity.id === member.inferenceCapacityId,
                                                )?.hardConcurrencyLimit ?? "∞",
                                            })
                                          : t("dashboard:pools.capacity.unattached")}
                                      </dd>
                                    </div>
                                    {member.inferenceCapacityId ? (
                                      <div>
                                        <dt className="inline">
                                          {t("dashboard:pools.memberPhysicalContext")}:{" "}
                                        </dt>
                                        <dd className="inline">
                                          {t("dashboard:pools.memberPhysicalContextValue", {
                                            context: String(
                                              capacitiesData?.find(
                                                (capacity) =>
                                                  capacity.id === member.inferenceCapacityId,
                                              )?.physicalMaxContext ?? "∞",
                                            ),
                                            strategy: String(
                                              capacitiesData?.find(
                                                (capacity) =>
                                                  capacity.id === member.inferenceCapacityId,
                                              )?.countStrategy ?? "—",
                                            ),
                                          })}
                                        </dd>
                                      </div>
                                    ) : null}
                                  </dl>
                                </details>
                              </td>
                              <td className="py-2 pr-3 align-top">
                                <StatusPill status={member.healthStatus}>
                                  {member.healthStatus}
                                </StatusPill>
                                {member.lastFailureClass ? (
                                  <p className="mt-2 text-muted-foreground">
                                    {member.lastFailureClass} ·{" "}
                                    {member.consecutiveRetryableFailures}
                                  </p>
                                ) : null}
                                {member.providerModel ? (
                                  <p className="mt-2 text-muted-foreground">
                                    {member.providerModel.ProviderAccount.label} ·{" "}
                                    {member.providerModel.pricingVersion
                                      ? t("dashboard:pools.memberCost", {
                                          version: member.providerModel.pricingVersion,
                                          currency: member.providerModel.pricingCurrency,
                                        })
                                      : t("dashboard:pools.costUnavailable")}
                                  </p>
                                ) : null}
                              </td>
                              <td className="py-2 pl-3 align-top">
                                <div className="flex justify-end gap-1">
                                  {member.tier === "PUBLIC_OVERFLOW" ? (
                                    <>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-touch"
                                        disabled={reorderOverflowMember.isPending}
                                        onClick={() =>
                                          reorderOverflowMember.mutate({
                                            id: member.id,
                                            direction: "EARLIER",
                                          })
                                        }
                                        aria-label={t("dashboard:pools.moveOverflowEarlier")}
                                      >
                                        <MoveUp className="size-4" />
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-touch"
                                        disabled={reorderOverflowMember.isPending}
                                        onClick={() =>
                                          reorderOverflowMember.mutate({
                                            id: member.id,
                                            direction: "LATER",
                                          })
                                        }
                                        aria-label={t("dashboard:pools.moveOverflowLater")}
                                      >
                                        <MoveDown className="size-4" />
                                      </Button>
                                    </>
                                  ) : null}
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="touch"
                                    disabled={testingMemberId === member.id}
                                    onClick={async () => {
                                      setTestingMemberId(member.id);
                                      try {
                                        await testPoolMemberThroughResolver({
                                          poolModel: pool.canonicalModelId,
                                          memberId: member.id,
                                          surface: memberTestSurface,
                                          mode: memberTestMode,
                                        });
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
                            {pool.members.some((member) => member.providerModel) ? (
                              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                                {t("dashboard:pools.grantEgressWarning")}
                              </p>
                            ) : null}
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
                capacities={capacitiesData ?? []}
                onSuccess={() => setEditingPool(null)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={Boolean(editingCapacity)}
        onOpenChange={(open) => !open && setEditingCapacity(null)}
      >
        <SheetContent className="w-full overflow-hidden sm:max-w-xl">
          <SheetHeader className="shrink-0">
            <SheetTitle>{t("dashboard:pools.capacity.editTitle")}</SheetTitle>
            <SheetDescription>{t("dashboard:pools.capacity.editDescription")}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip overscroll-y-contain px-4 pb-[max(1rem,var(--safe-area-bottom))]">
            {editingCapacity ? (
              <CapacitySetupForm
                key={editingCapacity.id}
                capacity={editingCapacity}
                onSuccess={() => setEditingCapacity(null)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDeleteDialog
        open={Boolean(deleteCapacity)}
        onOpenChange={(open) => !open && setDeleteCapacity(null)}
        title={t("dashboard:pools.capacity.deleteTitle")}
        description={t("dashboard:pools.capacity.deleteDescription")}
        confirmToken={deleteCapacity?.label ?? ""}
        typePrompt={t("dashboard:pools.capacity.typeName")}
        copyAriaLabel={t("dashboard:actions.copyConfirm")}
        isPending={deleteCapacityMutation.isPending}
        onConfirm={() => {
          if (deleteCapacity) deleteCapacityMutation.mutate({ id: deleteCapacity.id });
        }}
      />

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
              capacities={capacitiesData ?? []}
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
                capacities={capacitiesData ?? []}
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
      <ProviderOperationsSection />
    </section>
  );
}

function CapacitySetupForm({
  onSuccess,
  capacity,
}: {
  onSuccess: () => void;
  capacity?: CapacityRow;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
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
      const data = capacityMutationPayload(value);
      if (capacity) await updateCapacity.mutateAsync({ id: capacity.id, ...data });
      else await createCapacity.mutateAsync(data);
    },
  });
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

function PoolForm({
  mode,
  pool,
  onSuccess,
  directModels = [],
  capacities = [],
}: {
  mode: "create" | "edit";
  pool?: ModelPool;
  onSuccess: () => void;
  directModels?: ReturnType<typeof allDirectModels>;
  capacities?: CapacityRow[];
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
  const updatePoolPolicy = useMutation(orpc.capacityManagement.updatePoolPolicy.mutationOptions());
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
      allowLossyDeveloperRoleCollapse: pool?.allowLossyDeveloperRoleCollapse ?? false,
      recommendedSurfaceOverride: pool?.recommendedSurfaceOverride ?? "",
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
          capacityPriority: value.capacityPriority,
          capacityConcurrencyLimit:
            value.capacityConcurrencyMode === "UNLIMITED" ? null : value.capacityConcurrencyLimit,
          capacityReservedSlots: value.capacityReservedSlots,
          capacityWaitBudgetMs:
            value.capacityWaitBudgetMode === "UNLIMITED" ? null : value.capacityWaitBudgetMs,
          capacityContextCeiling:
            value.capacityContextCeilingMode === "UNLIMITED" ? null : value.capacityContextCeiling,
          capacityContextMargin: value.capacityContextMargin,
          capacityBorrowPolicy: value.capacityBorrowPolicy,
          affinityEnabled: value.affinityEnabled,
          affinityTtlSeconds: value.affinityTtlSeconds,
          affinityMaxRecords: value.affinityMaxRecords,
          affinityPrefixWeight: value.affinityPrefixWeight,
          affinityConversationWeight: value.affinityConversationWeight,
          affinityLoadPenaltyWeight: value.affinityLoadPenaltyWeight,
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
          affinityEnabled: value.affinityEnabled,
          affinityTtlSeconds: value.affinityTtlSeconds,
          affinityMaxRecords: value.affinityMaxRecords,
          affinityPrefixWeight: value.affinityPrefixWeight,
          affinityConversationWeight: value.affinityConversationWeight,
          affinityLoadPenaltyWeight: value.affinityLoadPenaltyWeight,
        });
        await updatePoolPolicy.mutateAsync({
          modelPoolId: pool.id,
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
          protocolAdaptationEnabled: value.protocolAdaptationEnabled,
          allowLossyDeveloperRoleCollapse: value.allowLossyDeveloperRoleCollapse,
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

      {mode === "edit" ? (
        <details className="rounded-md border p-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
            {t("dashboard:pools.capacity.poolPolicy")}
          </summary>
          <p className="mb-3 text-xs text-muted-foreground">
            {t("dashboard:pools.capacity.poolPolicyHint", { count: capacities.length })}
          </p>
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
        </details>
      ) : null}

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

function PoolMemberForm({
  mode,
  poolId,
  member,
  directModels,
  capacities,
  onSuccess,
}: {
  mode: "create" | "edit";
  poolId?: string;
  member?: PoolMember;
  directModels: ReturnType<typeof allDirectModels>;
  capacities: CapacityRow[];
  onSuccess: () => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
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
  const selectId = useId();
  const createMember = useMutation(
    orpc.forwarderManagement.addPoolMember.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.memberAdded"));
      },
    }),
  );
  const updateMember = useMutation(
    orpc.forwarderManagement.updatePoolMember.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.memberUpdated"));
      },
    }),
  );
  const updateMemberPolicy = useMutation(
    orpc.capacityManagement.updateMemberPolicy.mutationOptions(),
  );
  const attachCapacity = useMutation(orpc.capacityManagement.updateDirectPolicy.mutationOptions());
  const isPending = createMember.isPending || updateMember.isPending;
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
    memberPolicyValid;

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!canSubmit) return;
        if (mode === "create" && poolId) {
          const created = await createMember.mutateAsync({
            poolId,
            discoveredModelId,
            weight: parsedWeight,
            routingStatus,
          });
          await updateMemberPolicy.mutateAsync(
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
          );
          await attachCapacity.mutateAsync({
            executionTargetId: created.executionTargetId,
            inferenceCapacityId: capacityId || null,
          });
          queryClient.invalidateQueries({ queryKey: orpc.capacityManagement.key() });
          onSuccess();
        }
        if (mode === "edit" && member) {
          if (member.providerModel) {
            await updateMember.mutateAsync({
              id: member.id,
              tier: memberTier,
              weight: parsedWeight,
              routingStatus,
              capacityPriority: priorityMode === "INHERIT" ? null : Number(priority),
              capacityConcurrencyMode: concurrencyMode,
              capacityConcurrencyLimit: concurrencyMode === "LIMITED" ? Number(concurrency) : null,
              capacityReservedSlots: reservedMode === "INHERIT" ? null : Number(reservedSlots),
              capacityBorrowPolicy: borrowMode === "INHERIT" ? null : borrow,
              capacityWaitBudgetMode: waitMode,
              capacityWaitBudgetMs: waitMode === "LIMITED" ? Number(waitBudget) : null,
              capacityContextCeilingMode: ceilingMode,
              capacityContextCeiling: ceilingMode === "LIMITED" ? Number(contextCeiling) : null,
              capacityContextMargin: marginMode === "INHERIT" ? null : Number(contextMargin),
            });
          } else {
            await updateMember.mutateAsync({ id: member.id, weight: parsedWeight, routingStatus });
            await updateMemberPolicy.mutateAsync(
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
            );
          }
          if (member.executionTargetId && !member.providerModel) {
            await attachCapacity.mutateAsync({
              executionTargetId: member.executionTargetId,
              inferenceCapacityId: capacityId || null,
            });
          }
          queryClient.invalidateQueries({ queryKey: orpc.capacityManagement.key() });
          onSuccess();
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
            onChange={(event) => setMemberTier(event.target.value as "PRIMARY" | "PUBLIC_OVERFLOW")}
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
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
        />
      </div>
      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
          {t("dashboard:pools.capacity.memberPolicy")}
        </summary>
        <div className="grid gap-4 pt-3 sm:grid-cols-2">
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
        </div>
      </details>
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
  const providerEgress = pool?.members.some((member) => member.providerModel) ?? false;
  const grant = useMutation(
    orpc.forwarderManagement.grantPoolAccessByEmail.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.grantAdded"));
        form.reset();
        onOpenChange(false);
      },
    }),
  );
  const schema = z
    .object({
      email: z.string().trim().email(),
      publicEgressAcknowledged: z.boolean(),
    })
    .superRefine((value, ctx) => {
      if (providerEgress && !value.publicEgressAcknowledged) {
        ctx.addIssue({ code: "custom", path: ["publicEgressAcknowledged"] });
      }
    });
  const form = useForm({
    defaultValues: { email: "", publicEgressAcknowledged: false },
    validators: { onSubmit: schema },
    onSubmit: ({ value }) =>
      pool
        ? grant.mutateAsync({
            poolId: pool.id,
            email: value.email,
            publicEgressAcknowledged: value.publicEgressAcknowledged,
          })
        : Promise.resolve(),
  });

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
            form.handleSubmit();
          }}
        >
          <form.Field name="email">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="grant-email">{t("dashboard:pools.email")}</Label>
                <Input
                  id="grant-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="user@example.com"
                  aria-invalid={field.state.meta.errors.length > 0}
                />
                <p className="text-xs text-muted-foreground">
                  {t("dashboard:pools.exactEmailOnly")}
                </p>
              </div>
            )}
          </form.Field>
          {providerEgress ? (
            <form.Field name="publicEgressAcknowledged">
              {(field) => (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                  <p className="text-sm font-medium">
                    {t("dashboard:pools.grantEgressWarningTitle")}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("dashboard:pools.grantEgressWarning", { pool: pool?.name ?? "" })}
                  </p>
                  <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                    <Checkbox
                      checked={field.state.value}
                      onCheckedChange={(checked) => field.handleChange(checked === true)}
                      aria-invalid={field.state.meta.errors.length > 0}
                    />
                    <span>{t("dashboard:pools.grantEgressAcknowledge")}</span>
                  </label>
                </div>
              )}
            </form.Field>
          ) : null}
          <DialogFooter>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
              {([canSubmit, isSubmitting]) => (
                <Button type="submit" size="touch" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? t("dashboard:pools.granting") : t("dashboard:pools.grant")}
                </Button>
              )}
            </form.Subscribe>
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
