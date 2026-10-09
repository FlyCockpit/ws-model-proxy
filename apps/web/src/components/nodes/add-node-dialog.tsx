import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "@ws-model-proxy/ui/components/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ws-model-proxy/ui/components/select";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { SegmentedControl } from "@/components/segmented-control";
import { orpc } from "@/utils/orpc";
import { EnrollmentPanel } from "./enrollment-panel";
import { FieldError } from "./field-error";
import type { EnrollmentResult } from "./node-types";
import { refusalToastOptions } from "./refusal";

const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const HOUR_MS = 3_600_000;
const TTL_OPTIONS = ["1", "24", "168"] as const;

export function parseLabels(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ];
}

function buildSchema(t: (key: string) => string) {
  return z
    .object({
      mode: z.enum(["one", "many"]),
      maxUses: z.string(),
      ttlHours: z.enum(TTL_OPTIONS),
      labels: z.string(),
      temporary: z.boolean(),
      offlineHours: z.string(),
    })
    .superRefine((value, ctx) => {
      if (value.mode === "many") {
        const uses = Number(value.maxUses);
        if (!Number.isInteger(uses) || uses < 2 || uses > 50)
          ctx.addIssue({
            code: "custom",
            path: ["maxUses"],
            message: t("dashboard:nodes.add.maxUsesInvalid"),
          });
      }
      const labels = parseLabels(value.labels);
      if (labels.length > 32 || labels.some((label) => !LABEL_PATTERN.test(label)))
        ctx.addIssue({
          code: "custom",
          path: ["labels"],
          message: t("dashboard:nodes.add.labelsInvalid"),
        });
      if (value.temporary) {
        const hours = Number(value.offlineHours);
        if (!(hours >= 1 / 60) || hours > 720)
          ctx.addIssue({
            code: "custom",
            path: ["offlineHours"],
            message: t("dashboard:nodes.add.offlineHoursInvalid"),
          });
      }
    });
}

type AddNodeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lang: string;
  /** "Replace node <slug>": a single-use code that moves that node to a new identity. */
  replace?: { nodeId: string; slug: string };
};

export function AddNodeDialog({ open, onOpenChange, lang, replace }: AddNodeDialogProps) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const [result, setResult] = useState<EnrollmentResult | null>(null);

  const create = useMutation({
    ...orpc.nodes.enrollmentCodes.create.mutationOptions({
      onSuccess: (created) => {
        setResult(created);
        queryClient.invalidateQueries({ queryKey: orpc.nodes.enrollmentCodes.key() });
      },
    }),
    ...refusalToastOptions(t, "dashboard:nodes.add.failed"),
  });

  const form = useForm({
    defaultValues: {
      mode: "one" as "one" | "many",
      maxUses: "5",
      ttlHours: "1" as (typeof TTL_OPTIONS)[number],
      labels: "",
      temporary: false,
      offlineHours: "1",
    },
    validators: { onChange: buildSchema(t) },
    onSubmit: async ({ value }) => {
      const labels = parseLabels(value.labels);
      await create.mutateAsync(
        replace
          ? { replaceNodeId: replace.nodeId, ttlHours: Number(value.ttlHours) }
          : {
              ttlHours: Number(value.ttlHours),
              maxUses: value.mode === "many" ? Number(value.maxUses) : 1,
              ...(labels.length > 0 ? { labels } : {}),
              ...(value.temporary
                ? {
                    removeAfterOfflineMs: Math.max(
                      60_000,
                      Math.round(Number(value.offlineHours) * HOUR_MS),
                    ),
                  }
                : {}),
            },
      );
    },
  });

  const close = (next: boolean, explicit = false) => {
    if (create.isPending) return;
    // The one-time command closes only through Done, never a stray tap or Escape.
    if (!next && result && !explicit) return;
    if (!next) {
      setResult(null);
      form.reset();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => close(next)}>
      <DialogContent className="max-h-[90dvh] overflow-x-hidden overflow-y-auto overscroll-contain sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {replace
              ? t("dashboard:nodes.add.replaceTitle", { slug: replace.slug })
              : t("dashboard:nodes.add.title")}
          </DialogTitle>
          <DialogDescription>
            {replace
              ? t("dashboard:nodes.add.replaceDescription")
              : t("dashboard:nodes.add.description")}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <EnrollmentResultView result={result} lang={lang} onDone={() => close(false, true)} />
        ) : (
          <form
            className="min-w-0 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              form.handleSubmit().catch(() => undefined);
            }}
          >
            {replace ? null : (
              <form.Field name="mode">
                {(field) => (
                  <div className="space-y-1.5">
                    <span className="text-sm font-medium">{t("dashboard:nodes.add.howMany")}</span>
                    <SegmentedControl
                      value={field.state.value}
                      onChange={(next) => field.handleChange(next)}
                      ariaLabel={t("dashboard:nodes.add.howMany")}
                      items={[
                        { value: "one", label: t("dashboard:nodes.add.modeOne") },
                        { value: "many", label: t("dashboard:nodes.add.modeMany") },
                      ]}
                    />
                  </div>
                )}
              </form.Field>
            )}

            <form.Subscribe selector={(state) => state.values.mode}>
              {(mode) =>
                mode === "many" && !replace ? (
                  <form.Field name="maxUses">
                    {(field) => (
                      <div className="space-y-1.5">
                        <Label htmlFor="add-node-max-uses">
                          {t("dashboard:nodes.add.maxUses")}
                        </Label>
                        <Input
                          id="add-node-max-uses"
                          inputMode="numeric"
                          className="min-h-[44px]"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(event.target.value)}
                        />
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </form.Field>
                ) : null
              }
            </form.Subscribe>

            <form.Field name="ttlHours">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor="add-node-ttl">{t("dashboard:nodes.add.ttl")}</Label>
                  <Select
                    value={field.state.value}
                    onValueChange={(next) => {
                      const option = TTL_OPTIONS.find((candidate) => candidate === next);
                      if (option) field.handleChange(option);
                    }}
                  >
                    <SelectTrigger id="add-node-ttl" className="min-h-[44px] w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TTL_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {t(`dashboard:nodes.add.ttlOption.${option}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </form.Field>

            {replace ? null : (
              <>
                <form.Field name="labels">
                  {(field) => (
                    <div className="space-y-1.5">
                      <Label htmlFor="add-node-labels">{t("dashboard:nodes.add.labels")}</Label>
                      <Input
                        id="add-node-labels"
                        className="min-h-[44px] font-mono"
                        placeholder="gpu lab"
                        autoCapitalize="none"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("dashboard:nodes.add.labelsHint")}
                      </p>
                      <FieldError errors={field.state.meta.errors} />
                    </div>
                  )}
                </form.Field>

                <form.Field name="temporary">
                  {(field) => (
                    <label className="flex min-h-[44px] items-center justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">
                          {t("dashboard:nodes.add.temporary")}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t("dashboard:nodes.add.temporaryHint")}
                        </span>
                      </span>
                      <Switch
                        checked={field.state.value}
                        onCheckedChange={(checked) => field.handleChange(checked)}
                      />
                    </label>
                  )}
                </form.Field>

                <form.Subscribe selector={(state) => state.values.temporary}>
                  {(temporary) =>
                    temporary ? (
                      <form.Field name="offlineHours">
                        {(field) => (
                          <div className="space-y-1.5">
                            <Label htmlFor="add-node-offline">
                              {t("dashboard:nodes.add.offlineHours")}
                            </Label>
                            <Input
                              id="add-node-offline"
                              inputMode="decimal"
                              className="min-h-[44px]"
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(event) => field.handleChange(event.target.value)}
                            />
                            <FieldError errors={field.state.meta.errors} />
                          </div>
                        )}
                      </form.Field>
                    ) : null
                  }
                </form.Subscribe>
              </>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                className="min-h-[44px]"
                onClick={() => close(false)}
              >
                {t("common:actions.cancel")}
              </Button>
              <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
                {([canSubmit, isSubmitting]) => (
                  <Button
                    type="submit"
                    className="min-h-[44px]"
                    disabled={!canSubmit || isSubmitting || create.isPending}
                  >
                    {create.isPending
                      ? t("dashboard:nodes.add.creating")
                      : t("dashboard:nodes.add.create")}
                  </Button>
                )}
              </form.Subscribe>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The minted command (shared panel) with Done: the only way out once the secret is shown. */
function EnrollmentResultView({
  result,
  lang,
  onDone,
}: {
  result: EnrollmentResult;
  lang: string;
  onDone: () => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <div className="min-w-0 space-y-4">
      <EnrollmentPanel result={result} lang={lang} />
      <DialogFooter>
        <button
          type="button"
          className={buttonVariants({ className: "min-h-[44px]" })}
          onClick={onDone}
        >
          {t("dashboard:nodes.add.done")}
        </button>
      </DialogFooter>
    </div>
  );
}
