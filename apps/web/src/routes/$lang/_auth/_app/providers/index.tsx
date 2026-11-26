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
import { AdvancedSection } from "@ws-model-proxy/ui/components/form-page";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { Plus } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";
import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
import { StatusPill } from "@/components/status-pill";
import { SwitchRow } from "@/components/switch-row";
import { focusFirstInvalid } from "@/lib/form-focus";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/providers/")({
  staticData: { pendingShape: "list" },
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

/** The Add account form: on success it closes the dialog and opens the new account. */
function useAddAccountForm(onAdded: () => void) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useMutation({
    ...orpc.providers.accounts.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const testKey = useMutation({
    ...orpc.providers.credentials.test.mutationOptions(),
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
        baseUrl: z
          .string()
          .url(t("dashboard:providers.form.baseUrlInvalid"))
          .startsWith("https://", t("dashboard:providers.form.baseUrlInvalid")),
        authType: z.enum(["BEARER", "API_KEY"]),
        secret: z.string().min(1, t("dashboard:providers.form.keyRequired")).max(4_096),
        allowDataCollection: z.boolean(),
      }),
    },
    onSubmit: async ({ value }) => {
      try {
        const account = await create.mutateAsync({
          ...value,
          label: value.label.trim(),
          allowDataCollection: value.providerType === "openrouter" && value.allowDataCollection,
        });
        await queryClient.invalidateQueries({ queryKey: orpc.providers.key() });
        // Check the key at once, so a mistyped or revoked key is known before the account is
        // turned on. The account is added either way.
        const probe = await testKey.mutateAsync({ accountId: account.id }).catch(() => null);
        if (probe?.ok) toast.success(t("dashboard:providers.addedKeyOk"));
        else {
          const code = probe ? (probe.detail ?? "unexpected_status") : "unexpected_status";
          toast.warning(
            t("dashboard:providers.addedKeyFailed", {
              result: t(`dashboard:providers.testResult.${code}`, {
                defaultValue: t("dashboard:providers.testResult.unexpected_status"),
              }),
              next: t(`dashboard:providers.testNext.${code}`, {
                defaultValue: t("dashboard:providers.testNext.unexpected_status"),
              }),
            }),
          );
        }
        onAdded();
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
  return form;
}

function AddAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const formId = useId();
  const form = useAddAccountForm(() => onOpenChange(false));
  const submit = async () => {
    await form.handleSubmit();
    // Errors show next to their fields; focus moves to the first one (opening Connection details
    // when the base URL is the problem).
    if (!form.state.isValid) focusFirstInvalid(document.getElementById(formId));
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        // Never keep a pasted key around after the dialog closes.
        if (!next) form.reset();
        onOpenChange(next);
      }}
      title={t("dashboard:providers.add")}
      description={t("dashboard:providers.addHint")}
      footer={
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <div className="flex min-w-0 flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="touch"
                disabled={submitting}
                onClick={() => {
                  form.reset();
                  onOpenChange(false);
                }}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button type="submit" form={formId} size="touch" disabled={submitting}>
                {submitting ? t("common:actions.saving") : t("dashboard:providers.addButton")}
              </Button>
            </div>
          )}
        </form.Subscribe>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex min-w-0 flex-col gap-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }}
      >
        <form.Field name="providerType">
          {(field) => (
            <div className="min-w-0 space-y-1.5">
              <p id="provider-type-label" className="text-sm font-medium">
                {t("dashboard:providers.form.type")}
              </p>
              <SegmentedControl
                ariaLabel={t("dashboard:providers.form.type")}
                value={field.state.value}
                onChange={(type) => {
                  field.handleChange(type);
                  if (type === "openrouter") {
                    form.setFieldValue("baseUrl", OPENROUTER_BASE_URL);
                    form.setFieldValue("authType", "BEARER");
                    if (form.getFieldValue("label") === "")
                      form.setFieldValue("label", "OpenRouter");
                  } else {
                    // Don't leave OpenRouter's defaults on an OpenAI-compatible account.
                    if (form.getFieldValue("baseUrl") === OPENROUTER_BASE_URL)
                      form.setFieldValue("baseUrl", "");
                    if (form.getFieldValue("label") === "OpenRouter")
                      form.setFieldValue("label", "");
                  }
                }}
                items={[
                  { value: "openrouter", label: "OpenRouter" },
                  { value: "generic", label: t("dashboard:providers.form.generic") },
                ]}
              />
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
                aria-invalid={field.state.meta.errors.length > 0 || undefined}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.providerType}>
          {(providerType) => (providerType === "generic" ? <ConnectionFields form={form} /> : null)}
        </form.Subscribe>
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
                aria-invalid={field.state.meta.errors.length > 0 || undefined}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Subscribe
          selector={(state) =>
            [state.values.providerType, state.values.authType, state.values.baseUrl] as const
          }
        >
          {([providerType, authType, baseUrl]) =>
            // Only OpenRouter routes by data policy; other providers ignore the setting.
            providerType === "openrouter" ? (
              <>
                <form.Field name="allowDataCollection">
                  {(field) => (
                    <SwitchRow
                      id="provider-collection"
                      label={t("dashboard:providers.form.dataCollection")}
                      description={t("dashboard:providers.form.dataCollectionHint")}
                      checked={field.state.value}
                      onChange={field.handleChange}
                    />
                  )}
                </form.Field>
                <AdvancedSection
                  gridClassName="lg:grid-cols-1"
                  title={t("dashboard:providers.form.connection")}
                  summary={t("dashboard:providers.form.connectionSummary", {
                    url: baseUrl,
                    auth:
                      authType === "API_KEY"
                        ? t("dashboard:providers.form.apiKey")
                        : t("dashboard:providers.form.bearer"),
                  })}
                >
                  <ConnectionFields form={form} />
                </AdvancedSection>
              </>
            ) : null
          }
        </form.Subscribe>
      </form>
    </ResponsiveDialog>
  );
}

type AddAccountForm = ReturnType<typeof useAddAccountForm>;

/** Base URL and key type: shown for any OpenAI-compatible account, folded away for OpenRouter. */
function ConnectionFields({ form }: { form: AddAccountForm }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <>
      <form.Field name="baseUrl">
        {(field) => (
          <div className="space-y-1.5">
            <Label htmlFor="provider-url">{t("dashboard:providers.form.baseUrl")}</Label>
            <Input
              id="provider-url"
              className="h-11 font-mono"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://api.example.com/v1"
              value={field.state.value}
              aria-invalid={field.state.meta.errors.length > 0 || undefined}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <FieldErrors field={field} />
          </div>
        )}
      </form.Field>
      <form.Field name="authType">
        {(field) => (
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium">{t("dashboard:providers.form.auth")}</p>
            <SegmentedControl
              ariaLabel={t("dashboard:providers.form.auth")}
              value={field.state.value}
              onChange={field.handleChange}
              items={[
                { value: "BEARER", label: t("dashboard:providers.form.bearer") },
                { value: "API_KEY", label: t("dashboard:providers.form.apiKey") },
              ]}
            />
          </div>
        )}
      </form.Field>
    </>
  );
}
