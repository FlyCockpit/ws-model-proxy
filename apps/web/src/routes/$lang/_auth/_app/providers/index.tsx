import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { PageHeading } from "@/components/page-stub";
import { StatusPill } from "@/components/status-pill";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/providers/")({
  component: ProvidersPage,
});

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function ProvidersPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const accounts = useQuery(orpc.providers.accounts.list.queryOptions());
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <PageHeading page="providers" />
        <Button size="touch" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          {t("dashboard:providers.add")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("dashboard:providers.humanOnly")}</p>
      {accounts.isPending ? (
        <div className="grid gap-3 md:grid-cols-2" aria-hidden="true">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      ) : accounts.isError ? (
        <InlineRetry
          message={t("dashboard:providers.loadFailed")}
          onRetry={() => accounts.refetch()}
        />
      ) : accounts.data.accounts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("dashboard:providers.emptyTitle")}</CardTitle>
            <CardDescription>{t("dashboard:providers.emptyHint")}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ul className="grid min-w-0 gap-3 md:grid-cols-2">
          {accounts.data.accounts.map((account) => (
            <li key={account.id} className="min-w-0">
              <Card className="h-full">
                <CardHeader>
                  <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 text-base">
                    <Link
                      to="/$lang/providers/$accountId"
                      params={{ lang, accountId: account.id }}
                      className="inline-flex min-h-11 items-center break-all underline-offset-4 hover:underline"
                    >
                      {account.label}
                    </Link>
                    <StatusPill tone={account.enabled ? "good" : "muted"}>
                      {account.enabled ? t("dashboard:providers.on") : t("dashboard:providers.off")}
                    </StatusPill>
                    <StatusPill tone="info">
                      {t(`dashboard:providers.health.${account.health}`)}
                    </StatusPill>
                  </CardTitle>
                  <CardDescription className="break-all">{account.baseUrl}</CardDescription>
                </CardHeader>
                <CardContent className="text-sm">
                  {account.spend.monthlyLimit === null
                    ? t("dashboard:providers.spentNoCap", {
                        spent: account.spend.spentThisMonth,
                        currency: account.spend.currency,
                      })
                    : t("dashboard:providers.spentOfCap", {
                        spent: account.spend.spentThisMonth,
                        cap: account.spend.monthlyLimit,
                        currency: account.spend.currency,
                      })}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <AddAccountDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function AddAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useMutation({
    ...orpc.providers.accounts.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: {
      providerType: "openrouter" as "openrouter" | "generic",
      label: "OpenRouter",
      baseUrl: OPENROUTER_BASE_URL,
      authType: "BEARER" as "BEARER" | "API_KEY",
      secret: "",
      allowDataCollection: false,
    },
    validators: {
      onSubmit: z.object({
        providerType: z.enum(["openrouter", "generic"]),
        label: z.string().trim().min(1, t("dashboard:providers.form.labelRequired")).max(120),
        baseUrl: z.string().url(t("dashboard:providers.form.baseUrlInvalid")),
        authType: z.enum(["BEARER", "API_KEY"]),
        secret: z.string().min(1, t("dashboard:providers.form.keyRequired")).max(4_096),
        allowDataCollection: z.boolean(),
      }),
    },
    onSubmit: async ({ value }) => {
      try {
        const account = await create.mutateAsync({ ...value, label: value.label.trim() });
        await queryClient.invalidateQueries({ queryKey: orpc.providers.key() });
        toast.success(t("dashboard:providers.added"));
        onOpenChange(false);
        form.reset();
        await navigate({
          to: "/$lang/providers/$accountId",
          params: { lang, accountId: account.id },
        });
      } catch (error) {
        toast.error(refusalText(error));
      }
    },
  });
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("dashboard:providers.add")}
      description={t("dashboard:providers.addHint")}
    >
      <form
        className="flex flex-col gap-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          form.handleSubmit();
        }}
      >
        <form.Field name="providerType">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="provider-type">{t("dashboard:providers.form.type")}</Label>
              <NativeSelect
                id="provider-type"
                value={field.state.value}
                onChange={(event) => {
                  const type = event.target.value === "generic" ? "generic" : "openrouter";
                  field.handleChange(type);
                  if (type === "openrouter") form.setFieldValue("baseUrl", OPENROUTER_BASE_URL);
                }}
              >
                <option value="openrouter">OpenRouter</option>
                <option value="generic">{t("dashboard:providers.form.generic")}</option>
              </NativeSelect>
            </div>
          )}
        </form.Field>
        <form.Field name="label">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="provider-label">{t("dashboard:providers.form.label")}</Label>
              <Input
                id="provider-label"
                className="h-11"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="baseUrl">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="provider-url">{t("dashboard:providers.form.baseUrl")}</Label>
              <Input
                id="provider-url"
                className="h-11 font-mono"
                inputMode="url"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="authType">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="provider-auth">{t("dashboard:providers.form.auth")}</Label>
              <NativeSelect
                id="provider-auth"
                value={field.state.value}
                onChange={(event) =>
                  field.handleChange(event.target.value === "API_KEY" ? "API_KEY" : "BEARER")
                }
              >
                <option value="BEARER">{t("dashboard:providers.form.bearer")}</option>
                <option value="API_KEY">{t("dashboard:providers.form.apiKey")}</option>
              </NativeSelect>
            </div>
          )}
        </form.Field>
        <form.Field name="secret">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="provider-secret">{t("dashboard:providers.form.key")}</Label>
              <Input
                id="provider-secret"
                type="password"
                autoComplete="off"
                className="h-11 font-mono"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="allowDataCollection">
          {(field) => (
            <div className="flex min-h-11 items-center gap-3">
              <Checkbox
                id="provider-collection"
                checked={field.state.value}
                onCheckedChange={(checked) => field.handleChange(checked === true)}
              />
              <Label htmlFor="provider-collection">
                {t("dashboard:providers.form.dataCollection")}
              </Label>
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" size="touch" disabled={submitting}>
              {submitting ? t("common:actions.saving") : t("dashboard:providers.addButton")}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </ResponsiveDialog>
  );
}
