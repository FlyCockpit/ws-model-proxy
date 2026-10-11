import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { ChevronDown, ChevronUp, Trash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmAction } from "@/components/access/confirm-action";
import { FieldErrors } from "@/components/field-errors";
import { NativeSelect } from "@/components/native-select";
import { StatusPill } from "@/components/status-pill";
import { MODEL_TYPES, type ModelType } from "@/lib/pool-ui";
import { orpc } from "@/utils/orpc";

import { CatalogSearch } from "./catalog-search";
import { ModelPricing } from "./model-pricing";
import {
  type ProviderAccountDetail,
  type ProviderModel,
  useProviderAction,
} from "./provider-action";

/** The account's models: enable, prices, delete; add one by ID or from the catalog. */
export function ModelsCard({ account }: { account: ProviderAccountDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:providers.models")}</CardTitle>
        <CardDescription>{t("dashboard:providers.modelsHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {account.models.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:providers.noModels")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y">
            {account.models.map((model) => (
              <ModelRow key={model.id} model={model} />
            ))}
          </ul>
        )}
        <AddModelForm account={account} />
      </CardContent>
    </Card>
  );
}

function ModelRow({ model }: { model: ProviderModel }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const action = useProviderAction();
  const [pricesOpen, setPricesOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const update = useMutation({
    ...orpc.providers.models.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const remove = useMutation({
    ...orpc.providers.models.delete.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <li className="flex min-w-0 flex-col gap-2 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 break-all font-mono text-sm">{model.upstreamModelId}</span>
        <StatusPill tone="info">{t(`dashboard:models.type.${model.type}`)}</StatusPill>
        {model.price ? (
          <span className="text-xs text-muted-foreground">
            {t("dashboard:providers.price", {
              input: model.price.input,
              output: model.price.output,
              currency: model.price.currency,
            })}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("dashboard:providers.pricing.noActive")}
          </span>
        )}
        <Switch
          aria-label={t("dashboard:providers.enableModel", { model: model.upstreamModelId })}
          checked={model.enabled}
          disabled={update.isPending}
          onCheckedChange={(checked) =>
            action(() => update.mutateAsync({ modelId: model.id, enabled: checked === true }))
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="touch"
          aria-expanded={pricesOpen}
          onClick={() => setPricesOpen((open) => !open)}
        >
          {pricesOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          {t("dashboard:providers.pricing.toggle")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label={t("dashboard:providers.deleteModel", { model: model.upstreamModelId })}
          onClick={() => setDeleting(true)}
        >
          <Trash aria-hidden="true" />
        </Button>
      </div>
      {pricesOpen ? <ModelPricing model={model} /> : null}
      <ConfirmAction
        open={deleting}
        onOpenChange={setDeleting}
        title={t("dashboard:providers.deleteModelTitle", { model: model.upstreamModelId })}
        description={t("dashboard:providers.deleteModelHint")}
        confirmLabel={t("common:actions.delete")}
        isPending={remove.isPending}
        onConfirm={async () => {
          if (
            await action(
              () => remove.mutateAsync({ modelId: model.id }),
              t("dashboard:providers.modelDeleted"),
            )
          )
            setDeleting(false);
        }}
      />
    </li>
  );
}

function AddModelForm({ account }: { account: ProviderAccountDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const action = useProviderAction();
  const create = useMutation({
    ...orpc.providers.models.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: { upstreamModelId: "", type: "LLM" as ModelType, contextWindow: "" },
    validators: {
      onSubmit: z.object({
        upstreamModelId: z
          .string()
          .trim()
          .min(1, t("dashboard:providers.modelIdRequired"))
          .max(256),
        type: z.enum(MODEL_TYPES),
        contextWindow: z
          .string()
          .trim()
          .refine(
            (value) => value === "" || /^[1-9][0-9]{0,9}$/.test(value),
            t("dashboard:providers.contextWindowInvalid"),
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      const contextWindow = value.contextWindow.trim();
      const ok = await action(
        () =>
          create.mutateAsync({
            accountId: account.id,
            upstreamModelId: value.upstreamModelId.trim(),
            type: value.type,
            ...(contextWindow ? { contextWindow: Number(contextWindow) } : {}),
          }),
        t("dashboard:providers.modelAdded"),
      );
      if (ok) form.reset();
    },
  });
  return (
    <div className="flex min-w-0 flex-col gap-3 border-t pt-4">
      <p className="text-sm font-medium">{t("dashboard:providers.addModel")}</p>
      {account.providerType === "openrouter" ? (
        <CatalogSearch
          onPick={(model) => {
            form.setFieldValue("upstreamModelId", model.id);
            form.setFieldValue("type", model.type);
            form.setFieldValue(
              "contextWindow",
              model.contextWindow === null ? "" : String(model.contextWindow),
            );
          }}
        />
      ) : null}
      <form
        className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          form.handleSubmit().catch(() => undefined);
        }}
      >
        <form.Field name="upstreamModelId">
          {(field) => (
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="model-id">{t("dashboard:providers.modelId")}</Label>
              <Input
                id="model-id"
                className="h-11 font-mono"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="type">
          {(field) => (
            <div className="space-y-1.5 sm:w-48">
              <Label htmlFor="model-type">{t("dashboard:pool.form.type")}</Label>
              <NativeSelect
                id="model-type"
                value={field.state.value}
                onChange={(event) =>
                  field.handleChange(
                    MODEL_TYPES.find((value) => value === event.target.value) ?? "LLM",
                  )
                }
              >
                {MODEL_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(`dashboard:models.type.${value}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
        </form.Field>
        <form.Field name="contextWindow">
          {(field) => (
            <div className="space-y-1.5 sm:w-40">
              <Label htmlFor="model-context">{t("dashboard:providers.contextWindow")}</Label>
              <Input
                id="model-context"
                inputMode="numeric"
                className="h-11"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" size="touch" disabled={submitting}>
              {t("dashboard:pool.add")}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </div>
  );
}
