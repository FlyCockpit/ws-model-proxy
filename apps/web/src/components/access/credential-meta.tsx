import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTranslation } from "react-i18next";

import { TimeAgo } from "@/components/time-ago";

import type { CredentialDates, CredentialStatus } from "./credential-meta-utils";

export function CredentialStatusBadge({ status }: { status: CredentialStatus }) {
  const { t } = useTranslation(["access"]);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs",
        status === "active"
          ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
          : "text-muted-foreground",
      )}
    >
      {t(`access:status.${status}`)}
    </span>
  );
}

/** Created / last used / expires, as a compact definition list. */
export function CredentialDatesList({ row }: { row: CredentialDates }) {
  const { t } = useTranslation(["access"]);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      <dt>{t("access:fields.created")}</dt>
      <dd>
        <TimeAgo value={row.createdAt} />
      </dd>
      <dt>{t("access:fields.lastUsed")}</dt>
      <dd>{row.lastUsedAt ? <TimeAgo value={row.lastUsedAt} /> : t("access:fields.neverUsed")}</dd>
      <dt>{t("access:fields.expiry")}</dt>
      <dd>{row.expiresAt ? <TimeAgo value={row.expiresAt} /> : t("access:fields.never")}</dd>
    </dl>
  );
}
