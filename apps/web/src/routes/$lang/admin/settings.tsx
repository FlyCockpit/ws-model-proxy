import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { Shield } from "lucide-react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/admin/settings")({
  component: AdminSettings,
});

function AdminSettings() {
  const { session } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const appSettings = useQuery(orpc.settings.getAll.queryOptions());
  const appConfig = useQuery(orpc.appConfig.queryOptions());
  const adminHas2FA = session.user.twoFactorEnabled === true;
  const { t } = useTranslation(["admin", "common"]);

  const updateSetting = useMutation({
    ...orpc.settings.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.settings.key() });
        queryClient.invalidateQueries({ queryKey: orpc.appConfig.queryKey() });
      },
    }),
    meta: { errorFallbackKey: "admin:settings.updateFailed" },
  });

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("admin:settings.title")}</h1>
        <p className="mt-2 text-muted-foreground">{t("admin:settings.description")}</p>
      </div>

      {appSettings.isPending || appConfig.isPending ? (
        <SettingsSkeleton />
      ) : appSettings.isError || appConfig.isError ? (
        <Card>
          <CardContent>
            <InlineRetry
              className="py-12"
              message={t("admin:settings.loadFailed")}
              onRetry={() => {
                appSettings.refetch();
                appConfig.refetch();
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <SecurityPolicyCard
          force2FA={appSettings.data.force2fa === "true"}
          signupEnabled={
            appSettings.data.signupEnabled === undefined
              ? appConfig.data.signupEnabled
              : appSettings.data.signupEnabled === "true"
          }
          adminHas2FA={adminHas2FA}
          isUpdating={updateSetting.isPending}
          onForce2FAToggle={(newValue) => {
            updateSetting.mutate(
              { key: "force2fa", value: newValue },
              {
                onSuccess: () => {
                  toast.success(
                    newValue === "true"
                      ? t("admin:settings.force2faEnabled")
                      : t("admin:settings.force2faDisabled"),
                  );
                },
              },
            );
          }}
          onSignupToggle={(newValue) => {
            updateSetting.mutate(
              { key: "signupEnabled", value: newValue },
              {
                onSuccess: () => {
                  toast.success(
                    newValue === "true"
                      ? t("admin:settings.signupEnabledToast")
                      : t("admin:settings.signupDisabledToast"),
                  );
                },
              },
            );
          }}
        />
      )}
    </div>
  );
}

function SecurityPolicyCard({
  force2FA,
  signupEnabled,
  adminHas2FA,
  isUpdating,
  onForce2FAToggle,
  onSignupToggle,
}: {
  force2FA: boolean;
  signupEnabled: boolean;
  adminHas2FA: boolean;
  isUpdating: boolean;
  onForce2FAToggle: (newValue: "true" | "false") => void;
  onSignupToggle: (newValue: "true" | "false") => void;
}) {
  const { t } = useTranslation("admin");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="size-5" />
          {t("settings.securityTitle")}
        </CardTitle>
        <CardDescription>{t("settings.securityDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <p className="font-medium">{t("settings.force2faTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("settings.force2faDescription")}</p>
            {!adminHas2FA && (
              <p className="text-sm text-destructive">{t("settings.force2faAdminWarning")}</p>
            )}
          </div>
          <Button
            variant={force2FA ? "destructive" : "default"}
            size="sm"
            className="min-h-[44px]"
            disabled={(!adminHas2FA && !force2FA) || isUpdating}
            onClick={() => onForce2FAToggle(force2FA ? "false" : "true")}
          >
            {isUpdating
              ? t("settings.updating")
              : force2FA
                ? t("settings.disable")
                : t("settings.enable")}
          </Button>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <p className="font-medium">{t("settings.signupTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("settings.signupDescription")}</p>
            <p className="text-sm text-muted-foreground">
              {signupEnabled
                ? t("settings.signupStatusEnabled")
                : t("settings.signupStatusDisabled")}
            </p>
          </div>
          <div className="flex min-h-[44px] min-w-[44px] items-center justify-center">
            <Switch
              checked={signupEnabled}
              disabled={isUpdating}
              aria-label={t("settings.signupSwitchLabel")}
              onCheckedChange={(checked) => onSignupToggle(checked ? "true" : "false")}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SettingsSkeleton() {
  const { t } = useTranslation("admin");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="size-5" />
          <span className="sr-only">{t("settings.securityTitle")}</span>
          <Skeleton className="h-5 w-32" />
        </CardTitle>
        <CardDescription>
          <Skeleton className="h-4 w-64" />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          <Skeleton className="h-9 w-20" />
        </div>
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className="h-11 w-11 rounded-full" />
        </div>
      </CardContent>
    </Card>
  );
}
