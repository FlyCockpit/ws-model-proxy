import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  gpuBudgetKey,
  NODE_LABEL_PATTERN,
  NODE_LABELS_MAX,
  type NodeCardSnapshot,
  nodeLabelsSchema,
} from "@ws-model-proxy/api/lib/node-inventory";
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
import { Pencil, Tags, Thermometer } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { orpc } from "@/utils/orpc";

function formatGb(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return (Math.round(value * 10) / 10).toString();
}

function gpuKey(gpu: NodeCardSnapshot["gpus"][number]): string {
  return gpuBudgetKey({ index: gpu.index, uuid: gpu.uuid ?? undefined });
}

function budgetInputValue(value: number | null, isDefault: boolean): string {
  if (isDefault || value == null) return "";
  return String(value);
}

function parseBudgetInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export function CliDeviceNodeCard({
  cliDeviceId,
  node,
}: {
  cliDeviceId: string;
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
                  {gpu.name ?? t("dashboard:clis.node.gpuIndex", { index: gpu.index })}
                  {gpu.vramUsedGb != null && gpu.vramTotalGb != null
                    ? ` · ${t("dashboard:clis.node.vram", {
                        used: formatGb(gpu.vramUsedGb),
                        total: formatGb(gpu.vramTotalGb),
                      })}`
                    : gpu.vramTotalGb != null
                      ? ` · ${t("dashboard:clis.node.vramTotal", {
                          total: formatGb(gpu.vramTotalGb),
                        })}`
                      : ""}
                  {gpu.temperatureC != null
                    ? ` · ${t("dashboard:clis.node.temp", { value: Math.round(gpu.temperatureC) })}`
                    : ""}
                  {gpu.utilizationPercent != null
                    ? ` · ${t("dashboard:clis.node.util", {
                        value: Math.round(gpu.utilizationPercent),
                      })}`
                    : ""}
                </p>
              ))
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-4 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">{t("dashboard:clis.node.labels")}</p>
          <EditLabelsDialog cliDeviceId={cliDeviceId} node={node} />
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
            {t("dashboard:clis.node.suggested")}: {node.suggestedLabels.join(", ")}
          </p>
        ) : null}
      </div>

      <div className="mt-4 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">{t("dashboard:clis.node.budgets")}</p>
          <EditBudgetsDialog cliDeviceId={cliDeviceId} node={node} />
        </div>
        <ul className="mt-2 space-y-1 text-sm">
          {showMemory && node.usableMemoryGb != null ? (
            <li>
              {t("dashboard:clis.node.usableMemory")}:{" "}
              {t("dashboard:clis.node.budgetGb", { value: formatGb(node.usableMemoryGb) })}
              {node.usableMemoryGbDefault ? (
                <span className="ml-1 text-xs text-muted-foreground">
                  ({t("dashboard:clis.node.budgetDefault")})
                </span>
              ) : null}
            </li>
          ) : null}
          {showRam && node.usableRamGb != null ? (
            <li>
              {t("dashboard:clis.node.usableRam")}:{" "}
              {t("dashboard:clis.node.budgetGb", { value: formatGb(node.usableRamGb) })}
              {node.usableRamGbDefault ? (
                <span className="ml-1 text-xs text-muted-foreground">
                  ({t("dashboard:clis.node.budgetDefault")})
                </span>
              ) : null}
            </li>
          ) : null}
          {node.gpus.map((gpu) =>
            gpu.usableVramGb == null ? null : (
              <li key={gpuKey(gpu)}>
                {t("dashboard:clis.node.usableVram")}{" "}
                {gpu.name ?? t("dashboard:clis.node.gpuIndex", { index: gpu.index })}:{" "}
                {t("dashboard:clis.node.budgetGb", { value: formatGb(gpu.usableVramGb) })}
                {gpu.usableVramGbDefault ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({t("dashboard:clis.node.budgetDefault")})
                  </span>
                ) : null}
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
  const save = useMutation(
    orpc.forwarderManagement.setCliDeviceLabels.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:clis.node.labelsSaved"));
      },
      onError: () => toast.error(t("dashboard:clis.node.labelsSaveFailed")),
    }),
  );
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

function EditLabelsDialog({ cliDeviceId, node }: { cliDeviceId: string; node: NodeCardSnapshot }) {
  const { t } = useTranslation("dashboard");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="touch"
        aria-label={t("dashboard:clis.node.editLabels")}
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
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const save = useMutation(
    orpc.forwarderManagement.setCliDeviceLabels.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:clis.node.labelsSaved"));
        onDone();
      },
      onError: () => toast.error(t("dashboard:clis.node.labelsSaveFailed")),
    }),
  );
  const form = useForm({
    defaultValues: { labels: [...node.labels] },
    validators: { onSubmit: z.object({ labels: nodeLabelsSchema }) },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({ cliDeviceId, labels: value.labels }).catch(() => undefined);
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
            <Label>{t("dashboard:clis.node.labels")}</Label>
            <ul className="flex flex-wrap gap-1">
              {field.state.value.map((label) => (
                <li key={label}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="touch"
                    onClick={() =>
                      field.handleChange(field.state.value.filter((item) => item !== label))
                    }
                  >
                    {label} ×
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
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
                  const next = draft.trim().toLowerCase();
                  if (!NODE_LABEL_PATTERN.test(next)) {
                    setDraftError(t("dashboard:clis.node.invalidLabel"));
                    return;
                  }
                  if (field.state.value.includes(next)) {
                    setDraftError(t("dashboard:clis.node.duplicateLabel"));
                    return;
                  }
                  if (field.state.value.length >= NODE_LABELS_MAX) return;
                  field.handleChange([...field.state.value, next]);
                  setDraft("");
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="touch"
                onClick={() => {
                  const next = draft.trim().toLowerCase();
                  if (!NODE_LABEL_PATTERN.test(next)) {
                    setDraftError(t("dashboard:clis.node.invalidLabel"));
                    return;
                  }
                  if (field.state.value.includes(next)) {
                    setDraftError(t("dashboard:clis.node.duplicateLabel"));
                    return;
                  }
                  if (field.state.value.length >= NODE_LABELS_MAX) return;
                  field.handleChange([...field.state.value, next]);
                  setDraft("");
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

function EditBudgetsDialog({ cliDeviceId, node }: { cliDeviceId: string; node: NodeCardSnapshot }) {
  const { t } = useTranslation("dashboard");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="touch"
        aria-label={t("dashboard:clis.node.editBudgets")}
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
  const { t } = useTranslation("dashboard");
  const queryClient = useQueryClient();
  const showMemory = node.kind !== "discrete" && node.kind !== "cpu";
  const showRam = node.kind !== "unified";
  const save = useMutation(
    orpc.forwarderManagement.setCliDeviceUsableBudgets.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:clis.node.budgetsSaved"));
        onDone();
      },
      onError: () => toast.error(t("dashboard:clis.node.budgetsSaveFailed")),
    }),
  );
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
      onSubmit: z.object({
        usableMemoryGb: z.string(),
        usableRamGb: z.string(),
        vram: z.record(z.string(), z.string()),
      }),
    },
    onSubmit: async ({ value }) => {
      const usableMemoryGb = showMemory ? parseBudgetInput(value.usableMemoryGb) : undefined;
      const usableRamGb = showRam ? parseBudgetInput(value.usableRamGb) : undefined;
      if (showMemory && usableMemoryGb === undefined) return;
      if (showRam && usableRamGb === undefined) return;
      const usableVramGb: Record<string, number> = {};
      for (const gpu of node.gpus) {
        const parsed = parseBudgetInput(value.vram[String(gpu.index)] ?? "");
        if (parsed === undefined) return;
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
              invalidMessage={t("dashboard:clis.node.invalidBudget")}
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
              invalidMessage={t("dashboard:clis.node.invalidBudget")}
            />
          )}
        </form.Field>
      ) : null}
      {node.gpus.map((gpu) => (
        <form.Field key={gpuKey(gpu)} name={`vram.${gpu.index}`}>
          {(field) => (
            <BudgetField
              id={`usable-vram-${cliDeviceId}-${gpu.index}`}
              label={`${t("dashboard:clis.node.usableVram")} ${
                gpu.name ?? t("dashboard:clis.node.gpuIndex", { index: gpu.index })
              }`}
              field={field}
              invalidMessage={t("dashboard:clis.node.invalidBudget")}
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
  invalidMessage,
}: {
  id: string;
  label: string;
  field: {
    name: string;
    state: { value: string };
    handleBlur: () => void;
    handleChange: (value: string) => void;
  };
  invalidMessage: string;
}) {
  const { t } = useTranslation("dashboard");
  const parsed = parseBudgetInput(field.state.value);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={field.name}
        className="min-h-11"
        inputMode="decimal"
        autoComplete="off"
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">{t("dashboard:clis.node.budgetHint")}</p>
      {parsed === undefined ? <p className="text-sm text-destructive">{invalidMessage}</p> : null}
    </div>
  );
}
