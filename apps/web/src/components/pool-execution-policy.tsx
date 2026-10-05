import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { embeddingContractSchema } from "@ws-model-proxy/api/lib/embedding-contract";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export function PoolExecutionPolicy({
  pool,
}: {
  pool: { id: string; paidWarmProtectionEnabled?: boolean; embeddingContract?: unknown };
}) {
  const { t } = useTranslation("dashboard");
  const id = useId();
  const parsed = embeddingContractSchema.safeParse(pool.embeddingContract);
  const contract = parsed.success ? parsed.data : null;
  const queryClient = useQueryClient();
  const save = useMutation(
    orpc.forwarderManagement.updateModelPool.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
      },
    }),
  );
  const schema = z
    .object({
      paid: z.boolean(),
      enabled: z.boolean(),
      model: z.string(),
      revision: z.string(),
      dimensions: z.string(),
      normalization: z.enum(["none", "l2"]),
      vectorSpace: z.string(),
    })
    .superRefine((value, ctx) => {
      if (!value.enabled) return;
      // The schema is strict, so pass only identity fields, not form controls.
      const identity = embeddingContractSchema.safeParse({
        model: value.model,
        revision: value.revision,
        dimensions: Number(value.dimensions),
        normalization: value.normalization,
        vectorSpace: value.vectorSpace,
      });
      if (!identity.success)
        for (const issue of identity.error.issues)
          ctx.addIssue({ code: "custom", path: issue.path, message: t("deployments.invalid") });
    });
  const form = useForm({
    defaultValues: {
      paid: pool.paidWarmProtectionEnabled ?? false,
      enabled: !!contract,
      model: contract?.model ?? "",
      revision: contract?.revision ?? "",
      dimensions: String(contract?.dimensions ?? ""),
      normalization: contract?.normalization ?? ("none" as "none" | "l2"),
      vectorSpace: contract?.vectorSpace ?? "",
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const embeddingContract = value.enabled
        ? embeddingContractSchema.parse({
            model: value.model,
            revision: value.revision,
            dimensions: Number(value.dimensions),
            normalization: value.normalization,
            vectorSpace: value.vectorSpace,
          })
        : null;
      await save
        .mutateAsync({ id: pool.id, paidWarmProtectionEnabled: value.paid, embeddingContract })
        .catch(() => undefined);
    },
  });
  return (
    <form
      className="min-w-0 space-y-3 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <h2 className="text-xl font-semibold">{t("deployments.policyTitle")}</h2>
      <form.Field name="paid">
        {(field) => (
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={field.state.value}
              onChange={(event) => field.handleChange(event.target.checked)}
            />
            {t("deployments.paidProtection")}
          </label>
        )}
      </form.Field>
      <p className="text-sm text-muted-foreground">{t("deployments.paidProtectionHint")}</p>
      <form.Field name="enabled">
        {(field) => (
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={field.state.value}
              onChange={(event) => field.handleChange(event.target.checked)}
            />
            {t("deployments.embeddingEnable")}
          </label>
        )}
      </form.Field>
      <p className="text-sm text-muted-foreground">{t("deployments.embeddingHint")}</p>
      <form.Subscribe selector={(state) => state.values.enabled}>
        {(enabled) =>
          enabled ? (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              {(["model", "revision", "dimensions", "vectorSpace"] as const).map((name) => (
                <form.Field key={name} name={name}>
                  {(field) => (
                    <div className="min-w-0">
                      <Label htmlFor={`${id}-${name}`}>
                        {t(`deployments.${name === "revision" ? "revisionName" : name}`)}
                      </Label>
                      <Input
                        id={`${id}-${name}`}
                        className="min-h-11"
                        inputMode={name === "dimensions" ? "numeric" : "text"}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={field.state.meta.errors.length > 0}
                        aria-describedby={`${id}-${name}-error`}
                      />
                      <div id={`${id}-${name}-error`}>
                        {field.state.meta.errors.length ? (
                          <p role="alert">{t("deployments.invalid")}</p>
                        ) : null}
                      </div>
                    </div>
                  )}
                </form.Field>
              ))}
              <form.Field name="normalization">
                {(field) => (
                  <div>
                    <Label htmlFor={`${id}-normalization`}>{t("deployments.normalization")}</Label>
                    <select
                      id={`${id}-normalization`}
                      className="min-h-11 w-full rounded-md border bg-background p-2"
                      value={field.state.value}
                      onChange={(event) =>
                        field.handleChange(event.target.value === "l2" ? "l2" : "none")
                      }
                    >
                      <option value="none">{t("deployments.normalizationNone")}</option>
                      <option value="l2">{t("deployments.normalizationL2")}</option>
                    </select>
                  </div>
                )}
              </form.Field>
            </div>
          ) : null
        }
      </form.Subscribe>
      <Button size="touch" type="submit" disabled={save.isPending}>
        {t("deployments.savePolicy")}
      </Button>
      {save.isError ? <p role="alert">{friendly(save.error, t("deployments.failed"))}</p> : null}
    </form>
  );
}
