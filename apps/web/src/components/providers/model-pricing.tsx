import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmAction } from "@/components/access/confirm-action";
import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { type PillTone, StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

import { type ProviderModel, useProviderAction } from "./provider-action";

type PriceVersion = Awaited<
  ReturnType<AppRouterClient["providers"]["pricing"]["list"]>
>["versions"][number];

const MONEY = /^(0|[1-9][0-9]{0,20})(\.[0-9]{1,9})?$/;
/** Per-million-token rates the editor offers; input and output are required by the server. */
const RATES = ["input", "output", "cacheRead", "cacheWrite"] as const;
const STATUS_TONE: Record<PriceVersion["status"], PillTone> = {
  DRAFT: "muted",
  ACTIVE: "good",
  RETIRED: "muted",
};

/**
 * Price versions of one provider model (people only): add a draft, activate it (the active
 * one retires when it starts), retire the active one, delete a draft.
 */
export function ModelPricing({ model }: { model: ProviderModel }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const versions = useQuery(
    orpc.providers.pricing.list.queryOptions({ input: { modelId: model.id } }),
  );
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border p-3">
      <p className="text-sm font-medium">
        {t("dashboard:providers.pricing.title", { model: model.upstreamModelId })}
      </p>
      {versions.isPending ? (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : versions.isError ? (
        <InlineRetry
          message={t("dashboard:providers.pricing.loadFailed")}
          onRetry={() => versions.refetch()}
        />
      ) : versions.data.versions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("dashboard:providers.pricing.none")}</p>
      ) : (
        <ul className="flex min-w-0 flex-col divide-y">
          {versions.data.versions.map((version) => (
            <PriceVersionRow key={version.id} version={version} />
          ))}
        </ul>
      )}
      <NewPriceForm model={model} />
    </div>
  );
}

function PriceVersionRow({ version }: { version: PriceVersion }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const action = useProviderAction();
  const [confirm, setConfirm] = useState<"retire" | "delete" | null>(null);
  const activate = useMutation({
    ...orpc.providers.pricing.activate.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const retire = useMutation({
    ...orpc.providers.pricing.retire.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const remove = useMutation({
    ...orpc.providers.pricing.delete.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  // Known rates by name; any other key a catalog price carries is shown as written.
  const known: readonly string[] = RATES;
  const rates = [
    ...RATES.flatMap((rate) =>
      version.pricing[rate] === undefined
        ? []
        : [t(`dashboard:providers.pricing.rateValue.${rate}`, { value: version.pricing[rate] })],
    ),
    ...Object.entries(version.pricing)
      .filter(([key]) => !known.includes(key))
      .map(([key, value]) => `${key} ${value}`),
  ];
  return (
    <li className="flex min-w-0 flex-col gap-2 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{version.version}</span>
        <StatusPill tone={STATUS_TONE[version.status]}>
          {t(`dashboard:providers.pricing.status.${version.status}`)}
        </StatusPill>
        <span className="min-w-0 break-words text-xs text-muted-foreground">
          {rates.join(" · ")} {version.currency}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("dashboard:providers.pricing.effective")} <TimeAgo value={version.effectiveAt} />
      </p>
      {version.status !== "RETIRED" ? (
        <div className="flex flex-wrap gap-2">
          {version.status === "DRAFT" ? (
            <>
              <Button
                type="button"
                size="touch"
                variant="outline"
                disabled={activate.isPending}
                onClick={() =>
                  action(
                    () => activate.mutateAsync({ versionId: version.id }),
                    t("dashboard:providers.pricing.activated"),
                  )
                }
              >
                {t("dashboard:providers.pricing.activate")}
              </Button>
              <Button
                type="button"
                size="touch"
                variant="ghost"
                onClick={() => setConfirm("delete")}
              >
                {t("common:actions.delete")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="touch"
              variant="outline"
              onClick={() => setConfirm("retire")}
            >
              {t("dashboard:providers.pricing.retire")}
            </Button>
          )}
        </div>
      ) : null}
      <ConfirmAction
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={
          confirm === "retire"
            ? t("dashboard:providers.pricing.retireTitle", { version: version.version })
            : t("dashboard:providers.pricing.deleteTitle", { version: version.version })
        }
        description={
          confirm === "retire"
            ? t("dashboard:providers.pricing.retireHint")
            : t("dashboard:providers.pricing.deleteHint")
        }
        confirmLabel={
          confirm === "retire"
            ? t("dashboard:providers.pricing.retire")
            : t("common:actions.delete")
        }
        isPending={retire.isPending || remove.isPending}
        onConfirm={async () => {
          const ok =
            confirm === "retire"
              ? await action(() => retire.mutateAsync({ versionId: version.id }))
              : await action(() => remove.mutateAsync({ versionId: version.id }));
          if (ok) setConfirm(null);
        }}
      />
    </li>
  );
}

function NewPriceForm({ model }: { model: ProviderModel }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const action = useProviderAction();
  const create = useMutation({
    ...orpc.providers.pricing.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const money = z.string().trim().regex(MONEY, t("dashboard:providers.pricing.rateInvalid"));
  const optionalMoney = z
    .string()
    .trim()
    .refine(
      (value) => value === "" || MONEY.test(value),
      t("dashboard:providers.pricing.rateInvalid"),
    );
  const form = useForm({
    defaultValues: {
      currency: model.price?.currency ?? "USD",
      input: "",
      output: "",
      cacheRead: "",
      cacheWrite: "",
    },
    validators: {
      onSubmit: z.object({
        currency: z
          .string()
          .trim()
          .regex(/^[A-Z]{3}$/, t("dashboard:providers.pricing.currencyInvalid")),
        input: money,
        output: money,
        cacheRead: optionalMoney,
        cacheWrite: optionalMoney,
      }),
    },
    onSubmit: async ({ value }) => {
      const pricing = Object.fromEntries(
        RATES.flatMap((rate) => (value[rate].trim() === "" ? [] : [[rate, value[rate].trim()]])),
      );
      const ok = await action(
        () => create.mutateAsync({ modelId: model.id, currency: value.currency.trim(), pricing }),
        t("dashboard:providers.pricing.draftAdded"),
      );
      if (ok) form.reset();
    },
  });
  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit().catch(() => undefined);
      }}
    >
      <p className="text-xs text-muted-foreground">{t("dashboard:providers.pricing.newHint")}</p>
      <div className="grid min-w-0 gap-2 sm:grid-cols-5">
        {RATES.map((rate) => (
          <form.Field key={rate} name={rate}>
            {(field) => (
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`price-${model.id}-${rate}`} className="text-xs">
                  {t(`dashboard:providers.pricing.rate.${rate}`)}
                </Label>
                <Input
                  id={`price-${model.id}-${rate}`}
                  inputMode="decimal"
                  className="h-11"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldErrors field={field} />
              </div>
            )}
          </form.Field>
        ))}
        <form.Field name="currency">
          {(field) => (
            <div className="min-w-0 space-y-1">
              <Label htmlFor={`price-${model.id}-currency`} className="text-xs">
                {t("dashboard:providers.pricing.currency")}
              </Label>
              <Input
                id={`price-${model.id}-currency`}
                className="h-11 font-mono uppercase"
                maxLength={3}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value.toUpperCase())}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
      </div>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(submitting) => (
          <Button
            type="submit"
            size="touch"
            variant="outline"
            className="self-start"
            disabled={submitting}
          >
            {t("dashboard:providers.pricing.addDraft")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
