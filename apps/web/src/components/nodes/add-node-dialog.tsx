import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { FormAdvanced, focusFirstInvalid } from "@/components/form-surface";
import { LabelledSelect } from "@/components/labelled-select";
import { SegmentedControl } from "@/components/segmented-control";
import { SwitchRow } from "@/components/switch-row";
import { orpc } from "@/utils/orpc";
import { parseLabels } from "./add-node-dialog-utils";
import { EnrollmentPanel } from "./enrollment-panel";
import { FieldError } from "./field-error";
import type { EnrollmentResult } from "./node-types";
import { refusalToastOptions } from "./refusal";

const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const HOUR_MS = 3_600_000;
const TTL_OPTIONS = ["1", "24", "168"] as const;

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
    validators: { onChange: buildSchema(t), onSubmit: buildSchema(t) },
    // The options sit in a collapsed section: a refused create opens it and focuses the field.
    onSubmitInvalid: () =>
      window.setTimeout(() => focusFirstInvalid(document.getElementById(formId)), 0),
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

  const formId = `add-node-form${replace ? "-replace" : ""}`;
  const ttlField = (
    <form.Field name="ttlHours">
      {(field) => (
        <div className="space-y-1.5">
          <Label htmlFor="add-node-ttl">{t("dashboard:nodes.add.ttl")}</Label>
          <LabelledSelect
            id="add-node-ttl"
            value={field.state.value}
            onValueChange={field.handleChange}
            options={TTL_OPTIONS.map((option) => ({
              value: option,
              label: t(`dashboard:nodes.add.ttlOption.${option}`),
            }))}
          />
        </div>
      )}
    </form.Field>
  );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => close(next)}
      title={
        replace
          ? t("dashboard:nodes.add.replaceTitle", { slug: replace.slug })
          : t("dashboard:nodes.add.title")
      }
      description={
        replace ? t("dashboard:nodes.add.replaceDescription") : t("dashboard:nodes.add.description")
      }
      className="md:max-w-lg"
      footer={
        result ? (
          <div className="flex min-w-0 justify-end">
            <Button type="button" size="touch" onClick={() => close(false, true)}>
              {t("dashboard:nodes.add.done")}
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="touch" onClick={() => close(false)}>
              {t("common:actions.cancel")}
            </Button>
            {/* Enabled while invalid: a refused create shows and focuses the error, even when it
                sits in the collapsed options. */}
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <Button
                  type="submit"
                  form={formId}
                  size="touch"
                  disabled={isSubmitting || create.isPending}
                >
                  {create.isPending
                    ? t("dashboard:nodes.add.creating")
                    : t("dashboard:nodes.add.create")}
                </Button>
              )}
            </form.Subscribe>
          </div>
        )
      }
    >
      {result ? (
        <div className="min-w-0 pb-4">
          <EnrollmentPanel result={result} lang={lang} />
        </div>
      ) : (
        <form
          id={formId}
          className="min-w-0 space-y-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit().catch(() => undefined);
          }}
        >
          {replace ? (
            ttlField
          ) : (
            <>
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
              <form.Subscribe selector={(state) => state.values.mode}>
                {(mode) =>
                  mode === "many" ? (
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
                            aria-invalid={field.state.meta.errors.length > 0 || undefined}
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
              <form.Subscribe
                selector={(state) =>
                  [
                    state.values.ttlHours,
                    state.values.labels,
                    state.values.temporary,
                    state.values.offlineHours,
                  ] as const
                }
              >
                {([ttlHours, labels, temporary, offlineHours]) => {
                  const labelList = parseLabels(labels);
                  return (
                    <FormAdvanced
                      title={t("dashboard:nodes.add.options")}
                      summary={[
                        t("dashboard:nodes.add.summary.ttl", {
                          ttl: t(`dashboard:nodes.add.ttlOption.${ttlHours}`),
                        }),
                        labelList.length > 0
                          ? t("dashboard:nodes.add.summary.labels", { labels: labelList.join(" ") })
                          : t("dashboard:nodes.add.summary.noLabels"),
                        temporary
                          ? t("dashboard:nodes.add.summary.removed", { hours: offlineHours })
                          : t("dashboard:nodes.add.summary.kept"),
                      ].join(" · ")}
                    >
                      {ttlField}
                      <form.Field name="labels">
                        {(field) => (
                          <div className="space-y-1.5">
                            <Label htmlFor="add-node-labels">
                              {t("dashboard:nodes.add.labels")}
                            </Label>
                            <Input
                              id="add-node-labels"
                              className="min-h-[44px] font-mono"
                              placeholder="gpu lab"
                              autoCapitalize="none"
                              value={field.state.value}
                              aria-invalid={field.state.meta.errors.length > 0 || undefined}
                              aria-describedby="add-node-labels-hint add-node-labels-error"
                              onBlur={field.handleBlur}
                              onChange={(event) => field.handleChange(event.target.value)}
                            />
                            <p id="add-node-labels-hint" className="text-xs text-muted-foreground">
                              {t("dashboard:nodes.add.labelsHint")}
                            </p>
                            <FieldError
                              id="add-node-labels-error"
                              errors={field.state.meta.errors}
                            />
                          </div>
                        )}
                      </form.Field>
                      <form.Field name="temporary">
                        {(field) => (
                          <SwitchRow
                            id="add-node-temporary"
                            label={t("dashboard:nodes.add.temporary")}
                            description={t("dashboard:nodes.add.temporaryHint")}
                            checked={field.state.value}
                            onChange={field.handleChange}
                          />
                        )}
                      </form.Field>
                      {temporary ? (
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
                                aria-invalid={field.state.meta.errors.length > 0 || undefined}
                                aria-describedby="add-node-offline-error"
                                onBlur={field.handleBlur}
                                onChange={(event) => field.handleChange(event.target.value)}
                              />
                              <FieldError
                                id="add-node-offline-error"
                                errors={field.state.meta.errors}
                              />
                            </div>
                          )}
                        </form.Field>
                      ) : null}
                    </FormAdvanced>
                  );
                }}
              </form.Subscribe>
            </>
          )}
        </form>
      )}
    </ResponsiveDialog>
  );
}
