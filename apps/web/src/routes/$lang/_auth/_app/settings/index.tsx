import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import z from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { useAuthSession } from "@/hooks/use-auth-session";
import { isSupportedLocale, type Locale, SUPPORTED_LOCALES } from "@/i18n/config";
import { LOCALE_LABELS } from "@/i18n/labels";
import { useNamespaceT } from "@/i18n/use-namespace-t";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/settings/")({
  component: ProfileSettings,
});

function buildProfileSchema(t: TFunction<"settings">) {
  return z.object({
    name: z.string().trim().min(2, t("profile.minLength")).max(200),
  });
}

function ProfileSettings() {
  const { t } = useTranslation(["settings", "auth", "common"]);
  const settings = useQuery(orpc.settings.get.queryOptions());

  if (settings.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }
  if (settings.isError) {
    return (
      <InlineRetry message={t("settings:profile.loadFailed")} onRetry={() => settings.refetch()} />
    );
  }
  return <ProfileForm settings={settings.data} />;
}

type UserSettings = {
  name: string;
  email: string;
  slug: string;
  locale: Locale;
  operationalAlerts: boolean;
};

function ProfileForm({ settings }: { settings: UserSettings }) {
  const { t } = useTranslation(["settings", "auth", "common"]);
  const tSettings = useNamespaceT("settings");
  const queryClient = useQueryClient();
  const update = useMutation({
    ...orpc.settings.update.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(orpc.settings.get.queryKey(), next);
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });

  const form = useForm({
    defaultValues: { name: settings.name },
    onSubmit: async ({ value }) => {
      try {
        await update.mutateAsync({ name: value.name.trim() });
        toast.success(t("settings:profile.saved"));
      } catch (error) {
        console.error("[settings.update]", error);
        toast.error(t("settings:profile.saveError"));
      }
    },
    validators: { onSubmit: buildProfileSchema(tSettings) },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("settings:profile.title")}</CardTitle>
          <CardDescription>{t("settings:profile.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="settings-email">{t("auth:fields.email")}</Label>
              <Input id="settings-email" value={settings.email} disabled />
              <p className="text-xs text-muted-foreground">{t("settings:profile.emailReadonly")}</p>
            </div>

            <form.Field name="name">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor={field.name}>{t("auth:fields.name")}</Label>
                  <Input
                    id={field.name}
                    name={field.name}
                    autoComplete="name"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  {field.state.meta.errors.map((error) => (
                    <p key={error?.message} className="text-sm text-destructive">
                      {error?.message}
                    </p>
                  ))}
                </div>
              )}
            </form.Field>

            <form.Subscribe
              selector={(state) => ({
                canSubmit: state.canSubmit,
                isSubmitting: state.isSubmitting,
              })}
            >
              {({ canSubmit, isSubmitting }) => (
                <Button type="submit" size="touch" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? t("common:actions.saving") : t("common:actions.saveChanges")}
                </Button>
              )}
            </form.Subscribe>
          </form>

          <div className="mt-6 border-t pt-6">
            <div className="flex items-start gap-3">
              <Checkbox
                id="operational-alerts"
                checked={settings.operationalAlerts}
                disabled={update.isPending}
                onCheckedChange={(checked) => {
                  update.mutate(
                    { operationalAlerts: checked === true },
                    {
                      onSuccess: () => toast.success(t("settings:profile.notificationsSaved")),
                      onError: () => toast.error(t("settings:profile.notificationsSaveError")),
                    },
                  );
                }}
              />
              <div className="space-y-1">
                <Label htmlFor="operational-alerts">
                  {t("settings:profile.operationalAlerts")}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t("settings:profile.operationalAlertsDescription")}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <LocaleCard locale={settings.locale} />

      <Card>
        <CardHeader>
          <CardTitle>{t("settings:profile.slugTitle")}</CardTitle>
          <CardDescription>{t("settings:profile.slugDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <code className="block break-all rounded-md bg-muted px-3 py-2 font-mono text-sm">
            {settings.slug}
          </code>
        </CardContent>
      </Card>
    </div>
  );
}

/** The saved UI language: it follows the account to other devices; this page switches now. */
function LocaleCard({ locale }: { locale: Locale }) {
  const { t, i18n } = useTranslation(["settings"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { actions: session } = useAuthSession();
  const update = useMutation({
    ...orpc.settings.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const choose = async (next: string) => {
    if (!isSupportedLocale(next) || next === locale) return;
    try {
      const saved = await update.mutateAsync({ locale: next });
      queryClient.setQueryData(orpc.settings.get.queryKey(), saved);
      // The session carries user.locale too (the header switcher compares against it).
      void session.refetch();
      try {
        window.localStorage.setItem("locale", next);
      } catch {
        // Storage can be unavailable (private mode); the saved account locale still applies.
      }
      void i18n.changeLanguage(next);
      await navigate({ to: "/$lang/settings", params: { lang: next }, replace: true });
      toast.success(t("settings:locale.saved"));
    } catch (error) {
      console.error("[settings.update locale]", error);
      toast.error(t("settings:locale.saveError"));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings:locale.title")}</CardTitle>
        <CardDescription>{t("settings:locale.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label htmlFor="settings-locale">{t("settings:locale.label")}</Label>
        <NativeSelect
          id="settings-locale"
          className="sm:max-w-xs"
          value={locale}
          disabled={update.isPending}
          onChange={(event) => void choose(event.target.value)}
        >
          {SUPPORTED_LOCALES.map((value) => (
            <option key={value} value={value}>
              {LOCALE_LABELS[value]}
            </option>
          ))}
        </NativeSelect>
      </CardContent>
    </Card>
  );
}
