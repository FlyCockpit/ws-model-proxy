import { useForm } from "@tanstack/react-form";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
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
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { useNamespaceT } from "@/i18n/use-namespace-t";
import { authClient } from "@/lib/auth-client";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/settings/")({
  component: ProfileSettings,
});

function buildProfileSchema(t: TFunction<"settings">) {
  return z.object({
    name: z.string().min(2, t("profile.minLength")),
  });
}

function buildSlugSchema() {
  return z.object({
    slug: z.string().trim().min(1).max(80),
  });
}

function hasAdminRole(role: string | null | undefined): boolean {
  return (role ?? "")
    .split(",")
    .map((part) => part.trim())
    .includes("admin");
}

function ProfileSettings() {
  const { session } = Route.useRouteContext();
  const { t } = useTranslation(["settings", "auth", "common"]);
  const tSettings = useNamespaceT("settings");
  const queryClient = useQueryClient();
  const { data: notificationPrefsData, isPending: notificationPrefsIsPending } = useQuery(
    orpc.settings.myNotificationPreferences.queryOptions(),
  );
  const {
    data: profileSlugData,
    isPending: profileSlugIsPending,
    isError: profileSlugIsError,
    refetch: refetchProfileSlug,
  } = useQuery(orpc.forwarderManagement.getProfileSlug.queryOptions());
  const { mutate: updateNotificationPrefs, isPending: updateNotificationPrefsIsPending } =
    useMutation({
      ...orpc.settings.updateMyNotificationPreferences.mutationOptions({
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: orpc.settings.myNotificationPreferences.queryKey(),
          });
          toast.success(t("settings:profile.notificationsSaved"));
        },
        onError: () => {
          toast.error(t("settings:profile.notificationsSaveError"));
        },
      }),
      meta: { skipGlobalErrorToast: true },
    });
  const form = useForm({
    defaultValues: {
      name: session.user.name || "",
    },
    onSubmit: async ({ value }) => {
      const result = await authClient.updateUser({
        name: value.name,
      });
      if (result.error) {
        console.error("[settings.updateUser]", result.error);
        toast.error(friendly(result.error, t("settings:profile.saveError")));
        return;
      }
      toast.success(t("settings:profile.saved"));
    },
    validators: {
      onSubmit: buildProfileSchema(tSettings),
    },
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
              <Label>{t("auth:fields.email")}</Label>
              <Input value={session.user.email} disabled />
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
                <Button type="submit" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? t("common:actions.saving") : t("common:actions.saveChanges")}
                </Button>
              )}
            </form.Subscribe>
          </form>

          {hasAdminRole(session.user.role) ? (
            <div className="mt-6 border-t pt-6">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="operational-alerts"
                  checked={notificationPrefsData?.operationalAlerts ?? true}
                  disabled={notificationPrefsIsPending || updateNotificationPrefsIsPending}
                  onCheckedChange={(checked) => {
                    updateNotificationPrefs({ operationalAlerts: checked === true });
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
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings:profile.slugTitle")}</CardTitle>
          <CardDescription>{t("settings:profile.slugDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {profileSlugIsPending ? (
            <div className="space-y-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-11 w-full" />
            </div>
          ) : profileSlugIsError ? (
            <InlineRetry
              message={t("settings:profile.slugLoadFailed")}
              onRetry={() => refetchProfileSlug()}
            />
          ) : (
            <SlugChangePanel key={profileSlugData.slug} currentSlug={profileSlugData.slug} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SlugChangePanel({ currentSlug }: { currentSlug: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const [previewSlug, setPreviewSlug] = useState<string | null>(null);
  const {
    data: slugPreviewData,
    isPending: slugPreviewIsPending,
    isError: slugPreviewIsError,
    refetch: refetchSlugPreview,
  } = useQuery(
    orpc.forwarderManagement.previewProfileSlugChange.queryOptions({
      input: previewSlug ? { slug: previewSlug } : skipToken,
    }),
  );
  const updateSlug = useMutation(
    orpc.forwarderManagement.updateProfileSlug.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("settings:profile.slugSaved"));
        setPreviewSlug(null);
      },
    }),
  );
  const slugForm = useForm({
    defaultValues: {
      slug: currentSlug,
    },
    validators: {
      onSubmit: buildSlugSchema(),
    },
    onSubmit: async ({ value }) => {
      setPreviewSlug(value.slug.trim());
    },
  });

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          slugForm.handleSubmit();
        }}
        className="space-y-4"
      >
        <slugForm.Field name="slug">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor={field.name}>{t("settings:profile.slug")}</Label>
              <Input
                id={field.name}
                name={field.name}
                inputMode="text"
                autoComplete="off"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => {
                  setPreviewSlug(null);
                  field.handleChange(e.target.value);
                }}
              />
              {field.state.meta.errors.map((error) => (
                <p key={error?.message} className="text-sm text-destructive">
                  {error?.message}
                </p>
              ))}
            </div>
          )}
        </slugForm.Field>
        <slugForm.Subscribe
          selector={(state) => ({
            canSubmit: state.canSubmit,
            isSubmitting: state.isSubmitting,
          })}
        >
          {({ canSubmit, isSubmitting }) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {t("settings:profile.previewSlug")}
            </Button>
          )}
        </slugForm.Subscribe>
      </form>

      {slugPreviewIsPending ? (
        <Skeleton className="h-24 w-full" />
      ) : slugPreviewIsError ? (
        <InlineRetry
          variant="destructive"
          message={t("settings:profile.slugPreviewFailed")}
          onRetry={() => refetchSlugPreview()}
        />
      ) : slugPreviewData ? (
        <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-destructive">
                {t("settings:profile.slugWarningTitle")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("settings:profile.slugWarningDescription")}
              </p>
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto rounded border bg-background">
            {slugPreviewData.affectedModels.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                {t("settings:profile.noAffectedModels")}
              </p>
            ) : (
              slugPreviewData.affectedModels.map((model) => (
                <div key={`${model.kind}-${model.id}`} className="border-b p-3 last:border-b-0">
                  <p className="text-xs font-medium">{model.kind}</p>
                  <code className="block break-all font-mono text-xs text-muted-foreground">
                    {model.currentModelId}
                  </code>
                  <code className="mt-1 block break-all font-mono text-xs">
                    {model.nextModelId}
                  </code>
                </div>
              ))
            )}
          </div>
          <Button
            type="button"
            variant="destructive"
            disabled={updateSlug.isPending}
            onClick={() => updateSlug.mutate({ slug: slugPreviewData.nextSlug })}
          >
            {updateSlug.isPending ? t("common:actions.saving") : t("settings:profile.saveSlug")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
