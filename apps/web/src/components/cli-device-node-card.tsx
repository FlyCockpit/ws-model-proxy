import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  gpuBudgetKey,
  gpuBudgetMap,
  NODE_BUDGET_MAX_GB,
  NODE_LABEL_PATTERN,
  NODE_LABELS_MAX,
  type NodeCardSnapshot,
  nodeLabelsSchema,
} from "@ws-model-proxy/api/lib/node-inventory";
import { parseLocaleDecimal } from "@ws-model-proxy/config/decimal-input";
import { DEFAULT_LOCALE } from "@ws-model-proxy/config/locales";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { FolderX, Pencil, Tags, Thermometer, X } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { friendly, isBadRequest } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

function formatGb(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return (Math.round(value * 10) / 10).toString();
}

function gpuKey(gpu: NodeCardSnapshot["gpus"][number]): string {
  return gpuBudgetKey({ index: gpu.index, uuid: gpu.uuid ?? undefined });
}

function formatBudgetInput(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  const rounded = Math.round(value * 1e9) / 1e9;
  if (rounded === 0 && value > 0) {
    const text = String(value);
    const [mantissa, exponent] = text.split("e-");
    if (!exponent || !mantissa) return text;
    const digits = mantissa.replace(".", "");
    return `0.${"0".repeat(Number(exponent) - 1)}${digits}`;
  }
  if (rounded === 0) return "0";
  return rounded.toFixed(9).replace(/\.?0+$/, "");
}

function budgetInputValue(value: number | null, isDefault: boolean): string {
  if (isDefault || value == null) return "";
  return formatBudgetInput(value);
}

function parseBudgetInput(raw: string, locale: string): number | null {
  const normalized = parseLocaleDecimal(raw, locale);
  if (normalized === null || normalized.length === 0) return null;
  return Number(normalized);
}

function budgetInputSchema(
  invalidMessage: string,
  locale: string,
  options?: { maxGb?: number | null; exceedsMessage?: string; whileTyping?: boolean },
) {
  return z.string().superRefine((raw, ctx) => {
    // A lone decimal separator is an unfinished entry while typing, not an error.
    if (options?.whileTyping && /^[.,]$/.test(raw.trim())) return;
    const value = parseLocaleDecimal(raw, locale);
    if (value === null) {
      ctx.addIssue({ code: "custom", message: invalidMessage });
      return;
    }
    if (value === "") return;
    if (
      !/^(\d+(\.\d*)?|\.\d+)$/.test(value) ||
      Number(value) < 0 ||
      Number(value) > NODE_BUDGET_MAX_GB
    ) {
      ctx.addIssue({ code: "custom", message: invalidMessage });
      return;
    }
    const maxGb = options?.maxGb;
    if (
      maxGb != null &&
      Number.isFinite(maxGb) &&
      Number(value) > maxGb &&
      options?.exceedsMessage
    ) {
      ctx.addIssue({ code: "custom", message: options.exceedsMessage });
    }
  });
}

function declaredBudgetFields(error: unknown): string[] {
  if (!isBadRequest(error) || !error || typeof error !== "object" || !("data" in error)) return [];
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("fields" in data)) return [];
  const fields = (data as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function formFieldsForBudgetServerField(field: string, node: NodeCardSnapshot): string[] {
  if (field === "usableMemoryGb") return ["usableMemoryGb"];
  if (field === "usableRamGb") return ["usableRamGb"];
  if (field === "usableVramGb") return node.gpus.map((gpu) => `vram.${gpu.index}`);
  if (field.startsWith("usableVramGb.")) {
    const key = field.slice("usableVramGb.".length);
    const gpu = node.gpus.find((item) => gpuKey(item) === key || String(item.index) === key);
    return gpu ? [`vram.${gpu.index}`] : node.gpus.map((item) => `vram.${item.index}`);
  }
  return [];
}

function budgetDefaultMark(isDefault: boolean, t: (key: string) => string): string {
  return isDefault ? t("dashboard:clis.node.budgetDefaultMark") : "";
}

function gpuStatLine(
  gpu: NodeCardSnapshot["gpus"][number],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const name = gpu.name ?? t("dashboard:clis.node.gpuIndex", { index: gpu.index });
  const vram =
    gpu.vramUsedGb != null && gpu.vramTotalGb != null
      ? t("dashboard:clis.node.vramDetail", {
          used: formatGb(gpu.vramUsedGb),
          total: formatGb(gpu.vramTotalGb),
        })
      : gpu.vramTotalGb != null
        ? t("dashboard:clis.node.vramTotalDetail", { total: formatGb(gpu.vramTotalGb) })
        : "";
  const temp =
    gpu.temperatureC != null
      ? t("dashboard:clis.node.tempDetail", { value: Math.round(gpu.temperatureC) })
      : "";
  const util =
    gpu.utilizationPercent != null
      ? t("dashboard:clis.node.utilDetail", { value: Math.round(gpu.utilizationPercent) })
      : "";
  return t("dashboard:clis.node.gpuLine", { name, vram, temp, util });
}

export function CliDeviceNodeCard({
  cliDeviceId,
  deviceName,
  node,
}: {
  cliDeviceId: string;
  deviceName: string;
  node: NodeCardSnapshot;
}) {
  const { t } = useTranslation("dashboard");
  const hasTelemetry = node.kind !== null || node.gpus.length > 0 || node.memoryTotalGb !== null;
  const showMemory = node.kind !== "discrete" && node.kind !== "cpu";
  const showRam = node.kind !== "unified";
  const showSuggest = node.labels.length === 0 && node.suggestedLabels.length > 0;

  return (
    <div className="min-w-0 max-w-full border-b p-4" data-testid="cli-device-node-card">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">{t("dashboard:clis.node.title")}</h4>
        <span className="inline-flex min-h-6 items-center border px-2 text-xs font-medium">
          {node.kind
            ? t(`dashboard:clis.node.kinds.${node.kind}`)
            : t("dashboard:clis.node.kindUnknown")}
        </span>
        {node.cpuPercent != null ? (
          <span className="text-xs text-muted-foreground">
            {t("dashboard:clis.node.cpu", { value: Math.round(node.cpuPercent) })}
          </span>
        ) : null}
      </div>

      {hasTelemetry ? null : (
        <p className="mt-2 text-xs text-muted-foreground">{t("dashboard:clis.node.noTelemetry")}</p>
      )}

      <dl className="mt-3 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t("dashboard:clis.node.memory")}</dt>
          <dd className="mt-1">
            {node.memoryAvailableGb != null && node.memoryTotalGb != null
              ? t("dashboard:clis.node.memoryLive", {
                  available: formatGb(node.memoryAvailableGb),
                  total: formatGb(node.memoryTotalGb),
                })
              : t("dashboard:clis.node.memoryUnknown")}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t("dashboard:clis.node.gpus")}</dt>
          <dd className="mt-1 space-y-1">
            {node.gpus.length === 0 ? (
              <p className="text-muted-foreground">{t("dashboard:clis.node.noGpus")}</p>
            ) : (
              node.gpus.map((gpu) => (
                <p key={gpuKey(gpu)} className="min-w-0 truncate">
                  {gpuStatLine(gpu, t)}
                </p>
              ))
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-4 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">{t("dashboard:clis.node.labels")}</p>
          <EditLabelsDialog cliDeviceId={cliDeviceId} deviceName={deviceName} node={node} />
          {showSuggest ? (
            <AcceptSuggestedLabels cliDeviceId={cliDeviceId} labels={node.suggestedLabels} />
          ) : null}
        </div>
        {node.labels.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {t("dashboard:clis.node.labelsEmpty")}
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-1">
            {node.labels.map((label) => (
              <li
                key={label}
                className="inline-flex min-h-6 items-center border px-2 font-mono text-xs"
              >
                {label}
              </li>
            ))}
          </ul>
        )}
        {showSuggest ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("dashboard:clis.node.suggestedList", {
              labels: node.suggestedLabels.join(", "),
            })}
          </p>
        ) : null}
      </div>

      <div className="mt-4 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">{t("dashboard:clis.node.budgets")}</p>
          <EditBudgetsDialog cliDeviceId={cliDeviceId} deviceName={deviceName} node={node} />
        </div>
        <ul className="mt-2 space-y-1 text-sm">
          {showMemory && node.usableMemoryGb != null ? (
            <li>
              {t("dashboard:clis.node.usableMemoryLine", {
                value: formatGb(node.usableMemoryGb),
                default: budgetDefaultMark(node.usableMemoryGbDefault, t),
              })}
            </li>
          ) : null}
          {showRam && node.usableRamGb != null ? (
            <li>
              {t("dashboard:clis.node.usableRamLine", {
                value: formatGb(node.usableRamGb),
                default: budgetDefaultMark(node.usableRamGbDefault, t),
              })}
            </li>
          ) : null}
          {node.gpus.map((gpu) =>
            gpu.usableVramGb == null ? null : (
              <li key={gpuKey(gpu)}>
                {t("dashboard:clis.node.usableVramLine", {
                  gpu: gpu.name ?? t("dashboard:clis.node.gpuIndex", { index: gpu.index }),
                  value: formatGb(gpu.usableVramGb),
                  default: budgetDefaultMark(gpu.usableVramGbDefault, t),
                })}
              </li>
            ),
          )}
        </ul>
      </div>

      <div className="mt-4 min-w-0">
        <p className="text-xs text-muted-foreground">{t("dashboard:clis.node.warnings")}</p>
        {node.warnings.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {t("dashboard:clis.node.warningsNone")}
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-1">
            {node.warnings.map((warning) => (
              <li
                key={warning.code}
                className={cn(
                  "inline-flex min-h-6 items-center gap-1 border border-amber-300 px-2 text-xs text-amber-800 dark:border-amber-700 dark:text-amber-300",
                )}
              >
                {warning.code === "thermal" ? (
                  <Thermometer className="size-3.5" aria-hidden />
                ) : null}
                {warning.code === "abandoned_recovery" ? (
                  <FolderX className="size-3.5" aria-hidden />
                ) : null}
                {t(`dashboard:clis.node.warning.${warning.code}`)}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {t("dashboard:clis.node.warningsHint")}
        </p>
      </div>
    </div>
  );
}

function AcceptSuggestedLabels({
  cliDeviceId,
  labels,
}: {
  cliDeviceId: string;
  labels: readonly string[];
}) {
  const { t } = useTranslation("dashboard");
  const queryClient = useQueryClient();
  const save = useMutation({
    ...orpc.forwarderManagement.setCliDeviceLabels.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:clis.node.labelsSaved"));
      },
      onError: (error) => {
        toast.error(friendly(error, t("dashboard:clis.node.labelsSaveFailed")));
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <Button
      type="button"
      variant="secondary"
      size="touch"
      disabled={save.isPending}
      onClick={() =>
        void save.mutateAsync({ cliDeviceId, labels: [...labels] }).catch(() => undefined)
      }
    >
      <Tags className="size-4" />
      {save.isPending ? t("dashboard:clis.node.saving") : t("dashboard:clis.node.acceptSuggested")}
    </Button>
  );
}

function EditLabelsDialog({
  cliDeviceId,
  deviceName,
  node,
}: {
  cliDeviceId: string;
  deviceName: string;
  node: NodeCardSnapshot;
}) {
  const { t } = useTranslation("dashboard");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="touch"
        aria-label={t("dashboard:clis.node.editLabelsFor", { name: deviceName })}
        onClick={() => setOpen(true)}
      >
        <Pencil className="size-4" />
        {t("dashboard:clis.node.editLabels")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dashboard:clis.node.editLabelsTitle")}</DialogTitle>
            <DialogDescription>{t("dashboard:clis.node.editLabelsDescription")}</DialogDescription>
          </DialogHeader>
          {open ? (
            <LabelsForm cliDeviceId={cliDeviceId} node={node} onDone={() => setOpen(false)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function LabelsForm({
  cliDeviceId,
  node,
  onDone,
}: {
  cliDeviceId: string;
  node: NodeCardSnapshot;
  onDone: () => void;
}) {
  const { t } = useTranslation("dashboard");
  const queryClient = useQueryClient();
  const labelsId = useId();
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const save = useMutation({
    ...orpc.forwarderManagement.setCliDeviceLabels.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:clis.node.labelsSaved"));
        onDone();
      },
      onError: (error) => {
        toast.error(friendly(error, t("dashboard:clis.node.labelsSaveFailed")));
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });
  const commitDraft = (labels: string[], clear = true): string[] | null => {
    const next = draft.trim().toLowerCase();
    if (!next) return labels;
    if (!NODE_LABEL_PATTERN.test(next)) {
      setDraftError(t("dashboard:clis.node.invalidLabel"));
      return null;
    }
    if (labels.includes(next)) {
      setDraftError(t("dashboard:clis.node.duplicateLabel"));
      return null;
    }
    if (labels.length >= NODE_LABELS_MAX) {
      setDraftError(t("dashboard:clis.node.labelsMax", { max: NODE_LABELS_MAX }));
      return null;
    }
    setDraftError(null);
    if (clear) setDraft("");
    return [...labels, next];
  };
  const form = useForm({
    defaultValues: { labels: [...node.labels] },
    validators: {
      onSubmit: z.object({
        labels: z.array(z.string()).superRefine((labels, ctx) => {
          const result = nodeLabelsSchema.safeParse(labels);
          if (!result.success)
            for (const issue of result.error.issues)
              ctx.addIssue({
                code: "custom",
                path: issue.path,
                message: t("dashboard:clis.node.invalidLabel"),
              });
        }),
      }),
    },
    onSubmit: async ({ value }) => {
      const labels = commitDraft(value.labels, false);
      if (labels === null) return;
      await save
        .mutateAsync({ cliDeviceId, labels })
        .then(() => setDraft(""))
        .catch(() => undefined);
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="labels">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={labelsId}>{t("dashboard:clis.node.labels")}</Label>
            <ul className="flex flex-wrap gap-1">
              {field.state.value.map((label) => (
                <li key={label}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="touch"
                    aria-label={t("dashboard:clis.node.removeLabel", { label })}
                    onClick={() =>
                      field.handleChange(field.state.value.filter((item) => item !== label))
                    }
                  >
                    {label}
                    <X className="size-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id={labelsId}
                className="min-h-11 min-w-0"
                autoComplete="off"
                placeholder={t("dashboard:clis.node.addLabelPlaceholder")}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setDraftError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const committed = commitDraft(field.state.value);
                  if (committed) field.handleChange(committed);
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="touch"
                onClick={() => {
                  const committed = commitDraft(field.state.value);
                  if (committed) field.handleChange(committed);
                }}
              >
                {t("dashboard:clis.node.addLabel")}
              </Button>
            </div>
            {draftError ? <p className="text-sm text-destructive">{draftError}</p> : null}
          </div>
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="outline" size="touch" onClick={onDone}>
          {t("dashboard:clis.node.cancel")}
        </Button>
        <form.Subscribe
          selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <Button type="submit" size="touch" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? t("dashboard:clis.node.saving") : t("dashboard:clis.node.saveLabels")}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}

function EditBudgetsDialog({
  cliDeviceId,
  deviceName,
  node,
}: {
  cliDeviceId: string;
  deviceName: string;
  node: NodeCardSnapshot;
}) {
  const { t } = useTranslation("dashboard");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="touch"
        aria-label={t("dashboard:clis.node.editBudgetsFor", { name: deviceName })}
        onClick={() => setOpen(true)}
      >
        <Pencil className="size-4" />
        {t("dashboard:clis.node.editBudgets")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dashboard:clis.node.editBudgetsTitle")}</DialogTitle>
            <DialogDescription>{t("dashboard:clis.node.editBudgetsDescription")}</DialogDescription>
          </DialogHeader>
          {open ? (
            <BudgetsForm cliDeviceId={cliDeviceId} node={node} onDone={() => setOpen(false)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function BudgetsForm({
  cliDeviceId,
  node,
  onDone,
}: {
  cliDeviceId: string;
  node: NodeCardSnapshot;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation("dashboard");
  const locale = i18n.language || DEFAULT_LOCALE;
  const queryClient = useQueryClient();
  const showMemory = node.kind !== "discrete" && node.kind !== "cpu";
  const showRam = node.kind !== "unified";
  const invalidBudget = t("dashboard:clis.node.invalidBudget");
  const exceedsMessage = (total: number | null | undefined) =>
    total == null
      ? t("dashboard:clis.node.budgetExceedsUnknownTotal")
      : t("dashboard:clis.node.budgetExceedsTotal", { total: String(total) });
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    ...orpc.forwarderManagement.setCliDeviceUsableBudgets.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:clis.node.budgetsSaved"));
        onDone();
      },
      onError: (error) => {
        const next: Record<string, string> = {};
        for (const field of declaredBudgetFields(error)) {
          for (const formField of formFieldsForBudgetServerField(field, node)) {
            const total =
              formField === "usableMemoryGb" || formField === "usableRamGb"
                ? node.memoryTotalGb
                : node.gpus.find((gpu) => formField === `vram.${gpu.index}`)?.vramTotalGb;
            next[formField] = exceedsMessage(total);
          }
        }
        setServerErrors(next);
        if (Object.keys(next).length === 0) {
          toast.error(friendly(error, t("dashboard:clis.node.budgetsSaveFailed")));
        }
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });
  const budgetsSchema = (whileTyping: boolean) => {
    const visibleBudget = (maxGb: number | null | undefined) =>
      budgetInputSchema(invalidBudget, locale, {
        maxGb,
        exceedsMessage: exceedsMessage(maxGb),
        whileTyping,
      });
    return z.object({
      usableMemoryGb: showMemory ? visibleBudget(node.memoryTotalGb) : z.string(),
      usableRamGb: showRam ? visibleBudget(node.memoryTotalGb) : z.string(),
      vram: z.object(
        Object.fromEntries(
          node.gpus.map((gpu) => [String(gpu.index), visibleBudget(gpu.vramTotalGb)]),
        ),
      ),
    });
  };
  const form = useForm({
    defaultValues: {
      usableMemoryGb: budgetInputValue(node.usableMemoryGb, node.usableMemoryGbDefault),
      usableRamGb: budgetInputValue(node.usableRamGb, node.usableRamGbDefault),
      vram: Object.fromEntries(
        node.gpus.map((gpu) => [
          String(gpu.index),
          budgetInputValue(gpu.usableVramGb, gpu.usableVramGbDefault),
        ]),
      ) as Record<string, string>,
    },
    validators: {
      onChange: budgetsSchema(true),
      onBlur: budgetsSchema(false),
      onSubmit: budgetsSchema(false),
    },
    onSubmit: async ({ value }) => {
      setServerErrors({});
      const usableMemoryGb = showMemory
        ? parseBudgetInput(value.usableMemoryGb, locale)
        : undefined;
      const usableRamGb = showRam ? parseBudgetInput(value.usableRamGb, locale) : undefined;
      const usableVramGb = gpuBudgetMap<number>();
      for (const gpu of node.gpus) {
        const parsed = parseBudgetInput(value.vram[String(gpu.index)] ?? "", locale);
        if (parsed !== null) usableVramGb[gpuKey(gpu)] = parsed;
      }
      await save
        .mutateAsync({
          cliDeviceId,
          ...(showMemory ? { usableMemoryGb: usableMemoryGb ?? null } : {}),
          ...(showRam ? { usableRamGb: usableRamGb ?? null } : {}),
          usableVramGb: Object.keys(usableVramGb).length > 0 ? usableVramGb : null,
        })
        .catch(() => undefined);
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {showMemory ? (
        <form.Field name="usableMemoryGb">
          {(field) => (
            <BudgetField
              id={`usable-memory-${cliDeviceId}`}
              label={t("dashboard:clis.node.usableMemory")}
              field={field}
              extraError={serverErrors.usableMemoryGb}
              onValueChange={() =>
                setServerErrors((current) => {
                  if (!("usableMemoryGb" in current)) return current;
                  const next = { ...current };
                  delete next.usableMemoryGb;
                  return next;
                })
              }
            />
          )}
        </form.Field>
      ) : null}
      {showRam ? (
        <form.Field name="usableRamGb">
          {(field) => (
            <BudgetField
              id={`usable-ram-${cliDeviceId}`}
              label={t("dashboard:clis.node.usableRam")}
              field={field}
              extraError={serverErrors.usableRamGb}
              onValueChange={() =>
                setServerErrors((current) => {
                  if (!("usableRamGb" in current)) return current;
                  const next = { ...current };
                  delete next.usableRamGb;
                  return next;
                })
              }
            />
          )}
        </form.Field>
      ) : null}
      {node.gpus.map((gpu) => (
        <form.Field key={gpuKey(gpu)} name={`vram.${gpu.index}`}>
          {(field) => (
            <BudgetField
              id={`usable-vram-${cliDeviceId}-${gpu.index}`}
              label={t("dashboard:clis.node.usableVramForGpu", {
                gpu: gpu.name ?? t("dashboard:clis.node.gpuIndex", { index: gpu.index }),
              })}
              field={field}
              extraError={serverErrors[`vram.${gpu.index}`]}
              onValueChange={() => {
                const key = `vram.${gpu.index}`;
                setServerErrors((current) => {
                  if (!(key in current)) return current;
                  const next = { ...current };
                  delete next[key];
                  return next;
                });
              }}
            />
          )}
        </form.Field>
      ))}
      <p className="text-xs text-muted-foreground">{t("dashboard:clis.node.budgetHint")}</p>
      <DialogFooter>
        <Button type="button" variant="outline" size="touch" onClick={onDone}>
          {t("dashboard:clis.node.cancel")}
        </Button>
        <form.Subscribe
          selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <Button type="submit" size="touch" disabled={!canSubmit || isSubmitting}>
              {isSubmitting
                ? t("dashboard:clis.node.saving")
                : t("dashboard:clis.node.saveBudgets")}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}

function BudgetField({
  id,
  label,
  field,
  extraError,
  onValueChange,
}: {
  id: string;
  label: string;
  field: {
    name: string;
    state: { value: string; meta: { errors: Array<{ message?: string } | undefined> } };
    handleBlur: () => void;
    handleChange: (value: string) => void;
  };
  extraError?: string;
  onValueChange?: () => void;
}) {
  const messages = [
    ...field.state.meta.errors.map((error) => error?.message).filter((message) => message),
    ...(extraError ? [extraError] : []),
  ];
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={field.name}
        className="min-h-11"
        inputMode="decimal"
        aria-invalid={messages.length > 0}
        aria-describedby={messages.length > 0 ? `${id}-errors` : undefined}
        autoComplete="off"
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => {
          field.handleChange(event.target.value);
          onValueChange?.();
        }}
      />
      <div id={`${id}-errors`}>
        {messages.map((message) => (
          <p key={message} className="text-sm text-destructive">
            {message}
          </p>
        ))}
      </div>
    </div>
  );
}
