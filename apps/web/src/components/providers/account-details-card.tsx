import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ws-model-proxy/ui/components/card";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { FieldErrors } from "@/components/field-errors";
import { orpc } from "@/utils/orpc";

import { type ProviderAccountDetail, useProviderAction } from "./provider-action";

/** Rename the account or move it to another base URL (providers.accounts.update). */
export function AccountDetailsCard({ account }: { account: ProviderAccountDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const action = useProviderAction();
  const update = useMutation({
    ...orpc.providers.accounts.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: { label: account.label, baseUrl: account.baseUrl },
    validators: {
      onSubmit: z.object({
        label: z.string().trim().min(1, t("dashboard:providers.form.labelRequired")).max(120),
        baseUrl: z
          .string()
          .url(t("dashboard:providers.form.baseUrlInvalid"))
          .startsWith("https://", t("dashboard:providers.form.baseUrlInvalid"))
          .max(2_048),
      }),
    },
    onSubmit: async ({ value }) => {
      const label = value.label.trim();
      const baseUrl = value.baseUrl.trim();
      if (label === account.label && baseUrl === account.baseUrl) return;
      await action(() =>
        update.mutateAsync({
          accountId: account.id,
          ...(label !== account.label ? { label } : {}),
          ...(baseUrl !== account.baseUrl ? { baseUrl } : {}),
        }),
      );
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:providers.details")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit().catch(() => undefined);
          }}
        >
          <form.Field name="label">
            {(field) => (
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="account-label">{t("dashboard:providers.form.label")}</Label>
                <Input
                  id="account-label"
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
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="account-base-url">{t("dashboard:providers.form.baseUrl")}</Label>
                <Input
                  id="account-base-url"
                  className="h-11 font-mono"
                  inputMode="url"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldErrors field={field} />
              </div>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => [state.isSubmitting, state.isDirty] as const}>
            {([submitting, dirty]) => (
              <Button
                type="submit"
                size="touch"
                className="self-start"
                disabled={submitting || !dirty}
              >
                {submitting ? t("common:actions.saving") : t("common:actions.save")}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  );
}
