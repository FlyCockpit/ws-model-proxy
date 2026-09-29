import type { DeviceLoginRefusalReason } from "@ws-model-proxy/config/cli-device-login";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";

/** What approving a `wsmp login` request authorizes (`cliCredentials.deviceLoginRequest`). */
export type DeviceLoginRequestSummary = {
  slug: string;
  existingDevice: { id: string; slug: string; displayName: string } | null;
};

/**
 * Tells the approver whether approving adds a new CLI device or replaces the
 * login of an existing one, and which slug it is for.
 */
export function DeviceLoginRequestDetails({ request }: { request: DeviceLoginRequestSummary }) {
  const { t } = useTranslation("auth");
  const existing = request.existingDevice;

  return (
    <div className="space-y-2 rounded-md border px-3 py-2 text-sm">
      <p className="font-medium">
        {existing ? t("device.request.replaceTitle") : t("device.request.newTitle")}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {existing ? (
          <>
            <dt className="text-muted-foreground">{t("device.request.deviceLabel")}</dt>
            <dd className="min-w-0 break-words">{existing.displayName}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("device.request.slugLabel")}</dt>
        <dd className="min-w-0 break-all font-mono">{request.slug}</dd>
      </dl>
      <p className="text-muted-foreground">{t("device.request.checkSlug")}</p>
      {existing ? <p className="text-muted-foreground">{t("device.request.replaceNote")}</p> : null}
    </div>
  );
}

/** Loading state matching `DeviceLoginRequestDetails`. */
export function DeviceLoginRequestSkeleton() {
  return (
    <div className="space-y-2 rounded-md border px-3 py-2" aria-hidden="true">
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-full" />
    </div>
  );
}

/**
 * Why the request cannot be approved and what to do next, in place of the
 * Approve button (which would only be refused again). A stale page
 * (`slug_mismatch`) offers a reload; every other reason is final for this
 * link, so the next step is in the terminal.
 */
export function DeviceLoginRefusal({
  reason,
  onReload,
}: {
  reason: DeviceLoginRefusalReason;
  onReload: () => void;
}) {
  const { t } = useTranslation("auth");

  return (
    <div role="alert" className="space-y-2 rounded-md border px-3 py-2 text-sm">
      <p className="font-medium">{t(`device.refusal.${reason}.title`)}</p>
      <p className="text-muted-foreground">{t(`device.refusal.${reason}.next`)}</p>
      {reason === "slug_mismatch" ? (
        <Button type="button" variant="outline" className="min-h-[44px]" onClick={onReload}>
          {t("device.refusal.reload")}
        </Button>
      ) : null}
    </div>
  );
}
