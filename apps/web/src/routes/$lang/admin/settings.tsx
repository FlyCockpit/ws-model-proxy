import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "@ws-model-proxy/env/web";
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
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { HardDrive, Shield, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/admin/settings")({
  component: AdminSettings,
});

// --- Admin media policy endpoints (plain Hono routes, verified-admin gated) ---
// Fetched in the same raw-fetch style as chat-test's media routes. Metadata /
// policy only: the responses never carry ids, owners, or content URLs.

type MediaAdminStats = {
  uploadEnabled: boolean;
  ttl: { hours: number; min: number; max: number; default: number };
  stats: { assetCount: number; totalBytes: number; expiredCount: number };
};

const MEDIA_STATS_QUERY_KEY = ["admin", "media-stats"] as const;

async function fetchMediaAdminStats(signal: AbortSignal): Promise<MediaAdminStats> {
  const response = await fetch(`${env.VITE_SERVER_URL}/api/internal/media/admin/stats`, {
    credentials: "include",
    signal,
  });
  if (!response.ok) throw new Error(`media stats request failed: ${response.status}`);
  return (await response.json()) as MediaAdminStats;
}

type MediaActionResult = { removed: number; bytes?: number };

async function postMediaAdminAction(
  path: "purge-expired" | "delete-all",
): Promise<MediaActionResult> {
  const response = await fetch(`${env.VITE_SERVER_URL}/api/internal/media/admin/${path}`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw new Error(`media action failed: ${response.status}`);
  return (await response.json()) as MediaActionResult;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const rounded = exponent === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[exponent]}`;
}

function AdminSettings() {
  const { session } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const appSettings = useQuery(orpc.settings.getAll.queryOptions());
  const appConfig = useQuery(orpc.appConfig.queryOptions());
  const mediaStats = useQuery({
    queryKey: MEDIA_STATS_QUERY_KEY,
    queryFn: ({ signal }) => fetchMediaAdminStats(signal),
  });
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

      {mediaStats.isPending ? (
        <MediaPolicySkeleton />
      ) : mediaStats.isError ? (
        <Card>
          <CardContent>
            <InlineRetry
              className="py-12"
              message={t("admin:settings.media.loadFailed")}
              onRetry={() => mediaStats.refetch()}
            />
          </CardContent>
        </Card>
      ) : (
        <MediaPolicyCard data={mediaStats.data} />
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

function MediaPolicyCard({ data }: { data: MediaAdminStats }) {
  const queryClient = useQueryClient();
  const { t } = useTranslation(["admin", "common"]);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);

  const invalidateStats = () => {
    queryClient.invalidateQueries({ queryKey: MEDIA_STATS_QUERY_KEY });
  };

  const updateTtl = useMutation({
    ...orpc.settings.update.mutationOptions({ onSuccess: invalidateStats }),
    meta: { errorFallbackKey: "admin:settings.updateFailed" },
  });

  const purgeExpired = useMutation({
    mutationFn: () => postMediaAdminAction("purge-expired"),
    onSuccess: (result) => {
      invalidateStats();
      toast.success(t("admin:settings.media.purgeToast", { count: result.removed }));
    },
    onError: () => toast.error(t("admin:settings.media.actionFailed")),
  });

  const deleteAll = useMutation({
    mutationFn: () => postMediaAdminAction("delete-all"),
    onSuccess: (result) => {
      invalidateStats();
      setDeleteAllOpen(false);
      toast.success(t("admin:settings.media.deleteAllToast", { count: result.removed }));
    },
    onError: () => toast.error(t("admin:settings.media.actionFailed")),
  });

  const { ttl, stats } = data;
  const ttlFieldId = useId();

  const ttlForm = useForm({
    defaultValues: { hours: String(ttl.hours) },
    validators: {
      onChange: z.object({
        hours: z
          .string()
          .refine((v) => /^\d+$/.test(v.trim()), t("admin:settings.media.ttlInvalid"))
          .refine(
            (v) => {
              const n = Number(v);
              return n >= ttl.min && n <= ttl.max;
            },
            t("admin:settings.media.ttlRange", { min: ttl.min, max: ttl.max }),
          ),
      }),
    },
    onSubmit: ({ value }) => {
      updateTtl.mutate(
        { key: "mediaAssetTtlHours", value: Number(value.hours) },
        {
          onSuccess: () => toast.success(t("admin:settings.media.ttlSavedToast")),
        },
      );
    },
  });

  const actionsDisabled = !data.uploadEnabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-5" />
          {t("admin:settings.media.title")}
        </CardTitle>
        <CardDescription>{t("admin:settings.media.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Upload capability (read-only, from deploy env) */}
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <p className="font-medium">{t("admin:settings.media.uploadStatusTitle")}</p>
            <p className="text-sm text-muted-foreground">
              {data.uploadEnabled
                ? t("admin:settings.media.uploadStatusEnabled")
                : t("admin:settings.media.uploadStatusDisabled")}
            </p>
          </div>
        </div>

        {/* Editable TTL */}
        <div className="space-y-3 rounded-lg border p-4">
          <div className="space-y-1">
            <p className="font-medium">{t("admin:settings.media.ttlTitle")}</p>
            <p className="text-sm text-muted-foreground">
              {t("admin:settings.media.ttlDescription")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("admin:settings.media.ttlHint", { min: ttl.min, max: ttl.max })}
            </p>
          </div>
          <form
            className="flex flex-wrap items-start gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void ttlForm.handleSubmit();
            }}
          >
            <ttlForm.Field name="hours">
              {(field) => (
                <div className="space-y-1">
                  <Label htmlFor={ttlFieldId} className="sr-only">
                    {t("admin:settings.media.ttlTitle")}
                  </Label>
                  <Input
                    id={ttlFieldId}
                    className="min-h-[44px] w-28"
                    type="number"
                    inputMode="numeric"
                    min={ttl.min}
                    max={ttl.max}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <FieldErrors field={field} />
                </div>
              )}
            </ttlForm.Field>
            <Button type="submit" className="min-h-[44px]" disabled={updateTtl.isPending}>
              {updateTtl.isPending ? t("admin:settings.updating") : t("common:actions.save")}
            </Button>
          </form>
        </div>

        {/* Aggregate stats (counts only) */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MediaStat
            label={t("admin:settings.media.statAssetCount")}
            value={String(stats.assetCount)}
          />
          <MediaStat
            label={t("admin:settings.media.statTotalBytes")}
            value={formatBytes(stats.totalBytes)}
          />
          <MediaStat
            label={t("admin:settings.media.statExpired")}
            value={String(stats.expiredCount)}
          />
        </div>

        {/* Purge expired */}
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <p className="font-medium">{t("admin:settings.media.purgeTitle")}</p>
            <p className="text-sm text-muted-foreground">
              {t("admin:settings.media.purgeDescription")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="min-h-[44px]"
            disabled={actionsDisabled || purgeExpired.isPending}
            onClick={() => purgeExpired.mutate()}
          >
            {purgeExpired.isPending
              ? t("admin:settings.media.purging")
              : t("admin:settings.media.purgeAction")}
          </Button>
        </div>

        {/* Danger zone: delete all */}
        <div className="flex items-start justify-between gap-4 rounded-lg border border-destructive/40 p-4">
          <div className="space-y-1">
            <p className="flex items-center gap-2 font-medium text-destructive">
              <Trash2 className="size-4" />
              {t("admin:settings.media.deleteAllTitle")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("admin:settings.media.deleteAllDescription")}
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            className="min-h-[44px]"
            disabled={actionsDisabled || stats.assetCount === 0}
            onClick={() => setDeleteAllOpen(true)}
          >
            {t("admin:settings.media.deleteAllAction")}
          </Button>
        </div>
      </CardContent>

      <ConfirmDeleteDialog
        open={deleteAllOpen}
        onOpenChange={setDeleteAllOpen}
        title={t("admin:settings.media.deleteAllConfirmTitle")}
        description={t("admin:settings.media.deleteAllConfirmDescription", {
          count: stats.assetCount,
        })}
        confirmToken={t("admin:settings.media.deleteAllConfirmToken")}
        typePrompt={t("admin:settings.media.deleteAllConfirmPrompt")}
        copyAriaLabel={t("admin:settings.media.deleteAllCopyLabel")}
        confirmLabel={t("admin:settings.media.deleteAllAction")}
        pendingLabel={t("admin:settings.media.deleting")}
        isPending={deleteAll.isPending}
        disabled={stats.assetCount === 0}
        onConfirm={() => deleteAll.mutate()}
      />
    </Card>
  );
}

function MediaStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function FieldErrors({
  field,
}: {
  field: { state: { meta: { errors: Array<{ message?: string } | string | undefined> } } };
}) {
  const firstMessage = field.state.meta.errors.reduce<string | null>((acc, e) => {
    if (acc) return acc;
    const msg = typeof e === "string" ? e : e?.message;
    return msg ?? null;
  }, null);
  if (!firstMessage) return null;
  return <p className="text-sm text-destructive">{firstMessage}</p>;
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

function MediaPolicySkeleton() {
  const { t } = useTranslation("admin");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-5" />
          <span className="sr-only">{t("settings.media.title")}</span>
          <Skeleton className="h-5 w-32" />
        </CardTitle>
        <CardDescription>
          <Skeleton className="h-4 w-64" />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </CardContent>
    </Card>
  );
}
